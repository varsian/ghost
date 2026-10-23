"""GPU runtime adapters: the VoxCPM inference backend, sounddevice player, audio IO.

Every heavy import (torch, numpy, sounddevice, voxcpm) happens inside a function or
method so ``ttslib.textsplit``/``voices``/``hygiene``/``pipeline`` and the test suite
stay importable without the GPU stack installed.

One backend sits behind :class:`ModelHost`: ``voxcpm`` 1.5.0. It clones the one
reference voice by continuing from that clip plus its exact transcript, and exposes
real incremental ``generate_streaming`` chunks at the model's own sample rate.
"""

from __future__ import annotations

import contextlib
import gc
import os
import sys
import time
import wave
from typing import Any, Callable, Dict, Iterator, Optional, Tuple

from .hygiene import max_new_tokens_for


@contextlib.contextmanager
def quiet_stdout():
    """Send library chatter to stderr while heavy imports/calls run.

    ``voxcpm`` and transformers may print notices with ``print()``, and stdout is the
    JSONL protocol stream, so every such print must be diverted.
    """
    with contextlib.redirect_stdout(sys.stderr):
        yield


def import_torch():
    """Import and return ``torch`` (raises ImportError with a clear message)."""
    try:
        import torch  # type: ignore
    except Exception as exc:  # noqa: BLE001 - surfaced as MODEL_LOAD_FAILED
        raise ImportError(f"torch is not importable in this interpreter: {exc!r}") from exc
    return torch


def import_numpy():
    try:
        import numpy as np  # type: ignore
    except Exception as exc:  # noqa: BLE001 - surfaced as PLAYBACK_FAILED/SAVE_FAILED
        raise ImportError(f"numpy is not importable in this interpreter: {exc!r}") from exc
    return np


def configure_cuda_alloc() -> str:
    """Set ``PYTORCH_CUDA_ALLOC_CONF`` before torch is imported (PROTOCOL.md §9)."""
    current = os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "")
    if "expandable_segments" not in current:
        value = f"{current},expandable_segments:True" if current else "expandable_segments:True"
        os.environ["PYTORCH_CUDA_ALLOC_CONF"] = value
    return os.environ["PYTORCH_CUDA_ALLOC_CONF"]


def to_float32_mono(waveform: Any):
    """Normalize a model waveform to a 1-D float32 numpy array in [-1, 1]."""
    np = import_numpy()
    array = np.asarray(waveform, dtype=np.float32)
    if array.ndim > 1:
        array = array.reshape(-1, array.shape[-1]).mean(axis=0) if array.ndim == 2 else array.reshape(-1)
    array = array.reshape(-1)
    array = np.nan_to_num(array, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(array))) if array.size else 0.0
    if peak > 1.0:
        array = array / peak
    return array


def resample_linear(array: Any, sample_rate_in: int, sample_rate_out: int):
    """Linear resampling between device rates (speech-quality adequate)."""
    if sample_rate_in == sample_rate_out or array.size == 0:
        return array
    np = import_numpy()
    duration = array.shape[0] / float(sample_rate_in)
    target_len = max(1, int(round(duration * float(sample_rate_out))))
    source = np.linspace(0.0, duration, num=array.shape[0], endpoint=False)
    target = np.linspace(0.0, duration, num=target_len, endpoint=False)
    return np.interp(target, source, array).astype(np.float32)


