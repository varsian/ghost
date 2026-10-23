"""Full model path over the wire with a faked ``voxcpm`` (no GPU, no playback).

Proves, without CUDA:

* stdout stays pure JSONL although the model package prints a banner at import time;
* the lazy load happens once and is never repeated (fake-side counter);
* emotion labels pass through the segment events unchanged;
* sentences are generated one by one with per-unit timing;
* ``speak_done`` carries totals, per-segment seconds/notes and the saved WAV paths;
* ``unload`` runs the VRAM cleanup path and reports why it happened;
* the idle timer releases the model on its own and the next call reloads it.

The real-GPU equivalent is ``tests/e2e_speak.py``.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, PYTHON_DIR)

from voxcpm_daemon import FakeVoxDaemon, make_voice  # noqa: E402


class ModelPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认", transcript="这是参考文本")
        self.marker = os.path.join(self.dir, "fake-calls.json")
        self.save_dir = os.path.join(self.dir, "wav")
        self.daemon = FakeVoxDaemon(self.dir, self.marker, extra_args=("--idle-unload-sec", "0"))
        self.addCleanup(self.daemon.stop)
        self.ready = self.daemon.ready()

    def test_speak_pipeline_model_reuse_and_save(self) -> None:
        daemon = self.daemon
        self.assertEqual(self.ready["defaultEmotion"], "默认")
        self.assertTrue(self.ready["emotions"])
        self.assertEqual(self.ready["engine"], "voxcpm")

        daemon.send(
            {
                "id": "1",
                "op": "speak",
                "segments": [
                    {"emotion": "默认", "content": "第一句。第二句！"},
                    {"emotion": "开心", "content": "第三句，用一个表情标签。"},
                ],
                "play": False,
                "save": True,
                "saveDir": self.save_dir,
                "gapMs": 50,
            }
        )
        start = daemon.expect("speak_start", id="1")
        self.assertGreater(start["modelLoadMs"], 0, "cold load must be reported")
        self.assertFalse(start["modelWasLoaded"])
        self.assertGreaterEqual(start["sentences"], 3)
        self.assertEqual(start["warmupMs"], 0, "VoxCPM warms up inside its constructor")
        self.assertEqual(start["engine"], "voxcpm")
        self.assertTrue(start["streaming"])

        sentence_events = []
        while True:
            event = daemon.expect("sentence_end", id="1")
            sentence_events.append(event)
            if event["index"] == 1:
                break
        self.assertTrue(all(event["genMs"] >= 0 and event["audioSec"] > 0 for event in sentence_events))
        self.assertTrue(all("firstAudioMs" in event for event in sentence_events))

        done = daemon.expect("speak_done", id="1")
        self.assertTrue(done["ok"])
        self.assertGreater(done["totalSeconds"], 0)
        self.assertEqual(done["sampleRate"], 44100)
        self.assertEqual(len(done["segments"]), 2)
        self.assertTrue(all(segment["seconds"] > 0 for segment in done["segments"]))
        self.assertFalse(done["segments"][1]["fallback"])
        self.assertEqual(done["segments"][1]["requestedEmotion"], "开心")
        self.assertEqual(done["segments"][1]["usedEmotion"], "开心")
        self.assertEqual(len(done["files"]), 2)
        for path in done["files"]:
            self.assertTrue(os.path.isfile(path), path)
            self.assertGreater(os.path.getsize(path), 44)

        daemon.send({"id": "2", "op": "stats"})
        stats = daemon.expect("stats", id="2")
        self.assertTrue(stats["modelLoaded"])
        self.assertEqual(stats["calls"], 1)
        self.assertEqual(stats["engine"], "voxcpm")
        self.assertEqual(stats["sampleRate"], 44100)
        self.assertFalse(stats["optimize"])
        for key in ("allocatedMb", "reservedMb", "peakMb", "freeMb", "generations"):
            self.assertIn(key, stats)
        self.assertNotIn("voicesCached", stats)
        self.assertNotIn("promptsCached", stats)

        daemon.send({"id": "3", "op": "speak", "segments": [{"content": "复用的第二段。"}], "play": False})
        start2 = daemon.expect("speak_start", id="3")
        self.assertTrue(start2["modelWasLoaded"])
        self.assertEqual(start2["modelLoadMs"], 0)
        self.assertEqual(start2["warmupMs"], 0, "warmup must not repeat")
        self.assertTrue(daemon.expect("speak_done", id="3")["ok"])
        daemon.send({"id": "4", "op": "stats"})
        self.assertEqual(daemon.expect("stats", id="4")["calls"], 2)

        self.assertEqual(daemon.marker().get("init"), 1, "the model must load exactly once")

        daemon.send({"id": "5", "op": "unload"})
        unloaded = daemon.expect("unloaded", id="5")
        self.assertTrue(unloaded["ok"])
        self.assertEqual(unloaded["reason"], "explicit")
        self.assertIn("freedMb", unloaded)
        daemon.send({"id": "6", "op": "stats"})
        self.assertFalse(daemon.expect("stats", id="6")["modelLoaded"])

        daemon.send({"id": "7", "op": "shutdown"})
        daemon.expect("shutdown", id="7")
        self.assertEqual(daemon.proc.wait(timeout=20), 0)

    def test_stdout_is_pure_jsonl_despite_library_prints(self) -> None:
        daemon = self.daemon
        daemon.send({"id": "1", "op": "speak", "segments": [{"content": "检查输出纯净度。"}], "play": False})
        daemon.expect("speak_done", id="1")
        daemon.send({"id": "2", "op": "shutdown"})
        daemon.expect("shutdown", id="2")
        daemon.proc.wait(timeout=20)

        unparsable = [event for event in daemon.events if "__unparsable__" in event]
        self.assertEqual(unparsable, [], f"stdout carried non-JSON output: {unparsable[:1]}")
        self.assertEqual(json.loads(daemon.stdout_lines[0])["event"], "ready")
        for line in daemon.stdout_lines:
            json.loads(line)

        stderr = "\n".join(daemon.stderr_lines)
        self.assertIn("FAKE-VOXCPM-BANNER", stderr, "the import-time banner must reach stderr")

    def test_idle_unload_releases_the_model_and_reports_itself(self) -> None:
        marker = os.path.join(self.dir, "idle-calls.json")
        daemon = FakeVoxDaemon(self.dir, marker, extra_args=("--idle-unload-sec", "1"))
        self.addCleanup(daemon.stop)
        daemon.ready()

        daemon.send({"id": "1", "op": "speak", "segments": [{"content": "空闲卸载测试。"}], "play": False})
        daemon.expect("speak_done", id="1")
        daemon.send({"id": "2", "op": "stats"})
        self.assertTrue(daemon.expect("stats", id="2")["modelLoaded"])

        idle = daemon.expect("unloaded", timeout=10)
        self.assertEqual(idle["reason"], "idle")
        self.assertIsNone(idle["id"], "an idle unload answers no request")
        # The stderr pump is a separate thread, so give it a moment to deliver the log.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not any("idle unload" in line for line in daemon.stderr_lines):
            time.sleep(0.05)
        self.assertTrue(any("idle unload" in line for line in daemon.stderr_lines), "idle unload must be logged")

        daemon.send({"id": "3", "op": "stats"})
        self.assertFalse(daemon.expect("stats", id="3")["modelLoaded"], "idle unload must release the model")

        daemon.send({"id": "4", "op": "speak", "segments": [{"content": "重新加载。"}], "play": False})
        start = daemon.expect("speak_start", id="4")
        self.assertFalse(start["modelWasLoaded"])
        self.assertGreater(start["modelLoadMs"], 0, "the reload must be reported truthfully")
        daemon.expect("speak_done", id="4")
        self.assertEqual(daemon.marker().get("init"), 2)

    def test_merge_modes_change_the_generation_unit_count(self) -> None:
        # Default (short): three 4-char sentences become ONE generation unit, so the
        # model keeps one acoustic context instead of sampling a fresh voice per sentence.
        self.daemon.send(
            {"id": "1", "op": "speak", "segments": [{"content": "第一句。第二句！第三句？"}], "play": False}
        )
        merged = self.daemon.expect("speak_start", id="1")
        self.assertEqual(merged["sentences"], 3)
        self.assertEqual(merged["units"], 1)
        self.daemon.expect("speak_done", id="1")

        # `off` restores the pre-merge behavior: one unit per sentence.
        marker = os.path.join(self.dir, "no-merge-calls.json")
        plain = FakeVoxDaemon(
            self.dir, marker, extra_args=("--idle-unload-sec", "0", "--merge-sentences", "off")
        )
        self.addCleanup(plain.stop)
        plain.ready()
        plain.send({"id": "1", "op": "speak", "segments": [{"content": "第一句。第二句！第三句？"}], "play": False})
        unmerged = plain.expect("speak_start", id="1")
        self.assertEqual(unmerged["sentences"], 3)
        self.assertEqual(unmerged["units"], 3)
        plain.expect("speak_done", id="1")


if __name__ == "__main__":
    unittest.main()
