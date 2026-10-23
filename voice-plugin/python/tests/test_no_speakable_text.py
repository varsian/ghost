"""Punctuation-only segments take the "no speakable text" skip path.

A segment whose normalized text carries no word character (``\\w``) — punctuation,
whitespace, or emoji only — must not reach the model, must report ``seconds: 0``,
and must keep the existing note ``segment {i}: no speakable text; skipped``, in
any position relative to real segments.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
sys.path.insert(0, PYTHON_DIR)

import tts_daemon  # noqa: E402
from tests.voxcpm_daemon import FakeVoxDaemon as ProbeDaemon, make_voice, write_wav  # noqa: E402
from ttslib.events import EventWriter  # noqa: E402

SKIPPED = ("。。。", "……", "，，", "   ", "🙂🙂", "！！！", "——", "```\n```")
SPEAKABLE = ("abc", "123", "你好", "🙂 hi", "版本 v1.2", "_")


class _Sink:
    def write(self, data) -> int:
        return len(data)

    def flush(self) -> None:
        return None


class PlanSkipTests(unittest.TestCase):
    """`_plan` treats a non-speakable segment exactly like an empty one."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        make_voice(self.dir, "默认")
        args = tts_daemon.build_parser().parse_args(
            ["--voices-dir", self.dir, "--default-emotion", "默认", "--first-sentence-max-chars", "0"]
        )
        self.daemon = tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))

    def plan(self, contents):
        return self.daemon._plan("1", {"segments": [{"content": text} for text in contents]}, 0)

    def test_punctuation_only_texts_are_skipped(self) -> None:
        for text in SKIPPED:
            plan = self.plan([text])
            self.assertEqual(plan.jobs, [], repr(text))
            self.assertEqual(plan.segments[0]["sentences"], 0, repr(text))
            self.assertIn("segment 0: no speakable text; skipped", plan.notes, repr(text))

    def test_word_bearing_texts_are_kept(self) -> None:
        for text in SPEAKABLE:
            plan = self.plan([text])
            self.assertTrue(plan.jobs, repr(text))
            self.assertGreaterEqual(plan.segments[0]["sentences"], 1, repr(text))
            self.assertNotIn("segment 0: no speakable text; skipped", plan.notes, repr(text))

    def test_latin_and_digits_are_word_characters(self) -> None:
        plan = self.plan(["abc", "123"])
        self.assertEqual([job.segment_index for job in plan.jobs], [0, 1])

    def test_skipped_segment_keeps_its_slot_between_real_segments(self) -> None:
        plan = self.plan(["甲一。", "。。。", "乙一。"])
        self.assertEqual([segment["sentences"] for segment in plan.segments], [1, 0, 1])
        self.assertEqual([job.segment_index for job in plan.jobs], [0, 2])
        self.assertIn("segment 1: no speakable text; skipped", plan.notes)

    def test_skipped_segment_before_a_real_one(self) -> None:
        plan = self.plan(["。。。", "甲一。"])
        self.assertEqual([segment["sentences"] for segment in plan.segments], [0, 1])
        self.assertEqual([job.segment_index for job in plan.jobs], [1])

    def test_skipped_segment_after_a_real_one(self) -> None:
        plan = self.plan(["甲一。", "。。。"])
        self.assertEqual([segment["sentences"] for segment in plan.segments], [1, 0])
        self.assertEqual([job.segment_index for job in plan.jobs], [0])

    def test_a_punctuation_only_segment_needs_no_voice(self) -> None:
        with tempfile.TemporaryDirectory() as empty:
            args = tts_daemon.build_parser().parse_args(
                ["--voices-dir", empty, "--default-emotion", "默认", "--first-sentence-max-chars", "0"]
            )
            daemon = tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))
            plan = daemon._plan("1", {"segments": [{"content": "。。。"}]}, 0)
            self.assertEqual(plan.jobs, [], "punctuation-only text must not require a voice")
            self.assertNotIn("NO_VOICES", " ".join(plan.notes))


