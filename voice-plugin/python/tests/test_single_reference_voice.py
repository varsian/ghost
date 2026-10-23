"""The single-reference-voice contract (PROTOCOL.md §5).

The engine clones exactly one reference voice: ``--voices-dir`` holds one audio file
plus its same-stem transcript. These tests pin that contract:

* exactly one audio file is required — 0 and more than 1 fail cleanly, naming the
  folder and what to keep;
* the same-stem ``.txt`` is the transcript; missing, empty or over-long transcripts
  are refused at speak time, naming the file to write, before any model load;
* emotion values are labels echoed on the protocol events (``requestedEmotion`` ==
  ``usedEmotion``, ``fallback:false``); they never select a different recording;
* ``ready`` keeps the plugin-facing shape: ``defaultEmotion``/``emotionNames`` ==
  ``默认`` and ``asrAvailable`` false;
* the flags the built Node plugin always passes are accepted and have no effect.
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

from ttslib.voices import DEFAULT_EMOTION, VoiceLibrary  # noqa: E402
from voxcpm_daemon import FakeVoxDaemon, make_voice, write_text, write_wav  # noqa: E402


class VoiceLibraryTests(unittest.TestCase):
    """The folder rules, without a daemon process."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.logs: list[str] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def library(self) -> VoiceLibrary:
        return VoiceLibrary(self.dir, default_emotion="默认", log=self.logs.append)

    def test_one_audio_file_plus_transcript_is_the_reference_voice(self) -> None:
        make_voice(self.dir, "voice", transcript="这是参考文本")
        lib = self.library()
        self.assertTrue(lib.scan(force=True))
        self.assertEqual(lib.error, "")
        self.assertEqual(lib.effective_default, DEFAULT_EMOTION)
        self.assertEqual(lib.default_source, "voice")
        self.assertEqual(lib.names(), [DEFAULT_EMOTION])
        voice = lib.voice
        assert voice is not None
        self.assertEqual(voice.name, DEFAULT_EMOTION)
        self.assertEqual(voice.path, os.path.join(self.dir, "voice.wav"))
        self.assertEqual(voice.ref_text, "这是参考文本")
        self.assertEqual(voice.ref_text_path, os.path.join(self.dir, "voice.txt"))
        self.assertEqual(voice.via, "text")
        self.assertAlmostEqual(voice.duration_sec or 0.0, 0.2, places=2)
        self.assertEqual(voice.sample_rate, 44100)
        event = lib.emotions_event()[0]
        self.assertEqual(event["name"], DEFAULT_EMOTION)
        self.assertTrue(event["refText"])
        self.assertEqual(event["via"], "text")
        self.assertIn("file", event)
        self.assertIn("durationSec", event)
        self.assertIn("sampleRate", event)

    def test_folder_without_audio_file_fails_cleanly(self) -> None:
        write_text(os.path.join(self.dir, "notes.md"), "not a voice")
        write_text(os.path.join(self.dir, "voice.txt"), "a transcript without its clip")
        lib = self.library()
        self.assertTrue(lib.scan(force=True))
        self.assertIn("no reference voice", lib.error)
        self.assertIn("exactly one audio file", lib.error)
        self.assertIsNone(lib.voice)
        self.assertEqual(lib.names(), [])
        self.assertEqual(lib.emotions_event(), [])
        self.assertIsNone(lib.effective_default)
        self.assertEqual(lib.default_source, "none")

    def test_more_than_one_audio_file_fails_cleanly(self) -> None:
        make_voice(self.dir, "one", transcript="一")
        make_voice(self.dir, "two", transcript="二")
        lib = self.library()
        self.assertTrue(lib.scan(force=True))
        self.assertIn("exactly one reference voice is required", lib.error)
        self.assertIn("2 audio files", lib.error)
        self.assertIn("one.wav", lib.error)
        self.assertIn("two.wav", lib.error)
        self.assertIsNone(lib.voice)

    def test_missing_folder_fails_cleanly(self) -> None:
        lib = VoiceLibrary(os.path.join(self.dir, "no-such-folder"), log=self.logs.append)
        lib.scan(force=True)
        self.assertIn("does not exist", lib.error)
        self.assertIsNone(lib.voice)

    def test_missing_transcript_leaves_the_voice_without_reference_text(self) -> None:
        write_wav(os.path.join(self.dir, "voice.wav"))
        lib = self.library()
        lib.scan(force=True)
        self.assertEqual(lib.error, "", "one audio file is a valid reference voice")
        voice = lib.voice
        assert voice is not None
        self.assertIsNone(voice.ref_text)
        self.assertEqual(voice.via, "none")
        self.assertEqual(voice.ref_text_path, os.path.join(self.dir, "voice.txt"))

    def test_empty_undecodable_and_over_long_transcripts_are_ignored(self) -> None:
        audio = make_voice(self.dir, "voice", transcript="这是参考文本")
        lib = self.library()
        for raw in (b"   \n\t ", b"\xff\xff\xff", "x".encode("utf-8") * 2001):
            with open(os.path.join(self.dir, "voice.txt"), "wb") as handle:
                handle.write(raw)
            lib.scan(force=True)
            voice = lib.voice
            assert voice is not None
            self.assertIsNone(voice.ref_text, raw[:8])
            self.assertEqual(voice.via, "none")
            self.assertTrue(voice.ref_text_path and voice.ref_text_path.endswith("voice.txt"))
        # Restoring a real transcript brings the reference text back on the next scan.
        write_text(os.path.join(self.dir, "voice.txt"), "你好呀")
        self.assertTrue(lib.scan())
        self.assertEqual(lib.voice.ref_text, "你好呀")
        self.assertTrue(os.path.isfile(audio))

    def test_transcript_encodings_bom_and_case_insensitive_name(self) -> None:
        write_wav(os.path.join(self.dir, "Voice.wav"))
        with open(os.path.join(self.dir, "Voice.TXT"), "wb") as handle:
            handle.write("侧车文本".encode("utf-16"))
        lib = self.library()
        lib.scan(force=True)
        self.assertEqual(lib.error, "")
        self.assertEqual(lib.voice.ref_text, "侧车文本")
        with open(os.path.join(self.dir, "Voice.TXT"), "wb") as handle:
            handle.write(b"\xef\xbb\xbf" + "带 BOM 的文本".encode("utf-8"))
        lib.scan(force=True)
        self.assertEqual(lib.voice.ref_text, "带 BOM 的文本")

    def test_labels_never_change_the_reference_voice(self) -> None:
        make_voice(self.dir, "voice", transcript="这是参考文本")
        lib = self.library()
        voice = lib.voice
        assert voice is not None
        for requested, expected in (
            ("", "默认"),
            (None, "默认"),
            ("   ", "默认"),
            ("开心", "开心"),
            (" 愤怒 ", "愤怒"),
            ("任意标签", "任意标签"),
        ):
            resolution = lib.resolve(requested)
            self.assertFalse(resolution.fallback)
            self.assertEqual(resolution.requested, expected)
            self.assertIs(resolution.voice, voice, "every label resolves to the one voice")

    def test_rescan_picks_up_transcript_edits_and_a_second_audio_file(self) -> None:
        make_voice(self.dir, "voice", transcript="第一版文本")
        lib = self.library()
        lib.scan(force=True)
        self.assertEqual(lib.voice.ref_text, "第一版文本")
        self.assertFalse(lib.scan(), "nothing changed")

        write_text(os.path.join(self.dir, "voice.txt"), "第二版更长的文本")
        self.assertTrue(lib.scan())
        self.assertEqual(lib.voice.ref_text, "第二版更长的文本")

        write_wav(os.path.join(self.dir, "extra.wav"))
        self.assertTrue(lib.scan())
        self.assertIn("exactly one reference voice is required", lib.error)

        os.remove(os.path.join(self.dir, "extra.wav"))
        self.assertTrue(lib.scan())
        self.assertEqual(lib.error, "")
        self.assertEqual(lib.voice.ref_text, "第二版更长的文本")

    def test_non_wav_reference_audio_is_accepted(self) -> None:
        path = os.path.join(self.dir, "voice.flac")
        with open(path, "wb") as handle:
            handle.write(b"not really a flac file")
        write_text(os.path.join(self.dir, "voice.txt"), "这是参考文本")
        lib = self.library()
        lib.scan(force=True)
        self.assertEqual(lib.error, "")
        self.assertEqual(lib.voice.path, path)


