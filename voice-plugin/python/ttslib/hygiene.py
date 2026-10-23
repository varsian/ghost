"""Audio hygiene: silence trimming and runaway-tail caps (silence-trimming requirement).

Two defects showed up on the first locally installed voice model, and both are
handled here, per sentence: dead air before/after the spoken words, and occasional
runaway generation.

* :func:`trim_edges` removes leading/trailing silence below a noise gate while
  keeping ``pad_ms`` of natural breath on each side — the reported ``seconds``
  are post-trim audible audio.
* :class:`StreamTrimmer` does the same for the streaming backend without
  buffering a whole sentence: leading silence is dropped from the first chunks
  and a trailing silence run longer than ``max_trailing_ms`` is truncated.
* :func:`max_new_tokens_for` derives a generation cap from the text length so a
  runaway tail cannot cost more than a bounded amount of compute.

Caps are expressed in VoxCPM 1.5 language-model tokens: the model emits audio at
6.25 tokens per second of speech (patch size 4 over a 44.1 kHz AudioVAE), and its
own bad-case retry is disabled while streaming, so this cap plus the host's audio
and wall-clock guards are the runaway protection on that path.

Only ``numpy`` is required, imported lazily.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Tuple

GATE_DB_DEFAULT = -45.0
PAD_MS_DEFAULT = 40.0
MAX_TRAILING_MS_DEFAULT = 400.0
FRAMES_PER_CHAR_DEFAULT = 3.2
FRAMES_FLOOR = 96
FRAMES_CEILING = 512
#: VoxCPM 1.5 emits 6.25 language-model tokens per second of generated audio.
FRAMES_PER_SECOND = 6.25


def _numpy():
    import numpy as np  # type: ignore

    return np


def gate_amplitude(gate_db: float) -> float:
    """Linear amplitude of a dBFS gate (``-45`` dB → ~0.0056)."""
    return float(10.0 ** (float(gate_db) / 20.0))


@dataclass(frozen=True)
class TrimResult:
    """A trimmed waveform plus how much silence was removed."""

    audio: Any
    head_sec: float
    tail_sec: float

    @property
    def trimmed_sec(self) -> float:
        return self.head_sec + self.tail_sec


def audible_span(array: Any, sample_rate: int, gate_db: float = GATE_DB_DEFAULT) -> Tuple[int, int]:
    """Indices of the first/last sample above the gate; ``(0, 0)`` when silent."""
    np = _numpy()
    if array is None or len(array) == 0:
        return (0, 0)
    threshold = gate_amplitude(gate_db)
    loud = np.flatnonzero(np.abs(np.asarray(array, dtype=np.float32)) >= threshold)
    if loud.size == 0:
        return (0, 0)
    return (int(loud[0]), int(loud[-1]) + 1)


def trim_edges(
    array: Any,
    sample_rate: int,
    gate_db: float = GATE_DB_DEFAULT,
    pad_ms: float = PAD_MS_DEFAULT,
) -> TrimResult:
    """Trim leading/trailing sub-gate silence, keeping ``pad_ms`` of padding."""
    np = _numpy()
    samples = np.asarray(array, dtype=np.float32).reshape(-1)
    if samples.size == 0 or sample_rate <= 0:
        return TrimResult(samples, 0.0, 0.0)
    start, end = audible_span(samples, sample_rate, gate_db)
    if end <= start:
        return TrimResult(samples, 0.0, 0.0)
    pad = max(0, int(round(float(pad_ms) * sample_rate / 1000.0)))
    first = max(0, start - pad)
    last = min(samples.size, end + pad)
    if first == 0 and last == samples.size:
        return TrimResult(samples, 0.0, 0.0)
    head_sec = first / float(sample_rate)
    tail_sec = (samples.size - last) / float(sample_rate)
    return TrimResult(samples[first:last], head_sec, tail_sec)


class StreamTrimmer:
    """Stateful trimmer for a per-sentence stream of audio chunks.

    ``push`` returns the audio that should be written (possibly ``None`` when a
    chunk is entirely leading silence or fully caught by the trailing cap).
    Leading silence is skipped until the first audible sample; after that, a
    silence run longer than ``max_trailing_ms`` is dropped, which caps dead air
    without waiting for the end of the sentence.
    """

    def __init__(
        self,
        sample_rate: int,
        gate_db: float = GATE_DB_DEFAULT,
        pad_ms: float = PAD_MS_DEFAULT,
        max_trailing_ms: float = MAX_TRAILING_MS_DEFAULT,
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.gate_db = float(gate_db)
        self.pad_ms = float(pad_ms)
        self.max_trailing_ms = float(max_trailing_ms)
        self.trimmed_sec = 0.0
        self._started = False
        self._silence_run = 0
        self._ended = False

    def _threshold(self, chunk: Any) -> float:
        return gate_amplitude(self.gate_db)

    def push(self, chunk: Any, sample_rate: Optional[int] = None) -> Any:
        """Return the audio to write for this chunk (``None`` = all trimmed)."""
        np = _numpy()
        samples = np.asarray(chunk, dtype=np.float32).reshape(-1)
        rate = int(sample_rate or self.sample_rate)
        if samples.size == 0:
            return None
        if self._ended:
            self.trimmed_sec += samples.size / float(rate)
            return None
        if rate != self.sample_rate:
            self.sample_rate = rate
        threshold = self._threshold(samples)
        loud = np.abs(samples) >= threshold

        if not self._started:
            first = int(np.argmax(loud)) if bool(loud.any()) else -1
            if first < 0:
                # Leading silence is dropped entirely: nothing is audible yet, so
                # writing it would only delay the first real sample.
                self.trimmed_sec += samples.size / float(rate)
                return None
            pad = max(0, int(round(self.pad_ms * rate / 1000.0)))
            trim = max(0, first - pad)
            self._started = True
            self.trimmed_sec += trim / float(rate)
            return samples[trim:]

        if not bool(loud.any()):
            self._silence_run += samples.size
            cap = int(round(self.max_trailing_ms * rate / 1000.0))
            allowed = max(0, cap - (self._silence_run - samples.size))
            keep = min(samples.size, allowed)
            self.trimmed_sec += (samples.size - keep) / float(rate)
            return samples[:keep] if keep > 0 else None

        # Audible content in this chunk: release the accumulated trailing silence.
        first = int(np.argmax(loud))
        if self._silence_run > 0:
            cap = int(round(self.max_trailing_ms * rate / 1000.0))
            allowed = min(self._silence_run, cap)
            self.trimmed_sec += max(0, self._silence_run - allowed) / float(rate)
        self._silence_run = 0
        return samples

    def finish(self) -> None:
        """Close the sentence; further pushes are counted as trimmed."""
        self._ended = True

    def snapshot(self) -> float:
        return self.trimmed_sec


def max_new_tokens_for(
    text: str,
    frames_per_char: float = FRAMES_PER_CHAR_DEFAULT,
    floor: int = FRAMES_FLOOR,
    ceiling: int = FRAMES_CEILING,
) -> int:
    """Generation cap derived from text length (6.25 Hz LM tokens).

    A Chinese character is normally well under a second of speech;
    ``frames_per_char`` is the generous per-character allowance used to bound
    runaway tails, the floor keeps short sentences from being clipped, and the
    ceiling keeps one unit from ever asking for an unbounded generation.
    """
    chars = len(text or "")
    value = FRAMES_FLOOR if floor <= 0 else floor
    value = max(value, int(round(chars * float(frames_per_char))) + 36)
    return int(min(max(value, floor or 1), ceiling))


def cap_seconds(max_new_tokens: int) -> float:
    """Audible seconds a token cap can produce at 6.25 tokens per second."""
    return float(max_new_tokens) / FRAMES_PER_SECOND
