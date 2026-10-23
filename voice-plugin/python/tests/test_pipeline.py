"""Pipelined generation/playback tests with synthetic audio (no torch, no device)."""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ttslib.pipeline import (  # noqa: E402
    NullPlayer,
    PipelineGenerateError,
    PipelinePlaybackError,
    SentenceJob,
    SpeechPipeline,
)

SAMPLE_RATE = 1000
SENTENCE_SECONDS = 0.2
SENTENCE_SAMPLES = int(SENTENCE_SECONDS * SAMPLE_RATE)


def job(segment: int, unit: int, count: int, text: str, sentences=None) -> SentenceJob:
    """One generation unit; `sentences` defaults to the single sentence it speaks."""
    parts = tuple(sentences) if sentences is not None else (text,)
    return SentenceJob(
        segment_index=segment,
        unit_index=unit,
        unit_count=count,
        sentences=parts,
        text=text,
        segment_text=" ".join([text] * count),
        voice=object(),
        requested_emotion="默认",
        used_emotion="默认",
        fallback=False,
        resolved_via="exact",
        language="Auto",
        speed=1.0,
    )


class FakePlayer:
    """Simulates a device that plays exactly as long as the audio it is given."""

    def __init__(self) -> None:
        self.events = []
        self.rate = None
        self.closed = False
        self.drained = False
        self.fail_on_write = None

    def open(self, sample_rate: int) -> None:
        self.rate = sample_rate
        self.events.append(("open", time.monotonic()))

    def write(self, audio, sample_rate: int) -> None:
        self.events.append(("write_start", time.monotonic()))
        time.sleep(len(audio) / float(sample_rate))
        if self.fail_on_write is not None:
            self.fail_on_write = None
            raise RuntimeError("device gone")
        self.events.append(("write_end", time.monotonic()))

    def write_silence(self, seconds: float) -> None:
        self.events.append(("silence", time.monotonic()))
        time.sleep(seconds)

    def drain(self) -> None:
        self.drained = True
        self.events.append(("drain", time.monotonic()))

    def close(self) -> None:
        self.closed = True
        self.events.append(("close", time.monotonic()))


class RecordingGenerator:
    """Thread-safe fake model: fixed latency, fixed-length audio, optional failure."""

    def __init__(self, gen_seconds: float = 0.05, fail_on: str = "") -> None:
        self.gen_seconds = gen_seconds
        self.fail_on = fail_on
        self.calls = []
        self._lock = threading.Lock()

    def __call__(self, job: SentenceJob):
        with self._lock:
            self.calls.append((job.segment_index, job.unit_index, time.monotonic()))
        time.sleep(self.gen_seconds)
        if self.fail_on and job.text == self.fail_on:
            raise RuntimeError("model exploded")
        return [0.0] * SENTENCE_SAMPLES, SAMPLE_RATE


def run(jobs, generate=None, player=None, gap_ms=120, on_segment=None, started_at=None):
    events = []
    pipeline = SpeechPipeline(
        generate=generate or RecordingGenerator(),
        player=player or FakePlayer(),
        emit=lambda name, **fields: events.append((name, fields)),
    )
    started = time.monotonic() if started_at is None else started_at
    result = pipeline.run(
        jobs, "req-1", gap_ms=gap_ms, on_segment=on_segment, started_at=started
    )
    return result, events


