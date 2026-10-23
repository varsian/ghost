"""First-sentence cap: streaming branch vs non-streaming branch (rev 7).

The cap exists to shorten the wait before the first audible sample, which only
matters when a whole unit must be generated before playback starts. A streaming
backend therefore plans with the cap disabled (``--first-sentence-max-chars`` is
passed as ``0``) and the daemon re-plans only when that effective value differs
from the configured one.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, PYTHON_DIR)

from tests.voxcpm_daemon import FakeVoxDaemon as FastDaemon, make_voice, write_wav  # noqa: E402

LONG_FIRST = "这是一句很长的开场白，需要被切分成更小的片段来降低首次出声的等待时间。"


class StreamingCapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认")
        self.marker = os.path.join(self.dir, "fast.json")

    def start(self, extra_args=()) -> FastDaemon:
        daemon = FastDaemon(self.dir, self.marker, extra_args=extra_args)
        self.addCleanup(daemon.stop)
        daemon.expect("ready", timeout=60)
        return daemon

    def speak(self, daemon: FastDaemon, content: str) -> tuple:
        daemon.send({"id": "1", "op": "speak", "segments": [{"content": content}], "play": False})
        start = daemon.expect("speak_start", id="1", timeout=60)
        done = daemon.expect("speak_done", id="1", timeout=60)
        return start, done, [event for event in daemon.events if event.get("event") == "sentence_end"]

    def test_streaming_backend_ignores_the_first_sentence_cap(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "20"))
        start, _done, sentence_ends = self.speak(daemon, LONG_FIRST)
        self.assertTrue(start["streaming"])
        self.assertEqual(len(sentence_ends), 1, "a streaming backend starts at the first chunk")
        self.assertEqual(sentence_ends[0]["text"], LONG_FIRST)

    def test_non_streaming_branch_applies_the_cap(self) -> None:
        daemon = self.start(extra_args=("--stream", "false", "--first-sentence-max-chars", "20"))
        start, _done, sentence_ends = self.speak(daemon, LONG_FIRST)
        self.assertFalse(start["streaming"])
        self.assertGreaterEqual(len(sentence_ends), 2)
        # The first-unit cap bounds unit 0; later units are bounded by the sentence
        # cap, since merging may join short pieces again.
        self.assertLessEqual(len(sentence_ends[0]["text"]), 20, sentence_ends[0]["text"])
        self.assertTrue(all(len(event["text"]) <= 60 for event in sentence_ends), [e["text"] for e in sentence_ends])
        self.assertEqual("".join(event["text"] for event in sentence_ends), LONG_FIRST)

    def test_cap_zero_plans_the_same_on_both_branches(self) -> None:
        streaming = self.start(extra_args=("--first-sentence-max-chars", "0"))
        _start, _done, streamed = self.speak(streaming, LONG_FIRST)
        whole = self.start(extra_args=("--stream", "false", "--first-sentence-max-chars", "0"))
        _start2, _done2, whole_units = self.speak(whole, LONG_FIRST)
        self.assertEqual([event["text"] for event in streamed], [event["text"] for event in whole_units])

    def test_short_first_sentence_is_unchanged_while_streaming(self) -> None:
        daemon = self.start()
        _start, done, sentence_ends = self.speak(daemon, "你好。")
        self.assertEqual(len(sentence_ends), 1)
        self.assertGreater(done["totalSeconds"], 0)

    def test_text_without_speakable_content_loads_no_model_while_streaming(self) -> None:
        daemon = self.start()
        daemon.send({"id": "1", "op": "speak", "segments": [{"content": "。。。"}], "play": False})
        start = daemon.expect("speak_start", id="1", timeout=60)
        done = daemon.expect("speak_done", id="1", timeout=60)
        self.assertEqual((start["sentences"], start["units"]), (0, 0))
        self.assertEqual(done["totalSeconds"], 0.0)
        self.assertFalse(os.path.exists(self.marker), "no model call for non-speakable text")

    def test_streamed_units_report_the_engine_and_language(self) -> None:
        daemon = self.start()
        start, done, sentence_ends = self.speak(daemon, "这是一句用来检查引擎与语言上报的句子。")
        self.assertEqual(start["engine"], "voxcpm")
        self.assertEqual(done["engine"], "voxcpm")
        self.assertEqual(done["sampleRate"], 44100)
        self.assertEqual([event["language"] for event in sentence_ends], ["Auto"])
        self.assertTrue(all(event["chunks"] >= 1 for event in sentence_ends))
        self.assertTrue(all(event["chars"] == len(event["text"]) for event in sentence_ends))
        self.assertTrue(all(event["maxLen"] > 0 for event in sentence_ends))


if __name__ == "__main__":
    unittest.main()
