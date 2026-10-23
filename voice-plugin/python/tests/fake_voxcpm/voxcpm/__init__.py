"""Stand-in for ``voxcpm`` (1.5.0) for tests.

Reproduces the API shape the engine uses — ``VoxCPM(voxcpm_model_path=…,
enable_denoiser=…, zipenhancer_model_path=…, optimize=…)`` with no ``device``
keyword, ``model.tts_model.sample_rate``, ``generate(**kwargs)`` and the
incremental ``generate_streaming(**kwargs)`` — plus a stdout banner so the
protocol-purity checks cover this import too.

Importing the real package prints notices, and its constructor runs one warmup
generation, so both happen here as well (booked as ``ctor_warmup`` in the marker).

Environment knobs:

* ``FAKE_VOX_MARKER`` — path of a JSON file recording call counts, the constructor
  keywords, the generation keywords, and whether the streaming generator closed.
* ``FAKE_VOX_LOAD_SEC`` — seconds to spend in the constructor (slow load).
* ``FAKE_VOX_RUNAWAY=1`` — every generation produces 60 s of audio.
* ``FAKE_VOX_LONG_TAIL=1`` — append a 30 s tail after the first streaming chunk.
* ``FAKE_VOX_OOM=1`` — raise ``RuntimeError("CUDA out of memory …")`` on generate.
* ``FAKE_VOX_BAD_RESPONSE=1`` — ``generate`` returns ``None`` instead of a waveform.
* ``FAKE_VOX_IMPORT_FAIL=1`` — raise at import time (the MODEL_LOAD_FAILED path).
* ``FAKE_VOX_SAMPLE_RATE`` — override the reported sample rate.
* ``FAKE_VOX_HONOR_MAX_LEN=1`` — produce exactly the ``max_len`` the caller allowed,
  the way the engine truncates a runaway generation at its cap.
* ``FAKE_VOX_SILENT_BODY=1`` — the produced body is sub-gate silence, which is how a
  capped runaway looks after the silence trimmer.
"""

from __future__ import annotations

import json
import os
import time

if os.environ.get("FAKE_VOX_IMPORT_FAIL", "") not in ("", "0", "false"):
    raise RuntimeError("FAKE_VOX_IMPORT_FAIL: the voxcpm package cannot be imported")

print("FAKE-VOXCPM-BANNER: loading faked voxcpm 1.5.0 (stdout)")

_MARKER = os.environ.get("FAKE_VOX_MARKER", "")
_LOAD_SEC = float(os.environ.get("FAKE_VOX_LOAD_SEC", "0") or 0.0)
_RUNAWAY = os.environ.get("FAKE_VOX_RUNAWAY", "") not in ("", "0", "false")
_LONG_TAIL = os.environ.get("FAKE_VOX_LONG_TAIL", "") not in ("", "0", "false")
_OOM = os.environ.get("FAKE_VOX_OOM", "") not in ("", "0", "false")
_BAD_RESPONSE = os.environ.get("FAKE_VOX_BAD_RESPONSE", "") not in ("", "0", "false")
#: Honour ``max_len`` as a real generation cap (the engine truncates there), and
#: optionally make the truncated body sub-gate silence, which is how a capped runaway
#: looks after the silence trimmer.
_HONOR_MAX_LEN = os.environ.get("FAKE_VOX_HONOR_MAX_LEN", "") not in ("", "0", "false")
_SILENT_BODY = os.environ.get("FAKE_VOX_SILENT_BODY", "") not in ("", "0", "false")

#: VoxCPM 1.5 emits one language-model token per 7056 decoded samples at 44.1 kHz.
SAMPLE_RATE = int(os.environ.get("FAKE_VOX_SAMPLE_RATE", "44100") or 44100)
CHUNK_SAMPLES = 7056
LEAD_SILENCE_SEC = 0.15
TAIL_SILENCE_SEC = 0.30


