"""Script contract: what VoxCPM 1.5 can speak, over the wire and in the planner.

There is no request-side language parameter — the model infers the language from the
text. What a request cannot do is ask for text the engine will mispronounce: a segment
whose letters are mostly outside Han/Latin (kana, hangul, Cyrillic, Greek, Arabic,
Thai, …) fails with `GENERATE_FAILED` naming the script, and a `language` key on a
segment object is ignored rather than validated.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, PYTHON_DIR)

from ttslib.textsplit import unsupported_script_ratio  # noqa: E402
from voxcpm_daemon import FakeVoxDaemon, make_voice  # noqa: E402


class ScriptRatioTests(unittest.TestCase):
    """The pure classifier the planner thresholds on."""

    def test_han_and_latin_are_supported(self) -> None:
        self.assertEqual(unsupported_script_ratio("你好世界"), (0.0, ""))
        self.assertEqual(unsupported_script_ratio("Hello, world!"), (0.0, ""))
        self.assertEqual(unsupported_script_ratio("你好 world 123"), (0.0, ""))
        self.assertEqual(unsupported_script_ratio("café naïve"), (0.0, ""))

    def test_unsupported_scripts_are_named_in_first_seen_order(self) -> None:
        ratio, names = unsupported_script_ratio("こんにちは")
        self.assertEqual(ratio, 1.0)
        self.assertEqual(names, "kana")
        ratio, names = unsupported_script_ratio("привет мир")
        self.assertEqual(ratio, 1.0)
        self.assertEqual(names, "Cyrillic")
        self.assertEqual(unsupported_script_ratio("สวัสดี")[1], "Thai")
        self.assertEqual(unsupported_script_ratio("안녕하세요")[1], "hangul")
        self.assertEqual(unsupported_script_ratio("καλημέρα")[1], "Greek")
        self.assertEqual(unsupported_script_ratio("你好ねハ")[1], "kana")

    def test_ratio_boundaries(self) -> None:
        self.assertAlmostEqual(unsupported_script_ratio("你好ABね")[0], 0.2)
        self.assertGreater(unsupported_script_ratio("你好Aね")[0], 0.2)
        self.assertEqual(unsupported_script_ratio("你好，。！")[0], 0.0)
        self.assertEqual(unsupported_script_ratio("")[0], 0.0)
        self.assertEqual(unsupported_script_ratio(None)[0], 0.0)


class LanguageContractTests(unittest.TestCase):
    """The planner's accept/reject decisions, driven through the daemon."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认")
        self.daemon = FakeVoxDaemon(self.dir, os.path.join(self.dir, "marker.json"), extra_args=("--idle-unload-sec", "0"))
        self.addCleanup(self.daemon.stop)
        self.ready_event = self.daemon.ready()

    def speak(self, segments) -> dict:
        self.daemon.speak(segments)
        return self.daemon.expect("speak_done")

    def failure(self, segments) -> dict:
        self.daemon.speak(segments)
        return self.daemon.expect("error")

    def test_ready_reports_the_engine_and_drops_backend_fields(self) -> None:
        ready = self.ready_event
        self.assertEqual(ready["engine"], "voxcpm")
        self.assertEqual(ready["sampleRate"], 0)
        self.assertFalse(ready["modelLoaded"])
        self.assertFalse(ready["optimize"])
        self.assertEqual(ready["cfgValue"], 2.7)
        self.assertEqual(ready["timesteps"], 10)
        self.assertFalse(ready["asrAvailable"])
        self.assertTrue(ready["streaming"])
        for gone in ("backend", "backendRequested", "fastAvailable", "upstreamAvailable"):
            self.assertNotIn(gone, ready)

    def test_supported_scripts_speak(self) -> None:
        self.assertTrue(self.speak([{"emotion": "默认", "content": "你好，世界。"}])["ok"])
        self.assertTrue(self.speak([{"emotion": "默认", "content": "Hello there."}])["ok"])
        self.assertTrue(self.speak([{"emotion": "默认", "content": "你好，world 123。"}])["ok"])

    def test_a_language_key_is_ignored_not_validated(self) -> None:
        # The tool schema does not offer the field; a raw request that still carries
        # one must not change the outcome in either direction.
        for value in ("Chinese", "english", "Japanese", "Korean", "German", "xx", ""):
            done = self.speak([{"emotion": "默认", "content": "你好。", "language": value}])
            self.assertTrue(done["ok"], value)
        sentence_ends = [event for event in self.daemon.of("sentence_end")]
        self.assertTrue(sentence_ends)
        self.assertTrue(all(event["language"] == "Auto" for event in sentence_ends), sentence_ends)

    def test_mostly_unsupported_script_fails_with_or_without_a_language_key(self) -> None:
        for value in (None, "Chinese", "English"):
            segment = {"emotion": "默认", "content": "こんにちは、世界。"}
            if value is not None:
                segment["language"] = value
            error = self.failure([segment])
            self.assertEqual(error["code"], "GENERATE_FAILED")
            self.assertIn("kana", error["message"])
            self.assertIn("Chinese and English", error["message"])
        error = self.failure([{"emotion": "默认", "content": "привет"}])
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn("Cyrillic", error["message"])
        error = self.failure([{"emotion": "默认", "content": "안녕하세요"}])
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn("hangul", error["message"])
        self.assertNotIn("init", self.daemon.marker(), "the refusal happens before any load")

    def test_minority_unsupported_script_is_a_note_and_still_speaks(self) -> None:
        done = self.speak([{"emotion": "默认", "content": "你好ABね。"}])
        self.assertTrue(done["ok"])
        notes = [note for note in done["notes"] if "kana" in note]
        self.assertEqual(len(notes), 1, done["notes"])
        self.assertIn("read as Chinese", notes[0])

    def test_language_never_reaches_the_model(self) -> None:
        self.speak([{"emotion": "默认", "content": "Hello there.", "language": "Japanese"}])
        seen = self.daemon.marker().get("generate_streaming.prompt_text")
        self.assertEqual(seen, "你好呀")
        self.assertNotIn("language", self.daemon.marker())

    def test_script_switch_still_splits_units_at_a_clause(self) -> None:
        # A minority script run still moves the unit boundary, so one generation never
        # has to switch script mid-unit; nothing about the text is lost.
        content = "你好，世界ね、第二句。"
        done = self.speak([{"emotion": "默认", "content": content}], )
        self.assertTrue(done["ok"])
        texts = [event["text"] for event in self.daemon.of("sentence_end")]
        self.assertGreaterEqual(len(texts), 2, texts)
        self.assertEqual("".join(texts), content, texts)


if __name__ == "__main__":
    unittest.main()
