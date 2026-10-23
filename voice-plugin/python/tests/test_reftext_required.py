"""The reference transcript is required.

VoxCPM clones by continuing the reference clip, so the clip and its exact transcript
are both required: the transcript is the same-stem ``.txt`` file beside the audio.
A missing, empty, undecodable or over-long transcript fails the call at speak time,
naming the file to write, instead of cloning with a half-given prompt.
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

from voxcpm_daemon import FakeVoxDaemon, make_voice, write_wav  # noqa: E402


class ReferenceTextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.marker = os.path.join(self.dir, "marker.json")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def boot(self, extra_args=()) -> FakeVoxDaemon:
        daemon = FakeVoxDaemon(
            self.dir,
            self.marker,
            extra_args=("--idle-unload-sec", "0") + tuple(extra_args),
        )
        self.addCleanup(daemon.stop)
        daemon.ready_event = daemon.ready()
        return daemon

    def test_transcript_is_used_as_the_prompt_text(self) -> None:
        make_voice(self.dir, "默认", transcript="这是参考文本")
        daemon = self.boot()
        daemon.speak([{"emotion": "默认", "content": "你好。"}])
        done = daemon.expect("speak_done")
        self.assertTrue(done["ok"])
        self.assertEqual(daemon.marker().get("generate_streaming.prompt_text"), "这是参考文本")

    def test_missing_transcript_fails_naming_the_path(self) -> None:
        write_wav(os.path.join(self.dir, "默认.wav"))
        daemon = self.boot()
        daemon.speak([{"emotion": "默认", "content": "你好。"}])
        error = daemon.expect("error")
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn(os.path.join(self.dir, "默认.txt"), error["message"])
        self.assertIn("no transcript", error["message"])
        self.assertNotIn("init", daemon.marker(), "the refusal happens before any load")

    def test_empty_transcript_counts_as_missing(self) -> None:
        make_voice(self.dir, "默认", transcript="   ")
        daemon = self.boot()
        daemon.speak([{"emotion": "默认", "content": "你好。"}])
        error = daemon.expect("error")
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn("默认.txt", error["message"])
        self.assertNotIn("init", daemon.marker())

    def test_ready_reports_the_voice_without_transcript(self) -> None:
        write_wav(os.path.join(self.dir, "默认.wav"))
        daemon = self.boot()
        ready = daemon.ready_event
        self.assertTrue(ready["ok"], "one audio file is a valid reference voice")
        self.assertFalse(ready["emotions"][0]["refText"], "the missing transcript is reported")
        self.assertEqual(ready["emotions"][0]["via"], "none")


if __name__ == "__main__":
    unittest.main()
