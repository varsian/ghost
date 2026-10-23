"""Adversarial review tests for the sentence-merge change set (sentence-merge review).

These tests attack the merge semantics rather than the implementation's
self-description:

* ``plan_units(..., merge_mode='off')`` is compared against the exact pre-merge
  composition (``split_sentences`` + ``cap_first_sentence``) over a matrix of
  inputs and parameters (claim 1);
* the merge bound is checked as an invariant over the same matrix, including
  degenerate parameters (``max_chars=0``, ``merge_max_chars`` smaller than one
  sentence, ``short_sentence_chars=0``, negatives, no-terminator text, mixed
  CJK/Japanese punctuation), and the first unit is checked against
  ``first_max_chars`` (claim 2);
* the daemon's per-segment planner is called directly, so cross-segment unit
  sharing is falsifiable;
* the pipeline's display-count vs unit-count contract and the
  ``PipelineGenerateError`` path are exercised with synthetic audio.

No product code is modified by this file.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import tts_daemon  # noqa: E402
from ttslib.events import EventWriter  # noqa: E402
from ttslib.pipeline import (  # noqa: E402
    NullPlayer,
    PipelineGenerateError,
    SentenceJob,
    SpeechPipeline,
)
from ttslib.textsplit import (  # noqa: E402
    DEFAULT_MERGE_MAX_CHARS,
    MERGE_MODES,
    cap_first_sentence,
    normalize_text,
    plan_units,
    split_sentences,
)

# Shapes the planner must survive.
RAW_INPUTS = {
    "plain": "你好。世界！今天很好？",
    "markdown": "```markdown\n**你好**，世界。\n```",
    "multiline": "第一条\n第二条\n第三条",
    "long_soft_breaks": "一二三四五，六七八九十，十一十二，十三十四，十五十六。",
    "no_terminator": "这一段没有任何终止标点结尾",
    "english_periods": "Hello world. This is not split. At all.",
    "repeated_punct": "你好！！！真的吗？？？",
    "closing_quote": "他说：“走吧。”然后走了。",
    "japanese": "こんにちは。これはテストです！本当ですか？はい、そうです。",
    "japanese_mixed": "これは「テスト」です。よろしいですか？",
    "whitespace": "   \n\t  ",
    "pure_punct": "！！！",
    "empty": "",
    "mixed_long": "短。中等长度的句子在这里。这一句话非常长而且没有任何软断点所以只能硬切开了ABCDEFG。短句！",
}

OFF_PARAMS = [
    dict(max_chars=60, first_max_chars=20),
    dict(max_chars=60, first_max_chars=0),
    dict(max_chars=0, first_max_chars=20),
    dict(max_chars=6, first_max_chars=3),
    dict(max_chars=-5, first_max_chars=-1),
    dict(max_chars=1000, first_max_chars=1000),
]

INVARIANT_PARAMS = [
    dict(max_chars=60, first_max_chars=20, merge_mode="short", merge_max_chars=0, short_sentence_chars=20),
    dict(max_chars=60, first_max_chars=0, merge_mode="short", merge_max_chars=0, short_sentence_chars=20),
    dict(max_chars=60, first_max_chars=20, merge_mode="all", merge_max_chars=0, short_sentence_chars=20),
    dict(max_chars=0, first_max_chars=0, merge_mode="all", merge_max_chars=0, short_sentence_chars=20),
    dict(max_chars=0, first_max_chars=12, merge_mode="all", merge_max_chars=0, short_sentence_chars=20),
    dict(max_chars=60, first_max_chars=20, merge_mode="all", merge_max_chars=5, short_sentence_chars=20),
    dict(max_chars=60, first_max_chars=20, merge_mode="all", merge_max_chars=1, short_sentence_chars=20),
    dict(max_chars=8, first_max_chars=4, merge_mode="all", merge_max_chars=8, short_sentence_chars=20),
    dict(max_chars=-1, first_max_chars=-1, merge_mode="short", merge_max_chars=-1, short_sentence_chars=0),
    dict(max_chars=20, first_max_chars=6, merge_mode="short", merge_max_chars=12, short_sentence_chars=3),
]


def premerge(raw: str, max_chars: int, first_max_chars: int) -> list:
    """The exact pre-merge composition this change set must preserve for ``off``."""
    sentences = split_sentences(normalize_text(raw), max_chars)
    return [[sentence] for sentence in cap_first_sentence(sentences, first_max_chars)]


def bound_for(max_chars: int, merge_max_chars: int) -> int:
    """The documented merge bound, recomputed here so a source change cannot hide."""
    if merge_max_chars and merge_max_chars > 0:
        return int(merge_max_chars)
    if max_chars and max_chars > 0:
        return int(max_chars)
    return DEFAULT_MERGE_MAX_CHARS


def flatten(units) -> list:
    return [part for unit in units for part in unit]


class OffEquivalenceTests(unittest.TestCase):
    """Claim 1: ``merge_mode='off'`` is byte-equivalent to pre-merge behavior."""

    def test_off_equals_premerge_for_every_input_and_parameter_set(self) -> None:
        checked = 0
        for name, raw in RAW_INPUTS.items():
            for params in OFF_PARAMS:
                expected = premerge(raw, params["max_chars"], params["first_max_chars"])
                actual = plan_units(
                    raw,
                    max_chars=params["max_chars"],
                    first_max_chars=params["first_max_chars"],
                    merge_mode="off",
                )
                self.assertEqual(actual, expected, f"{name} {params}")
                checked += 1
        self.assertEqual(checked, len(RAW_INPUTS) * len(OFF_PARAMS))

    def test_off_matches_split_sentences_without_first_cap(self) -> None:
        for name, raw in RAW_INPUTS.items():
            for max_chars in (0, 6, 20, 60, -3):
                expected = [[s] for s in split_sentences(normalize_text(raw), max_chars)]
                self.assertEqual(
                    plan_units(raw, max_chars=max_chars, first_max_chars=0, merge_mode="off"),
                    expected,
                    f"{name} max_chars={max_chars}",
                )

    def test_off_is_also_the_equivalence_baseline_for_merged_modes(self) -> None:
        """Flattened units keep the same sentences in the same order as pre-merge."""
        for name, raw in RAW_INPUTS.items():
            units = plan_units(raw, max_chars=20, first_max_chars=8, merge_mode="off")
            self.assertTrue(all(unit and all(part for part in unit) for unit in units), name)
            self.assertEqual(
                flatten(units),
                cap_first_sentence(split_sentences(normalize_text(raw), 20), 8),
                name,
            )


class MergeModeTests(unittest.TestCase):
    def test_short_mode_merges_only_short_sentences(self) -> None:
        raw = "短句一。短句二。这一句明显很长很长很长很长很长很长！短句三。"
        units = plan_units(raw, max_chars=0, first_max_chars=0, merge_mode="short", short_sentence_chars=8)
        self.assertEqual(len(units), 2, units)
        self.assertEqual(units[0], ["短句一。", "短句二。"])
        self.assertEqual(units[1], ["这一句明显很长很长很长很长很长很长！", "短句三。"])

    def test_all_mode_merges_long_sentences_too(self) -> None:
        raw = "第一句很长很长很长。第二句也是很长很长。"
        units = plan_units(raw, max_chars=0, merge_max_chars=40, first_max_chars=0, merge_mode="all")
        self.assertEqual(units, [["第一句很长很长很长。", "第二句也是很长很长。"]])

    def test_short_sentence_chars_zero_disables_merging(self) -> None:
        for name, raw in RAW_INPUTS.items():
            units = plan_units(raw, max_chars=60, first_max_chars=0, merge_mode="short", short_sentence_chars=0)
            self.assertEqual(
                units,
                plan_units(raw, max_chars=60, first_max_chars=0, merge_mode="off"),
                name,
            )

    def test_negative_short_sentence_chars_disables_merging(self) -> None:
        units = plan_units("短。也很短。", max_chars=60, first_max_chars=0, merge_mode="short", short_sentence_chars=-7)
        self.assertEqual(units, [["短。"], ["也很短。"]])

    def test_invalid_mode_raises_value_error(self) -> None:
        for mode in ("", "ALL", "merge", "off ", None, 0):
            with self.assertRaises(ValueError, msg=repr(mode)):
                plan_units("你好。", merge_mode=mode)  # type: ignore[arg-type]
        self.assertEqual(MERGE_MODES, ("off", "short", "all"))

    def test_default_mode_merges_adjacent_short_sentences(self) -> None:
        self.assertEqual(plan_units("短。也很短。"), [["短。", "也很短。"]])


class BoundInvariantTests(unittest.TestCase):
    """Claim 2: a merged unit never exceeds the bound, and never the first bound."""

    def test_merged_units_respect_the_bound(self) -> None:
        for name, raw in RAW_INPUTS.items():
            for params in INVARIANT_PARAMS:
                bound = bound_for(params["max_chars"], params["merge_max_chars"])
                units = plan_units(raw, **params)
                for unit in units:
                    if len(unit) > 1:
                        self.assertLessEqual(
                            sum(len(part) for part in unit),
                            bound,
                            f"{name} {params}: merged unit {unit} exceeds bound {bound}",
                        )

    def test_first_unit_respects_first_max_chars(self) -> None:
        for name, raw in RAW_INPUTS.items():
            for params in INVARIANT_PARAMS:
                first_cap = params["first_max_chars"]
                if not first_cap or first_cap <= 0:
                    continue
                units = plan_units(raw, **params)
                if not units:
                    continue
                total = sum(len(part) for part in units[0])
                self.assertLessEqual(total, first_cap, f"{name} {params}: first unit {units[0]} exceeds {first_cap}")

    def test_units_are_never_empty_and_cover_every_sentence(self) -> None:
        for name, raw in RAW_INPUTS.items():
            for params in INVARIANT_PARAMS:
                units = plan_units(raw, **params)
                sentences = split_sentences(normalize_text(raw), params["max_chars"])
                first_cap = params["first_max_chars"]
                if first_cap and first_cap > 0:
                    sentences = cap_first_sentence(sentences, first_cap)
                self.assertTrue(all(unit for unit in units), name)
                self.assertTrue(all(part for unit in units for part in unit), name)
                self.assertEqual(flatten(units), sentences, f"{name} {params}")

    def test_merge_max_chars_smaller_than_one_sentence(self) -> None:
        """Documented exception: the merge bound constrains MERGING, not sentence length.

        A lone sentence longer than the bound is left intact — splitting is
        `max_chars`' job (PROTOCOL §7.1/§7.2); the lead confirmed during the
        sentence-merge review that this is intentional.
        """
        raw = "这是第一句。这是第二句。"
        units = plan_units(raw, max_chars=60, first_max_chars=0, merge_mode="all", merge_max_chars=2)
        self.assertEqual(units, [["这是第一句。"], ["这是第二句。"]])
        lone = sum(len(part) for part in units[0])
        self.assertGreater(lone, 2, "a lone sentence is not split by the merge bound")

    def test_max_chars_zero_disables_splitting_but_keeps_a_merge_bound(self) -> None:
        # `max_chars=0` disables sentence splitting, so the single 201-char
        # sentence exceeds the 60-char merge bound — the same documented
        # exception as above: the bound merges, it does not split.
        raw = "一" * 200 + "。"
        units = plan_units(raw, max_chars=0, first_max_chars=0, merge_mode="all")
        self.assertEqual(len(units), 1)
        self.assertEqual(sum(len(part) for part in units[0]), 201)
        self.assertEqual(DEFAULT_MERGE_MAX_CHARS, 60)

    def test_no_terminator_long_text(self) -> None:
        raw = "一" * 150
        capped = plan_units(raw, max_chars=40, first_max_chars=0, merge_mode="all")
        self.assertTrue(all(sum(len(part) for part in unit) <= 40 for unit in capped), capped)
        self.assertEqual("".join(flatten(capped)), raw)
        uncapped = plan_units(raw, max_chars=0, first_max_chars=0, merge_mode="all")
        self.assertEqual(uncapped, [[raw]])

    def test_whitespace_only_and_empty(self) -> None:
        for raw in ("   \n\t ", "", None, "```\n```"):
            self.assertEqual(plan_units(raw, merge_mode="short"), [], repr(raw))
            self.assertEqual(plan_units(raw, merge_mode="off"), [], repr(raw))

    def test_pure_punctuation_is_planned_not_dropped(self) -> None:
        units = plan_units("！！！", merge_mode="off")
        self.assertEqual(units, [["！"]])
        self.assertEqual(plan_units("！！！", merge_mode="short"), [["！"]])

    def test_mixed_cjk_and_japanese_punctuation(self) -> None:
        raw = "こんにちは。これはテスト！本当？你好，世界；结束"
        sentences = split_sentences(normalize_text(raw), 60)
        # Rev 7: the semicolon is a clause break, so it does not end a sentence.
        self.assertEqual(sentences, ["こんにちは。", "これはテスト！", "本当？", "你好，世界；结束"])
        units = plan_units(raw, max_chars=60, first_max_chars=0, merge_mode="all", merge_max_chars=60)
        self.assertEqual(flatten(units), sentences)
        self.assertEqual([len(unit) for unit in units], [4], "all four fit inside the 60-char bound")

    def test_negative_parameters_do_not_raise(self) -> None:
        units = plan_units("你好。世界。", max_chars=-10, first_max_chars=-10, merge_mode="short", merge_max_chars=-10, short_sentence_chars=-10)
        self.assertEqual(flatten(units), ["你好。", "世界。"])

    def test_first_max_chars_zero_means_no_first_cap(self) -> None:
        long_first = "一" * 50 + "。短。"
        units = plan_units(long_first, max_chars=100, first_max_chars=0, merge_mode="off")
        self.assertEqual(sum(len(part) for part in units[0]), 51)


class CrossSegmentTests(unittest.TestCase):
    """Merging is intra-segment: the daemon plans each segment separately."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        with wave.open(os.path.join(self.tmp.name, "默认.wav"), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(48000)
            handle.writeframes(b"\x00\x00" * 480)
        # VoxCPM clones by continuing the prompt clip, so every voice needs its
        # transcript even for a plan-only test.
        with open(os.path.join(self.tmp.name, "默认.txt"), "w", encoding="utf-8") as handle:
            handle.write("你好呀")
        args = tts_daemon.build_parser().parse_args(
            [
                "--voices-dir",
                self.tmp.name,
                "--default-emotion",
                "默认",
                "--merge-sentences",
                "all",
                "--merge-max-chars",
                "60",
                "--first-sentence-max-chars",
                "0",
            ]
        )
        self.daemon = tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))

    def plan(self, segments):
        return self.daemon._plan("1", {"op": "speak", "segments": segments})

    def test_two_short_sentence_segments_never_share_a_unit(self) -> None:
        plan = self.plan(
            [
                {"emotion": "默认", "content": "甲一。甲二。"},
                {"emotion": "默认", "content": "乙一。乙二。"},
            ]
        )
        self.assertEqual(len(plan.jobs), 2, [job.sentences for job in plan.jobs])
        for job in plan.jobs:
            texts = "".join(job.sentences)
            if job.segment_index == 0:
                self.assertNotIn("乙", texts, job.sentences)
            else:
                self.assertNotIn("甲", texts, job.sentences)
        self.assertEqual([job.sentences for job in plan.jobs], [("甲一。", "甲二。"), ("乙一。", "乙二。")])
        self.assertEqual([job.unit_index for job in plan.jobs], [0, 0])
        self.assertEqual([job.unit_count for job in plan.jobs], [1, 1])

    def test_display_counts_stay_per_segment(self) -> None:
        plan = self.plan(
            [
                {"emotion": "默认", "content": "甲一。甲二。甲三。"},
                {"emotion": "默认", "content": "乙一。"},
            ]
        )
        self.assertEqual([segment["sentences"] for segment in plan.segments], [3, 1])
        self.assertEqual(sum(segment["sentences"] for segment in plan.segments), 4)
        self.assertEqual(len(plan.jobs), 2)
        self.assertEqual(sum(len(job.sentences) for job in plan.jobs), 4)
        self.assertEqual([job.unit_count for job in plan.jobs], [1, 1])

    def test_merging_stays_inside_a_segment_with_distinct_emotion_labels(self) -> None:
        plan = self.plan(
            [
                {"emotion": "默认", "content": "短一。短二。"},
                {"emotion": "开心", "content": "短三。短四。"},
            ]
        )
        # Emotion is a label carried per segment; the same reference voice speaks both.
        self.assertEqual([job.used_emotion for job in plan.jobs], ["默认", "开心"])
        self.assertEqual([job.fallback for job in plan.jobs], [False, False])
        self.assertEqual([job.segment_index for job in plan.jobs], [0, 1])
        self.assertTrue(all(job.voice is self.daemon.voices.voice for job in plan.jobs))

    def test_merge_mode_off_plans_one_unit_per_sentence(self) -> None:
        args = tts_daemon.build_parser().parse_args(
            ["--voices-dir", self.tmp.name, "--merge-sentences", "off", "--first-sentence-max-chars", "0"]
        )
        daemon = tts_daemon.TtsDaemon(args, EventWriter(stdout=_Sink()))
        plan = daemon._plan("1", {"op": "speak", "segments": [{"content": "甲一。甲二。乙一。"}]})
        self.assertEqual([job.sentences for job in plan.jobs], [("甲一。",), ("甲二。",), ("乙一。",)])
        self.assertEqual([job.unit_count for job in plan.jobs], [3, 3, 3])

    def test_empty_segment_stays_empty_and_does_not_absorb_neighbours(self) -> None:
        plan = self.plan(
            [
                {"content": "甲一。甲二。"},
                {"content": "   "},
                {"content": "乙一。乙二。"},
            ]
        )
        self.assertEqual([segment["sentences"] for segment in plan.segments], [2, 0, 2])
        self.assertEqual([job.segment_index for job in plan.jobs], [0, 2])
        self.assertEqual([job.sentences for job in plan.jobs], [("甲一。", "甲二。"), ("乙一。", "乙二。")])