def save_wav(path: str, array: Any, sample_rate: int) -> str:
    """Write a mono 16-bit PCM WAV; creates parent directories."""
    np = import_numpy()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    clipped = np.clip(np.asarray(array, dtype=np.float32), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    return path


def install_torchaudio_soundfile_fallback(log: Optional[Callable[[str], None]] = None) -> str:
    """Route ``torchaudio.load`` through soundfile when TorchCodec is unavailable.

    torchaudio >= 2.9 delegates loading to TorchCodec, which is not installed here and
    needs FFmpeg shared libraries on Windows, while VoxCPM 1.5.0 reads the prompt clip
    with ``torchaudio.load(path)``. soundfile decodes the reference WAVs this deployment
    uses and returns the ``(channels, samples)`` float32 tensor plus integer rate the
    model expects. Returns the one-line status the daemon logs; raises when no audio
    backend can load the prompt at all.
    """
    import torchaudio  # lazy: only the model side needs it

    try:
        import torchcodec  # type: ignore  # noqa: F401

        status = f"torchaudio {torchaudio.__version__} loads audio through TorchCodec"
    except Exception:  # noqa: BLE001 - a missing TorchCodec is the expected case here
        try:
            import soundfile as sf  # type: ignore
        except Exception as exc:  # noqa: BLE001 - fail loud: the prompt clip could not be read
            raise RuntimeError(
                f"neither torchcodec nor soundfile can load prompt audio in this interpreter: {exc!r}"
            ) from exc

        def _soundfile_load(path, *_args, **_kwargs):
            data, rate = sf.read(str(path), dtype="float32", always_2d=True)
            import torch

            return torch.from_numpy(data.T.copy()), int(rate)

        torchaudio.load = _soundfile_load  # type: ignore[assignment]
        status = f"installed the soundfile fallback for torchaudio.load (torchaudio {torchaudio.__version__})"
    if log is not None:
        log(status)
    return status


def is_out_of_memory(exc: BaseException) -> bool:
    """True for a CUDA OOM, however the failing allocator reported it.

    ``torch.cuda.OutOfMemoryError`` is the documented type, but allocator failures
    also surface as a plain ``RuntimeError`` whose message says "out of memory";
    torch itself may not even be importable in a hermetic test.
    """
    for cls in type(exc).__mro__:
        if cls.__name__ == "OutOfMemoryError":
            return True
    return "out of memory" in str(exc).lower()


class ModelOutOfMemory(RuntimeError):
    """Raised after an OOM was handled: device cache cleared, model unloaded."""


class SoundDevicePlayer:
    """Continuous playback through one open ``sounddevice`` output stream.

    The stream is opened once per ``speak`` call at the model's sample rate and
    stays open while sentences/chunks are written into it, so audio keeps
    playing while the next sentence is still being generated.
    """

    def __init__(self, device: Optional[str] = None, log: Optional[Callable[[str], None]] = None) -> None:
        self._device = device or None
        self._log = log or (lambda _msg: None)
        self._stream = None
        self._rate: Optional[int] = None
        self._latency = 0.0

    def _sounddevice(self):
        try:
            import sounddevice as sd  # type: ignore
        except Exception as exc:  # noqa: BLE001 - surfaced as PLAYBACK_FAILED
            raise RuntimeError(f"sounddevice is not importable in this interpreter: {exc!r}") from exc
        return sd

    def _device_rate(self, sd, requested: int) -> int:
        try:
            info = sd.query_devices(self._device, "output")
            rate = int(info["default_samplerate"])
            if rate > 0:
                return rate
        except Exception as exc:  # noqa: BLE001 - fall back to the model rate
            self._log(f"output device query failed ({exc!r}); using {requested} Hz")
        return int(requested)

    def _open_stream(self, sd, rate: int):
        return sd.OutputStream(
            samplerate=int(rate),
            channels=1,
            dtype="float32",
            device=self._device,
            blocksize=0,
            latency="high",
        )

    def open(self, sample_rate: int) -> None:
        """Open one stream at the model's sample rate; fall back to the device rate.

        PROTOCOL.md §3: the returned rate is authoritative (44.1 kHz today) — it is
        never hardcoded. When the host API refuses that rate on the chosen device,
        the stream opens at the device's default rate instead and ``write``
        resamples into it.
        """
        sd = self._sounddevice()
        requested = int(sample_rate)
        try:
            self._stream = self._open_stream(sd, requested)
            self._rate = requested
        except Exception as exc:  # noqa: BLE001 - device may reject the model rate
            device_rate = self._device_rate(sd, requested)
            if device_rate == requested:
                raise
            self._log(f"output device refused {requested} Hz ({exc!r}); using {device_rate} Hz with resampling")
            self._stream = self._open_stream(sd, device_rate)
            self._rate = device_rate
        self._stream.start()
        try:
            self._latency = float(self._stream.latency)
        except Exception:  # noqa: BLE001 - latency is advisory
            self._latency = 0.2

    def write(self, audio: Any, sample_rate: int) -> None:
        if self._stream is None:
            raise RuntimeError("playback stream is not open")
        np = import_numpy()
        array = np.asarray(audio, dtype=np.float32).reshape(-1)
        if sample_rate != self._rate:
            array = resample_linear(array, int(sample_rate), int(self._rate))
        self._stream.write(array.reshape(-1, 1))

    def write_silence(self, seconds: float) -> None:
        if self._stream is None or seconds <= 0:
            return
        np = import_numpy()
        frames = max(1, int(round(seconds * float(self._rate or 44100))))
        zeros = np.zeros((frames, 1), dtype=np.float32)
        self._stream.write(zeros)

    def drain(self) -> None:
        """Let the device buffer empty before ``speak_done`` is emitted."""
        stream = self._stream
        if stream is None:
            return
        wait = max(0.05, float(self._latency) + 0.05)
        time.sleep(wait)

    def close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is None:
            return
        try:
            stream.stop()
        except Exception as exc:  # noqa: BLE001 - stopping a dead device is not fatal
            self._log(f"stream stop failed: {exc!r}")
        try:
            stream.close()
        except Exception as exc:  # noqa: BLE001 - closing a dead device is not fatal
            self._log(f"stream close failed: {exc!r}")


# --------------------------------------------------------------------- backend


def reference_text_path(voice: Any) -> str:
    """Path of the ``<stem>.txt`` transcript that belongs beside the reference audio."""
    stem, _ = os.path.splitext(str(getattr(voice, "path", "") or ""))
    return stem + ".txt"


class VoxCPMBackend:
    """``voxcpm`` 1.5.0: prompt-clip continuation cloning with real streaming.

    Cloning is continuation mode, so the prompt clip and its exact transcript are
    both mandatory; a call without them is refused instead of falling back to a
    random voice. VRAM is the binding constraint on the 8 GB card this runs on, so
    every generation releases the device cache and every tenth generation also
    collects garbage and resets the peak counter.
    """

    name = "voxcpm"
    streaming = True
    #: Generations between the deeper cache cleanups.
    DEEP_CLEANUP_EVERY = 10

    def __init__(self, host: "ModelHost") -> None:
        self.host = host
        self._model: Any = None
        self._sample_rate = 0
        self._generations = 0

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def sample_rate(self) -> int:
        """Sample rate the model reported; 0 before a successful load."""
        return self._sample_rate

    def load(self) -> None:
        torch = import_torch()
        self._apply_device(torch)
        install_torchaudio_soundfile_fallback(self.host.log)
        try:
            with quiet_stdout():
                from voxcpm import VoxCPM  # type: ignore
        except Exception as exc:  # noqa: BLE001 - surfaced as MODEL_LOAD_FAILED
            raise ImportError(f"voxcpm is not importable in this interpreter: {exc!r}") from exc
        if self.host.optimize:
            self.host.log(
                "optimize=true: torch.compile needs triton on Windows and its CUDA graphs cannot "
                "run on the daemon's generation thread"
            )
        with quiet_stdout():
            self._model = VoxCPM(
                voxcpm_model_path=self.host.model_dir,
                enable_denoiser=False,
                zipenhancer_model_path=None,
                optimize=bool(self.host.optimize),
            )
        sample_rate = int(getattr(getattr(self._model, "tts_model", None), "sample_rate", 0) or 0)
        if sample_rate <= 0:
            raise RuntimeError("voxcpm reported no sample rate (model.tts_model.sample_rate)")
        self._sample_rate = sample_rate
        self.host.log(f"voxcpm loaded at {sample_rate} Hz")
        self.host.synchronize()

    def _apply_device(self, torch: Any) -> None:
        """Make the configured CUDA device current before the weights land.

        ``voxcpm`` 1.5.0's constructor takes no ``device`` argument and selects the
        device itself, so the only control the engine has is which device is
        current when it loads.
        """
        device = str(self.host.device or "").strip().lower()
        if device in ("", "auto"):
            return
        if not device.startswith("cuda"):
            raise RuntimeError(
                f"voxcpm 1.5.0 selects the device internally; only cuda:N is supported, got {self.host.device!r}"
            )
        index = device.split(":", 1)[1].strip()
        if index == "":
            return
        try:
            torch.cuda.set_device(int(index))
        except Exception as exc:  # noqa: BLE001 - surfaced as MODEL_LOAD_FAILED
            raise RuntimeError(f"torch.cuda.set_device({index}) failed: {exc!r}") from exc

    def native_warmup(self) -> None:
        """No engine-native warmup: the host pays it with throwaway phrases."""
        return None

    def supports_speed(self) -> bool:
        """VoxCPM 1.5 has no rate control."""
        return False

    def _require_reference(self, voice: Any, ref_text: Optional[str]) -> str:
        if ref_text:
            return ref_text
        path = reference_text_path(voice)
        raise RuntimeError(
            f"the reference voice has no transcript: write exactly what the clip says to {path} "
            f"— VoxCPM clones by continuing the reference clip, so the clip and its exact text are both required"
        )

    def _call_kwargs(
        self,
        text: str,
        voice: Any,
        ref_text: Optional[str],
        max_new_tokens: int,
        speed: Optional[float],
    ) -> Dict[str, Any]:
        return {
            "text": text,
            "prompt_wav_path": voice.path,
            "prompt_text": self._require_reference(voice, ref_text),
            "cfg_value": float(self.host.cfg_value),
            "inference_timesteps": int(self.host.timesteps),
            "max_len": int(max_new_tokens) if max_new_tokens > 0 else 4096,
            "normalize": bool(self.host.normalize),
            "retry_badcase": True,
        }

    def _release_device_cache(self, deep: bool = False) -> None:
        """Return unused blocks to the driver after one generation.

        ``torch.compile``/streaming generation keeps buffers alive until the
        generator is closed, so this runs only after the generator closed and the
        waveform was dropped.
        """
        try:
            torch = import_torch()
        except ImportError:
            return
        try:
            if not torch.cuda.is_available():
                return
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            if deep:
                gc.collect()
                torch.cuda.empty_cache()
                torch.cuda.reset_peak_memory_stats()
        except Exception as exc:  # noqa: BLE001 - cache cleanup is best effort
            self.host.log(f"cuda cache cleanup failed: {exc!r}")

    def _after_generation(self) -> None:
        self._generations += 1
        self._release_device_cache(deep=self._generations % self.DEEP_CLEANUP_EVERY == 0)

    def _waveform(self, output: Any) -> Any:
        """Normalize one model response, refusing an empty or non-array answer.

        ``np.asarray(None, dtype=float32)`` yields a single NaN sample, so a failed
        generation would otherwise pass as audible audio.
        """
        if output is None:
            raise RuntimeError("voxcpm returned no audio")
        audio = to_float32_mono(output)
        if len(audio) == 0:
            raise RuntimeError("voxcpm returned no audio")
        return audio

    def _make_generator(self, kwargs: Dict[str, Any]):
        """Build the streaming generator with library chatter diverted."""
        with quiet_stdout():
            return self._model.generate_streaming(**kwargs)

    def synthesize(
        self,
        text: str,
        voice: Any,
        ref_text: Optional[str],
        max_new_tokens: int,
        speed: Optional[float] = None,
    ):
        kwargs = self._call_kwargs(text, voice, ref_text, max_new_tokens, speed)
        started = time.monotonic()
        try:
            with quiet_stdout():
                waveform = self._model.generate(**kwargs)
            sample_rate = self._sample_rate
        finally:
            self._after_generation()
        elapsed_ms = (time.monotonic() - started) * 1000.0
        audio = self._waveform(waveform)
        del waveform
        self.host.synchronize()
        return audio, sample_rate, elapsed_ms

    def synthesize_stream(
        self,
        text: str,
        voice: Any,
        ref_text: Optional[str],
        max_new_tokens: int,
        speed: Optional[float] = None,
    ) -> Iterator[Tuple[Any, int]]:
        kwargs = self._call_kwargs(text, voice, ref_text, max_new_tokens, speed)
        iterator = None
        try:
            iterator = self._make_generator(kwargs)
            for chunk in iterator:
                if chunk is None:
                    continue
                yield self._waveform(chunk), self._sample_rate
        finally:
            # A partially consumed generator keeps GPU buffers alive until it is
            # closed, and the streaming path has no badcase retry to fall back on.
            if iterator is not None:
                close = getattr(iterator, "close", None)
                if close is not None:
                    try:
                        close()
                    except Exception as exc:  # noqa: BLE001 - closing a finished generator is best effort
                        self.host.log(f"stream close failed: {exc!r}")
            self._after_generation()

    def unload(self) -> None:
        self._model = None
        self._sample_rate = 0


class ModelHost:
    """Facade over the inference backend: loading, warmup, synthesis, VRAM."""

    def __init__(
        self,
        model_dir: str,
        device: str = "cuda:0",
        cache_dir: str = "",
        log: Optional[Callable[[str], None]] = None,
        optimize: bool = False,
        normalize: bool = False,
        cfg_value: float = 2.7,
        timesteps: int = 10,
        max_frames_per_char: float = 3.2,
        audio_multiple: float = 3.0,
        audio_floor_sec: float = 6.0,
        max_generation_sec: float = 90.0,
        chars_per_second: float = 3.3,
        seed: int = 0,
    ) -> None:
        self.model_dir = model_dir
        self.device = device
        self.cache_dir = cache_dir
        self.optimize = bool(optimize)
        self.normalize = bool(normalize)
        self.cfg_value = float(cfg_value)
        self.timesteps = int(timesteps)
        self.max_frames_per_char = float(max_frames_per_char)
        self.audio_multiple = float(audio_multiple)
        self.audio_floor_sec = float(audio_floor_sec)
        self.max_generation_sec = float(max_generation_sec)
        self.chars_per_second = max(0.1, float(chars_per_second))
        self.seed = max(0, int(seed or 0))
        self._log = log or (lambda _msg: None)
        self._backend: Optional[VoxCPMBackend] = None
        self._load_ms = 0
        self._warmup_ms = 0
        self._warmed = False
        self._calls = 0
        self._stream_note = ""
        self._oom_freed_mb: Optional[float] = None

    # ---------------------------------------------------------------- status

    def log(self, message: str) -> None:
        """Backend-facing logging hook (the daemon routes this to stderr)."""
        self._log(message)

    def apply_seed(self) -> None:
        """Reseed torch before one generation when `--seed` is configured.

        A fixed seed makes the SAME text reproducible, which is what a regression test
        needs; it does not make different short sentences share a timbre — merging
        sentences into one generation is what does that.
        """
        if not self.seed:
            return
        try:
            torch = import_torch()
            torch.manual_seed(self.seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(self.seed)
        except Exception as exc:  # noqa: BLE001 - seeding is an optimization, never fatal
            self._log(f"seed failed (ignored): {exc!r}")

    def synchronize(self) -> None:
        """Wait for the GPU so timings and teardown see completed work."""
        try:
            torch = import_torch()
            torch.cuda.synchronize()
        except Exception:  # noqa: BLE001 - CPU runs have no CUDA to synchronize
            pass

    @property
    def engine(self) -> str:
        """Inference engine that serves this daemon (always ``voxcpm`` today)."""
        return self._backend.name if self._backend is not None else VoxCPMBackend.name

    @property
    def is_streaming(self) -> bool:
        """True once the backend is loaded; the streaming decision itself is the daemon's."""
        return bool(self._backend is not None and self._backend.streaming)

    @property
    def is_loaded(self) -> bool:
        return self._backend is not None and self._backend.is_loaded

    @property
    def load_ms(self) -> int:
        """Duration of the last successful load; 0 before any load."""
        return self._load_ms

    @property
    def warmup_ms(self) -> int:
        """Duration of the one-time warmup synthesis; 0 when none ran."""
        return self._warmup_ms

    @property
    def is_warmed(self) -> bool:
        return self._warmed

    @property
    def calls(self) -> int:
        return self._calls

    @property
    def sample_rate(self) -> int:
        """Model sample rate; 0 before the model is loaded."""
        return self._backend.sample_rate if self._backend is not None else 0

    def supports_speed(self) -> bool:
        return bool(self._backend is not None and self._backend.supports_speed())

    # -------------------------------------------------------------- loading

    def ensure_loaded(self) -> Tuple[int, bool]:
        """Load the backend once.

        Returns ``(model_load_ms, model_was_already_loaded)``: the duration is 0 on
        every call after the first, which is how a verifier proves the model stayed
        resident across calls.
        """
        if self.is_loaded:
            return (0, True)

        backend = VoxCPMBackend(self)
        self._log(
            f"loading voxcpm 1.5 from {self.model_dir} ({self.device}, optimize={self.optimize}, "
            f"cfg={self.cfg_value}, timesteps={self.timesteps})"
        )
        started = time.monotonic()
        try:
            backend.load()
        except Exception as exc:  # noqa: BLE001 - surfaced as MODEL_LOAD_FAILED
            self._log(f"voxcpm backend unavailable: {exc!r}")
            try:
                backend.unload()
            except Exception:  # noqa: BLE001 - best effort
                pass
            raise
        self._backend = backend
        self._load_ms = int(round((time.monotonic() - started) * 1000.0))
        self._log(f"voxcpm backend loaded in {self._load_ms} ms at {backend.sample_rate} Hz")
        return (self._load_ms, False)

    def unload(self) -> float:
        """Release the backend and device cache; returns freed MB (0 if not loaded)."""
        if self._backend is None or not self._backend.is_loaded:
            self._backend = None
            return 0.0
        torch = import_torch()
        self.synchronize()
        before = 0.0
        try:
            before = torch.cuda.memory_allocated() / (1024 * 1024)
        except Exception:  # noqa: BLE001 - no CUDA means no VRAM to report
            before = 0.0
        try:
            self._backend.unload()
        except Exception as exc:  # noqa: BLE001 - teardown must not raise
            self._log(f"backend unload failed: {exc!r}")
        self._backend = None
        gc.collect()
        try:
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        except Exception as exc:  # noqa: BLE001 - cache cleanup is best effort
            self._log(f"cuda cache cleanup failed: {exc!r}")
        gc.collect()
        after = 0.0
        try:
            after = torch.cuda.memory_allocated() / (1024 * 1024)
        except Exception:  # noqa: BLE001 - see above
            after = 0.0
        freed = max(0.0, before - after)
        self._load_ms = 0
        self._warmup_ms = 0
        self._warmed = False
        self._log(f"model unloaded, freed {freed:.1f} MB VRAM")
        return freed

    def take_oom_freed(self) -> Optional[float]:
        """MB released by the OOM recovery, once; ``None`` when no OOM was handled."""
        freed, self._oom_freed_mb = self._oom_freed_mb, None
        return freed

    def _handle_oom(self, exc: BaseException) -> bool:
        """Clear the device cache and unload after an OOM so the next call starts clean."""
        if not is_out_of_memory(exc):
            return False
        torch = None
        try:
            torch = import_torch()
            gc.collect()
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
        except Exception as cleanup_exc:  # noqa: BLE001 - recovery must not raise
            self._log(f"OOM cache cleanup failed: {cleanup_exc!r}")
        self._log(f"CUDA out of memory ({exc!r}); unloading the model to release VRAM")
        freed = 0.0
        try:
            freed = self.unload()
        except Exception as unload_exc:  # noqa: BLE001 - recovery must not raise
            self._log(f"OOM unload failed: {unload_exc!r}")
        self._oom_freed_mb = freed
        return True

    # ------------------------------------------------------------ inference

    def max_tokens_for(self, text: str) -> int:
        """Runaway-tail cap for one sentence, derived from its text length (LM tokens)."""
        return max_new_tokens_for(text, frames_per_char=self.max_frames_per_char)

    def audio_limit_sec(self, text: str) -> float:
        """Audible seconds a sentence is allowed to reach before generation is cut.

        A 7-character sentence expects ~2 s of speech; the limit is
        ``max(audio_floor_sec, expected * audio_multiple)`` so short sentences are
        never clipped while a runaway tail is stopped.
        """
        expected = max(0.6, len(text or "") / self.chars_per_second)
        return max(self.audio_floor_sec, expected * self.audio_multiple)

    def take_stream_note(self) -> str:
        """Return (and clear) the last generation-guard note, if any."""
        note, self._stream_note = self._stream_note, ""
        return note

    def generate(
        self,
        text: str,
        voice: Any,
        language: str = "Auto",
        speed: Optional[float] = None,
        max_tokens: int = 0,
    ) -> Tuple[Any, int]:
        """Synthesize one whole sentence (non-streaming).

        ``max_tokens`` is the plan's cap for this unit; ``0`` derives one from the text.
        """
        self.apply_seed()
        audio, sample_rate, elapsed_ms = self._synthesize(text, voice, language, speed, max_tokens)
        self._calls += 1
        self._log(f"generated {len(audio)} samples @ {sample_rate} Hz in {int(elapsed_ms)} ms")
        return audio, sample_rate

    def stream(
        self,
        text: str,
        voice: Any,
        language: str = "Auto",
        speed: Optional[float] = None,
        max_tokens: int = 0,
    ) -> Iterator[Tuple[Any, int]]:
        """Yield ``(audio, sample_rate)`` chunks, smallest latency first.

        ``max_tokens`` is the plan's cap for this unit; ``0`` derives one from the text.
        """
        if self._backend is None:
            raise RuntimeError("model is not loaded")
        self.apply_seed()
        ref_text = voice.ref_text
        cap = int(max_tokens) if max_tokens > 0 else self.max_tokens_for(text)
        limit = self.audio_limit_sec(text)
        started = time.monotonic()
        total = 0
        sample_rate = self._backend.sample_rate
        iterator = self._backend.synthesize_stream(text, voice, ref_text, cap, speed)
        try:
            for chunk, chunk_rate in iterator:
                if chunk is None or len(chunk) == 0:
                    continue
                sample_rate = int(chunk_rate)
                produced = float(len(chunk)) / float(sample_rate)
                remaining = limit - total / float(sample_rate)
                if produced > remaining:
                    keep = max(0, int(remaining * sample_rate))
                    self._stream_note = (
                        f"generation aborted mid-stream: {total / float(sample_rate) + produced:.1f}s of audio "
                        f"for {len(text)} chars (limit {limit:.1f}s, cap {cap} tokens)"
                    )
                    self.log(self._stream_note)
                    if keep > 0:
                        total += keep
                        yield chunk[:keep], sample_rate
                    return
                if time.monotonic() - started > self.max_generation_sec:
                    self._stream_note = (
                        f"generation aborted mid-stream: {time.monotonic() - started:.1f}s of wall time "
                        f"(limit {self.max_generation_sec:.1f}s)"
                    )
                    self.log(self._stream_note)
                    return
                total += int(len(chunk))
                yield chunk, sample_rate
        except Exception as exc:  # noqa: BLE001 - OOM recovery, everything else re-raises
            if self._handle_oom(exc):
                raise ModelOutOfMemory(str(exc)) from exc
            raise
        finally:
            close = getattr(iterator, "close", None)
            if close is not None:
                try:
                    close()
                except Exception as exc:  # noqa: BLE001 - closing a finished generator is best effort
                    self.log(f"stream close failed: {exc!r}")
        self.synchronize()
        self._calls += 1
        self._log(
            f"streamed {total} samples @ {sample_rate} Hz in {int((time.monotonic() - started) * 1000)} ms "
            f"(cap {cap} tokens)"
        )

    def _synthesize(self, text: str, voice: Any, language: str, speed: Optional[float], max_tokens: int = 0):
        """One non-streaming call, without touching the public call counter."""
        if self._backend is None:
            raise RuntimeError("model is not loaded")
        ref_text = voice.ref_text
        cap = int(max_tokens) if max_tokens > 0 else self.max_tokens_for(text)
        try:
            waveform, sample_rate, elapsed_ms = self._backend.synthesize(text, voice, ref_text, cap, speed)
        except Exception as exc:  # noqa: BLE001 - OOM recovery, everything else re-raises
            if self._handle_oom(exc):
                raise ModelOutOfMemory(str(exc)) from exc
            raise
        return to_float32_mono(waveform), int(sample_rate), elapsed_ms

    def warmup(self, voice: Any = None) -> int:
        """No separate warmup: VoxCPM 1.5 warms up inside its constructor.

        The constructor always runs one throwaway generation, which is already part of
        ``modelLoadMs``; generating again here would only add seconds to the first call.
        """
        self._warmed = True
        self._warmup_ms = 0
        self._log("engine warms up during load; no separate warmup generation")
        return 0

    def stats(self) -> Dict[str, Any]:
        """VRAM figures and engine identity for the ``stats`` event."""
        allocated = reserved = peak = free = total = 0.0
        try:
            torch = import_torch()
            if torch.cuda.is_available():
                allocated = torch.cuda.memory_allocated() / (1024 * 1024)
                reserved = torch.cuda.memory_reserved() / (1024 * 1024)
                peak = torch.cuda.max_memory_allocated() / (1024 * 1024)
                free_bytes, total_bytes = torch.cuda.mem_get_info()
                free = float(free_bytes) / (1024 * 1024)
                total = float(total_bytes) / (1024 * 1024)
        except Exception:  # noqa: BLE001 - stats must answer even without a GPU
            pass
        return {
            "modelLoaded": self.is_loaded,
            "modelLoadMs": self._load_ms,
            "warmupMs": self._warmup_ms,
            "generations": self._calls,
            "device": self.device,
            "engine": self.engine,
            "streaming": self.is_streaming,
            "sampleRate": self.sample_rate,
            "optimize": self.optimize,
            "allocatedMb": round(allocated, 1),
            "reservedMb": round(reserved, 1),
            "peakMb": round(peak, 1),
            "freeMb": round(free, 1),
            "totalMb": round(locals().get("total", 0.0), 1),
        }
