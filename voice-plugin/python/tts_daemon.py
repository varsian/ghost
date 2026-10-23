#!/usr/bin/env python3
"""VoxCPM 1.5 engine for the DSH ``tts`` tool (PROTOCOL.md §4-§7, §9).

Long-lived daemon owned by the TypeScript plugin: it reads one JSON request per
line on stdin, writes one JSON event per line on stdout, keeps the voice model
resident across calls, and streams audio unit by unit while it plays.

The engine clones one reference voice: ``--voices-dir`` names the folder holding
exactly one audio file and its same-stem transcript. Per-segment emotion values are
labels forwarded on the protocol events (Live2D expressions); they never select a
different reference recording.

Run:

    <python> tts_daemon.py --voices-dir "<VOICES_DIR>" --default-emotion 默认 \\
        --model-dir "<MODELS_DIR>" --device cuda:0 \\
        --cfg-value 2.7 --timesteps 15 --optimize false --normalize true \\
        --cache-dir "<CACHE_DIR>" --max-sentence-chars 60 \\
        --idle-unload-sec 1800 --preload false
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ttslib import runtime  # noqa: E402
from ttslib.events import EventWriter  # noqa: E402
from ttslib.hygiene import (  # noqa: E402
    GATE_DB_DEFAULT,
    MAX_TRAILING_MS_DEFAULT,
    PAD_MS_DEFAULT,
    FRAMES_PER_CHAR_DEFAULT,
    StreamTrimmer,
    cap_seconds,
    trim_edges,
)
from ttslib.pipeline import (  # noqa: E402
    NullPlayer,
    PipelineGenerateError,
    PipelinePlaybackError,
    SentenceJob,
    SpeechPipeline,
)
from ttslib.textsplit import (  # noqa: E402
    MERGE_MODES,
    detect_language,
    has_cjk_script,
    normalize_text,
    plan_units,
    split_long,
    split_sentences,
    split_units_by_language,
    unsupported_script_ratio,
)
from ttslib.voices import VoiceLibrary  # noqa: E402

VERSION = "1.0.0"
ERROR_CODES = (
    "BAD_JSON",
    "BAD_REQUEST",
    "NO_VOICES",
    "MODEL_LOAD_FAILED",
    "GENERATE_FAILED",
    "PLAYBACK_FAILED",
    "SAVE_FAILED",
    "INTERNAL",
)
_BAD_FILENAME_CHARS = '<>:"/\\|?*'
#: Text is speakable only when it carries a word character: punctuation-only,
#: whitespace-only and emoji-only segments are skipped like empty ones.
_SPEAKABLE_RE = re.compile(r"\w")
#: What the engine can speak. Requests cannot name a language: VoxCPM 1.5 infers it
#: from the text, so a segment's script is checked here instead and anything else is
#: refused rather than read out as Chinese.
_SUPPORTED_LANGUAGES = "Chinese and English"
#: Share of a segment's letters that may belong to an unsupported script before the
#: call fails instead of being read out as Chinese.
UNSUPPORTED_SCRIPT_LIMIT = 0.2


def str2bool(value: Any) -> bool:
    """Accept ``--preload true`` and ``--preload`` alike."""
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def _as_text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def _as_float(value: Any, default: Optional[float]) -> Optional[float]:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value: Any, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def build_parser() -> argparse.ArgumentParser:
    """Command line per PROTOCOL.md §4."""
    parser = argparse.ArgumentParser(prog="tts_daemon.py", description="VoxCPM 1.5 engine for the DSH tts tool")
    parser.add_argument(
        "--voices-dir",
        required=True,
        help="folder holding the single reference voice: one audio file plus its same-stem .txt transcript",
    )
    parser.add_argument(
        "--default-emotion",
        default="默认",
        help="accepted for config compatibility; the engine reports 默认 as the default label",
    )
    parser.add_argument("--model-dir", default="", help="VoxCPM 1.5 model directory (weights, config and tokenizer)")
    parser.add_argument(
        "--device",
        default="cuda:0",
        help="CUDA device made current before the weights load; voxcpm 1.5 selects the device itself, "
             "so only cuda:N is supported",
    )
    parser.add_argument("--cfg-value", type=float, default=2.7, help="VoxCPM CFG guidance scale (1.0-3.0 recommended)")
    parser.add_argument("--timesteps", type=int, default=10, help="VoxCPM LocDiT inference timesteps (4-30 recommended)")
    parser.add_argument(
        "--optimize",
        type=str2bool,
        nargs="?",
        const=True,
        default=False,
        help="torch.compile the model: needs triton on Windows, and its CUDA graphs cannot run on the "
             "generation thread",
    )
    parser.add_argument(
        "--normalize",
        type=str2bool,
        nargs="?",
        const=True,
        default=False,
        help="run VoxCPM's own text normalization (numbers and abbreviations) before generation",
    )
    parser.add_argument("--cache-dir", default="", help="cache for the default WAV output")
    parser.add_argument("--save-dir", default="", help="default WAV output directory")
    parser.add_argument("--max-sentence-chars", type=int, default=60, help="0 disables the sentence length cap")
    parser.add_argument(
        "--first-sentence-max-chars",
        type=int,
        default=20,
        help="re-split each segment's first sentence shorter to keep first-audio latency low (0 disables)",
    )
    parser.add_argument(
        "--merge-sentences",
        default="short",
        choices=list(MERGE_MODES),
        help="merge adjacent short sentences into ONE generation so consecutive short "
             "utterances keep one voice: off | short | all (merging never crosses a segment)",
    )
    parser.add_argument(
        "--merge-max-chars",
        type=int,
        default=0,
        help="character bound one merged generation unit may reach (0 = use --max-sentence-chars)",
    )
    parser.add_argument(
        "--short-sentence-chars",
        type=int,
        default=20,
        help="under `short` merging, a sentence at most this long may join the previous unit",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=0,
        help=">0 reseeds torch before every generation: reproducible for the same text, "
             "but it does NOT make different short sentences match — merging does that",
    )
    parser.add_argument(
        "--stream",
        type=str2bool,
        nargs="?",
        const=True,
        default=True,
        help="play audio as the model produces chunks instead of waiting for a whole unit",
    )
    parser.add_argument(
        "--max-audio-multiple",
        type=float,
        default=3.0,
        help="abort streaming generation once produced audio exceeds this multiple of the expected duration",
    )
    parser.add_argument(
        "--max-audio-floor-sec",
        type=float,
        default=6.0,
        help="absolute floor for the runaway-audio abort, so short sentences are not cut off",
    )
    parser.add_argument(
        "--max-generation-sec",
        type=float,
        default=90.0,
        help="wall-clock guard: abort a streaming generation that runs longer than this",
    )
    parser.add_argument(
        "--chars-per-second",
        type=float,
        default=3.3,
        help="expected speaking rate used for the runaway-audio abort (characters per second)",
    )
    parser.add_argument("--silence-gate-db", type=float, default=GATE_DB_DEFAULT, help="noise gate for leading/trailing silence")
    parser.add_argument("--silence-pad-ms", type=float, default=PAD_MS_DEFAULT, help="silence kept on each side of the speech")
    parser.add_argument(
        "--max-trailing-silence-ms",
        type=float,
        default=MAX_TRAILING_MS_DEFAULT,
        help="cap on a trailing silence run while streaming",
    )
    parser.add_argument(
        "--max-frames-per-char",
        type=float,
        default=FRAMES_PER_CHAR_DEFAULT,
        help="runaway-tail cap: 6.25 Hz LM tokens allowed per character of text",
    )
    parser.add_argument("--idle-unload-sec", type=int, default=1800, help="0 disables idle unload")
    parser.add_argument("--preload", type=str2bool, nargs="?", const=True, default=False)
    parser.add_argument(
        "--warmup",
        type=str2bool,
        nargs="?",
        const=True,
        default=True,
        help="run a throwaway synthesis after the cold load so the first sentence is not slow",
    )
    parser.add_argument("--output-device", default="", help="sounddevice output device (empty = system default)")
    return parser


class TtsDaemon:
    """Wire protocol state machine around the voice library, model and pipeline."""

    def __init__(self, args: argparse.Namespace, writer: EventWriter) -> None:
        self.args = args
        self.writer = writer
        self.voices = VoiceLibrary(
            args.voices_dir,
            default_emotion=args.default_emotion,
            log=writer.log,
        )
        self.model = runtime.ModelHost(
            model_dir=args.model_dir,
            device=args.device,
            cache_dir=args.cache_dir,
            log=writer.log,
            optimize=args.optimize,
            normalize=args.normalize,
            cfg_value=args.cfg_value,
            timesteps=args.timesteps,
            max_frames_per_char=args.max_frames_per_char,
            audio_multiple=args.max_audio_multiple,
            audio_floor_sec=args.max_audio_floor_sec,
            max_generation_sec=args.max_generation_sec,
            chars_per_second=args.chars_per_second,
            seed=args.seed,
        )
        self.calls = 0
        self._busy = False
        self._last_activity = time.monotonic()
        self._idle_stop = threading.Event()
        self._idle_thread: Optional[threading.Thread] = None
        self._save_stamp = ""
        self._hygiene_records: List[Dict[str, Any]] = []

    # ------------------------------------------------------------- lifecycle

    def startup(self) -> None:
        """Validate the reference voice, optionally preload, then emit exactly one ``ready``.

        A folder that does not hold exactly one reference voice fails cleanly: the
        problem is reported once as an ``error`` event (so the failure is explicit)
        and repeated in ``ready.startupError``. The daemon keeps serving, and every
        ``speak`` then answers with the same clear ``NO_VOICES`` message instead of
        loading a model without a reference.
        """
        self.voices.scan(force=True)
        startup_error = self.voices.error
        preload_error = ""
        if startup_error:
            self.writer.log(f"reference voice is not usable: {startup_error}")
            self.writer.error(None, "NO_VOICES", startup_error)
        if self.args.preload and not startup_error:
            try:
                self._ensure_model()
            except Exception as exc:  # noqa: BLE001 - reported again on the first speak
                preload_error = str(exc)
                self.writer.log(f"preload failed: {exc!r}")
        if self.args.idle_unload_sec > 0:
            self._idle_thread = threading.Thread(target=self._idle_loop, name="tts-idle", daemon=True)
            self._idle_thread.start()
        self.writer.event(
            "ready",
            None,
            ok=not startup_error,
            pid=os.getpid(),
            voicesDir=self.args.voices_dir,
            defaultEmotion=self.voices.effective_default or "",
            defaultEmotionSource=self.voices.default_source,
            emotions=self.voices.emotions_event(),
            emotionNames=self.voices.names(),
            device=self.args.device,
            modelLoaded=self.model.is_loaded,
            modelDir=self.args.model_dir,
            engine=self.model.engine,
            sampleRate=self.model.sample_rate,
            optimize=bool(self.args.optimize),
            cfgValue=float(self.args.cfg_value),
            timesteps=int(self.args.timesteps),
            asrAvailable=False,
            streaming=bool(self.args.stream),
            maxSentenceChars=self.args.max_sentence_chars,
            firstSentenceMaxChars=self.args.first_sentence_max_chars,
            preloadError=preload_error,
            startupError=startup_error,
            version=VERSION,
        )

    def shutdown(self) -> None:
        self._idle_stop.set()
        try:
            self.model.unload()
        except Exception as exc:  # noqa: BLE001 - teardown must not raise
            self.writer.log(f"unload during shutdown failed: {exc!r}")

    def _ensure_model(self) -> Tuple[int, bool, int]:
        """Load once, warm up once; returns ``(load_ms_including_warmup, was_loaded, warmup_ms)``."""
        load_ms, was_loaded = self.model.ensure_loaded()
        warmup_ms = 0
        if self.args.warmup and not self.model.is_warmed:
            warmup_ms = self.model.warmup(self.voices.voice)
        return (load_ms + warmup_ms, was_loaded, warmup_ms)

    # --------------------------------------------------------------- handlers

    def dispatch(self, request: Any) -> Optional[str]:
        """Handle one decoded request; returns "shutdown" to stop serving."""
        if not isinstance(request, dict):
            self.writer.error(None, "BAD_REQUEST", "request must be a JSON object")
            return None
        rid = request.get("id")
        op = _as_text(request.get("op"))
        self._last_activity = time.monotonic()
        if not op:
            self.writer.error(rid, "BAD_REQUEST", "request has no op")
            return None
        if op == "ping":
            self.writer.event("pong", rid, ok=True, pid=os.getpid())
            return None
        if op in ("voices", "reload"):
            self.emit_voices(rid, force=True)
            return None
        if op == "stats":
            self.emit_stats(rid)
            return None
        if op == "unload":
            freed = self.model.unload()
            self.writer.event("unloaded", rid, ok=True, freedMb=round(float(freed), 1), reason="explicit")
            return None
        if op == "speak":
            self._busy = True
            try:
                self.handle_speak(rid, request)
            finally:
                self._busy = False
                self._last_activity = time.monotonic()
            return None
        if op == "shutdown":
            self.writer.event("shutdown", rid, ok=True, pid=os.getpid())
            return "shutdown"
        self.writer.error(rid, "BAD_REQUEST", f"unknown op {op!r}", f"known ops: ping, voices, reload, stats, unload, speak, shutdown")
        return None

    def emit_voices(self, rid: Any, force: bool = False) -> None:
        self.voices.scan(force=force)
        payload: Dict[str, Any] = {
            "ok": not self.voices.error,
            "voicesDir": self.args.voices_dir,
            "defaultEmotion": self.voices.effective_default or "",
            "defaultEmotionSource": self.voices.default_source,
            "emotions": self.voices.emotions_event(),
            "emotionNames": self.voices.names(),
        }
        if self.voices.error:
            payload["startupError"] = self.voices.error
        self.writer.event("voices", rid, **payload)

    def emit_stats(self, rid: Any) -> None:
        payload: Dict[str, Any] = {"ok": True, "pid": os.getpid(), "ready": True}
        payload.update(self.model.stats())
        payload["calls"] = self.calls
        payload["emotions"] = self.voices.names()
        payload["defaultEmotion"] = self.voices.effective_default or ""
        self.writer.event("stats", rid, **payload)
    # ------------------------------------------------------------------ speak

    def handle_speak(self, rid: Any, request: Dict[str, Any]) -> None:
        """Generate and play every sentence of one utterance."""
        try:
            plan = self._plan(rid, request, self.args.first_sentence_max_chars)
        except _BadRequest as exc:
            self.writer.error(rid, exc.code, exc.message, exc.detail)
            return
        except _GenerateFailed as exc:
            self.writer.error(rid, exc.code, exc.message, exc.detail)
            return
        except Exception as exc:  # noqa: BLE001 - never crash on a malformed request
            self.writer.error(rid, "INTERNAL", str(exc) or type(exc).__name__, traceback.format_exc())
            return

        jobs, segments, notes = plan.jobs, plan.segments, plan.notes
        model_load_ms = 0
        warmup_ms = 0
        model_was_loaded = self.model.is_loaded
        self._save_stamp = time.strftime("%Y%m%d-%H%M%S")

        if not jobs:
            self.writer.event(
                "speak_start",
                rid,
                ok=True,
                segments=len(segments),
                sentences=0,
                units=0,
                modelLoadMs=0,
                modelWasLoaded=model_was_loaded,
                warmupMs=0,
                engine=self.model.engine,
                streaming=False,
            )
            self.writer.event(
                "speak_done",
                rid,
                ok=True,
                totalSeconds=0.0,
                playedMs=0,
                genMs=0,
                units=0,
                rtf=0.0,
                modelLoadMs=0,
                modelWasLoaded=model_was_loaded,
                warmupMs=0,
                engine=self.model.engine,
                sampleRate=self.model.sample_rate,
                streaming=False,
                trimmedSeconds=0.0,
                segments=segments,
                files=[],
                firstAudioMs=None,
                notes=notes,
            )
            self.calls += 1
            return

        try:
            model_load_ms, model_was_loaded, warmup_ms = self._ensure_model()
        except Exception as exc:  # noqa: BLE001 - reported as MODEL_LOAD_FAILED
            self.writer.error(rid, "MODEL_LOAD_FAILED", str(exc) or type(exc).__name__, traceback.format_exc())
            return

        # The first-sentence cap only buys latency on a backend that must finish a
        # whole unit before any audio exists; a streaming backend starts at the
        # first chunk, so it plans without the cap and may need a fresh plan.
        streaming = bool(self.args.stream and self.model.is_streaming)
        effective_first_cap = 0 if streaming else self.args.first_sentence_max_chars
        if effective_first_cap != self.args.first_sentence_max_chars:
            try:
                plan = self._plan(rid, request, effective_first_cap)
            except _BadRequest as exc:
                self.writer.error(rid, exc.code, exc.message, exc.detail)
                return
            except _GenerateFailed as exc:
                self.writer.error(rid, exc.code, exc.message, exc.detail)
                return
            except Exception as exc:  # noqa: BLE001 - never crash on a malformed request
                self.writer.error(rid, "INTERNAL", str(exc) or type(exc).__name__, traceback.format_exc())
                return
            jobs, segments, notes = plan.jobs, plan.segments, plan.notes

        if plan.uses_speed and not self.model.supports_speed():
            plan.notes.append("speed ignored: VoxCPM 1.5 has no rate control")

        # One job is one generation unit; `sentences` stays the count a listener would make.
        display_sentences = sum(len(job.sentences) for job in jobs)
        self.writer.event(
            "speak_start",
            rid,
            ok=True,
            segments=len(segments),
            sentences=display_sentences,
            units=len(jobs),
            modelLoadMs=model_load_ms,
            modelWasLoaded=model_was_loaded,
            warmupMs=warmup_ms,
            engine=self.model.engine,
            streaming=bool(self.args.stream and self.model.is_streaming),
        )

        started_at = time.monotonic()
        player = (
            runtime.SoundDevicePlayer(self.args.output_device or None, log=self.writer.log)
            if plan.play
            else NullPlayer()
        )
        saver = self._make_saver(plan) if plan.save else None
        pipeline = SpeechPipeline(
            stream=self._make_streamer(plan),
            player=player,
            emit=lambda name, **fields: self.writer.event(name, rid, **fields),
            log=self.writer.log,
        )
        try:
            result = pipeline.run(jobs, rid, gap_ms=plan.gap_ms, on_segment=saver, started_at=started_at)
        except PipelineGenerateError as exc:
            self._emit_oom_unload()
            self.writer.error(rid, "GENERATE_FAILED", str(exc.cause) or type(exc.cause).__name__, traceback.format_exc())
            return
        except PipelinePlaybackError as exc:
            self.writer.error(rid, "PLAYBACK_FAILED", str(exc.cause) or type(exc.cause).__name__, traceback.format_exc())
            return
        except Exception as exc:  # noqa: BLE001 - any other failure stays inside this call
            self.writer.error(rid, "INTERNAL", str(exc) or type(exc).__name__, traceback.format_exc())
            return

        if result.save_errors:
            index, cause = result.save_errors[0]
            self.writer.error(
                rid,
                "SAVE_FAILED",
                f"segment {index}: {cause}",
                traceback.format_exception(type(cause), cause, cause.__traceback__)[-1].strip(),
            )
            return

        self.calls += 1
        trimmed_seconds = self._hygiene_notes(notes)
        by_index = {segment.index: segment.to_event() for segment in result.segments}
        for index, segment in enumerate(segments):
            if index not in by_index:
                segment["seconds"] = 0.0
        self.writer.event(
            "speak_done",
            rid,
            ok=True,
            totalSeconds=round(result.total_seconds, 3),
            playedMs=int(round(result.played_ms)),
            genMs=int(round(result.gen_ms)),
            units=len(result.sentences),
            rtf=round(result.rtf, 3),
            modelLoadMs=model_load_ms,
            modelWasLoaded=model_was_loaded,
            warmupMs=warmup_ms,
            engine=self.model.engine,
            sampleRate=self.model.sample_rate,
            streaming=bool(self.args.stream and self.model.is_streaming),
            trimmedSeconds=round(trimmed_seconds, 3),
            segments=[by_index.get(index, segments[index]) for index in range(len(segments))],
            files=result.files(),
            firstAudioMs=(int(round(result.first_audio_ms)) if result.first_audio_ms is not None else None),
            notes=notes,
        )

    # ------------------------------------------------------------------ plan

    def _emit_oom_unload(self, rid: Any = None) -> None:
        """Report the unload the engine performed to recover from CUDA OOM (once).

        The recovery is engine-initiated rather than a request answer, so the event
        carries no request id (``reason: "oom"``), like the idle unload.
        """
        freed = self.model.take_oom_freed()
        if freed is None:
            return
        self.writer.log(f"model unloaded after CUDA out of memory; freed {freed:.1f} MB VRAM")
        self.writer.event("unloaded", None, ok=True, freedMb=round(float(freed), 1), reason="oom")

    def _plan(self, rid: Any, request: Dict[str, Any], first_max_chars: int = 0) -> "_SpeakPlan":
        """Validate the request, resolve the reference voice, and split every segment.

        There is no request-side language: VoxCPM 1.5 infers it from the text, so a
        segment's script is checked (and refused when it is mostly unsupported).
        ``sentence_end.language`` reports ``Auto``: the language is inferred, never
        configured.

        A requested emotion is a label carried on the segment events and echoed as
        both ``requestedEmotion`` and ``usedEmotion`` with ``fallback:false``; it never
        changes the reference voice.

        ``first_max_chars`` is the effective first-sentence cap: the configured
        value on a non-streaming backend, ``0`` when the backend streams (its
        first audible sample does not wait for a whole unit).
        """
        raw_segments = request.get("segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            raise _BadRequest("BAD_REQUEST", "segments must be a non-empty array")

        parsed: List[Tuple[str, str, Optional[float]]] = []
        for index, item in enumerate(raw_segments):
            if isinstance(item, str):
                parsed.append(("", item, None))
                continue
            if not isinstance(item, dict):
                raise _BadRequest("BAD_REQUEST", f"segments[{index}] must be an object or a string")
            content = item.get("content")
            if content is None:
                content = item.get("text")
            if content is None or not isinstance(content, (str, int, float)):
                raise _BadRequest("BAD_REQUEST", f"segments[{index}].content must be a string")
            parsed.append(
                (
                    _as_text(item.get("emotion")),
                    str(content),
                    _as_float(item.get("speed"), None),
                )
            )

        play = _as_bool(request.get("play"), True)
        save = _as_bool(request.get("save"), False)
        gap_ms = max(0, _as_int(request.get("gapMs"), 120))
        default_speed = _as_float(request.get("speed"), 1.0)
        save_dir = (
            _as_text(request.get("saveDir"))
            or _as_text(request.get("save_dir"))
            or self.args.save_dir
            or (os.path.join(self.args.cache_dir, "wav") if self.args.cache_dir else "")
        )
        if save and not save_dir:
            raise _BadRequest("BAD_REQUEST", "save:true needs saveDir, --save-dir or --cache-dir")

        notes: List[str] = []
        jobs: List[SentenceJob] = []
        segment_events: List[Dict[str, Any]] = []
        speech_speed = False
        cap = int(self.args.max_sentence_chars)

        for index, (emotion, content, speed) in enumerate(parsed):
            text = normalize_text(content)
            # Punctuation-only / whitespace-only / emoji-only text has nothing to
            # synthesize: it takes the same skip path as empty content, so it never
            # loads the model and never reports audible seconds.
            speakable = _SPEAKABLE_RE.search(text) is not None
            if speakable:
                script_ratio, script_names = unsupported_script_ratio(text)
                if script_names and script_ratio > UNSUPPORTED_SCRIPT_LIMIT:
                    # Nothing on the request can excuse this: the engine reads those
                    # characters as Chinese and would speak something the text does not
                    # say.
                    raise _GenerateFailed(
                        f"segment {index}: {script_ratio:.0%} of its letters are {script_names}, which "
                        f"VoxCPM 1.5 cannot speak ({_SUPPORTED_LANGUAGES} only)"
                    )
                if script_names:
                    notes.append(
                        f"segment {index}: text contains {script_names}; VoxCPM 1.5 speaks "
                        f"{_SUPPORTED_LANGUAGES} only, so those characters are read as Chinese"
                    )
            units = (
                plan_units(
                    text,
                    max_chars=cap,
                    first_max_chars=first_max_chars,
                    merge_mode=self.args.merge_sentences,
                    merge_max_chars=self.args.merge_max_chars,
                    short_sentence_chars=self.args.short_sentence_chars,
                )
                if speakable
                else []
            )
            # One unit is one generation; a language switch inside a unit splits it
            # at a clause boundary so every generation speaks one language.
            language_units = split_units_by_language(units, detect_language) if units else []
            # Splitting can leave a punctuation-only fragment (a leading `。`, or a
            # clause that is only punctuation after a language switch). It carries no
            # word character, so it has nothing to synthesize and is dropped here;
            # when every fragment is dropped the segment takes the skip path below.
            language_units = [
                (parts, unit_language)
                for parts, unit_language in language_units
                if _SPEAKABLE_RE.search("".join(parts)) is not None
            ]
            display_sentences = sum(len(parts) for parts, _unit_language in language_units)
            effective_speed = speed if speed is not None else default_speed
            resolution = self.voices.resolve(emotion) if language_units else None
            if language_units and (resolution is None or resolution.voice is None):
                raise _BadRequest(
                    "NO_VOICES",
                    self.voices.error or f"no reference voice in {self.args.voices_dir}",
                    "put exactly one audio file and its same-stem .txt transcript in --voices-dir",
                )
            # VoxCPM clones by continuing the reference clip, so the clip and its
            # exact transcript are both required; never clone with a partial prompt.
            if language_units and resolution is not None and resolution.voice is not None:
                voice = resolution.voice
                if not voice.ref_text:
                    raise _GenerateFailed(
                        f"segment {index}: the reference voice has no transcript; write exactly what "
                        f"{os.path.basename(voice.path)} says to {runtime.reference_text_path(voice)} "
                        f"— VoxCPM clones by continuing the reference clip, so the clip and its exact "
                        f"text are both required"
                    )
            if language_units and effective_speed and float(effective_speed) != 1.0:
                speech_speed = True

            # An emotion is a label forwarded for the Live2D renderer: it is echoed to
            # both event fields and never picks a different reference recording.
            if resolution is not None:
                requested = resolution.requested
                used = resolution.requested
                via = resolution.via
            else:
                requested = _as_text(emotion)
                used = ""
                via = "none"
            if not language_units:
                notes.append(f"segment {index}: no speakable text; skipped")

            # (c) a sentence that the cap had to break into several generation units
            if cap > 0:
                for sentence_number, sentence in enumerate(split_sentences(text, 0), start=1):
                    pieces = split_long(sentence, cap)
                    limit_label = f"maxSentenceChars={cap}"
                    if sentence_number == 1 and first_max_chars and first_max_chars > 0 and pieces:
                        head = split_long(pieces[0], first_max_chars)
                        if len(head) > 1:
                            # The first-sentence cap is the limit that actually split it.
                            limit_label = f"firstSentenceMaxChars={first_max_chars}"
                        pieces = head + pieces[1:]
                    if len(pieces) > 1:
                        notes.append(
                            f"segment {index}: sentence {sentence_number} split into {len(pieces)} "
                            f"units ({limit_label})"
                        )
                        break

            # Guard: no planned unit may exceed the sentence cap (cap > 0).
            if cap > 0 and language_units:
                longest = max(len("".join(parts)) for parts, _unit_language in language_units)
                if longest > cap:
                    notes.append(
                        f"error: segment {index}: unit of {longest} chars exceeds maxSentenceChars={cap}"
                    )

            # A request cannot name a language: the engine infers it from the text, and
            # the scripts it cannot speak were handled above. What is reported is
            # `Auto` — the language is inferred, never configured.
            resolved_language = "Auto"
            segment_events.append(
                {
                    "index": index,
                    "requestedEmotion": requested,
                    "usedEmotion": used,
                    "fallback": False,
                    "seconds": 0.0,
                    "sentences": display_sentences,
                    "files": [],
                }
            )
            for unit_index, (parts, _unit_language) in enumerate(language_units):
                unit_text = "".join(parts)
                jobs.append(
                    SentenceJob(
                        segment_index=index,
                        unit_index=unit_index,
                        unit_count=len(language_units),
                        sentences=tuple(parts),
                        text=unit_text,
                        segment_text=text,
                        voice=resolution.voice,
                        requested_emotion=requested,
                        used_emotion=used,
                        fallback=False,
                        resolved_via=via,
                        language=resolved_language,
                        speed=effective_speed,
                        max_len=self.model.max_tokens_for(unit_text),
                    )
                )

        return _SpeakPlan(
            jobs=jobs,
            segments=segment_events,
            notes=notes,
            play=play,
            save=save,
            save_dir=save_dir,
            gap_ms=gap_ms,
            uses_speed=speech_speed,
        )

    def _make_streamer(self, plan: "_SpeakPlan"):
        """Build the pipeline's stream function: chunks plus silence hygiene.

        Streaming backends hand over chunks as the model produces them, so the
        :class:`~ttslib.hygiene.StreamTrimmer` trims leading silence and caps a
        trailing silence run without buffering the sentence. Non-streaming
        generation is trimmed exactly with ``trim_edges``. Every sentence records
        what was trimmed and whether the runaway-tail cap was reached.
        """
        args = self.args
        streaming = bool(args.stream and self.model.is_streaming)
        records: List[Dict[str, Any]] = []
        self._hygiene_records = records
        lock = threading.Lock()

        def stream(job: SentenceJob):
            cap = job.max_len or self.model.max_tokens_for(job.text)
            cap_sec = cap_seconds(cap)
            limit_sec = self.model.audio_limit_sec(job.text)
            # `produced` counts what the model generated, `written` what survived the
            # silence trimming: only the produced length can say whether the cap cut the
            # generation off, because trimming legitimately shortens the audible part.
            produced = 0.0
            written = 0.0
            trimmed = 0.0
            chunks = 0
            aborted = ""
            if streaming:
                trimmer: Optional[StreamTrimmer] = None
                for chunk, sample_rate in self.model.stream(job.text, job.voice, job.language, job.speed, cap):
                    sample_rate = int(sample_rate)
                    produced += len(chunk) / float(sample_rate)
                    if trimmer is None:
                        trimmer = StreamTrimmer(
                            sample_rate,
                            args.silence_gate_db,
                            args.silence_pad_ms,
                            args.max_trailing_silence_ms,
                        )
                    kept = trimmer.push(chunk, sample_rate)
                    if kept is not None and len(kept):
                        chunks += 1
                        written += len(kept) / float(sample_rate)
                        yield kept, sample_rate
                if trimmer is not None:
                    trimmer.finish()
                    trimmed = trimmer.trimmed_sec
                aborted = self.model.take_stream_note()
            else:
                audio, sample_rate = self.model.generate(job.text, job.voice, job.language, job.speed, cap)
                sample_rate = int(sample_rate)
                produced += len(audio) / float(sample_rate)
                result = trim_edges(audio, sample_rate, args.silence_gate_db, args.silence_pad_ms)
                trimmed = result.trimmed_sec
                kept = result.audio
                if kept is not None and len(kept):
                    chunks = 1
                    written = len(kept) / float(sample_rate)
                    yield kept, sample_rate
            with lock:
                records.append(
                    {
                        "segment": job.segment_index,
                        "unit": job.unit_index,
                        "text": job.text,
                        "trimmedSec": round(trimmed, 3),
                        "audioSec": round(written, 3),
                        "producedSec": round(produced, 3),
                        "maxNewTokens": cap,
                        "capSec": round(cap_sec, 3),
                        "capHit": bool(produced > 0 and produced >= cap_sec * 0.98),
                        "limitSec": round(limit_sec, 3),
                        "overLimit": bool(written > limit_sec),
                        "aborted": aborted,
                        "chunks": chunks,
                    }
                )

        return stream

    def _hygiene_notes(self, notes: List[str]) -> float:
        """Append trimming, cap, abort and speaking-rate notes; returns trimmed seconds."""
        records = list(self._hygiene_records)
        trimmed_total = sum(float(record["trimmedSec"]) for record in records)
        if trimmed_total >= 0.1:
            notes.append(f"trimmed {trimmed_total:.2f}s of silence (gate {self.args.silence_gate_db} dB)")
        aborted = [record for record in records if record["aborted"]]
        for record in aborted:
            notes.append(str(record["aborted"]))
        capped = [record for record in records if record["capHit"] and not record["aborted"]]
        if capped:
            notes.append(
                f"{len(capped)} sentence(s) reached the runaway-tail cap "
                f"({capped[0]['maxNewTokens']} tokens ~= {capped[0]['capSec']}s of audio)"
            )
        overlong = [
            record
            for record in records
            if record["overLimit"] and not record["aborted"] and record not in capped
        ]
        if overlong:
            notes.append(
                f"{len(overlong)} sentence(s) produced more audio than expected "
                f"({overlong[0]['audioSec']}s for {len(overlong[0]['text'])} characters)"
            )
        # (d) a unit that produced far less audio than its text implies, reported once
        # per segment; it is a signal for the caller, never a failure. The baseline is
        # calibrated per CJK character, so Latin-only units are skipped (F6). A unit the
        # cap cut off — or one the audio guard aborted — already has its own note, and
        # calling it "suspiciously fast" would contradict that explanation (F2).
        announced: set = set()
        for record in records:
            text = str(record.get("text", ""))
            if not has_cjk_script(text):
                continue
            if record.get("capHit") or record.get("aborted"):
                continue
            chars = len(text)
            expected = max(0.6, chars / max(0.1, float(self.args.chars_per_second)))
            if float(record.get("audioSec", 0.0)) < 0.3 * expected:
                segment = record.get("segment")
                if segment in announced:
                    continue
                announced.add(segment)
                notes.append(
                    f"segment {segment}: unit {record.get('unit')} produced "
                    f"{float(record.get('audioSec', 0.0)):.2f}s for {chars} chars (suspiciously fast)"
                )
        return trimmed_total

    def _make_saver(self, plan: "_SpeakPlan"):
        """Build the per-segment WAV writer used by the pipeline callback."""
        from ttslib.runtime import import_numpy, save_wav

        def on_segment(segment, chunks, sample_rate):
            if not chunks:
                return []
            np = import_numpy()
            safe_name = "".join("_" if ch in _BAD_FILENAME_CHARS else ch for ch in (segment.used_emotion or "voice"))
            path = os.path.join(plan.save_dir, f"tts_{self._save_stamp}_seg{segment.index:02d}_{safe_name}.wav")
            audio = np.concatenate([np.asarray(chunk, dtype=np.float32).reshape(-1) for chunk, _rate in chunks])
            saved = save_wav(path, audio, int(sample_rate))
            self.writer.log(f"saved {saved}")
            return [saved]

        return on_segment

    # ------------------------------------------------------------------ idle

    def _idle_loop(self) -> None:
        while not self._idle_stop.wait(1.0):
            if self.args.idle_unload_sec <= 0 or self._busy or not self.model.is_loaded:
                continue
            if time.monotonic() - self._last_activity >= self.args.idle_unload_sec:
                try:
                    freed = self.model.unload()
                except Exception as exc:  # noqa: BLE001 - idle unload is housekeeping
                    self.writer.log(f"idle unload failed: {exc!r}")
                    continue
                self.writer.log(
                    f"idle unload after {self.args.idle_unload_sec}s idle; freed {freed:.1f} MB VRAM"
                )
                self.writer.event("unloaded", None, ok=True, freedMb=round(float(freed), 1), reason="idle")


class _BadRequest(Exception):
    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class _GenerateFailed(Exception):
    """A request the engine cannot serve: reported as ``GENERATE_FAILED`` before/at generation."""

    code = "GENERATE_FAILED"

    def __init__(self, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


class _SpeakPlan:
    """Validated, voice-resolved, sentence-split view of one speak request."""

    def __init__(
        self,
        jobs: List[SentenceJob],
        segments: List[Dict[str, Any]],
        notes: List[str],
        play: bool,
        save: bool,
        save_dir: str,
        gap_ms: int,
        uses_speed: bool = False,
    ) -> None:
        self.jobs = jobs
        self.segments = segments
        self.notes = notes
        self.play = play
        self.save = save
        self.save_dir = save_dir
        self.gap_ms = gap_ms
        self.uses_speed = uses_speed


def _iter_stdin(stream) -> Iterable[str]:
    for raw in stream:
        yield raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else raw


def serve(daemon: TtsDaemon, stdin=None) -> int:
    """Read requests until EOF or ``shutdown``; never raises on bad input."""
    stream = stdin
    if stream is None:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
    daemon.startup()
    try:
        for line in _iter_stdin(stream):
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception as exc:  # noqa: BLE001 - malformed JSON keeps the daemon alive
                daemon.writer.error(None, "BAD_JSON", f"could not parse request line: {exc}", line[:200])
                continue
            try:
                if daemon.dispatch(request) == "shutdown":
                    break
            except Exception as exc:  # noqa: BLE001 - one bad request must not kill the daemon
                rid = request.get("id") if isinstance(request, dict) else None
                daemon.writer.error(rid, "INTERNAL", str(exc) or type(exc).__name__, traceback.format_exc())
    finally:
        daemon.shutdown()
        daemon.writer.log("stdin closed; exiting")
    return 0


def main(argv: Optional[List[str]] = None, stdin=None) -> int:
    """Parse arguments and serve until stdin closes."""
    runtime.configure_cuda_alloc()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - reconfigure is unavailable on exotic streams
        pass
    # stdout is the JSONL protocol stream. Capture the real byte stream for the
    # event writer and point `sys.stdout` at stderr, so any library `print()`
    # (voxcpm and transformers both print notices) cannot corrupt it.
    raw_stdout = getattr(sys.stdout, "buffer", None)
    writer = EventWriter(stdout=raw_stdout)
    sys.stdout = sys.stderr
    writer.log(f"tts_daemon {VERSION} starting (pid {os.getpid()}, python {sys.version.split()[0]})")
    writer.log(f"PYTORCH_CUDA_ALLOC_CONF={os.environ.get('PYTORCH_CUDA_ALLOC_CONF', '')}")
    daemon = TtsDaemon(args, writer)
    return serve(daemon, stdin=stdin)


if __name__ == "__main__":
    sys.exit(main())
