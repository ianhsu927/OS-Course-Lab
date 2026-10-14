"""Capture one complete EL0 -> EL1 -> EL0 cycle from the Lab1 kernel."""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import socket
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pexpect


REGISTER_NAMES = ("pc", "cpsr", "ELR_EL1", "SPSR_EL1", "ESR_EL1", "x0", "x1", "x8")
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def _clean_console(value: str) -> str:
    return ANSI_ESCAPE.sub("", value).replace("\r", "").replace("\x0c", "")


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _parse_registers(output: str) -> dict[str, int]:
    values = {}
    for name in REGISTER_NAMES:
        match = re.search(r"^" + re.escape(name) + r"\s+(0x[0-9a-fA-F]+|[0-9]+)\b", output, re.MULTILINE)
        if not match:
            raise RuntimeError(f"GDB did not return register {name}: {output[-1200:]}")
        values[name] = int(match.group(1), 0)
    return values


def _find_eret(disassembly: str) -> int:
    addresses = re.findall(r"^\s*(0x[0-9a-fA-F]+)\s+<[^>]+>:\s+eret\b", disassembly, re.MULTILINE)
    if len(addresses) != 1:
        raise RuntimeError("Expected exactly one eret in the kernel's el0_syscall symbol")
    return int(addresses[0], 16)


def _expect(child: pexpect.spawn, pattern, on_progress: Callable[[str], None], deadline: float,
            timeout: int, description: str, exact: bool = True) -> None:
    expires = min(time.monotonic() + timeout, deadline)
    while True:
        remaining = expires - time.monotonic()
        if remaining <= 0:
            raise pexpect.TIMEOUT(description + " timed out")
        try:
            method = child.expect_exact if exact else child.expect
            method(pattern, timeout=min(5, remaining))
            return
        except pexpect.TIMEOUT:
            if time.monotonic() >= expires:
                raise
            on_progress(description)


class _Debugger:
    def __init__(self, child: pexpect.spawn, on_progress: Callable[[str], None], deadline: float):
        self.child = child
        self.on_progress = on_progress
        self.deadline = deadline
        self.prompt = "OSLAB_TRACE_GDB> "
        self.expect("(gdb) ")
        child.sendline("set prompt " + self.prompt)
        self.expect(self.prompt)

    def expect(self, pattern, timeout: int = 20) -> None:
        _expect(self.child, pattern, self.on_progress, self.deadline, timeout, "等待 QEMU / GDB 到达观测点。")

    def command(self, value: str, timeout: int = 20) -> str:
        self.child.sendline(value)
        self.expect(self.prompt, timeout=timeout)
        output = self.child.before.replace("\r", "")
        if re.search(r"Undefined command|Cannot access memory|Invalid register|No symbol|Remote connection closed", output):
            raise RuntimeError(f"GDB command failed ({value}): {output[-1500:]}")
        return output

    def resume(self) -> None:
        self.child.sendline("continue")

    def stopped(self, timeout: int = 25) -> str:
        self.expect(self.prompt, timeout=timeout)
        output = self.child.before.replace("\r", "")
        if "Breakpoint" not in output and "Temporary breakpoint" not in output:
            raise RuntimeError(f"GDB did not stop at the requested breakpoint: {output[-1500:]}")
        return output

    def registers(self) -> dict[str, int]:
        return _parse_registers(self.command("info registers " + " ".join(REGISTER_NAMES)))

    def instruction(self) -> str:
        output = self.command("x/i $pc")
        match = re.search(r"=>\s+0x[0-9a-fA-F]+(?:\s+<[^>]+>)?:\s+([^\n]+)", output)
        if not match:
            raise RuntimeError("Cannot parse the instruction at the current PC")
        return match.group(1).strip().replace("\t", " ")

    def thread(self) -> int:
        output = self.command('printf "TRACE_THREAD=%d\\n", $_thread')
        match = re.search(r"TRACE_THREAD=(\d+)", output)
        if not match:
            raise RuntimeError("Cannot identify the selected QEMU CPU")
        return int(match.group(1))

    def string(self, address: int, length: int) -> str:
        # Read a bounded byte array: putstr uses a length, not a NUL-terminated string.
        count = min(length, 4096)
        output = self.command(f"x/{count}bx {address:#x}")
        data = []
        for line in output.splitlines():
            if re.match(r"^0x[0-9a-fA-F]+(?:\s+<[^>]+>)?:", line):
                data.extend(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{2})\b", line.split(":", 1)[1]))
        if len(data) != count:
            raise RuntimeError("GDB did not return the complete user output buffer")
        return bytes(data).decode("utf-8", errors="replace")


