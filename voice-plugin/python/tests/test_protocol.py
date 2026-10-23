"""Wire-protocol tests: real daemon subprocess, stdin/stdout JSON Lines (no torch)."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
DAEMON = os.path.join(PYTHON_DIR, "tts_daemon.py")
sys.path.insert(0, PYTHON_DIR)


def write_wav(path: str, seconds: float = 0.2, rate: int = 48000) -> None:
    frames = int(seconds * rate)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)


class DaemonHarness:
    """Spawns the daemon and exposes its JSONL stream as a queue."""

    def __init__(self, voices_dir: str, extra_args=()) -> None:
        env = dict(os.environ)
        env["HF_HUB_OFFLINE"] = "1"
        env["TRANSFORMERS_OFFLINE"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        self.stderr_lines = []
        self.events = []
        self.queue: "queue.Queue[dict]" = queue.Queue()
        self.proc = subprocess.Popen(
            [
                sys.executable,
                DAEMON,
                "--voices-dir",
                voices_dir,
                "--default-emotion",
                "默认",
                "--model-dir",
                os.path.join(voices_dir, "no-such-model-dir"),
                # Tests must not build a CUDA context: the engine only touches the
                # device when the value names one (PROTOCOL.md §3).
                "--device",
                "auto",
                "--cache-dir",
                os.path.join(voices_dir, "cache"),
                "--idle-unload-sec",
                "0",
                "--max-sentence-chars",
                "60",
            ]
            + list(extra_args),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        self._threads = [
            threading.Thread(target=self._pump_stdout, daemon=True),
            threading.Thread(target=self._pump_stderr, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:  # noqa: BLE001 - surfaced as a loud test failure
                event = {"__unparsable__": line}
            self.events.append(event)
            self.queue.put(event)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr_lines.append(raw.decode("utf-8", "replace").rstrip())

    def send(self, payload) -> None:
        assert self.proc.stdin is not None
        line = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        self.proc.stdin.write((line + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def next_event(self, timeout: float = 20.0) -> dict:
        try:
            event = self.queue.get(timeout=timeout)
        except queue.Empty:
            self.diagnose()
            raise AssertionError(f"no event within {timeout}s; stderr tail: {self.stderr_tail()}")
        if "__unparsable__" in event:
            self.diagnose()
            raise AssertionError(f"stdout carried a non-JSON line: {event['__unparsable__']!r}")
        return event

    def expect(self, name: str, timeout: float = 20.0, **fields) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.diagnose()
                raise AssertionError(f"no {name!r} event matching {fields}; stderr tail: {self.stderr_tail()}")
            event = self.next_event(timeout=remaining)
            if event.get("event") != name:
                continue
            if all(event.get(key) == value for key, value in fields.items()):
                return event

    def stderr_tail(self, count: int = 12) -> str:
        return "\n".join(self.stderr_lines[-count:])

    def diagnose(self) -> None:
        self.stdout_dump = list(self.events)
        sys.stderr.write(f"\n--- daemon stderr ---\n{self.stderr_tail(30)}\n--- daemon events ---\n")
        for event in self.events:
            sys.stderr.write(json.dumps(event, ensure_ascii=False)[:400] + "\n")
        sys.stderr.flush()

    def stop(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:  # noqa: BLE001 - teardown
                pass
        try:
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001 - teardown
            pass


class ProtocolTestCase(unittest.TestCase):
    """Shared fixtures: a temp folder holding the one reference voice (clip + transcript)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        write_wav(os.path.join(self.dir, "默认.wav"))
        with open(os.path.join(self.dir, "默认.txt"), "w", encoding="utf-8") as handle:
            handle.write("你好呀")
        self.harnesses = []

    def tearDown(self) -> None:
        for harness in self.harnesses:
            harness.stop()
        self.tmp.cleanup()

    def start(self, voices_dir: str = "", extra_args=()) -> DaemonHarness:
        harness = DaemonHarness(voices_dir or self.dir, extra_args=extra_args)
        self.harnesses.append(harness)
        return harness

    def ready(self, harness: DaemonHarness) -> dict:
        event = harness.expect("ready")
        self.assertIsNone(event["id"])
        return event