class PipelineTests(unittest.TestCase):
    def test_two_segments_two_sentences_each(self) -> None:
        jobs = [
            job(0, 0, 2, "第一句。"),
            job(0, 1, 2, "第二句。"),
            job(1, 0, 2, "第三句。"),
            job(1, 1, 2, "第四句。"),
        ]
        player = FakePlayer()
        result, events = run(jobs, player=player)

        names = [name for name, _ in events]
        self.assertEqual(names.count("segment_start"), 2)
        self.assertEqual(names.count("sentence_end"), 4)
        self.assertEqual(names.count("segment_end"), 2)
        self.assertEqual(names.index("segment_start"), 0)
        self.assertEqual(names[-1], "segment_end")

        self.assertAlmostEqual(result.total_seconds, 0.8, places=3)
        self.assertEqual([round(s.seconds, 3) for s in result.segments], [0.4, 0.4])
        self.assertEqual([s.sentences for s in result.segments], [2, 2])
        self.assertEqual(
            [dict(fields)["sentenceIndex"] for name, fields in events if name == "sentence_end"],
            [0, 1, 0, 1],
        )
        for name, fields in events:
            if name == "sentence_end":
                self.assertAlmostEqual(fields["audioSec"], SENTENCE_SECONDS, places=3)
                self.assertGreater(fields["genMs"], 0)
                self.assertGreaterEqual(fields["firstAudioMs"], 0)
                self.assertGreater(fields["rtf"], 0)
        self.assertTrue(player.drained)
        self.assertTrue(player.closed)
        self.assertEqual(player.rate, SAMPLE_RATE)

    def test_playback_of_sentence_one_overlaps_generation_of_two(self) -> None:
        jobs = [job(0, 0, 2, "甲。"), job(0, 1, 2, "乙。")]
        generate = RecordingGenerator(gen_seconds=0.15)
        player = FakePlayer()
        result, _events = run(jobs, generate=generate, player=player)

        write_ends = [t for kind, t in player.events if kind == "write_end"]
        self.assertEqual(len(write_ends), 2)
        second_gen_started = generate.calls[1][2]
        self.assertLess(
            second_gen_started,
            write_ends[0],
            "generation of sentence 2 must start while sentence 1 is still playing",
        )
        self.assertGreaterEqual(result.first_audio_ms or 0, 0)

    def test_first_audio_ms_is_measured_from_the_supplied_start(self) -> None:
        jobs = [job(0, 0, 1, "甲。")]
        started = time.monotonic() - 0.5
        _result, events = run(jobs, started_at=started)
        first = [fields for name, fields in events if name == "sentence_end"][0]
        self.assertGreaterEqual(first["firstAudioMs"], 500)

    def test_gap_silence_only_between_segments(self) -> None:
        jobs = [job(0, 0, 1, "甲。"), job(1, 0, 1, "乙。")]
        player = FakePlayer()
        _result, _events = run(jobs, player=player, gap_ms=100)
        kinds = [kind for kind, _t in player.events]
        self.assertEqual(kinds.count("silence"), 1)
        self.assertLess(kinds.index("silence"), kinds.index("close"))

    def test_generation_failure_is_reported_and_teardown_is_clean(self) -> None:
        jobs = [job(0, 0, 1, "甲。"), job(0, 1, 1, "炸。"), job(0, 2, 1, "丙。")]
        generate = RecordingGenerator(gen_seconds=0.01, fail_on="炸。")
        player = FakePlayer()
        with self.assertRaises(PipelineGenerateError) as caught:
            run(jobs, generate=generate, player=player)
        self.assertEqual(caught.exception.job.text, "炸。")
        self.assertTrue(player.closed)
        self.assertTrue(player.drained)
        # The sentence after the failure is never generated.
        self.assertEqual([call[1] for call in generate.calls], [0, 1])

    def test_playback_failure_stops_generation_immediately(self) -> None:
        jobs = [job(0, 0, 3, "甲。"), job(0, 1, 3, "乙。"), job(0, 2, 3, "丙。")]
        generate = RecordingGenerator(gen_seconds=0.05)
        player = FakePlayer()
        player.fail_on_write = True
        with self.assertRaises(PipelinePlaybackError):
            run(jobs, generate=generate, player=player)
        self.assertTrue(player.closed)
        self.assertLessEqual(len(generate.calls), 3)

    def test_segment_saver_receives_concatenated_chunks(self) -> None:
        jobs = [job(0, 0, 2, "甲。"), job(0, 1, 2, "乙。"), job(1, 0, 1, "丙。")]
        saved = []

        def on_segment(segment, chunks, sample_rate):
            saved.append((segment.index, sum(len(chunk) for chunk, _rate in chunks), sample_rate))
            return [f"/tmp/seg{segment.index}.wav"]

        result, _events = run(jobs, on_segment=on_segment)
        self.assertEqual(saved, [(0, SENTENCE_SAMPLES * 2, SAMPLE_RATE), (1, SENTENCE_SAMPLES, SAMPLE_RATE)])
        self.assertEqual(result.files(), ["/tmp/seg0.wav", "/tmp/seg1.wav"])
        self.assertEqual(result.segments[0].files, ["/tmp/seg0.wav"])

    def test_saver_failure_is_collected_not_raised(self) -> None:
        jobs = [job(0, 0, 1, "甲。")]

        def on_segment(segment, chunks, sample_rate):
            raise OSError("disk full")

        result, _events = run(jobs, on_segment=on_segment)
        self.assertEqual(len(result.save_errors), 1)
        self.assertEqual(result.save_errors[0][0], 0)
        self.assertAlmostEqual(result.total_seconds, SENTENCE_SECONDS, places=3)

    def test_null_player_writes_everything(self) -> None:
        jobs = [job(0, 0, 1, "甲。"), job(1, 0, 1, "乙。")]
        player = NullPlayer()
        result, events = run(jobs, player=player)
        self.assertEqual([name for name, _ in events].count("sentence_end"), 2)
        self.assertEqual(player.frames_written, SENTENCE_SAMPLES * 2)
        self.assertAlmostEqual(result.total_seconds, 0.4, places=3)

    def test_result_reports_rtf_from_generation_time(self) -> None:
        jobs = [job(0, 0, 1, "甲。")]
        result, _events = run(jobs, generate=RecordingGenerator(gen_seconds=0.1))
        self.assertAlmostEqual(result.gen_ms, 100, delta=40)
        self.assertAlmostEqual(result.rtf, result.gen_ms / (SENTENCE_SECONDS * 1000), places=3)
        self.assertLess(result.rtf, 1.0)

    def test_merged_unit_reports_display_sentences_once(self) -> None:
        # One generation unit speaks two sentences: one streamed call, one sentence_end
        # event carrying both, while segment counts stay the sentences a listener counts.
        jobs = [job(0, 0, 1, "今天天气不错。我们开始吧。", sentences=("今天天气不错。", "我们开始吧。"))]
        generate = RecordingGenerator()
        result, events = run(jobs, generate=generate)

        self.assertEqual(len(generate.calls), 1)
        sentence_events = [fields for name, fields in events if name == "sentence_end"]
        self.assertEqual(len(sentence_events), 1)
        self.assertEqual(sentence_events[0]["sentences"], 2)
        self.assertTrue(sentence_events[0]["merged"])
        self.assertEqual(sentence_events[0]["text"], "今天天气不错。我们开始吧。")

        start = [fields for name, fields in events if name == "segment_start"][0]
        self.assertEqual(start["sentences"], 2)
        segment_end = [fields for name, fields in events if name == "segment_end"][0]
        self.assertEqual(segment_end["sentences"], 2)
        self.assertEqual([segment.sentences for segment in result.segments], [2])


if __name__ == "__main__":
    unittest.main()