class _Sink:
    """Minimal byte sink so the daemon's EventWriter does not print."""

    def write(self, data) -> int:
        return len(data)

    def flush(self) -> None:
        return None


def make_job(segment: int, unit: int, unit_count: int, sentences) -> SentenceJob:
    return SentenceJob(
        segment_index=segment,
        unit_index=unit,
        unit_count=unit_count,
        sentences=tuple(sentences),
        text="".join(sentences),
        segment_text="".join(sentences),
        voice=object(),
        requested_emotion="默认",
        used_emotion="默认",
        fallback=False,
        resolved_via="reference",
        language="Auto",
        speed=1.0,
    )


class FakeGenerator:
    """One fixed-length clip per unit; records every call and can fail on demand."""

    def __init__(self, fail_on_unit: int = -1, fail_on_segment: int = 0) -> None:
        self.calls = []
        self.fail_on_unit = fail_on_unit
        self.fail_on_segment = fail_on_segment

    def __call__(self, job: SentenceJob):
        self.calls.append((job.segment_index, job.unit_index))
        if job.unit_index == self.fail_on_unit and job.segment_index == self.fail_on_segment:
            raise RuntimeError("unit exploded")
        return [0.0] * 100, 1000


def run_pipeline(jobs, generator=None, player=None):
    events = []
    pipeline = SpeechPipeline(
        generate=generator or FakeGenerator(),
        player=player or NullPlayer(),
        emit=lambda name, **fields: events.append((name, fields)),
    )
    result = pipeline.run(jobs, "req-1", gap_ms=0)
    return result, events


