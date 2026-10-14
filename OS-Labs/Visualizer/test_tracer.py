"""Check that trace validation rejects incomplete or unrelated observations."""

import copy
import unittest

from tracer import _find_eret, _parse_registers, _validate_cycle


class TraceValidationTests(unittest.TestCase):
    def cycle(self):
        events = []
        for index, el in enumerate((0, 1, 1, 1, 0)):
            events.append({"el": el, "pc": "0x1000", "instruction": "mov x0, x2",
                           "registers": {"ELR_EL1": "0x1004"}})
        events[0]["instruction"] = "svc #0x0"
        events[3]["instruction"] = "eret"
        events[4]["pc"] = "0x1004"
        return events

    def test_matching_return_is_accepted(self):
        _validate_cycle(self.cycle(), "Hello, world!")

    def test_return_from_another_cycle_is_rejected(self):
        events = copy.deepcopy(self.cycle())
        events[4]["pc"] = "0x3004"
        with self.assertRaisesRegex(RuntimeError, "same user instruction"):
            _validate_cycle(events, "Hello, world!")

    def test_wrong_entry_level_is_rejected(self):
        events = self.cycle()
        events[1]["el"] = 0
        with self.assertRaisesRegex(RuntimeError, "transition"):
            _validate_cycle(events, "Hello, world!")

    def test_return_breakpoint_requires_one_eret(self):
        disassembly = "   0xffffff000008fa18 <+120>:\teret\n"
        self.assertEqual(_find_eret(disassembly), 0xFFFFFF000008FA18)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            _find_eret(disassembly + disassembly)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            _find_eret("   0x1000 <+0>:\tret\n")

    def test_truncated_register_observation_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "ELR_EL1"):
            _parse_registers("pc 0x1000\ncpsr 0x5\n")


if __name__ == "__main__":
    unittest.main()
