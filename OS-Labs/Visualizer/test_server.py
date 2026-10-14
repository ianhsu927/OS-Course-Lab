import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from server import KERNEL_BASE, ObservationState, page_walk


class BootPageWalkTests(unittest.TestCase):
    def test_kernel_entry_identity_offset(self):
        result = page_walk(hex(KERNEL_BASE + 0x80000))
        self.assertTrue(result["mapped"])
        self.assertEqual(result["physical"], "0x80000")
        self.assertEqual(result["kind"], "normal")
        self.assertEqual([stage["level"] for stage in result["stages"]], ["L0", "L1", "L2"])
        self.assertEqual(result["offset"], "0x80000")

    def test_ram_device_boundary(self):
        self.assertEqual(page_walk(hex(KERNEL_BASE + 0x3EFFFFFF))["kind"], "normal")
        self.assertEqual(page_walk(hex(KERNEL_BASE + 0x3F000000))["kind"], "device")
        self.assertEqual(page_walk(hex(KERNEL_BASE + 0x3F201000))["physical"], "0x3f201000")

    def test_local_peripherals_are_one_gib_block(self):
        result = page_walk(hex(KERNEL_BASE + 0x40000040))
        self.assertEqual(result["granularity"], "1 GiB")
        self.assertEqual(result["stages"][-1]["level"], "L1")
        self.assertEqual(result["offset"], "0x40")

    def test_outside_startup_mapping_and_low_local_peripherals(self):
        for address in [hex(KERNEL_BASE + 0x80000000), "0x40000000", "0xffff000000000000"]:
            result = page_walk(address)
            self.assertFalse(result["mapped"])
            self.assertIsNone(result["physical"])

    def test_actual_symbol_addresses_form_table_descriptors(self):
        result = page_walk(hex(KERNEL_BASE), {"boot_ttbr1_l1": 0x81000, "boot_ttbr1_l2": 0x82000})
        self.assertEqual(int(result["stages"][0]["descriptor"], 16), 0x81803)
        self.assertEqual(int(result["stages"][1]["descriptor"], 16), 0x82803)

    def test_rejects_invalid_or_overflow_addresses(self):
        for address in ["-1", "0x", "x", "0x10000000000000000"]:
            with self.assertRaises(ValueError):
                page_walk(address)


class CaptureCaseIsolationTests(unittest.TestCase):
    def test_latest_trace_is_selected_independently_for_each_case(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            captures = data / "captures"
            captures.mkdir()
            entries = [
                ("trace-001.json", {"id": "syscall-1", "events": [{}]}),
                ("trace-002.json", {"id": "syscall-2", "events": [{}]}),
                ("trace-003.json", {"id": "irq-1", "case": "interrupt", "events": [{}]}),
                ("trace-004.json", {"id": "irq-2", "case": "interrupt", "events": [{}]}),
            ]
            for filename, trace in entries:
                (captures / filename).write_text(json.dumps(trace), encoding="utf-8")
            with patch("server.kernel_symbols", return_value={}):
                state = ObservationState(repo=data, data_dir=data)
            self.assertEqual(state.trace["id"], "syscall-2")
            self.assertEqual(state.traces["interrupt"]["id"], "irq-2")

    def test_interrupt_capture_preserves_syscall_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            with patch("server.kernel_symbols", return_value={}):
                state = ObservationState(repo=data, data_dir=data)
            original = {"id": "original-syscall", "events": [{}]}
            state.trace = original
            state.traces["syscall"] = original
            interrupt = {"id": "new-irq", "case": "interrupt", "events": [{}]}
            with patch("interrupt_tracer.capture_interrupt", return_value=interrupt):
                state._capture("interrupt")
            self.assertEqual(state.traces["interrupt"], interrupt)
            self.assertIs(state.trace, original)
            self.assertIs(state.traces["syscall"], original)
            self.assertEqual(state.state, "ready")


if __name__ == "__main__":
    unittest.main()