class PipelineDisplayContractTests(unittest.TestCase):
    """`sentences` counts what a listener counts; `units` counts generations."""

    def test_display_counts_units_and_merged_flags(self) -> None:
        jobs = [
            make_job(0, 0, 2, ["甲一。", "甲二。"]),
            make_job(0, 1, 2, ["甲三。"]),
            make_job(1, 0, 1, ["乙一。", "乙二。", "乙三。"]),
        ]
        generator = FakeGenerator()
        result, events = run_pipeline(jobs, generator=generator)

        segment_starts = [fields for name, fields in events if name == "segment_start"]
        self.assertEqual([fields["sentences"] for fields in segment_starts], [3, 3])
        self.assertEqual([fields["id"] for fields in segment_starts], ["req-1", "req-1"])

        sentence_ends = [fields for name, fields in events if name == "sentence_end"]
        self.assertEqual([fields["sentences"] for fields in sentence_ends], [2, 1, 3])
        self.assertEqual([fields["merged"] for fields in sentence_ends], [True, False, True])
        self.assertEqual([fields["text"] for fields in sentence_ends], ["甲一。甲二。", "甲三。", "乙一。乙二。乙三。"])

        segment_ends = [fields for name, fields in events if name == "segment_end"]
        self.assertEqual([fields["sentences"] for fields in segment_ends], [3, 3])

        self.assertEqual([segment.sentences for segment in result.segments], [3, 3])
        self.assertEqual(len(result.sentences), 3, "one result per generation unit")

    def test_one_generation_per_unit(self) -> None:
        jobs = [
            make_job(0, 0, 2, ["甲一。", "甲二。"]),
            make_job(0, 1, 2, ["甲三。"]),
            make_job(1, 0, 1, ["乙一。"]),
        ]
        generator = FakeGenerator()
        run_pipeline(jobs, generator=generator)
        self.assertEqual(generator.calls, [(0, 0), (0, 1), (1, 0)])

    def test_merged_never_true_for_single_sentence_units(self) -> None:
        jobs = [make_job(0, index, 3, [f"第{index}句。"]) for index in range(3)]
        _result, events = run_pipeline(jobs)
        sentence_ends = [fields for name, fields in events if name == "sentence_end"]
        self.assertEqual([fields["merged"] for fields in sentence_ends], [False, False, False])
        self.assertEqual([fields["sentences"] for fields in sentence_ends], [1, 1, 1])

    def test_segment_completion_keys_on_the_last_unit(self) -> None:
        jobs = [
            make_job(0, 0, 2, ["甲一。", "甲二。"]),
            make_job(0, 1, 2, ["甲三。"]),
        ]
        _result, events = run_pipeline(jobs)
        order = [name for name, _fields in events]
        self.assertEqual(order, ["segment_start", "sentence_end", "sentence_end", "segment_end"])

    def test_unit_sentence_carries_joined_text(self) -> None:
        jobs = [make_job(0, 0, 1, ["甲一。", "甲二。"])]
        _result, events = run_pipeline(jobs)
        sentence_end = [fields for name, fields in events if name == "sentence_end"][0]
        self.assertEqual(sentence_end["text"], "甲一。甲二。")
        self.assertEqual(sentence_end["sentenceIndex"], 0)