def _bump(name: str, **fields) -> None:
    if not _MARKER:
        return
    data = {}
    if os.path.exists(_MARKER):
        try:
            with open(_MARKER, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:  # noqa: BLE001 - the marker is diagnostic only
            data = {}
    data[name] = int(data.get(name, 0)) + 1
    if fields:
        data.setdefault("last", {})
        for key, value in fields.items():
            if isinstance(value, dict):
                data["last"].setdefault(name, {})
                data["last"][name] = value
            else:
                data[f"{name}.{key}"] = value
    with open(_MARKER, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)


def _tone(seconds: float, amplitude: float = 0.2, frequency: float = 220.0):
    import numpy as np

    frames = max(1, int(seconds * SAMPLE_RATE))
    timeline = np.arange(frames, dtype=np.float32) / SAMPLE_RATE
    return (amplitude * np.sin(2.0 * np.pi * frequency * timeline)).astype(np.float32)


def _silence(seconds: float):
    import numpy as np

    return np.zeros(max(1, int(seconds * SAMPLE_RATE)), dtype=np.float32)


def _check_prompt_pair(prompt_wav_path, prompt_text) -> None:
    """The real library refuses a half-given clone prompt."""
    if (prompt_wav_path is None) != (prompt_text is None):
        raise ValueError("prompt_wav_path and prompt_text must both be provided or both be None")
    if prompt_wav_path is not None and not os.path.exists(prompt_wav_path):
        raise FileNotFoundError(f"prompt_wav_path does not exist: {prompt_wav_path}")


class _FakeTtsModel:
    """The inner model that carries the reported sample rate."""

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = int(sample_rate)
        self.device = "cpu"


class VoxCPM:
    """API-compatible fake returning tone-framed audio at the reported rate."""

    def __init__(
        self,
        voxcpm_model_path: str,
        zipenhancer_model_path: str = "iic/speech_zipenhancer_ans_multiloss_16k_base",
        enable_denoiser: bool = True,
        optimize: bool = True,
        lora_config=None,
        lora_weights_path=None,
    ) -> None:
        self.kwargs = {
            "voxcpm_model_path": voxcpm_model_path,
            "zipenhancer_model_path": zipenhancer_model_path,
            "enable_denoiser": enable_denoiser,
            "optimize": optimize,
        }
        if _LOAD_SEC > 0:
            time.sleep(_LOAD_SEC)
        self.tts_model = _FakeTtsModel(SAMPLE_RATE)
        _bump("init", **{key: value for key, value in self.kwargs.items() if value is not None})
        # The real constructor always runs one throwaway generation, which is part of
        # the daemon's load time. It is booked under its own marker key so tests can
        # still assert the arguments of the generations they asked for.
        _bump("ctor_warmup")
        time.sleep(0.005)

    def _kwargs_seen(self, kwargs: dict) -> dict:
        return {
            "text": kwargs.get("text"),
            "max_len": kwargs.get("max_len"),
            "cfg_value": kwargs.get("cfg_value"),
            "inference_timesteps": kwargs.get("inference_timesteps"),
            "normalize": kwargs.get("normalize"),
            "retry_badcase": kwargs.get("retry_badcase"),
            "prompt_wav_path": kwargs.get("prompt_wav_path"),
            "prompt_text": kwargs.get("prompt_text"),
        }

    def _prepare(self, kwargs: dict) -> None:
        _check_prompt_pair(kwargs.get("prompt_wav_path"), kwargs.get("prompt_text"))
        if _OOM:
            raise RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")

    def _audio(self, text: str, max_len: int = 0):
        import numpy as np

        if _HONOR_MAX_LEN and max_len:
            body = max(0.05, float(max_len) / 6.25)  # exactly what the cap allows
        else:
            body = 60.0 if _RUNAWAY else max(0.2, 0.04 * len(text or ""))
        middle = _silence(body) if _SILENT_BODY else _tone(body)
        return np.concatenate([_silence(LEAD_SILENCE_SEC), middle, _silence(TAIL_SILENCE_SEC)])

    def generate(self, **kwargs):
        self._prepare(kwargs)
        _bump("generate", **self._kwargs_seen(kwargs))
        time.sleep(0.01)
        if _BAD_RESPONSE:
            return None
        return self._audio(kwargs.get("text", ""), int(kwargs.get("max_len") or 0))

    def generate_streaming(self, **kwargs):
        self._prepare(kwargs)
        _bump("generate_streaming", **self._kwargs_seen(kwargs))
        audio = self._audio(kwargs.get("text", ""), int(kwargs.get("max_len") or 0))
        try:
            for start in range(0, len(audio), CHUNK_SAMPLES):
                time.sleep(0.002)
                yield audio[start : start + CHUNK_SAMPLES]
            if _LONG_TAIL:
                tail = _silence(30.0)
                for start in range(0, len(tail), CHUNK_SAMPLES):
                    time.sleep(0.002)
                    yield tail[start : start + CHUNK_SAMPLES]
        finally:
            _bump("stream_closed")
