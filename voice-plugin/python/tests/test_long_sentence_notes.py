"""Long-sentence notes and the unit-cap guard (rev 7).

Covers:

* note c — ``segment {i}: sentence {n} split into {k} units (<limit>)`` for a
  sentence the cap had to break, naming ``maxSentenceChars`` or, when the
  first-sentence cap is what split it, ``firstSentenceMaxChars``;
* note d — ``segment {i}: unit {n} produced {x}s for {y} chars (suspiciously fast)``,
  emitted once per segment from the hygiene records;
* the post-plan guard that reports an over-cap unit as an ``error:`` note;
* the balanced split visible end to end: 61 characters without punctuation become
  units of 31 and 30 characters, never a one-character tail.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, PYTHON_DIR)

import tts_daemon  # noqa: E402
from tests.voxcpm_daemon import FakeVoxDaemon as ProbeDaemon, make_voice, write_wav  # noqa: E402
from ttslib.events import EventWriter  # noqa: E402


class _Sink:
    def write(self, data) -> int:
        return len(data)

    def flush(self) -> None:
        return None


def _record(
    segment: int,
    unit: int,
    text: str,
    audio_sec: float,
    trimmed: float = 0.0,
    aborted: str = "",
    cap_hit: bool = False,
    produced: float = None,
) -> dict:
    """A hygiene record with the exact shape `_hygiene_notes` consumes."""
    return {
        "segment": segment,
        "unit": unit,
        "text": text,
        "trimmedSec": trimmed,
        "audioSec": audio_sec,
        "producedSec": audio_sec if produced is None else produced,
        "maxNewTokens": 128,
        "capSec": 10.667,
        "capHit": cap_hit,
        "limitSec": 6.0,
        "overLimit": False,
        "aborted": aborted,
        "chunks": 1,
    }


class LongSentenceNoteTests(unittest.TestCase):
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

    def daemon(self) -> "tts_daemon.TtsDaemon":
        """An in-process daemon for unit-testing note generation directly."""
        args = tts_daemon.build_parser().parse_args(
            ["--voices-dir", self.dir, "--default-emotion", "默认", "--first-sentence-max-chars", "0"]
        )
        return tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))

    def speak(self, daemon: ProbeDaemon, content: str) -> tuple:
        daemon.send({"id": "1", "op": "speak", "segments": [{"content": content}], "play": False, "gapMs": 0})
        daemon.expect("speak_start", id="1", timeout=60)
        done = daemon.expect("speak_done", id="1", timeout=60)
        return done, daemon.of("sentence_end")

    def test_sixty_one_unpunctuated_chars_split_into_two_balanced_units(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        done, sentence_ends = self.speak(daemon, "一" * 61)
        self.assertEqual([len(event["text"]) for event in sentence_ends], [31, 30])
        self.assertIn(
            "segment 0: sentence 1 split into 2 units (maxSentenceChars=60)",
            done["notes"],
            done["notes"],
        )
        self.assertEqual(done["units"], 2)
        self.assertTrue(all(len(event["text"]) <= 60 for event in sentence_ends))

    def test_first_sentence_cap_shrinks_the_opening_unit_further(self) -> None:
        # Only the non-streaming branch applies the first-sentence cap: a streaming
        # engine starts at its first chunk, so it plans without one. Merging is off so
        # the short opening piece is not glued back onto the next one.
        daemon = self.start(
            extra_args=("--stream", "false", "--merge-sentences", "off", "--first-sentence-max-chars", "20")
        )
        _done, sentence_ends = self.speak(daemon, "一" * 61)
        self.assertEqual(sentence_ends[0]["text"][:1], "一")
        self.assertLessEqual(len(sentence_ends[0]["text"]), 20, "default first-sentence cap is 20")

    def test_sentence_cap_note_names_the_sentence_index(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        content = "甲" * 31 + "。" + "乙" * 61 + "。"
        done, sentence_ends = self.speak(daemon, content)
        self.assertIn(
            "segment 0: sentence 2 split into 2 units (maxSentenceChars=60)",
            done["notes"],
            done["notes"],
        )
        self.assertTrue(all(len(event["text"]) <= 60 for event in sentence_ends))

    def test_first_sentence_cap_also_produces_the_note(self) -> None:
        daemon = self.start(
            extra_args=("--stream", "false", "--first-sentence-max-chars", "10", "--merge-sentences", "off")
        )
        done, sentence_ends = self.speak(daemon, "这是一个很长很长很长很长的开场句子。")
        # The note names the limit that actually caused the split.
        self.assertIn(
            "segment 0: sentence 1 split into 2 units (firstSentenceMaxChars=10)",
            done["notes"],
            done["notes"],
        )
        self.assertTrue(all(len(event["text"]) <= 10 for event in sentence_ends), [e["text"] for e in sentence_ends])

    def test_note_c_keeps_the_sentence_cap_when_that_is_what_split_it(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "10", "--merge-sentences", "off"))
        # Sentence 1 is short enough for the first-sentence cap; sentence 2 is what
        # the 60-char sentence cap has to split, so that is the limit to report.
        done, _sentence_ends = self.speak(daemon, "甲一。" + "一" * 70 + "。")
        notes = [note for note in done["notes"] if "split into" in note]
        self.assertTrue(notes, done["notes"])
        self.assertIn("(maxSentenceChars=60)", notes[0], notes)

    def test_note_c_is_absent_for_short_text(self) -> None:
        daemon = self.start()
        done, _sentence_ends = self.speak(daemon, "短句。也很短。")
        self.assertFalse([note for note in done["notes"] if "split into" in note], done["notes"])

    def test_suspiciously_fast_note_is_reported_once_per_segment(self) -> None:
        daemon = self.start(extra_args=("--merge-sentences", "off", "--first-sentence-max-chars", "0"))
        done, _sentence_ends = self.speak(daemon, "一" * 40 + "。" + "二" * 40 + "。")
        fast_notes = [note for note in done["notes"] if "suspiciously fast" in note]
        self.assertEqual(len(fast_notes), 1, done["notes"])
        self.assertIn("segment 0: unit 0 produced", fast_notes[0])
        self.assertIn("for 41 chars", fast_notes[0])

    def test_note_d_threshold_keeps_realistic_audio_quiet(self) -> None:
        daemon = self.daemon()
        daemon._hygiene_records = [_record(0, 0, "一" * 20, 6.0)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertFalse([note for note in notes if "suspiciously fast" in note], notes)

    def test_note_d_flags_audio_far_below_the_expected_duration(self) -> None:
        daemon = self.daemon()
        daemon._hygiene_records = [_record(0, 0, "一" * 20, 0.2)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertEqual(
            [note for note in notes if "suspiciously fast" in note],
            ["segment 0: unit 0 produced 0.20s for 20 chars (suspiciously fast)"],
            notes,
        )

    def test_note_d_ignores_pure_latin_text(self) -> None:
        """F6: the baseline is per CJK character, so Latin must not be measured by it."""
        daemon = self.daemon()
        latin = "one two three four"
        self.assertEqual(len(latin), 18)
        # 1.18 s for 18 Latin characters would trip the CJK-calibrated threshold.
        daemon._hygiene_records = [_record(0, 0, latin, 1.18)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertFalse([note for note in notes if "suspiciously fast" in note], notes)

    def test_note_d_still_flags_a_really_fast_cjk_unit(self) -> None:
        daemon = self.daemon()
        cjk = "这是二十四个汉字组成的测试文本内容示例一二三四五"
        self.assertEqual(len(cjk), 24)
        daemon._hygiene_records = [_record(0, 0, cjk, 0.5)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertEqual(
            [note for note in notes if "suspiciously fast" in note],
            ["segment 0: unit 0 produced 0.50s for 24 chars (suspiciously fast)"],
            notes,
        )

    def test_note_d_accepts_a_legal_kana_speed(self) -> None:
        daemon = self.daemon()
        kana = "これはテストです" * 3
        self.assertEqual(len(kana), 24)
        daemon._hygiene_records = [_record(0, 0, kana, 3.0)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertFalse([note for note in notes if "suspiciously fast" in note], notes)

    def test_note_d_flags_a_really_fast_kana_unit(self) -> None:
        daemon = self.daemon()
        kana = "これはテストです" * 3
        self.assertEqual(len(kana), 24)
        daemon._hygiene_records = [_record(0, 0, kana, 0.2)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertEqual(len([note for note in notes if "suspiciously fast" in note]), 1, notes)

    def test_note_d_ignores_latin_on_the_wire(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        done, _sentence_ends = self.speak(daemon, "one two three four")
        self.assertFalse([note for note in done["notes"] if "suspiciously fast" in note], done["notes"])

    def test_cap_note_and_fast_note_are_mutually_exclusive(self) -> None:
        # F2: the cap is judged on what the model PRODUCED, so a unit that ran to the
        # cap still reports it even when trimming left almost nothing audible — and it
        # must not also be called "suspiciously fast".
        daemon = self.daemon()
        cjk = "这是二十四个汉字组成的测试文本内容示例一二三四五"
        daemon._hygiene_records = [_record(0, 0, cjk, 0.2, trimmed=10.0, cap_hit=True, produced=10.667)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertEqual(len([note for note in notes if "runaway-tail cap" in note]), 1, notes)
        self.assertFalse([note for note in notes if "suspiciously fast" in note], notes)

    def test_fast_note_still_fires_for_a_short_uncapped_unit(self) -> None:
        daemon = self.daemon()
        cjk = "这是二十四个汉字组成的测试文本内容示例一二三四五"
        daemon._hygiene_records = [_record(0, 0, cjk, 0.2, produced=0.2, cap_hit=False)]
        notes: list = []
        daemon._hygiene_notes(notes)
        self.assertEqual(len([note for note in notes if "suspiciously fast" in note]), 1, notes)
        self.assertFalse([note for note in notes if "runaway-tail cap" in note], notes)

    def test_wire_cap_truncation_reports_the_cap_note_only(self) -> None:
        # The same contract through the real pipeline: the fake generation honours the
        # cap and its body is sub-gate silence, so almost nothing survives trimming.
        daemon = ProbeDaemon(
            self.dir,
            self.marker,
            extra_args=(
                "--idle-unload-sec",
                "0",
                "--max-audio-floor-sec",
                "1000",
                "--max-audio-multiple",
                "1000",
            ),
            fake_env={"FAKE_VOX_HONOR_MAX_LEN": "1", "FAKE_VOX_SILENT_BODY": "1"},
        )
        self.addCleanup(daemon.stop)
        daemon.expect("ready", timeout=60)
        done, _sentence_ends = self.speak(daemon, "你好呀。")
        self.assertTrue(done["ok"], done)
        self.assertEqual(len([note for note in done["notes"] if "runaway-tail cap" in note]), 1, done["notes"])
        self.assertFalse([note for note in done["notes"] if "suspiciously fast" in note], done["notes"])


class CapGuardTests(unittest.TestCase):
    """The post-plan guard rejects any unit above the sentence cap."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认")

    def daemon(self, extra_args=()) -> "tts_daemon.TtsDaemon":
        args = tts_daemon.build_parser().parse_args(
            ["--voices-dir", self.dir, "--default-emotion", "默认", "--first-sentence-max-chars", "0"]
            + list(extra_args)
        )
        return tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))

    def test_legal_plans_never_report_the_guard(self) -> None:
        daemon = self.daemon()
        plan = daemon._plan("1", {"segments": [{"content": "一" * 150}]}, 0)
        self.assertFalse([note for note in plan.notes if note.startswith("error:")], plan.notes)
        self.assertTrue(all(len(job.text) <= 60 for job in plan.jobs))

    def test_guard_reports_an_over_cap_unit(self) -> None:
        daemon = self.daemon()
        oversized = [["一" * 80]]
        with mock.patch.object(tts_daemon, "plan_units", return_value=oversized):
            plan = daemon._plan("1", {"segments": [{"content": "一" * 80}]}, 0)
        self.assertEqual(
            [note for note in plan.notes if note.startswith("error:")],
            ["error: segment 0: unit of 80 chars exceeds maxSentenceChars=60"],
            plan.notes,
        )

    def test_merge_max_chars_cannot_relax_the_cap(self) -> None:
        daemon = self.daemon()
        plan = daemon._plan(
            "1",
            {"segments": [{"content": "一" * 20 + "。" + "二" * 20 + "。"}]},
            0,
        )
        self.assertTrue(all(len(job.text) <= 60 for job in plan.jobs))
        large = self.daemon(("--max-sentence-chars", "25", "--merge-max-chars", "500", "--merge-sentences", "all"))
        plan = large._plan("1", {"segments": [{"content": "一" * 20 + "。" + "二" * 20 + "。"}]}, 0)
        self.assertTrue(all(len(job.text) <= 25 for job in plan.jobs), [len(job.text) for job in plan.jobs])
        self.assertFalse([note for note in plan.notes if note.startswith("error:")], plan.notes)


if __name__ == "__main__":
    unittest.main()