class SegmentIndexGapTests(unittest.TestCase):
    """FINDING: a plan whose first or middle segment carries no units crashes the run.

    ``_segment_results`` only appends a segment when ``job.segment_index == len(out)``,
    so a segment that produced no units (empty content, PROTOCOL §7.4) is missing
    from ``result.segments``; ``chunks`` is built from that list and the playback
    loop then indexes the absent key. Reproduced through the protocol as
    ``error INTERNAL {"message":"1"}`` with ``KeyError: 1`` in the detail.
    """

    def test_leading_empty_segment_does_not_break_the_pipeline(self) -> None:
        jobs = [make_job(1, 0, 1, ["乙一。"])]
        result, events = run_pipeline(jobs)
        self.assertGreater(result.total_seconds, 0)
        self.assertEqual([segment.index for segment in result.segments], [1])
        self.assertEqual([name for name, _fields in events].count("sentence_end"), 1)

    def test_middle_empty_segment_does_not_break_the_pipeline(self) -> None:
        jobs = [make_job(0, 0, 1, ["甲一。"]), make_job(2, 0, 1, ["乙一。"])]
        result, events = run_pipeline(jobs)
        self.assertEqual([segment.index for segment in result.segments], [0, 2])
        self.assertEqual([name for name, _fields in events].count("segment_end"), 2)
        self.assertEqual([name for name, _fields in events].count("sentence_end"), 2)