class DaemonContractTests(unittest.TestCase):
    """The same contract over the real daemon's stdin/stdout protocol."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.marker = os.path.join(self.dir, "probe.json")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def boot(self, extra_args=()) -> FakeVoxDaemon:
        daemon = FakeVoxDaemon(self.dir, self.marker, extra_args=extra_args)
        self.addCleanup(daemon.stop)
        return daemon

    def test_ready_and_voices_report_the_one_reference_voice(self) -> None:
        make_voice(self.dir, "voice", transcript="这是参考文本")
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        ready = daemon.ready()
        self.assertTrue(ready["ok"])
        self.assertEqual(ready["startupError"], "")
        self.assertEqual(ready["voicesDir"], self.dir)
        self.assertEqual(ready["defaultEmotion"], "默认")
        self.assertEqual(ready["emotionNames"], ["默认"])
        self.assertEqual([item["name"] for item in ready["emotions"]], ["默认"])
        self.assertTrue(ready["emotions"][0]["refText"])
        self.assertFalse(ready["asrAvailable"])

        daemon.send({"id": "1", "op": "voices"})
        event = daemon.expect("voices", id="1")
        self.assertTrue(event["ok"])
        self.assertEqual(event["emotionNames"], ["默认"])
        self.assertEqual(len(event["emotions"]), 1)

    def test_emotion_labels_are_echoed_and_never_pick_another_voice(self) -> None:
        make_voice(self.dir, "voice", transcript="这是参考文本")
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        daemon.ready()
        daemon.speak(
            [
                {"emotion": "开心", "content": "第一句。"},
                {"emotion": "愤怒", "content": "第二句。"},
                {"content": "第三句没有情绪。"},
            ]
        )
        daemon.expect("speak_start", id="1")
        done = daemon.expect("speak_done", id="1")
        self.assertTrue(done["ok"])
        expected = [("开心", "开心"), ("愤怒", "愤怒"), ("默认", "默认")]
        got = [(segment["requestedEmotion"], segment["usedEmotion"]) for segment in done["segments"]]
        self.assertEqual(got, expected)
        self.assertTrue(all(segment["fallback"] is False for segment in done["segments"]))
        self.assertEqual(
            [event["usedEmotion"] for event in daemon.of("sentence_end")],
            ["开心", "愤怒", "默认"],
        )
        self.assertEqual(
            [event["usedEmotion"] for event in daemon.of("segment_start")],
            ["开心", "愤怒", "默认"],
        )
        self.assertEqual(daemon.marker().get("init"), 1, "one model, one reference voice")
        self.assertEqual(daemon.marker().get("generate_streaming.prompt_text"), "这是参考文本")

    def test_missing_transcript_fails_at_speak_time_naming_the_file(self) -> None:
        write_wav(os.path.join(self.dir, "voice.wav"))
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        self.assertTrue(daemon.ready()["ok"], "one audio file is a valid reference voice")
        daemon.speak([{"emotion": "开心", "content": "你好。"}])
        error = daemon.expect("error")
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn(os.path.join(self.dir, "voice.txt"), error["message"])
        self.assertIn("no transcript", error["message"])
        self.assertNotIn("init", daemon.marker(), "no model load without a reference transcript")

    def test_zero_audio_files_fail_at_startup_with_a_clear_message(self) -> None:
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        ready = daemon.ready()
        self.assertFalse(ready["ok"])
        self.assertEqual(ready["emotions"], [])
        self.assertIn("no reference voice", ready["startupError"])
        errors = daemon.of("error")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], "NO_VOICES")
        self.assertIn("no reference voice", errors[0]["message"])
        # A speak is answered with the same clear reason, not a model-load attempt.
        daemon.speak([{"emotion": "默认", "content": "你好。"}])
        error = daemon.expect("error")
        self.assertEqual(error["code"], "NO_VOICES")
        self.assertIn("no reference voice", error["message"])
        self.assertNotIn("init", daemon.marker())

    def test_two_audio_files_fail_and_the_fix_is_picked_up_on_reload(self) -> None:
        make_voice(self.dir, "one", transcript="一")
        make_voice(self.dir, "two", transcript="二")
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        ready = daemon.ready()
        self.assertFalse(ready["ok"])
        self.assertIn("exactly one reference voice is required", ready["startupError"])
        self.assertIn("2 audio files", ready["startupError"])
        self.assertTrue(any("exactly one reference voice" in event.get("message", "") for event in daemon.of("error")))

        # Fixing the folder is picked up by the next reload without restarting the daemon.
        os.remove(os.path.join(self.dir, "two.wav"))
        os.remove(os.path.join(self.dir, "two.txt"))
        daemon.send({"id": "1", "op": "voices"})
        event = daemon.expect("voices", id="1")
        self.assertTrue(event["ok"])
        self.assertEqual(event["emotionNames"], ["默认"])
        self.assertEqual(len(event["emotions"]), 1)
        self.assertNotIn("startupError", event)

    def test_missing_transcript_fails_before_model_load(self) -> None:
        write_wav(os.path.join(self.dir, "voice.wav"))
        daemon = self.boot(extra_args=("--idle-unload-sec", "0"))
        self.assertFalse(daemon.ready()["asrAvailable"])
        daemon.speak([{"emotion": "默认", "content": "你好。"}])
        error = daemon.expect("error")
        self.assertEqual(error["code"], "GENERATE_FAILED")
        self.assertIn("no transcript", error["message"])


if __name__ == "__main__":
    unittest.main()
