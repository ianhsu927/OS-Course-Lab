#!/usr/bin/env python3
"""Local ChCore observation server; the capture worker owns its QEMU instance."""

import argparse
import importlib.util
import json
import re
import shutil
import signal
import subprocess
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
KERNEL_BASE = 0xFFFFFF0000000000
PERIPHERAL_BASE = 0x3F000000
ONE_GIB = 0x40000000
TWO_MIB = 0x200000


def kernel_symbols(repo=REPO):
    image = repo / "Lab1/build/kernel.img"
    nm = shutil.which("aarch64-linux-gnu-nm")
    if not image.exists() or not nm:
        return {}
    result = subprocess.run([nm, str(image)], capture_output=True, text=True, timeout=10)
    if result.returncode:
        return {}
    symbols = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[2].startswith("boot_ttbr"):
            symbols[parts[2]] = int(parts[0], 16)
    return symbols


def page_walk(raw_address, symbols=None):
    """Evaluate the startup mappings in Lab1 mmu.c, not a live process page table."""
    if not isinstance(raw_address, str) or not re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)", raw_address.strip()):
        raise ValueError("请输入十六进制地址（0x 开头）或十进制地址。")
    raw_address = raw_address.strip()
    address = int(raw_address, 16 if raw_address.lower().startswith("0x") else 10)
    if address < 0 or address >= 1 << 64:
        raise ValueError("地址必须在 64 位无符号整数范围内。")
    high = address >= KERNEL_BASE
    physical = address - KERNEL_BASE if high else address
    indices = [(address >> shift) & 511 for shift in (39, 30, 21, 12)]
    mapped = physical < (2 * ONE_GIB if high else ONE_GIB)
    kind = ("normal" if physical < PERIPHERAL_BASE else "device") if mapped else "unmapped"
    block = ONE_GIB if high and physical >= ONE_GIB and mapped else TWO_MIB
    flags = (1 << 54) | (1 << 10) | (1 << 11) | 1
    attributes = ["UXN", "AF", "nG"]
    if kind == "normal":
        flags |= (3 << 8) | (4 << 2)
        attributes += ["Inner Shareable", "Normal Memory · AttrIndx 4"]
    elif kind == "device":
        attributes += ["Device Memory · AttrIndx 0"]
    tables = symbols or {}
    prefix = "boot_ttbr1" if high else "boot_ttbr0"
    stages = []
    if mapped:
        leaf = 1 if block == ONE_GIB else 2
        for level in range(leaf + 1):
            is_leaf = level == leaf
            next_table = tables.get("{}_l{}".format(prefix, level + 1))
            target = physical // block * block if is_leaf else next_table
            descriptor = target | flags if is_leaf else ((target | 3 | (1 << 11)) if target is not None else None)
            stages.append({
                "level": "L{}".format(level), "index": indices[level],
                "descriptor": hex(descriptor) if descriptor is not None else None,
                "address": hex(target) if target is not None else None,
                "type": "block" if is_leaf else "table",
                "attributes": attributes if is_leaf else ["Valid", "Table", "nG"],
                "table": "{}_l{}".format(prefix, level),
            })
    return {
        "source": "boot-mapping-model", "address": hex(address),
        "physical": hex(physical) if mapped else None, "mapped": mapped,
        "kind": kind, "granularity": ("1 GiB" if block == ONE_GIB else "2 MiB") if mapped else None,
        "l0": indices[0], "l1": indices[1], "l2": indices[2], "l3": indices[3],
        "indices": indices, "offset": hex(address % block) if mapped else None,
        "stages": stages, "attributes": attributes if mapped else [],
        "ttbr": "TTBR1_EL1" if high else "TTBR0_EL1",
        "note": "依据 Lab1 mmu.c 启动映射计算；不是当前进程页表的实时读取。",
    }