class ReadyTests(ProtocolTestCase):
    def test_ready_reports_the_single_reference_voice(self) -> None:
        harness = self.start()
        event = self.ready(harness)
        self.assertTrue(event["ok"])
        self.assertEqual(event["defaultEmotion"], "默认")
        self.assertEqual(event["defaultEmotionSource"], "voice")
        self.assertEqual(event["startupError"], "")
        self.assertFalse(event["modelLoaded"])
        self.assertEqual(event["device"], "auto", "the harness asks the engine to pick a device")
        self.assertIsInstance(event["pid"], int)
        self.assertFalse(event["asrAvailable"], "the engine needs no transcription backend")
        self.assertEqual(event["emotionNames"], ["默认"])
        self.assertEqual(len(event["emotions"]), 1)
        entry = event["emotions"][0]
        self.assertEqual(entry["name"], "默认")
        self.assertEqual(entry["via"], "text", "the same-stem transcript was read")
        self.assertTrue(entry["refText"])
        self.assertAlmostEqual(entry["durationSec"], 0.2, places=2)
        self.assertEqual(entry["sampleRate"], 48000)

    def test_ready_without_a_reference_voice_fails_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as empty:
            harness = self.start(voices_dir=empty)
            ready = self.ready(harness)
            self.assertFalse(ready["ok"])
            self.assertEqual(ready["emotions"], [])
            self.assertEqual(ready["emotionNames"], [])
            self.assertEqual(ready["defaultEmotion"], "")
            self.assertIn("exactly one reference voice", ready["startupError"])
            errors = [event for event in harness.events if event.get("event") == "error"]
            self.assertEqual(len(errors), 1, "the failure must be an explicit error event")
            self.assertEqual(errors[0]["code"], "NO_VOICES")
            self.assertIn("no reference voice", errors[0]["message"])
            # The daemon keeps serving and repeats the reason on every speak.
            harness.send({"id": "9", "op": "ping"})
            self.assertTrue(harness.expect("pong", id="9")["ok"])
            harness.send({"id": "10", "op": "speak", "segments": [{"content": "你好。"}], "play": False})
            error = harness.expect("error", id="10")
            self.assertEqual(error["code"], "NO_VOICES")
            self.assertIn("no reference voice", error["message"])


