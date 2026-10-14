"""Observe a real physical timer IRQ and the scheduler's return to EL0."""

import hashlib
import io
import json
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pexpect

from tracer import _Debugger, _clean_console, _event, _expect, _find_eret, _free_loopback_port


def capture_interrupt(repo_root, output_directory, on_progress):
    kernel = Path(repo_root) / "Lab1/build/kernel.img"
    output_directory = Path(output_directory)
    if not kernel.is_file():
        raise RuntimeError("请先构建 Lab1/build/kernel.img。")
    output_directory.mkdir(parents=True, exist_ok=True)
    identifier = "trace-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-irq-" + uuid.uuid4().hex[:6]
    serial, debugger_log = io.StringIO(), io.StringIO()
    qemu = gdb = None
    started = time.monotonic()
    deadline = started + 120
    try:
        on_progress("启动 Lab1，等待定时器中断采样。")
        port = _free_loopback_port()
        qemu = pexpect.spawn(shutil.which("qemu-system-aarch64"), [
            "-machine", "raspi3b", "-nographic", "-serial", "mon:stdio", "-m", "size=1G",
            "-kernel", str(kernel), "-gdb", "tcp:127.0.0.1:{}".format(port),
        ], encoding="utf-8", codec_errors="replace", timeout=30)
        qemu.logfile_read = serial
        _expect(qemu, "Welcome to ChCore shell!", on_progress, deadline, 30, "等待 ChCore Shell 启动。")
        _expect(qemu, r"\$ ", on_progress, deadline, 10, "等待用户线程进入运行状态。", exact=False)
        gdb = pexpect.spawn(shutil.which("gdb-multiarch") or shutil.which("gdb"), ["-q", "-nx", str(kernel)],
                            encoding="utf-8", codec_errors="replace", echo=False, timeout=25)
        gdb.logfile_read = debugger_log
        debugger = _Debugger(gdb, on_progress, deadline)
        debugger.command("set pagination off")
        debugger.command("set confirm off")
        debugger.command("set architecture aarch64")
        eret = _find_eret(debugger.command("disassemble __eret_to_thread"))
        debugger.command("target remote 127.0.0.1:{}".format(port))
        # BCM2836 per-CPU IRQ source bit 1 is the physical non-secure timer.
        debugger.command("break *irq_el0_64 if (*(unsigned int *)(0xffffff0040000060 + ($_thread - 1) * 4) & 2) != 0")
        on_progress("等待物理定时器打断 EL0 用户线程。")
        debugger.resume()
        debugger.stopped(timeout=30)
        cpu_thread = debugger.thread()
        events = [_event(debugger, 0, "定时器 IRQ 进入内核", "entry", "物理非安全定时器的 IRQ 打断 EL0 线程，CPU 进入 irq_el0_64；SPSR_EL1 保存被打断线程的 EL0 状态。")]
        interrupted_pc = events[0]["registers"]["ELR_EL1"]
        debugger.command("delete breakpoints")
        debugger.command("tbreak *handle_timer_irq thread {}".format(cpu_thread))
        debugger.resume()
        debugger.stopped()
        on_progress("已进入定时器处理函数，观察调度和异常返回。")
        events.append(_event(debugger, 1, "处理定时器中断", "kernel", "平台中断分派到 handle_timer_irq，更新定时器相关状态；中断处理可触发线程调度。"))
        debugger.command("tbreak *{} thread {} if ($SPSR_EL1 & 15) == 0".format(hex(eret), cpu_thread))
        debugger.resume()
        debugger.stopped()
        events.append(_event(debugger, 2, "恢复选中的用户线程", "return", "调度器恢复一个用户线程的寄存器并执行 eret；这个线程可能与被中断的线程不同。"))
        debugger.command("stepi")
        events.append(_event(debugger, 3, "CPU 返回用户态", "user", "eret 恢复 EL0，CPU 从调度器选择的用户线程继续执行。"))
        if [event["el"] for event in events] != [1, 1, 1, 0]:
            raise RuntimeError("中断轨迹的异常级别与预期不一致。")
        if int(events[0]["registers"]["SPSR_EL1"], 16) & 15:
            raise RuntimeError("此次中断没有来自 EL0。")
        if events[2]["instruction"] != "eret" or events[3]["pc"] != events[2]["registers"]["ELR_EL1"]:
            raise RuntimeError("中断返回现场无法验证。")
        debugger.command("delete breakpoints")
        debugger.command("detach")
        gdb.sendline("quit")
        debugger.expect(pexpect.EOF, timeout=5)
        trace = {
            "id": identifier, "case": "interrupt", "source": "qemu-gdb",
            "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "program": "ChCore 用户线程 / 物理定时器", "architecture": "AArch64",
            "events": events, "console": _clean_console(serial.getvalue()),
            "summary": {"eventCount": 4, "cpu": cpu_thread - 1, "completed": True,
                        "interruptedPc": interrupted_pc, "resumedPc": events[3]["pc"],
                        "sameResumeAddress": interrupted_pc == events[3]["pc"],
                        "elapsedMs": round((time.monotonic() - started) * 1000),
                        "interrupt": "physical non-secure timer", "irqSourceMask": "0x2"},
            "provenance": {"kernel": "Lab1/build/kernel.img", "kernelSha256": hashlib.sha256(kernel.read_bytes()).hexdigest(),
                           "machine": "raspi3b", "cpuThread": cpu_thread,
                           "note": "真实定时器 IRQ 采样。入口前的用户指令没有直接采样，返回可能调度到其他线程；ESR_EL1 不用于判断 IRQ 来源。",
                           "serialLog": identifier + ".serial.log", "debuggerLog": identifier + ".gdb.log",
                           "timing": "GDB 停止点与采集总时长不代表中断延迟。"},
        }
        (output_directory / (identifier + ".json")).write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        on_progress("真实定时器中断采集完成。")
        return trace
    except (pexpect.EOF, pexpect.TIMEOUT) as exc:
        raise RuntimeError("中断采样未完成：{}\n{}".format(str(exc), _clean_console(serial.getvalue())[-1200:])) from exc
    finally:
        for child in (gdb, qemu):
            if child is not None:
                if child.isalive():
                    child.terminate(force=True)
                child.close(force=True)
        (output_directory / (identifier + ".serial.log")).write_text(_clean_console(serial.getvalue()), encoding="utf-8")
        (output_directory / (identifier + ".gdb.log")).write_text(debugger_log.getvalue(), encoding="utf-8")