class ObservationState:
    def __init__(self, repo=REPO, data_dir=ROOT / "data"):
        self.repo = repo
        self.data_dir = data_dir
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.state = "idle"
        self.message = "就绪"
        self.error = None
        self.trace = None
        self.traces = {}
        self.case = "syscall"
        self.worker = None
        self.symbols = kernel_symbols(repo)
        self.available = {
            "qemu": bool(shutil.which("qemu-system-aarch64")),
            "gdb": bool(shutil.which("gdb-multiarch") or shutil.which("gdb")),
            "kernel": (repo / "Lab1/build/kernel.img").is_file(),
            "pexpect": importlib.util.find_spec("pexpect") is not None,
        }
        traces = sorted((data_dir / "captures").glob("*.json"), reverse=True)
        traces.append(data_dir / "recorded-trace.json")
        traces.append(data_dir / "recorded-interrupt.json")
        for path in traces:
            try:
                candidate = json.loads(path.read_text(encoding="utf-8"))
                case = candidate.get("case", "syscall")
                if candidate.get("events") and case not in self.traces:
                    self.traces[case] = candidate
            except (OSError, ValueError):
                continue
        self.trace = self.traces.get("syscall")

    def snapshot(self):
        with self.lock:
            return {"state": self.state, "message": self.message, "error": self.error,
                    "case": self.case,
                    "traceId": self.traces.get(self.case, {}).get("id"),
                    "available": self.available, "program": "定时器 IRQ" if self.case == "interrupt" else "hello_world.bin"}

    def progress(self, message):
        if self.stopping.is_set():
            raise RuntimeError("服务已停止，采集已取消。")
        with self.lock:
            self.message = message

    def start_capture(self, case="syscall"):
        with self.lock:
            if self.state == "capturing":
                return HTTPStatus.CONFLICT, {"error": "已有采集任务正在运行。"}
            missing = [name for name, value in self.available.items() if not value]
            if missing:
                return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "缺少运行依赖：" + ", ".join(missing)}
            self.state, self.message, self.error = "capturing", "正在启动 QEMU…", None
            self.case = case
            self.worker = threading.Thread(target=self._capture, args=(case,), name="chcore-capture", daemon=True)
            self.worker.start()
        return HTTPStatus.ACCEPTED, {"state": "capturing"}

    def _capture(self, case):
        try:
            if case == "interrupt":
                from interrupt_tracer import capture_interrupt
                trace = capture_interrupt(self.repo, self.data_dir / "captures", self.progress)
            else:
                from tracer import capture
                trace = capture(self.repo, self.data_dir / "captures", self.progress)
            with self.lock:
                self.traces[case] = trace
                if case == "syscall":
                    self.trace = trace
                self.state, self.message = "ready", "真实轨迹采集完成"
        except Exception as exc:
            with self.lock:
                self.state, self.error, self.message = "error", str(exc), "采集失败"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "public"), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        super().end_headers()

    def respond(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        request = urlparse(self.path)
        state = self.server.observation
        if request.path == "/api/status":
            self.respond(HTTPStatus.OK, state.snapshot())
        elif request.path == "/api/trace/last":
            case = parse_qs(request.query).get("case", ["syscall"])[0]
            if case not in ("syscall", "interrupt"):
                self.respond(HTTPStatus.BAD_REQUEST, {"error": "未知采集案例。"})
                return
            with state.lock:
                trace = state.traces.get(case)
            self.respond(HTTPStatus.OK if trace else HTTPStatus.NOT_FOUND, trace or {"error": "暂无轨迹，请先采集。"})
        elif request.path == "/api/page-walk":
            query = parse_qs(request.query)
            try:
                result = page_walk(query.get("address", ["0xffffff0000080000"])[0], state.symbols)
                self.respond(HTTPStatus.OK, result)
            except ValueError as exc:
                self.respond(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        elif request.path.startswith("/api/"):
            self.respond(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})
        else:
            super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/api/capture":
            self.respond(HTTPStatus.NOT_FOUND, {"error": "接口不存在。"})
            return
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            self.respond(HTTPStatus.FORBIDDEN, {"error": "采集请求必须来自本地观察台。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 4096:
                raise ValueError()
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict) or set(payload) - {"case"} or payload.get("case", "syscall") not in ("syscall", "interrupt"):
                raise ValueError()
        except (ValueError, json.JSONDecodeError):
            self.respond(HTTPStatus.BAD_REQUEST, {"error": "采集请求应为 {} 或指定 case 为 syscall / interrupt。"})
            return
        status, payload = self.server.observation.start_capture(payload.get("case", "syscall"))
        self.respond(status, payload)


def main():
    parser = argparse.ArgumentParser(description="ChCore 本地实验观察台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    state = ObservationState()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.observation = state
    def stop_server(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_server)
    print("ChCore Observatory: http://{}:{}".format(args.host, server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        state.stopping.set()
        server.server_close()
        if state.worker:
            state.worker.join(timeout=25)


if __name__ == "__main__":
    main()