class OpsTests(ProtocolTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.harness = self.start()
        self.ready_event = self.ready(self.harness)

    def test_ping_pong_echoes_id(self) -> None:
        self.harness.send({"id": "1", "op": "ping"})
        event = self.harness.expect("pong", id="1")
        self.assertTrue(event["ok"])
        self.assertEqual(event["pid"], self.ready_event["pid"])

    def test_voices_event_returns_the_one_voice(self) -> None:
        self.harness.send({"id": "2", "op": "voices"})
        event = self.harness.expect("voices", id="2")
        self.assertTrue(event["ok"])
        self.assertEqual(event["defaultEmotion"], "默认")
        self.assertEqual(event["emotionNames"], ["默认"])
        self.assertEqual([item["name"] for item in event["emotions"]], ["默认"])

    def test_reload_answers_with_voices_payload(self) -> None:
        self.harness.send({"id": "3", "op": "reload"})
        event = self.harness.expect("voices", id="3")
        self.assertTrue(event["ok"])
        self.assertEqual(event["defaultEmotion"], "默认")
        self.assertEqual(len(event["emotions"]), 1)

    def test_stats_before_any_speak(self) -> None:
        self.harness.send({"id": "4", "op": "stats"})
        event = self.harness.expect("stats", id="4")
        for key in (
            "ok",
            "pid",
            "modelLoaded",
            "modelLoadMs",
            "calls",
            "device",
            "engine",
            "streaming",
            "sampleRate",
            "optimize",
            "allocatedMb",
            "reservedMb",
            "peakMb",
            "freeMb",
        ):
            self.assertIn(key, event)
        self.assertFalse(event["modelLoaded"])
        self.assertEqual(event["modelLoadMs"], 0)
        self.assertEqual(event["calls"], 0)
        self.assertEqual(event["engine"], "voxcpm")
        self.assertEqual(event["sampleRate"], 0)
        self.assertNotIn("voicesCached", event)
        self.assertNotIn("promptsCached", event)

    def test_unload_without_model(self) -> None:
        self.harness.send({"id": "5", "op": "unload"})
        event = self.harness.expect("unloaded", id="5")
        self.assertTrue(event["ok"])
        self.assertEqual(event["freedMb"], 0.0)
        self.assertEqual(event["reason"], "explicit")

    def test_unknown_op_is_bad_request_and_daemon_survives(self) -> None:
        self.harness.send({"id": "6", "op": "explode"})
        event = self.harness.expect("error", id="6")
        self.assertFalse(event["ok"])
        self.assertEqual(event["code"], "BAD_REQUEST")
        self.assertIn("explode", event["message"])
        self.harness.send({"id": "7", "op": "ping"})
        self.assertTrue(self.harness.expect("pong", id="7")["ok"])

    def test_malformed_json_is_bad_json_and_daemon_survives(self) -> None:
        self.harness.send("{this is not json")
        event = self.harness.expect("error")
        self.assertIsNone(event["id"])
        self.assertEqual(event["code"], "BAD_JSON")
        self.harness.send({"id": "8", "op": "ping"})
        self.assertTrue(self.harness.expect("pong", id="8")["ok"])

    def test_non_object_request_is_rejected(self) -> None:
        self.harness.send("[1,2,3]")
        event = self.harness.expect("error")
        self.assertEqual(event["code"], "BAD_REQUEST")
        self.harness.send({"id": "9", "op": "ping"})
        self.assertTrue(self.harness.expect("pong", id="9")["ok"])


class SpeakValidationTests(ProtocolTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.harness = self.start()
        self.ready(self.harness)

    def test_missing_segments_is_bad_request(self) -> None:
        self.harness.send({"id": "1", "op": "speak", "play": False})
        event = self.harness.expect("error", id="1")
        self.assertEqual(event["code"], "BAD_REQUEST")

    def test_empty_segments_is_bad_request(self) -> None:
        self.harness.send({"id": "2", "op": "speak", "segments": [], "play": False})
        event = self.harness.expect("error", id="2")
        self.assertEqual(event["code"], "BAD_REQUEST")

    def test_segment_without_content_is_bad_request(self) -> None:
        self.harness.send(
            {"id": "3", "op": "speak", "segments": [{"emotion": "默认"}], "play": False}
        )
        event = self.harness.expect("error", id="3")
        self.assertEqual(event["code"], "BAD_REQUEST")
        self.assertIn("content", event["message"])

    def test_empty_content_needs_no_model_and_reports_zero_seconds(self) -> None:
        # --model-dir points at a missing directory: any model load would fail.
        self.harness.send(
            {
                "id": "4",
                "op": "speak",
                "segments": [
                    {"emotion": "愤怒", "content": "   "},
                    {"emotion": "默认", "content": "```\n```"},
                ],
                "play": False,
            }
        )
        start = self.harness.expect("speak_start", id="4")
        self.assertEqual(start["sentences"], 0)
        self.assertEqual(start["modelLoadMs"], 0)
        done = self.harness.expect("speak_done", id="4")
        self.assertTrue(done["ok"])
        self.assertEqual(done["totalSeconds"], 0.0)
        self.assertEqual([segment["seconds"] for segment in done["segments"]], [0, 0])
        self.assertEqual([segment["sentences"] for segment in done["segments"]], [0, 0])
        self.assertTrue(any("no speakable text" in note for note in done["notes"]))

    def test_missing_model_reports_model_load_failed_and_daemon_survives(self) -> None:
        # The reference voice is complete, so the planner reaches the missing model dir.
        with tempfile.TemporaryDirectory() as voices:
            write_wav(os.path.join(voices, "默认.wav"))
            with open(os.path.join(voices, "默认.txt"), "w", encoding="utf-8") as handle:
                handle.write("你好呀")
            harness = self.start(voices_dir=voices)
            self.ready(harness)
            harness.send(
                {"id": "6", "op": "speak", "segments": [{"content": "你好。"}], "play": False}
            )
            event = harness.expect("error", id="6", timeout=90)
            self.assertEqual(event["code"], "MODEL_LOAD_FAILED")
            harness.send({"id": "7", "op": "ping"})
            self.assertTrue(harness.expect("pong", id="7")["ok"])


class LifecycleTests(ProtocolTestCase):
    def test_shutdown_event_then_exit_zero(self) -> None:
        harness = self.start()
        self.ready(harness)
        harness.send({"id": "1", "op": "shutdown"})
        event = harness.expect("shutdown", id="1")
        self.assertTrue(event["ok"])
        self.assertEqual(harness.proc.wait(timeout=15), 0)

    def test_stdin_eof_exits_silently_with_zero(self) -> None:
        harness = self.start()
        self.ready(harness)
        assert harness.proc.stdin is not None
        harness.proc.stdin.close()
        self.assertEqual(harness.proc.wait(timeout=15), 0)
        self.assertNotIn("shutdown", [event.get("event") for event in harness.events])


class ParserDefaultTests(unittest.TestCase):
    """The frozen rev-9 defaults, asserted without starting a daemon (and so without CUDA)."""

    def setUp(self) -> None:
        import tts_daemon

        self.args = tts_daemon.build_parser().parse_args(["--voices-dir", "unused"])

    def test_engine_and_guard_defaults(self) -> None:
        self.assertEqual(self.args.device, "cuda:0")
        self.assertEqual(self.args.cfg_value, 2.7)
        self.assertEqual(self.args.timesteps, 10)
        self.assertFalse(self.args.optimize)
        self.assertFalse(self.args.normalize)
        self.assertTrue(self.args.stream)
        self.assertEqual(self.args.idle_unload_sec, 1800)
        self.assertEqual(self.args.max_sentence_chars, 60)
        self.assertEqual(self.args.first_sentence_max_chars, 20)
        self.assertEqual(self.args.max_frames_per_char, 3.2)

    def test_full_argv_of_the_built_plugin_is_accepted(self) -> None:
        """The built Node plugin passes every flag below on each spawn; the daemon must parse it."""
        import tts_daemon

        argv = [
            "--voices-dir", "unused",
            "--default-emotion", "默认",
            "--model-dir", "unused-model",
            "--device", "cuda:0",
            "--cfg-value", "2.7",
            "--timesteps", "10",
            "--optimize", "false",
            "--normalize", "false",
            "--cache-dir", "unused-cache",
            "--save-dir", "",
            "--max-sentence-chars", "60",
            "--first-sentence-max-chars", "20",
            "--merge-sentences", "short",
            "--merge-max-chars", "0",
            "--short-sentence-chars", "20",
            "--seed", "0",
            "--idle-unload-sec", "1800",
            "--preload", "false",
            "--output-device", "",
        ]
        args = tts_daemon.build_parser().parse_args(argv)
        self.assertEqual(args.voices_dir, "unused")


if __name__ == "__main__":
    unittest.main()
