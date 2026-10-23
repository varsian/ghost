"""Reported language per generation unit over the wire.

There is no request-side language parameter: VoxCPM 1.5 infers the language from the
text, so ``sentence_end.language`` always reports ``Auto``. Scripts the engine cannot
speak are a separate check — reported as a note, or refused, in
``test_language_contract.py``.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, PYTHON_DIR)
sys.path.insert(0, HERE)

from tests.voxcpm_daemon import FakeVoxDaemon as ProbeDaemon, make_voice  # noqa: E402


class LanguageResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认")
        self.marker = os.path.join(self.dir, "probe.json")

    def start(self, extra_args=()) -> ProbeDaemon:
        daemon = ProbeDaemon(self.dir, self.marker, extra_args=extra_args)
        self.addCleanup(daemon.stop)
        daemon.expect("ready", timeout=60)
        return daemon

    def speak(self, daemon: ProbeDaemon, content: str, rid: str = "1", extra: dict = None) -> tuple:
        segment = {"content": content}
        segment.update(extra or {})
        daemon.send({"id": rid, "op": "speak", "segments": [segment], "play": False, "gapMs": 0})
        daemon.expect("speak_start", id=rid, timeout=60)
        done = daemon.expect("speak_done", id=rid, timeout=60)
        return done, [event for event in daemon.of("sentence_end") if event.get("id") == rid]

    def test_auto_is_the_default_for_both_scripts(self) -> None:
        daemon = self.start()
        _done, chinese = self.speak(daemon, "你好，世界。", rid="1")
        self.assertEqual([event["language"] for event in chinese], ["Auto"])
        _done, english = self.speak(daemon, "Hello world.", rid="2")
        self.assertEqual([event["language"] for event in english], ["Auto"])

    def test_a_language_key_is_ignored(self) -> None:
        daemon = self.start()
        _done, sentence_ends = self.speak(daemon, "你好。", extra={"language": "Japanese"})
        self.assertEqual([event["language"] for event in sentence_ends], ["Auto"])

    def test_sentence_end_carries_language_chars_and_max_len(self) -> None:
        daemon = self.start()
        _done, sentence_ends = self.speak(daemon, "甲一。甲二。")
        self.assertTrue(sentence_ends)
        for event in sentence_ends:
            self.assertEqual(event["language"], "Auto")
            self.assertEqual(event["chars"], len(event["text"]))
            self.assertGreater(event["maxLen"], 0)

    def test_reported_language_does_not_switch_per_unit(self) -> None:
        daemon = self.start(extra_args=("--merge-sentences", "off"))
        done, sentence_ends = self.speak(daemon, "你好ABね。第二句。")
        self.assertTrue(done["ok"])
        self.assertEqual([event["language"] for event in sentence_ends], ["Auto", "Auto"])


if __name__ == "__main__":
    unittest.main()
