"""Silence trimming and runaway-tail caps (silence-trimming requirement)."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ttslib.hygiene import (  # noqa: E402
    StreamTrimmer,
    audible_span,
    cap_seconds,
    gate_amplitude,
    max_new_tokens_for,
    trim_edges,
)

try:
    import numpy as np  # type: ignore
except Exception:  # noqa: BLE001 - numpy is a runtime dependency, not a test one
    np = None

RATE = 24000


def tone(seconds: float, amplitude: float = 0.2) -> "np.ndarray":
    frames = int(seconds * RATE)
    timeline = np.arange(frames, dtype=np.float32) / RATE
    return (amplitude * np.sin(2.0 * np.pi * 220.0 * timeline)).astype(np.float32)


def silence(seconds: float) -> "np.ndarray":
    return np.zeros(int(seconds * RATE), dtype=np.float32)


@unittest.skipUnless(np is not None, "numpy is not installed")
class TrimTests(unittest.TestCase):
    def test_trims_leading_and_trailing_silence_keeping_pad(self) -> None:
        audio = np.concatenate([silence(0.5), tone(1.0), silence(0.8)])
        result = trim_edges(audio, RATE, gate_db=-45.0, pad_ms=40.0)
        self.assertAlmostEqual(result.head_sec, 0.46, places=2)
        self.assertAlmostEqual(result.tail_sec, 0.76, places=2)
        self.assertAlmostEqual(result.audio.shape[0] / RATE, 1.08, places=2)

    def test_audio_with_no_silence_is_unchanged(self) -> None:
        audio = tone(0.5)
        result = trim_edges(audio, RATE)
        self.assertEqual(result.trimmed_sec, 0.0)
        self.assertEqual(result.audio.shape[0], audio.shape[0])

    def test_fully_silent_audio_is_not_deleted(self) -> None:
        audio = silence(0.5)
        result = trim_edges(audio, RATE)
        self.assertEqual(result.trimmed_sec, 0.0)
        self.assertEqual(result.audio.shape[0], audio.shape[0])

    def test_gate_amplitude(self) -> None:
        self.assertAlmostEqual(gate_amplitude(-45.0), 0.005623, places=6)
        self.assertAlmostEqual(gate_amplitude(0.0), 1.0, places=6)

    def test_audible_span(self) -> None:
        audio = np.concatenate([silence(0.1), tone(0.2), silence(0.1)])
        start, end = audible_span(audio, RATE, gate_db=-45.0)
        self.assertAlmostEqual(start / RATE, 0.1, places=2)
        self.assertAlmostEqual(end / RATE, 0.3, places=2)


@unittest.skipUnless(np is not None, "numpy is not installed")
class StreamTrimmerTests(unittest.TestCase):
    def make(self, **kwargs) -> StreamTrimmer:
        defaults = dict(sample_rate=RATE, gate_db=-45.0, pad_ms=40.0, max_trailing_ms=400.0)
        defaults.update(kwargs)
        return StreamTrimmer(**defaults)

    def test_leading_silence_is_dropped_and_tone_kept(self) -> None:
        trimmer = self.make()
        first = trimmer.push(np.concatenate([silence(0.3), tone(0.1)]))
        self.assertIsNotNone(first)
        # 0.1 s of tone plus the 40 ms onset pad before the first audible sample.
        self.assertAlmostEqual(len(first) / RATE, 0.14, places=2)
        self.assertAlmostEqual(trimmer.trimmed_sec, 0.26, places=2)

    def test_leading_silence_chunks_are_dropped_whole(self) -> None:
        trimmer = self.make()
        self.assertIsNone(trimmer.push(silence(0.2)))
        self.assertIsNone(trimmer.push(silence(0.2)))
        self.assertAlmostEqual(trimmer.trimmed_sec, 0.4, places=2)
        self.assertIsNotNone(trimmer.push(tone(0.1)))

    def test_trailing_silence_is_capped(self) -> None:
        trimmer = self.make()
        trimmer.push(tone(0.5))
        kept = []
        for _ in range(10):
            chunk = trimmer.push(silence(0.2))
            kept.append(0 if chunk is None else len(chunk))
        self.assertAlmostEqual(sum(kept) / RATE, 0.4, places=2)
        self.assertGreater(trimmer.trimmed_sec, 1.5)

    def test_silence_between_words_is_preserved(self) -> None:
        trimmer = self.make()
        trimmer.push(tone(0.3))
        gap = trimmer.push(silence(0.2))
        self.assertEqual(len(gap), int(0.2 * RATE))
        self.assertEqual(trimmer.trimmed_sec, 0.0)

    def test_finish_drops_everything_after(self) -> None:
        trimmer = self.make()
        trimmer.push(tone(0.3))
        trimmer.finish()
        self.assertIsNone(trimmer.push(tone(0.3)))
        self.assertGreater(trimmer.trimmed_sec, 0.29)


class TokenCapTests(unittest.TestCase):
    def test_short_sentence_gets_the_floor(self) -> None:
        self.assertEqual(max_new_tokens_for("你好"), 96)

    def test_long_sentence_scales_with_length(self) -> None:
        text = "这是一段比较长的测试文本。" * 6  # 78 characters
        self.assertEqual(max_new_tokens_for(text), int(round(len(text) * 3.2)) + 36)
        self.assertLessEqual(max_new_tokens_for(text), 512)

    def test_ceiling_is_respected(self) -> None:
        self.assertEqual(max_new_tokens_for("字" * 10000), 512)

    def test_cap_seconds_uses_the_625hz_token_rate(self) -> None:
        self.assertAlmostEqual(cap_seconds(62.5), 10.0, places=3)


if __name__ == "__main__":
    unittest.main()