class WireSkipTests(unittest.TestCase):
    """The same behavior through the protocol, including no model load."""

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

    def speak(self, daemon: ProbeDaemon, contents) -> dict:
        daemon.send(
            {
                "id": "1",
                "op": "speak",
                "segments": [{"content": text} for text in contents],
                "play": False,
                "gapMs": 0,
            }
        )
        start = daemon.expect("speak_start", id="1", timeout=60)
        done = daemon.expect("speak_done", id="1", timeout=60)
        self.start_event = start
        return done

    def test_punctuation_only_utterance_never_loads_the_model(self) -> None:
        daemon = self.start()
        done = self.speak(daemon, ["。。。", "……", "，"])
        self.assertEqual((self.start_event["sentences"], self.start_event["units"]), (0, 0))
        self.assertEqual(done["units"], 0, "speak_start.units and speak_done.units must agree (F7)")
        self.assertEqual(done["totalSeconds"], 0.0)
        self.assertEqual([segment["seconds"] for segment in done["segments"]], [0.0, 0.0, 0.0])
        self.assertEqual(
            [note for note in done["notes"] if "no speakable text" in note],
            [
                "segment 0: no speakable text; skipped",
                "segment 1: no speakable text; skipped",
                "segment 2: no speakable text; skipped",
            ],
            done["notes"],
        )
        self.assertFalse(os.path.exists(self.marker), "no model call may happen for punctuation-only text")

    def test_punctuation_only_segment_before_a_real_one(self) -> None:
        daemon = self.start()
        done = self.speak(daemon, ["。。。", "甲一。"])
        self.assertEqual([segment["seconds"] for segment in done["segments"]], [0.0, done["segments"][1]["seconds"]])
        self.assertGreater(done["segments"][1]["seconds"], 0)
        self.assertIn("segment 0: no speakable text; skipped", done["notes"])
        self.assertEqual(len(daemon.of("sentence_end")), 1)

    def test_punctuation_only_segment_after_a_real_one(self) -> None:
        daemon = self.start()
        done = self.speak(daemon, ["甲一。", "。。。"])
        self.assertGreater(done["segments"][0]["seconds"], 0)
        self.assertEqual(done["segments"][1]["seconds"], 0.0)
        self.assertIn("segment 1: no speakable text; skipped", done["notes"])

    def test_punctuation_only_segment_between_two_real_ones(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        done = self.speak(daemon, ["甲一。", "！！！", "乙一。"])
        seconds = [segment["seconds"] for segment in done["segments"]]
        self.assertGreater(seconds[0], 0)
        self.assertEqual(seconds[1], 0.0)
        self.assertGreater(seconds[2], 0)
        self.assertIn("segment 1: no speakable text; skipped", done["notes"])
        self.assertEqual([event["index"] for event in daemon.of("segment_end")], [0, 2])

    def test_emoji_only_segment_is_skipped(self) -> None:
        daemon = self.start()
        done = self.speak(daemon, ["🙂🙂"])
        self.assertEqual(done["totalSeconds"], 0.0)
        self.assertEqual(done["units"], 0, "the early-return speak_done reports units too")
        self.assertIn("segment 0: no speakable text; skipped", done["notes"])


class FragmentSkipTests(unittest.TestCase):
    """F1: a punctuation-only fragment produced INSIDE a segment is dropped too.

    The segment-level check only covers the whole normalized text; splitting
    (including a language switch) can leave a fragment such as a leading ``。``
    or a lone ``。`` between two clauses, which must not become a generation.
    """

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

    def speak(self, daemon: ProbeDaemon, content: str) -> tuple:
        daemon.send({"id": "1", "op": "speak", "segments": [{"content": content}], "play": False, "gapMs": 0})
        start = daemon.expect("speak_start", id="1", timeout=60)
        done = daemon.expect("speak_done", id="1", timeout=60)
        return start, done, daemon.of("sentence_end")

    def generations(self) -> int:
        with open(self.marker, "r", encoding="utf-8") as handle:
            counts = json.load(handle)
        # The constructor's throwaway warmup generation is booked separately, so this
        # counts real per-unit generations only.
        return int(counts.get("generate_streaming", 0)) + int(counts.get("generate", 0))

    def test_repro_a_leading_punctuation_fragment_is_not_synthesized(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        content = "。今天天气不错，我们出去走走吧，顺便买点东西回来。"
        start, done, sentence_ends = self.speak(daemon, content)
        self.assertEqual([event["text"] for event in sentence_ends], ["今天天气不错，我们出去走走吧，顺便买点东西回来。"])
        self.assertEqual(self.generations(), 1, "the leading 。 must not be a generation")
        self.assertEqual((start["sentences"], start["units"]), (1, 1))
        self.assertGreater(done["segments"][0]["seconds"], 0)
        self.assertFalse([note for note in done["notes"] if "no speakable text" in note], done["notes"])

    def test_repro_a_with_the_default_first_sentence_cap(self) -> None:
        daemon = self.start()
        content = "。今天天气不错，我们出去走走吧，顺便买点东西回来。"
        start, _done, sentence_ends = self.speak(daemon, content)
        self.assertTrue(all("。" != event["text"] for event in sentence_ends), [e["text"] for e in sentence_ends])
        self.assertEqual("".join(event["text"] for event in sentence_ends), content[1:])
        self.assertEqual(start["sentences"], len(sentence_ends), "display count excludes dropped fragments")

    def test_display_counts_ignore_dropped_fragments(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        start, done, sentence_ends = self.speak(daemon, "。甲一。乙一。")
        # A fragment adjacent to real text of the same language stays glued to it,
        # so nothing is generated for punctuation alone.
        self.assertTrue(all(re.search(r"\w", event["text"]) for event in sentence_ends), [e["text"] for e in sentence_ends])
        self.assertEqual(self.generations(), len(sentence_ends), "one generation per emitted unit")
        self.assertEqual(
            start["sentences"],
            sum(event["sentences"] for event in sentence_ends),
            "display sentences count the parts of KEPT units only",
        )
        self.assertEqual(done["segments"][0]["sentences"], start["sentences"])
        self.assertIn("甲一。", "".join(event["text"] for event in sentence_ends))
        self.assertIn("乙一。", "".join(event["text"] for event in sentence_ends))

    def test_no_generation_is_punctuation_only(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        for content in ("。甲一。乙一。", "。甲一。", "甲一。。乙一。", "。今天天气不错，我们出去走走吧，顺便买点东西回来。"):
            daemon.send({"id": "2", "op": "speak", "segments": [{"content": content}], "play": False, "gapMs": 0})
            daemon.expect("speak_start", id="2", timeout=60)
            daemon.expect("speak_done", id="2", timeout=60)
            events = [event for event in daemon.events if event.get("event") == "sentence_end" and event.get("id") == "2"]
            self.assertTrue(events, content)
            for event in events:
                self.assertIsNotNone(
                    re.search(r"\w", event["text"]),
                    f"{content!r} produced a punctuation-only generation {event['text']!r}",
                )

    def test_fragment_only_segment_still_takes_the_skip_path(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        start, done, sentence_ends = self.speak(daemon, "。……，")
        self.assertEqual(sentence_ends, [])
        self.assertEqual((start["sentences"], start["units"]), (0, 0))
        self.assertEqual(done["units"], 0, "speak_start.units and speak_done.units must agree (F7)")
        self.assertEqual(done["totalSeconds"], 0.0)
        self.assertIn("segment 0: no speakable text; skipped", done["notes"])
        self.assertFalse(os.path.exists(self.marker), "no model call for a punctuation-only segment")

    def test_real_text_around_a_fragment_is_still_spoken(self) -> None:
        daemon = self.start(extra_args=("--first-sentence-max-chars", "0"))
        _start, done, sentence_ends = self.speak(daemon, "。甲一。")
        self.assertTrue(sentence_ends)
        self.assertIn("甲一。", "".join(event["text"] for event in sentence_ends))
        self.assertTrue(all(re.search(r"\w", event["text"]) for event in sentence_ends), [e["text"] for e in sentence_ends])
        self.assertGreater(done["segments"][0]["seconds"], 0)
        self.assertEqual(self.generations(), len(sentence_ends))


if __name__ == "__main__":
    unittest.main()