class GenerationFailureTests(unittest.TestCase):
    """The old AttributeError on `job.sentence_index` must stay fixed."""

    def test_generation_failure_raises_pipeline_generate_error(self) -> None:
        jobs = [
            make_job(0, 0, 1, ["甲一。"]),
            make_job(1, 0, 1, ["乙一。"]),
        ]
        generator = FakeGenerator(fail_on_unit=0, fail_on_segment=1)
        pipeline = SpeechPipeline(generate=generator, player=NullPlayer(), emit=lambda *a, **k: None)
        with self.assertRaises(PipelineGenerateError) as caught:
            pipeline.run(jobs, "req-1", gap_ms=0)
        error = caught.exception
        self.assertEqual(error.job.unit_index, 0)
        self.assertEqual(error.job.segment_index, 1)
        self.assertIsInstance(error.cause, RuntimeError)
        message = str(error)
        self.assertIn("unit 0", message)
        self.assertIn("segment 1", message)
        self.assertIn("unit exploded", message)
        self.assertNotIn("sentence_index", message)
        self.assertNotIn("AttributeError", message)

    def test_failure_in_a_later_unit_still_reports_the_unit_it_failed_on(self) -> None:
        jobs = [
            make_job(0, 0, 2, ["甲一。"]),
            make_job(0, 1, 2, ["甲二。"]),
            make_job(1, 0, 2, ["乙一。"]),
            make_job(1, 1, 2, ["乙二。"]),
        ]
        generator = FakeGenerator(fail_on_unit=0, fail_on_segment=1)
        pipeline = SpeechPipeline(generate=generator, player=NullPlayer(), emit=lambda *a, **k: None)
        with self.assertRaises(PipelineGenerateError) as caught:
            pipeline.run(jobs, "req-1", gap_ms=0)
        self.assertEqual(caught.exception.job.unit_index, 0)
        self.assertEqual(caught.exception.job.segment_index, 1)
        self.assertIn("unit 0", str(caught.exception))
        self.assertIn("segment 1", str(caught.exception))
        self.assertEqual(
            generator.calls,
            [(0, 0), (0, 1), (1, 0)],
            "generation runs in order and stops at the failing unit",
        )

    def test_no_error_is_raised_when_every_unit_succeeds(self) -> None:
        jobs = [make_job(0, 0, 1, ["甲一。"])]
        result, _events = run_pipeline(jobs)
        self.assertGreater(result.total_seconds, 0)


if __name__ == "__main__":
    unittest.main()