def _event(debugger: _Debugger, index: int, label: str, phase: str, detail: str) -> dict:
    registers = debugger.registers()
    el = (registers["cpsr"] & 0xF) >> 2
    if el not in (0, 1):
        raise RuntimeError(f"Unexpected exception level EL{el} while tracing Lab1")
    return {
        "id": index,
        "label": label,
        "phase": phase,
        "el": el,
        "pc": hex(registers["pc"]),
        "instruction": debugger.instruction(),
        "cpsr": hex(registers["cpsr"]),
        "registers": {name: hex(registers[name]) for name in REGISTER_NAMES if name not in ("pc", "cpsr")},
        "detail": detail,
    }


def _validate_cycle(events: list[dict], message: str) -> None:
    if [event["el"] for event in events] != [0, 1, 1, 1, 0]:
        raise RuntimeError("The captured cycle did not make the expected EL0 -> EL1 -> EL0 transition")
    if not re.match(r"svc\s+#(?:0x)?0\b", events[0]["instruction"]):
        raise RuntimeError("The user entry instruction was not svc #0")
    if events[3]["instruction"] != "eret":
        raise RuntimeError("The kernel return instruction was not eret")
    resume_pc = int(events[0]["pc"], 16) + 4
    if int(events[1]["registers"]["ELR_EL1"], 16) != resume_pc or int(events[4]["pc"], 16) != resume_pc:
        raise RuntimeError("Captured entry and return do not belong to the same user instruction")
    if not message:
        raise RuntimeError("The captured sys_putstr buffer was empty")


