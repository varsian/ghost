"""Sentence-level generation/playback pipeline (PROTOCOL.md §3.4, §4, §7.3).

One worker thread produces audio while the calling thread writes it to the
output device, so playback of the first audible samples starts before the rest
of the utterance exists and the device stream stays open across sentences and
segments.

Two generation styles use the same item model:

* **sentence** (upstream backend): ``generate(job)`` returns one audio buffer per
  sentence — the worker emits one chunk and then the end-of-sentence marker.
* **streaming** (fast backend): ``stream(job)`` yields audio chunks as the model
  produces them, so the first chunk is audible after TTFA instead of after the
  whole sentence; the marker is emitted when the generator is exhausted.

``sentence_end`` is emitted when a sentence's end-of-sentence marker is consumed,
i.e. after every sample of that sentence has been written to the device.

The module is pure stdlib and dependency-injected, so the same code path is
unit-tested with synthetic audio; ``ttslib.runtime`` supplies the torch and
sounddevice implementations.
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

_SENTINEL = object()


def _ms(value: float) -> int:
    return int(round(value))


def _sec(value: float) -> float:
    return round(value, 3)


def _ratio(value: float) -> float:
    return round(value, 3)


@dataclass
class SentenceJob:
    """One generation unit to synthesize: one model call, one or more display sentences.

    A unit carries the sentences the planner merged (``textsplit.plan_units``); one model
    call per unit keeps consecutive short sentences inside one acoustic context instead of
    sampling a fresh timbre per sentence.
    """

    segment_index: int
    unit_index: int
    unit_count: int
    sentences: Tuple[str, ...]
    text: str
    segment_text: str
    voice: Any
    requested_emotion: str
    used_emotion: str
    fallback: bool
    resolved_via: str
    language: str
    speed: Optional[float] = None
    #: Generation cap in engine tokens, derived from this unit's text length at plan
    #: time; reported on ``sentence_end`` so a length/duration trend can prove the cap
    #: neither clipped slow speech nor let a runaway tail through.
    max_len: int = 0

    @property
    def merged(self) -> bool:
        """Whether this unit speaks more than one display sentence."""
        return len(self.sentences) > 1


@dataclass
class SentenceResult:
    """Per-sentence generation + playback measurements."""

    job: SentenceJob
    gen_ms: float = 0.0
    audio_sec: float = 0.0
    rtf: float = 0.0
    first_audio_ms: Optional[float] = None
    sample_rate: Optional[int] = None
    chunks: int = 0
    max_new_tokens: Optional[int] = None


@dataclass
class SegmentResult:
    """Per-segment aggregate reported in ``segment_end`` / ``speak_done``."""

    index: int
    requested_emotion: str
    used_emotion: str
    fallback: bool
    resolved_via: str
    sentences: int
    text: str
    seconds: float = 0.0
    files: List[str] = field(default_factory=list)

    def to_event(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "requestedEmotion": self.requested_emotion,
            "usedEmotion": self.used_emotion,
            "fallback": self.fallback,
            "seconds": _sec(self.seconds),
            "sentences": self.sentences,
            "files": list(self.files),
        }


@dataclass
class PipelineResult:
    """Everything the daemon needs to emit ``speak_done``."""

    segments: List[SegmentResult] = field(default_factory=list)
    sentences: List[SentenceResult] = field(default_factory=list)
    total_seconds: float = 0.0
    gen_ms: float = 0.0
    played_ms: float = 0.0
    first_audio_ms: Optional[float] = None
    save_errors: List[Tuple[int, BaseException]] = field(default_factory=list)
    model_sample_rate: Optional[int] = None

    @property
    def rtf(self) -> float:
        audio_ms = self.total_seconds * 1000.0
        if audio_ms <= 0:
            return 0.0
        return self.gen_ms / audio_ms

    def files(self) -> List[str]:
        out: List[str] = []
        for segment in self.segments:
            out.extend(segment.files)
        return out


class PipelineGenerateError(Exception):
    """Model generation failed for one sentence."""

    def __init__(self, job: SentenceJob, cause: BaseException) -> None:
        super().__init__(f"generation failed for unit {job.unit_index} of segment {job.segment_index}: {cause}")
        self.job = job
        self.cause = cause


class PipelinePlaybackError(Exception):
    """The output device refused or aborted playback."""

    def __init__(self, cause: BaseException) -> None:
        super().__init__(f"playback failed: {cause}")
        self.cause = cause


class NullPlayer:
    """``play:false`` sink: consumes audio, reports it as fully written."""

    def __init__(self) -> None:
        self.sample_rate: Optional[int] = None
        self.frames_written = 0

    def open(self, sample_rate: int) -> None:
        self.sample_rate = int(sample_rate)

    def write(self, audio: Any, sample_rate: int) -> None:
        self.frames_written += int(len(audio))

    def write_silence(self, seconds: float) -> None:
        return None

    def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


@dataclass
class _Item:
    """One playback unit: a chunk of audio, or an end-of-sentence marker."""

    pos: int
    audio: Any
    sample_rate: int
    final: bool = False
    gen_ms: float = 0.0


class SpeechPipeline:
    """Runs sentences through a generation thread and a playback loop.

    ``generate(job) -> (audio, sample_rate)`` synthesizes a whole sentence;
    ``stream(job) -> iterable[(audio, sample_rate)]`` yields chunks instead. The
    worker thread calls exactly one of them per sentence, never both. ``player``
    implements ``open``/``write``/``write_silence``/``drain``/``close`` and is
    only touched by the calling thread. ``emit(name, **fields)`` receives
    protocol events.
    """

    def __init__(
        self,
        player: Any,
        emit: Callable[..., Any],
        generate: Optional[Callable[[SentenceJob], Tuple[Any, int]]] = None,
        stream: Optional[Callable[[SentenceJob], Iterable[Tuple[Any, int]]]] = None,
        clock: Callable[[], float] = time.monotonic,
        log: Optional[Callable[[str], None]] = None,
        join_timeout: float = 30.0,
        queue_depth: Optional[int] = None,
    ) -> None:
        if generate is None and stream is None:
            raise ValueError("SpeechPipeline needs generate or stream")
        self._generate = generate
        self._stream = stream
        self._player = player
        self._emit = emit
        self._clock = clock
        self._log = log or (lambda _msg: None)
        self._join_timeout = join_timeout
        self._queue_depth = int(queue_depth) if queue_depth else (4 if stream is not None else 1)

    # ------------------------------------------------------------------ run

    def run(
        self,
        jobs: Sequence[SentenceJob],
        request_id: Optional[str],
        gap_ms: int = 120,
        on_segment: Optional[Callable[[SegmentResult, List[Tuple[Any, int]], int], List[str]]] = None,
        started_at: Optional[float] = None,
    ) -> PipelineResult:
        """Generate and play ``jobs`` in order; returns the measured result."""
        start = started_at if started_at is not None else self._clock()
        result = PipelineResult()
        result.segments = _segment_results(jobs)
        # Keyed by the units' own segment index: a segment whose text normalized to nothing
        # contributes no units and therefore no SegmentResult, so indexing the compact list by
        # segment index would crash on the next segment.
        segments_by_index = {segment.index: segment for segment in result.segments}
        result.sentences = [SentenceResult(job=job) for job in jobs]

        work: "queue.Queue[Any]" = queue.Queue(maxsize=max(1, self._queue_depth))
        stop = threading.Event()
        gen_errors: List[PipelineGenerateError] = []
        chunks: Dict[int, List[Tuple[Any, int]]] = {job.segment_index: [] for job in jobs}

        def produce(job: SentenceJob) -> Iterator[Tuple[Any, int]]:
            if self._stream is not None:
                yield from self._stream(job)
                return
            assert self._generate is not None
            yield self._generate(job)

        # Display sentences per segment: units merge sentences, but the reported sentence
        # count stays the number of sentences a listener would count.
        segment_sentences: Dict[int, int] = {}
        for job in jobs:
            segment_sentences[job.segment_index] = segment_sentences.get(job.segment_index, 0) + len(job.sentences)

        def worker() -> None:
            last_segment: Optional[int] = None
            try:
                for pos, job in enumerate(jobs):
                    if stop.is_set():
                        break
                    if job.segment_index != last_segment:
                        last_segment = job.segment_index
                        self._emit(
                            "segment_start",
                            id=request_id,
                            index=job.segment_index,
                            requestedEmotion=job.requested_emotion,
                            usedEmotion=job.used_emotion,
                            fallback=job.fallback,
                            text=job.segment_text,
                            sentences=segment_sentences.get(job.segment_index, 0),
                        )
                    entry = result.sentences[pos]
                    entry.max_new_tokens = job.max_len or None
                    started = self._clock()
                    try:
                        for chunk, sample_rate in produce(job):
                            if chunk is None or len(chunk) == 0:
                                continue
                            entry.chunks += 1
                            if entry.sample_rate is None:
                                entry.sample_rate = int(sample_rate)
                                if result.model_sample_rate is None:
                                    result.model_sample_rate = int(sample_rate)
                            if not _offer(work, _Item(pos, chunk, int(sample_rate)), stop):
                                return
                    except BaseException as exc:  # noqa: BLE001 - reported as GENERATE_FAILED
                        gen_errors.append(PipelineGenerateError(job, exc))
                        break
                    gen_ms = (self._clock() - started) * 1000.0
                    if not _offer(work, _Item(pos, None, entry.sample_rate or 24000, True, gen_ms), stop):
                        return
            finally:
                _offer(work, _SENTINEL, stop, force=True)

        thread = threading.Thread(target=worker, name="tts-generate", daemon=True)
        thread.start()

        playback_error: Optional[BaseException] = None
        opened = False
        write_started: Optional[float] = None
        gap_seconds = max(0, int(gap_ms)) / 1000.0
        last_segment_index = result.segments[-1].index if result.segments else None

        try:
            while True:
                item = work.get()
                if item is _SENTINEL:
                    break
                entry = result.sentences[item.pos]
                job = entry.job
                if item.audio is not None:
                    if not opened:
                        try:
                            self._player.open(item.sample_rate)
                        except BaseException as exc:  # noqa: BLE001 - reported as PLAYBACK_FAILED
                            playback_error = exc
                            stop.set()
                            break
                        opened = True
                    t_write = self._clock()
                    if write_started is None:
                        write_started = t_write
                    try:
                        self._player.write(item.audio, item.sample_rate)
                    except BaseException as exc:  # noqa: BLE001 - reported as PLAYBACK_FAILED
                        playback_error = exc
                        stop.set()
                        break
                    if entry.first_audio_ms is None:
                        entry.first_audio_ms = (t_write - start) * 1000.0
                        if result.first_audio_ms is None:
                            result.first_audio_ms = entry.first_audio_ms
                    entry.audio_sec += float(len(item.audio)) / float(item.sample_rate)
                    chunks[job.segment_index].append((item.audio, item.sample_rate))

                if not item.final:
                    continue

                entry.gen_ms = item.gen_ms
                entry.rtf = (entry.gen_ms / (entry.audio_sec * 1000.0)) if entry.audio_sec > 0 else 0.0
                self._emit(
                    "sentence_end",
                    id=request_id,
                    index=job.segment_index,
                    sentenceIndex=job.unit_index,
                    usedEmotion=job.used_emotion,
                    language=job.language,
                    text=job.text,
                    chars=len(job.text),
                    maxLen=int(entry.max_new_tokens or 0),
                    sentences=len(job.sentences),
                    merged=job.merged,
                    genMs=_ms(entry.gen_ms),
                    audioSec=_sec(entry.audio_sec),
                    rtf=_ratio(entry.rtf),
                    firstAudioMs=_ms(entry.first_audio_ms or 0.0),
                    chunks=entry.chunks,
                )

                if job.unit_index == job.unit_count - 1:
                    segment = segments_by_index[job.segment_index]
                    segment.seconds = sum(
                        s.audio_sec for s in result.sentences if s.job.segment_index == job.segment_index
                    )
                    if on_segment is not None:
                        try:
                            segment.files = list(
                                on_segment(segment, chunks[job.segment_index], entry.sample_rate or 24000) or []
                            )
                        except BaseException as exc:  # noqa: BLE001 - reported as SAVE_FAILED
                            result.save_errors.append((job.segment_index, exc))
                    self._emit(
                        "segment_end",
                        id=request_id,
                        index=segment.index,
                        requestedEmotion=segment.requested_emotion,
                        usedEmotion=segment.used_emotion,
                        fallback=segment.fallback,
                        seconds=_sec(segment.seconds),
                        sentences=segment.sentences,
                    )
                    if gap_seconds > 0 and job.segment_index != last_segment_index:
                        try:
                            self._player.write_silence(gap_seconds)
                        except BaseException as exc:  # noqa: BLE001 - reported as PLAYBACK_FAILED
                            playback_error = exc
                            stop.set()
                            break
        finally:
            stop.set()
            _drain_queue(work, thread, self._join_timeout)
            try:
                if opened:
                    self._player.drain()
            except BaseException as exc:  # noqa: BLE001 - drain failure is still a playback failure
                if playback_error is None:
                    playback_error = exc
            try:
                self._player.close()
            except BaseException as exc:  # noqa: BLE001 - close must not mask the real error
                self._log(f"player close failed: {exc!r}")

        if write_started is not None:
            result.played_ms = (self._clock() - write_started) * 1000.0
        result.total_seconds = sum(s.audio_sec for s in result.sentences)
        result.gen_ms = sum(s.gen_ms for s in result.sentences)

        if playback_error is not None:
            raise PipelinePlaybackError(playback_error)
        if gen_errors:
            raise gen_errors[0]
        return result


def _segment_results(jobs: Sequence[SentenceJob]) -> List[SegmentResult]:
    """One SegmentResult per segment that has units, in first-appearance order.

    A segment whose text normalized to nothing contributes no jobs; it must not shift the
    indices of the segments after it, so results are keyed by the units' own segment index
    instead of by list position.
    """
    counts: Dict[int, int] = {}
    for job in jobs:
        counts[job.segment_index] = counts.get(job.segment_index, 0) + len(job.sentences)
    out: List[SegmentResult] = []
    by_index: Dict[int, SegmentResult] = {}
    for job in jobs:
        if job.segment_index in by_index:
            continue
        result = SegmentResult(
            index=job.segment_index,
            requested_emotion=job.requested_emotion,
            used_emotion=job.used_emotion,
            fallback=job.fallback,
            resolved_via=job.resolved_via,
            sentences=counts.get(job.segment_index, 0),
            text=job.segment_text,
        )
        by_index[job.segment_index] = result
        out.append(result)
    return out


def _offer(work: "queue.Queue[Any]", item: Any, stop: threading.Event, force: bool = False) -> bool:
    """Put an item, giving up when playback has already stopped."""
    while True:
        try:
            work.put(item, timeout=0.1)
            return True
        except queue.Full:
            if stop.is_set() and not force:
                return False


def _drain_queue(work: "queue.Queue[Any]", thread: threading.Thread, timeout: float) -> None:
    """Unblock the worker's final put, then join it."""
    deadline = time.monotonic() + max(1.0, timeout)
    while thread.is_alive() and time.monotonic() < deadline:
        try:
            work.get(timeout=0.05)
        except queue.Empty:
            continue
        except Exception:  # noqa: BLE001 - defensive: never hang teardown
            break
    thread.join(timeout=1.0)