def capture(repo_root: Path, output_directory: Path, on_progress: Callable[[str], None]) -> dict:
    """Run hello_world.bin, record a real syscall cycle, and close QEMU/GDB.

    The first Hello output locates the shared user syscall wrapper. Only the
    following full putstr cycle is returned; discovery samples are excluded.
    """
    repo_root = Path(repo_root).resolve()
    output_directory = Path(output_directory).resolve()
    kernel = repo_root / "Lab1" / "build" / "kernel.img"
    if not kernel.is_file():
        raise RuntimeError("Lab1/build/kernel.img is missing; run make in Lab1 first")
    qemu_path = shutil.which("qemu-system-aarch64")
    gdb_path = shutil.which("gdb-multiarch") or shutil.which("gdb")
    if not qemu_path or not gdb_path:
        raise RuntimeError("Real capture requires qemu-system-aarch64 and an AArch64-capable GDB")
    output_directory.mkdir(parents=True, exist_ok=True)
    identifier = "trace-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:6]
    serial = io.StringIO()
    debugger_log = io.StringIO()
    qemu = None
    gdb = None
    started = time.monotonic()
    deadline = started + 120
    try:
        port = _free_loopback_port()
        on_progress("启动 Lab1 内核，等待 ChCore Shell。")
        qemu_arguments = [
            "-machine", "raspi3b", "-nographic", "-serial", "mon:stdio",
            "-m", "size=1G", "-kernel", str(kernel), "-gdb", f"tcp:127.0.0.1:{port}",
        ]
        qemu = pexpect.spawn(qemu_path, qemu_arguments, encoding="utf-8", codec_errors="replace", timeout=30)
        qemu.logfile_read = serial
        _expect(qemu, "Welcome to ChCore shell!", on_progress, deadline, 25, "等待 ChCore Shell 启动。")
        _expect(qemu, r"\$ ", on_progress, deadline, 10, "等待 ChCore Shell 提示符。", exact=False)
        on_progress("连接 GDB，定位 hello_world.bin 的系统调用指令。")
        gdb = pexpect.spawn(gdb_path, ["-q", "-nx", str(kernel)], encoding="utf-8", codec_errors="replace", timeout=20, echo=False)
        gdb.logfile_read = debugger_log
        debugger = _Debugger(gdb, on_progress, deadline)
        debugger.command("set pagination off")
        debugger.command("set confirm off")
        debugger.command("set architecture aarch64")
        eret = _find_eret(debugger.command("disassemble el0_syscall"))
        debugger.command(f"target remote 127.0.0.1:{port}")
        debugger.command("break *sys_putstr if $x1 > 10 && *(unsigned char*)$x0 == 72")
        debugger.resume()
        qemu.sendline("hello_world.bin")
        debugger.stopped()
        locator = debugger.registers()
        svc_address = locator["ELR_EL1"] - 4
        locator_message = debugger.string(locator["x0"], locator["x1"])
        if "Hello" not in locator_message:
            raise RuntimeError("The initial output breakpoint did not identify hello_world.bin")
        debugger.command("delete breakpoints")
        # Any CPU can locate the next output; all subsequent stops follow its CPU.
        debugger.command(f"tbreak *{svc_address:#x} if $x8 == 0 && $x1 > 10")
        debugger.resume()
        debugger.stopped()
        thread = debugger.thread()
        on_progress("采集同一次输出调用：用户态、异常入口、内核处理和返回。")
        events = [_event(debugger, 0, "用户态发起系统调用", "user", "EL0 的用户程序准备执行 svc #0；x8 选择输出系统调用，x0 / x1 指向文本及其长度。")]
        debugger.command("stepi")
        events.append(_event(debugger, 1, "CPU 进入异常向量", "entry", "svc 触发同步异常，CPU 切换到 EL1；ELR_EL1 保存下一条用户指令，SPSR_EL1 保存用户状态。"))
        debugger.command(f"tbreak *sys_putstr thread {thread}")
        debugger.resume()
        debugger.stopped()
        events.append(_event(debugger, 2, "内核处理输出请求", "kernel", "异常处理代码分派到 sys_putstr；内核读取用户缓冲区并通过串口输出。"))
        current = debugger.registers()
        message = debugger.string(current["x0"], current["x1"])
        events[2]["buffer"] = message
        debugger.command(f"tbreak *{eret:#x} thread {thread}")
        debugger.resume()
        debugger.stopped()
        events.append(_event(debugger, 3, "内核准备返回用户态", "return", "系统调用完成，内核恢复用户寄存器，准备执行 eret。"))
        debugger.command("stepi")
        events.append(_event(debugger, 4, "用户程序继续执行", "user", "eret 恢复 EL0 状态，PC 回到 svc 后的下一条指令，用户程序继续运行。"))
        _validate_cycle(events, message)
        on_progress("验证异常级别和返回地址，等待用户程序完成。")
        debugger.command("delete breakpoints")
        debugger.command("detach")
        gdb.sendline("quit")
        debugger.expect(pexpect.EOF, timeout=5)
        _expect(qemu, "Hello world finished!", on_progress, deadline, 25, "等待 hello_world.bin 完成。")
        _expect(qemu, r"\$ ", on_progress, deadline, 10, "等待返回 ChCore Shell。", exact=False)
        console = _clean_console(serial.getvalue())
        trace = {
            "id": identifier,
            "source": "qemu-gdb",
            "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "program": "hello_world.bin",
            "architecture": "AArch64",
            "events": events,
            "console": console,
            "summary": {
                "consoleMessage": message.strip(),
                "syscall": "sys_putstr",
                "syscallNumber": int(events[0]["registers"]["x8"], 16),
                "cpu": thread - 1,
                "modeSwitches": 2,
                "eventCount": len(events),
                "elapsedMs": round((time.monotonic() - started) * 1000),
                "completed": True,
            },
            "provenance": {
                "kernel": "Lab1/build/kernel.img",
                "kernelSha256": hashlib.sha256(kernel.read_bytes()).hexdigest(),
                "machine": "raspi3b",
                "breakpointDerivation": "User svc is ELR_EL1 - 4 at sys_putstr; eret is derived from disassemble el0_syscall.",
                "observedCycle": "One complete consecutive sys_putstr cycle; the first Hello output is used only to locate the syscall wrapper and is excluded from events.",
                "cpuThread": thread,
                "serialLog": identifier + ".serial.log",
                "debuggerLog": identifier + ".gdb.log",
                "jsonFile": identifier + ".json",
                "timing": "Events are GDB stop points; elapsedMs is host capture duration, not syscall latency.",
            },
        }
        (output_directory / (identifier + ".json")).write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        on_progress("真实轨迹采集完成，QEMU 和 GDB 即将关闭。")
        return trace
    except (pexpect.TIMEOUT, pexpect.EOF) as error:
        tail = _clean_console(serial.getvalue())[-1800:]
        raise RuntimeError(f"QEMU/GDB capture stopped before completing the experiment: {error}\nSerial tail:\n{tail}") from error
    finally:
        for child in (gdb, qemu):
            if child is not None and child.isalive():
                child.terminate(force=True)
            if child is not None:
                child.close(force=True)
        (output_directory / (identifier + ".serial.log")).write_text(_clean_console(serial.getvalue()), encoding="utf-8")
        (output_directory / (identifier + ".gdb.log")).write_text(debugger_log.getvalue(), encoding="utf-8")
