#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Live2D TTS daemon shim: the real TTS daemon, plus a PCM envelope / event tee.

This script is meant to be configured as the ``tts`` plugin's ``daemonScript``.  The
host spawns it exactly like the real daemon::

    <pythonPath> live2d_tts_shim.py --voices-dir ... --model-dir <MODELS_DIR> --device cuda:0 --cfg-value 2.7 --preload false

It must therefore behave **byte for byte** like
``<dsh-tool-tts>/python/tts_daemon.py`` on stdin/stdout/stderr and on exit:

* the real daemon is executed **in this same process** with
  ``runpy.run_path(real_daemon, run_name="__main__")``, so its JSONL protocol, stderr
  logging, exit codes, shutdown-on-EOF and signal behaviour are unchanged;
* stdout is never wrapped or rewritten -- protocol frames are observed by teeing
  ``ttslib.events.EventWriter.emit`` (the original writer still writes the frame);
* stdin is never wrapped either -- request lines are observed by teeing ``os.read`` on
  the stdin file descriptor (the daemon's ``StdinPoller`` reads the raw fd);
* the only behavioural addition is a subclass of ``ttslib.runtime.SoundDevicePlayer``
  whose ``_callback`` computes the RMS of the samples actually handed to the sound
  device and forwards a small JSON event stream to the Live2D plugin's local ingest
  endpoint (``POST /ingest``).  Once the output stream is open, its output latency
  (``stream.latency`` / the ``inDeviceSecMs`` override) is reported as ``latencyMs`` on
  ``speak_start`` / ``envelope`` / ``speak_done`` so the renderer can postpone envelope
  consumption and align the mouth with the audible sound.

Everything the tee does is best effort: a missing config, a missing enabled-file, a
dead ingest endpoint, a full queue, a numpy hiccup -- none of it may disturb TTS.  No
GPU work, no model loading, no heavy imports happen here; only ``numpy`` is used (and
only once audio is actually playing).

Side-channel config: ``live2d_tts_shim.json`` next to this file (or the path in
``LIVE2D_TTS_SHIM_CONFIG``)::

    {
      "realDaemon": "<DSH_PROFILE>/node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py",
      "ingestUrl": "http://127.0.0.1:34567/ingest",
      "token": "dsh-live2d-local",
      "enabledFile": "<PLUGIN_ROOT>/data/tts-bridge.enabled",
      "hopMs": 20,
      "envelopeGain": 3.0,
      "batchFrames": 4
    }

Missing/invalid config means "bridge disabled": TTS keeps working, no events are sent.
``enabledFile`` turns the bridge on only while that file exists (the plugin creates it
while the Live2D row is enabled and deletes it on disable), which makes the disabled
state cost one ``stat`` per second at most.

Env overrides (used by the tests / diagnostics): ``LIVE2D_TTS_SHIM_CONFIG``,
``LIVE2D_TTS_REAL_DAEMON``, ``LIVE2D_TTS_INGEST_URL``, ``LIVE2D_TTS_TOKEN``,
``LIVE2D_TTS_ENABLED_FILE``, ``LIVE2D_TTS_HOP_MS``, ``LIVE2D_TTS_ENVELOPE_GAIN``,
``LIVE2D_TTS_BATCH_FRAMES``, ``LIVE2D_TTS_PLAYER_GAIN`` (unused; reserved).

See ``docs/TTS-BRIDGE.md`` for the event protocol, measured evidence and rollback.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

SHIM_VERSION = "1.0.0"
CONFIG_FILE_NAME = "live2d_tts_shim.json"
DEFAULT_INGEST_URL = "http://127.0.0.1:34567/ingest"
DEFAULT_HOP_MS = 20.0
DEFAULT_ENVELOPE_GAIN = 3.0
DEFAULT_BATCH_FRAMES = 4
DEFAULT_POST_TIMEOUT_SEC = 0.8
#: A closed ingest endpoint backs off; events are dropped instead of queued forever.
MAX_POST_BACKOFF_SEC = 10.0
#: At most this many event groups wait for the sender thread.
MAX_QUEUE_DEPTH = 512
#: How often the housekeeping thread refreshes the enabledFile flag and finishes drains.
TICK_SEC = 0.2
#: Frame event names relayed to the plugin (frozen DESIGN.md §2.1 set).
_RELAYED_FRAMES = (
    "speak_start",
    "segment_start",
    "sentence_end",
    "segment_end",
    "speak_done",
    "error",
)


def _now_ms() -> int:
    return int(round(time.time() * 1000.0))


def _log(message: str) -> None:
    """One diagnostic line on stderr; never raises, never touches stdout."""
    try:
        stamp = time.strftime("%H:%M:%S")
        sys.stderr.write(f"[live2d-shim {stamp}] {message}\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001 - logging must never break the daemon
        pass


def _as_text(value: Any) -> str:
    return "" if value is None else str(value)


def _truthy(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def _as_float(value: Any, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float("inf"), float("-inf")):  # NaN/inf
        return default
    return number


def _as_int(value: Any, default: int) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- config


def _config_path() -> str:
    explicit = os.environ.get("LIVE2D_TTS_SHIM_CONFIG", "").strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(os.path.expandvars(explicit)))
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), CONFIG_FILE_NAME)


def _load_config() -> Tuple[Dict[str, Any], str, bool]:
    """Read the side-channel config; returns ``(cfg, path, configured)``.

    A missing or malformed file is not an error: the bridge stays disabled and the TTS
    daemon runs normally.
    """
    path = _config_path()
    raw: Dict[str, Any] = {}
    configured = False
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                loaded = json.load(handle)
            if not isinstance(loaded, dict):
                raise ValueError("config root must be a JSON object")
            raw = loaded
            configured = True
        except Exception as exc:  # noqa: BLE001 - a bad config only disables the bridge
            _log(f"config {path!r} is invalid ({exc}); live2d bridge disabled")
            raw = {}
            configured = False
    else:
        _log(f"config {path!r} not found; live2d bridge disabled")

    cfg: Dict[str, Any] = {
        "realDaemon": _as_text(raw.get("realDaemon")),
        "ingestUrl": _as_text(raw.get("ingestUrl")) or DEFAULT_INGEST_URL,
        "token": _as_text(raw.get("token")),
        "enabledFile": _as_text(raw.get("enabledFile")),
        "hopMs": _as_float(raw.get("hopMs"), DEFAULT_HOP_MS),
        "envelopeGain": _as_float(raw.get("envelopeGain"), DEFAULT_ENVELOPE_GAIN),
        "batchFrames": _as_int(raw.get("batchFrames"), DEFAULT_BATCH_FRAMES),
        "latencyExtraMs": _as_float(raw.get("latencyExtraMs"), 0.0),
        "configDir": os.path.dirname(path),
    }
    env_map = {
        "realDaemon": "LIVE2D_TTS_REAL_DAEMON",
        "ingestUrl": "LIVE2D_TTS_INGEST_URL",
        "token": "LIVE2D_TTS_TOKEN",
        "enabledFile": "LIVE2D_TTS_ENABLED_FILE",
        "hopMs": "LIVE2D_TTS_HOP_MS",
        "envelopeGain": "LIVE2D_TTS_ENVELOPE_GAIN",
        "batchFrames": "LIVE2D_TTS_BATCH_FRAMES",
        "latencyExtraMs": "LIVE2D_TTS_LATENCY_EXTRA_MS",
    }
    for key, env_name in env_map.items():
        value = os.environ.get(env_name, "")
        if value.strip() == "":
            continue
        if key in ("hopMs", "envelopeGain", "latencyExtraMs"):
            cfg[key] = _as_float(value, cfg[key])
        elif key == "batchFrames":
            cfg[key] = _as_int(value, cfg[key])
        else:
            cfg[key] = value.strip()
        configured = True

    cfg["hopMs"] = min(200.0, max(5.0, float(cfg["hopMs"])))
    cfg["envelopeGain"] = min(20.0, max(0.1, float(cfg["envelopeGain"])))
    cfg["batchFrames"] = min(50, max(1, int(cfg["batchFrames"])))
    cfg["latencyExtraMs"] = min(2000.0, max(0.0, float(cfg["latencyExtraMs"])))
    for key in ("realDaemon", "enabledFile"):
        value = cfg[key]
        if value and not os.path.isabs(value):
            cfg[key] = os.path.abspath(os.path.join(cfg["configDir"], value))
    return cfg, path, configured


def _auto_detect_daemon() -> str:
    """Find the real daemon when the config file does not name it.

    Order: ``DSH_TTS_DAEMON``, then the installed desktop/web profile copies.  This is a
    convenience for dev runs; the installed bundle writes an absolute ``realDaemon``.
    """
    explicit = os.environ.get("DSH_TTS_DAEMON", "").strip()
    if explicit and os.path.isfile(explicit):
        return os.path.abspath(explicit)
    home = os.path.expanduser("~")
    profiles = os.path.join(home, ".dsh", "profiles")
    candidates: List[str] = []
    try:
        for profile in sorted(os.listdir(profiles)):
            candidates.append(
                os.path.join(
                    profiles,
                    profile,
                    "node_modules",
                    "@deepseek-ai",
                    "dsh-tool-tts",
                    "python",
                    "tts_daemon.py",
                )
            )
    except OSError:
        pass
    for candidate in candidates:
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return ""


def _resolve_real_daemon(cfg: Dict[str, Any]) -> str:
    named = _as_text(cfg.get("realDaemon"))
    if named and os.path.isfile(named):
        return os.path.abspath(named)
    if named:
        _log(f"configured realDaemon {named!r} does not exist; trying auto-detect")
    found = _auto_detect_daemon()
    if found:
        _log(f"realDaemon auto-detected: {found}")
    return found


# ------------------------------------------------------------------ HTTP delivery


class _IngestSender:
    """Fire-and-forget POST thread: coalesces event groups, backs off when down."""

    def __init__(self, cfg: Dict[str, Any]) -> None:
        self.url = str(cfg.get("ingestUrl") or DEFAULT_INGEST_URL)
        self.token = str(cfg.get("token") or "")
        self.enabled = bool(self.url)
        self._queue: "queue.Queue[List[Dict[str, Any]]]" = queue.Queue(maxsize=MAX_QUEUE_DEPTH)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._disabled_until = 0.0
        self._failures = 0
        self._connected = False
        self._last_warn = 0.0
        self._dropped = 0
        # Bypass any system HTTP proxy: this is a loopback endpoint.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._parts = urllib.parse.urlsplit(self.url)
        if self._parts.scheme not in ("http", "https") or not self._parts.hostname:
            _log(f"ingestUrl {self.url!r} is not a usable http(s) URL; live2d bridge disabled")
            self.enabled = False

    def start(self) -> None:
        if not self.enabled:
            return
        self._thread = threading.Thread(target=self._loop, name="live2d-ingest", daemon=True)
        self._thread.start()
        _log(f"live2d bridge -> {self.url} (token {'set' if self.token else 'empty'})")

    # ---------------------------------------------------------------- posting
    def submit(self, events: List[Dict[str, Any]]) -> None:
        """Queue one group of events; drops (never blocks) when the host is unreachable."""
        if not events or not self.enabled:
            return
        if time.monotonic() < self._disabled_until:
            return
        try:
            self._queue.put_nowait(events)
        except queue.Full:
            self._dropped += len(events)
            if self._dropped % 100 == 1:
                _log(f"ingest queue full; dropped {self._dropped} event(s) so far")

    def _post(self, events: List[Dict[str, Any]]) -> None:
        if not events or not self.enabled:
            return
        if time.monotonic() < self._disabled_until:
            return
        body = json.dumps(events, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "X-Live2D-Token": self.token,
                "User-Agent": f"live2d-tts-shim/{SHIM_VERSION}",
            },
        )
        try:
            with self._opener.open(request, timeout=DEFAULT_POST_TIMEOUT_SEC) as response:
                status = int(getattr(response, "status", 200) or 200)
                response.read()
            if status < 200 or status >= 300:
                raise RuntimeError(f"HTTP {status}")
        except Exception as exc:  # noqa: BLE001 - the ingest path never hurts TTS
            self._failures += 1
            backoff = min(MAX_POST_BACKOFF_SEC, 1.0 * (2 ** min(self._failures - 1, 4)))
            self._disabled_until = time.monotonic() + backoff
            now = time.monotonic()
            if now - self._last_warn > 5.0:
                self._last_warn = now
                _log(
                    f"ingest POST failed ({type(exc).__name__}: {exc}); "
                    f"dropping events for {backoff:.1f}s (TTS is unaffected)"
                )
            return
        self._failures = 0
        if not self._connected:
            self._connected = True
            _log("ingest connected")

    # ----------------------------------------------------------------- thread
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                group = self._queue.get(timeout=TICK_SEC)
            except queue.Empty:
                continue
            groups = [group]
            while len(groups) < 16:
                try:
                    groups.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            flat: List[Dict[str, Any]] = []
            for item in groups:
                flat.extend(item)
            self._post(flat)
        # Final drain after shutdown (best effort, bounded by the queue).
        leftovers: List[Dict[str, Any]] = []
        while True:
            try:
                leftovers.extend(self._queue.get_nowait())
            except queue.Empty:
                break
        if leftovers:
            self._post(leftovers)

    def stop(self, timeout: float = 2.0) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout=timeout)


# ----------------------------------------------------------------------- bridge


def read_output_latency_ms(player: Any, time_info: Any = None) -> int:
    """How long audio handed to the device *now* stays inaudible before it is audible.

    Primary source: the real player's own ``in_device_sec`` (ttslib SPEC-v11 MF-r2-3),
    which is the open sounddevice ``OutputStream.latency`` (or an explicit
    ``inDeviceSecMs`` override).  Fallbacks: the stream's ``latency`` attribute, then the
    callback's PortAudio ``time_info``: ``outputBufferDacTime - currentTime`` is the same
    clock domain's estimate of the output buffer that has not reached the DAC yet.

    Returns 0 when nothing is known; callers omit the field instead of reporting 0.
    """
    if player is not None:
        try:
            getter = getattr(player, "in_device_sec", None)
            seconds = float(getter() if callable(getter) else (getter or 0.0))
            if seconds > 0:
                return int(round(seconds * 1000.0))
        except Exception:  # noqa: BLE001 - latency is decoration, never a failure
            pass
        try:
            stream = getattr(player, "_stream", None)
            latency = float(getattr(stream, "latency", 0.0) or 0.0) if stream is not None else 0.0
            if latency > 0:
                return int(round(latency * 1000.0))
        except Exception:  # noqa: BLE001
            pass
    if time_info is not None:
        try:
            dac = float(getattr(time_info, "outputBufferDacTime", 0.0) or 0.0)
            current = float(getattr(time_info, "currentTime", 0.0) or 0.0)
            if dac > 0 and current > 0 and dac > current:
                return int(round((dac - current) * 1000.0))
        except Exception:  # noqa: BLE001
            pass
    return 0


class Bridge:
    """Tee state: parses requests/frames, collects the playback envelope, ships events."""

    def __init__(self, cfg: Dict[str, Any], configured: bool) -> None:
        self.cfg = cfg
        self.configured = bool(configured)
        self.hop_ms = float(cfg["hopMs"])
        self.gain = float(cfg["envelopeGain"])
        self.batch_frames = int(cfg["batchFrames"])
        self.enabled_file = _as_text(cfg.get("enabledFile"))
        self.sender = _IngestSender(cfg) if configured else None

        self._lock = threading.RLock()
        self._stdin_buffer = bytearray()
        #: request id -> whether the speak request asked for audible playback
        self._pending: Dict[Any, bool] = {}
        self._last_sample_rate = 0
        self._active: Optional[Dict[str, Any]] = None
        self._primary_player: Optional[Any] = None
        self._np: Optional[Any] = None
        self._np_failed = False
        self._bridge_on = False
        self._enabled_checked = 0.0
        #: Output latency of the open stream in ms: audio handed to the device now is
        #: audible only after this much time.  Read from the real player's stream once it
        #: opens (`SoundDevicePlayer.in_device_sec` -> `stream.latency` or the configured
        #: `inDeviceSecMs`); 0 = not known yet / not provided by the player.
        self._latency_ms = 0
        self._latency_source = ""
        #: Calibration offset added to the reported output latency. Positive values
        #: postpone the mouth further (useful when Bluetooth headsets are audibly
        #: later than the player's own latency estimate).
        self.latency_extra_ms = max(0.0, float(cfg.get("latencyExtraMs") or 0.0))
        self._internal_errors = 0
        self._closed = False
        if self.sender is not None:
            self.sender.start()
        self._housekeeping = threading.Thread(target=self._housekeeping_loop, name="live2d-shim-house", daemon=True)
        self._housekeeping.start()

    # ------------------------------------------------------------- lifecycle
    @property
    def bridge_on(self) -> bool:
        """Cheap cached "may I forward anything" flag (enabledFile refreshed once a second)."""
        return self._bridge_on and self.sender is not None and self.sender.enabled

    def _refresh_enabled(self) -> None:
        now = time.monotonic()
        if now - self._enabled_checked < 1.0:
            return
        self._enabled_checked = now
        if not self.configured or self.sender is None or not self.sender.enabled:
            self._bridge_on = False
            return
        if not self.enabled_file:
            self._bridge_on = True
            return
        try:
            self._bridge_on = os.path.isfile(self.enabled_file)
        except OSError:
            self._bridge_on = False

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            with self._lock:
                self._finalize_locked()
        except Exception:  # noqa: BLE001 - teardown must never raise
            pass
        if self.sender is not None:
            self.sender.stop()

    def note_internal_error(self) -> None:
        self._internal_errors += 1
        if self._internal_errors in (1, 10, 100):
            _log(f"internal tee error #{self._internal_errors}:\n{traceback.format_exc()}")

    def register_player(self, player: Any) -> str:
        """Tag the first SoundDevicePlayer instance (the speaker path) as the primary."""
        with self._lock:
            if self._primary_player is None:
                self._primary_player = player
                return "primary"
        return "secondary"

    # ---------------------------------------------------------------- events
    def submit_events(self, events: List[Dict[str, Any]]) -> None:
        if self.sender is not None and self.sender.enabled:
            self.sender.submit(events)

    def _forward(self, event: Dict[str, Any]) -> None:
        self.submit_events([event])

    def _latency_extra(self) -> Dict[str, int]:
        """``{"latencyMs": n}``: output latency + calibration offset (if known)."""
        total = int(round(float(self._latency_ms or 0) + float(self.latency_extra_ms or 0)))
        return {"latencyMs": total} if total > 0 else {}

    # ------------------------------------------------------------- housekeeping
    def _housekeeping_loop(self) -> None:
        while not self._closed:
            try:
                self._refresh_enabled()
                with self._lock:
                    active = self._active
                    if active is not None and not self.bridge_on:
                        # The plugin row was switched off mid-utterance: drop silently.
                        self._active = None
                    elif active is not None:
                        now = time.monotonic()
                        deadline = active.get("drain_until")
                        if deadline is not None and now >= deadline:
                            self._finalize_locked()
                        elif now - active["started"] > 900.0:  # fail-safe: never leak
                            self._finalize_locked()
            except Exception:  # noqa: BLE001 - housekeeping is best effort
                self.note_internal_error()
            time.sleep(TICK_SEC)

    # ------------------------------------------------------------------ stdin
    def on_stdin_bytes(self, data: bytes) -> None:
        """Observe the raw request bytes the daemon's StdinPoller reads (tee only)."""
        self._stdin_buffer.extend(data)
        if len(self._stdin_buffer) > 1_048_576:  # a request line never gets this long
            del self._stdin_buffer[:1_000_000]
        while True:
            index = self._stdin_buffer.find(b"\n")
            if index < 0:
                return
            line = bytes(self._stdin_buffer[:index])
            del self._stdin_buffer[: index + 1]
            self._on_request_line(line)

    def on_stdin_line(self, data: bytes) -> None:
        """Also accept a line without its trailing newline (tests / diagnostics)."""
        self.on_stdin_bytes(data + b"\n" if not data.endswith(b"\n") else data)

    def _on_request_line(self, line: bytes) -> None:
        line = line.strip()
        if not line:
            return
        try:
            request = json.loads(line)
        except Exception:  # noqa: BLE001 - the daemon answers BAD_JSON itself
            return
        if not isinstance(request, dict):
            return
        if _as_text(request.get("op")) != "speak":
            return
        rid = request.get("id")
        play = _truthy(request.get("play"), True)
        segments = _normalize_segments(request.get("segments"))
        with self._lock:
            self._pending[rid] = play
            if len(self._pending) > 32:  # bounds a broken host that never cleans up
                for stale in list(self._pending.keys())[: len(self._pending) - 32]:
                    self._pending.pop(stale, None)
        if not self.bridge_on:
            return
        self._forward(
            {
                "type": "speak_request",
                "id": rid,
                "segments": segments,
                "play": play,
                "sampleRate": self._last_sample_rate or None,
                "ts": _now_ms(),
            }
        )

    # ----------------------------------------------------------------- stdout
    def on_frame(self, payload: Any) -> None:
        """Observe one protocol frame *after* the daemon wrote it unchanged."""
        if not isinstance(payload, dict):
            return
        name = payload.get("event")
        if not isinstance(name, str):
            return
        if name == "ready":
            sample_rate = payload.get("sampleRate")
            if isinstance(sample_rate, int) and sample_rate > 0:
                self._last_sample_rate = sample_rate
            return
        if name not in _RELAYED_FRAMES:
            return
        if not self.bridge_on:
            if name in ("speak_done", "error"):
                with self._lock:
                    self._pending.pop(payload.get("id"), None)
            return
        rid = payload.get("id")
        ts = _now_ms()

        if name == "speak_start":
            with self._lock:
                play = self._pending.pop(rid, True)
            # Settle the previous utterance first: its envelope tail and its held
            # speak_done must reach the host before this one's speak_start.
            if play:
                self._begin_speech(rid)
            else:
                with self._lock:
                    self._finalize_locked()
            self._forward(
                {
                    "type": "speak_start",
                    "id": rid,
                    "segments": payload.get("segments"),
                    "sentences": payload.get("sentences"),
                    "units": payload.get("units"),
                    "modelLoadMs": payload.get("modelLoadMs"),
                    "streaming": payload.get("streaming"),
                    "ts": ts,
                    **self._latency_extra(),
                }
            )
            return

        if name == "segment_start":
            self._forward(
                {
                    "type": "segment_start",
                    "id": rid,
                    "index": payload.get("index"),
                    "usedEmotion": payload.get("usedEmotion"),
                    "requestedEmotion": payload.get("requestedEmotion"),
                    "fallback": bool(payload.get("fallback", False)),
                    "text": payload.get("text"),
                    "sentences": payload.get("sentences"),
                    "ts": ts,
                }
            )
            return

        if name == "sentence_end":
            self._forward(
                {
                    "type": "sentence_end",
                    "id": rid,
                    "index": payload.get("index"),
                    "sentenceIndex": payload.get("sentenceIndex"),
                    "usedEmotion": payload.get("usedEmotion"),
                    "language": payload.get("language"),
                    "text": payload.get("text"),
                    "chars": payload.get("chars"),
                    "genMs": payload.get("genMs"),
                    "audioSec": payload.get("audioSec"),
                    "ts": ts,
                }
            )
            return

        if name == "segment_end":
            self._forward(
                {
                    "type": "segment_end",
                    "id": rid,
                    "index": payload.get("index"),
                    "requestedEmotion": payload.get("requestedEmotion"),
                    "usedEmotion": payload.get("usedEmotion"),
                    "fallback": bool(payload.get("fallback", False)),
                    "seconds": payload.get("seconds"),
                    "sentences": payload.get("sentences"),
                    "ts": ts,
                }
            )
            return

        if name == "error":
            self._forward(
                {
                    "type": "error",
                    "id": rid,
                    "code": payload.get("code"),
                    "message": payload.get("message"),
                    "ts": ts,
                }
            )
            with self._lock:
                self._pending.pop(rid, None)
                self._finalize_locked()
            return

        if name == "speak_done":
            sample_rate = payload.get("sampleRate")
            if isinstance(sample_rate, int) and sample_rate > 0:
                self._last_sample_rate = sample_rate
            remaining = payload.get("remainingMs")
            drain = 0.0
            if isinstance(remaining, (int, float)) and remaining > 0:
                drain = float(remaining) / 1000.0
            with self._lock:
                active = self._active
                if active is not None and active["id"] == rid:
                    # Hold the frame until the tail of the audio has been observed, so the
                    # player sees the envelope before `speak_done` (the daemon returns
                    # early-return mode before the sound is over); `remainingMs` says how much
                    # audio is still in the device queue, plus probe slack.
                    active["done"] = payload
                    active["drain_until"] = time.monotonic() + drain + 0.1
                    return
            self._forward_speak_done(payload)
            return

    def _forward_speak_done(self, payload: Dict[str, Any]) -> None:
        self._forward(
            {
                "type": "speak_done",
                "id": payload.get("id"),
                "ok": bool(payload.get("ok", False)),
                "cancelled": bool(payload.get("cancelled", False)),
                "totalSeconds": payload.get("totalSeconds"),
                "playedMs": payload.get("playedMs"),
                "genMs": payload.get("genMs"),
                "firstAudioMs": payload.get("firstAudioMs"),
                "sampleRate": payload.get("sampleRate") or (self._last_sample_rate or None),
                "remainingMs": payload.get("remainingMs"),
                "early": bool(payload.get("early", False)),
                "segments": payload.get("segments") or [],
                "notes": payload.get("notes") or [],
                "ts": _now_ms(),
                **self._latency_extra(),
            }
        )

    # --------------------------------------------------------------- envelope
    def _numpy(self) -> Optional[Any]:
        if self._np is not None or self._np_failed:
            return self._np
        try:
            import numpy as np  # type: ignore  # noqa: PLC0415 - lazy, never at startup

            self._np = np
        except Exception:  # noqa: BLE001 - no numpy means no envelope, not a broken TTS
            self._np_failed = True
            _log("numpy is not importable; envelope collection disabled")
        return self._np

    def _begin_speech(self, rid: Any) -> None:
        with self._lock:
            if self._active is not None:
                self._finalize_locked()
            self._active = {
                "id": rid,
                "seq": 0,
                "frames": [],
                "pending": None,
                "hop": 0,
                "rate": 0,
                "done": None,
                "drain_until": None,
                "started": time.monotonic(),
                # Set on the first real PCM callback: the sync anchor the renderer
                # uses to start the mouth (segment announcements happen at
                # generation time and can lead the audible sound by seconds).
                "playback_started": False,
            }

    def on_audio(self, outdata: Any, frames: int, rate: int, player: Any = None, time_info: Any = None) -> None:
        """Called right after the real callback filled ``outdata`` with what will play."""
        if not self.bridge_on or int(rate) <= 0:
            return
        if self._latency_ms <= 0:
            latency = read_output_latency_ms(player, time_info)
            if latency > 0:
                self._latency_ms = latency
                self._latency_source = "stream"
        np = self._numpy()
        if np is None:
            return
        try:
            mono = outdata[:, 0]
        except Exception:  # noqa: BLE001 - a 1-D buffer is fine too
            mono = outdata.reshape(-1)
        mono = np.ascontiguousarray(mono, dtype=np.float32)
        if mono.size == 0:
            return
        with self._lock:
            active = self._active
            if active is None:
                return
            now = time.monotonic()
            deadline = active.get("drain_until")
            if deadline is not None and now >= deadline:
                self._finalize_locked()
                return
            if not active.get("playback_started"):
                # First sample handed to the device for this utterance: from now
                # (plus the output latency) the sound is actually audible.
                active["playback_started"] = True
                self.submit_events(
                    [
                        {
                            "type": "playback_start",
                            "id": active["id"],
                            "seq": active["seq"],
                            "ts": _now_ms(),
                            "sampleRate": int(rate),
                            **self._latency_extra(),
                        }
                    ]
                )
            active["rate"] = int(rate)
            hop = active["hop"] or max(1, int(round(float(rate) * self.hop_ms / 1000.0)))
            active["hop"] = hop
            pending = active["pending"]
            data = mono if pending is None or pending.size == 0 else np.concatenate((pending, mono))
            full = int(data.size) // int(hop)
            if full:
                usable = data[: full * hop].reshape(full, hop).astype(np.float64)
                values = np.minimum(1.0, np.sqrt((usable * usable).mean(axis=1)) * self.gain)
                active["frames"].extend(round(float(value), 4) for value in values)
                data = data[full * hop :]
            active["pending"] = np.array(data, copy=True) if data.size else None
            if len(active["frames"]) >= self.batch_frames:
                self._flush_envelope_locked()
            deadline = active.get("drain_until")
            if deadline is not None and time.monotonic() >= deadline:
                self._finalize_locked()

    def _flush_envelope_locked(self) -> None:
        active = self._active
        if active is None or not active["frames"]:
            return
        event = {
            "type": "envelope",
            "id": active["id"],
            "seq": active["seq"],
            "frames": active["frames"],
            "frameMs": self.hop_ms,
            "sampleRate": active["rate"] or (self._last_sample_rate or None),
            "ts": _now_ms(),
        }
        # Audio just handed to the device becomes audible only after this delay; the
        # renderer postpones envelope consumption by this much to align the mouth.
        event.update(self._latency_extra())
        active["seq"] += 1
        active["frames"] = []
        self.submit_events([event])

    def _finalize_locked(self) -> None:
        active = self._active
        if active is None:
            return
        try:
            pending = active.get("pending")
            if pending is not None and getattr(pending, "size", 0):
                np = self._np
                if np is not None:
                    tail = pending.astype(np.float64)
                    rms = float(np.sqrt(float((tail * tail).mean())))
                    active["frames"].append(round(min(1.0, rms * self.gain), 4))
            self._flush_envelope_locked()
        finally:
            active = self._active
            self._active = None
            done = active.get("done") if active else None
        if done is not None:
            self._forward_speak_done(done)


def _normalize_segments(raw: Any) -> List[Dict[str, str]]:
    """Project the request's segments onto the DESIGN.md shape ``{emotion, content}``."""
    out: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            out.append({"emotion": "", "content": item})
            continue
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if content is None:
            content = item.get("text")
        out.append({"emotion": _as_text(item.get("emotion")), "content": _as_text(content)})
    return out


# ------------------------------------------------------------------ patching


def _install_event_tee(bridge: Bridge, events_module: Any) -> None:
    """Wrap ``EventWriter.emit``: the original writes the frame, we copy it for the host."""
    original_emit = events_module.EventWriter.emit

    def emit(self, payload: dict) -> dict:
        result = original_emit(self, payload)
        try:
            bridge.on_frame(payload)
        except Exception:  # noqa: BLE001 - a tee bug must not corrupt the protocol
            bridge.note_internal_error()
        return result

    events_module.EventWriter.emit = emit


def _install_player_tee(bridge: Bridge, runtime_module: Any) -> None:
    """Subclass SoundDevicePlayer; every speaker-path callback feeds the envelope."""
    real_player = runtime_module.SoundDevicePlayer

    class Live2DTeePlayer(real_player):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._live2d_role = bridge.register_player(self)

        def _callback(self, outdata: Any, frames: int, time_info: Any, status: Any) -> None:
            super()._callback(outdata, frames, time_info, status)
            if self._live2d_role != "primary":
                return
            try:
                rate = int(getattr(self, "rate", 0) or 0)
                bridge.on_audio(outdata, int(frames), rate, player=self, time_info=time_info)
            except Exception:  # noqa: BLE001 - never break the audio callback
                bridge.note_internal_error()

    runtime_module.SoundDevicePlayer = Live2DTeePlayer


def _install_stdin_tee(bridge: Bridge) -> bool:
    """Wrap ``os.read`` on the stdin fd; the daemon's StdinPoller still gets the bytes."""
    try:
        stdin_fd = sys.stdin.fileno()
    except Exception:  # noqa: BLE001 - an exotic stdin means no request tee, not a failure
        _log("stdin has no fileno(); speak_request events disabled")
        return False
    original_read = os.read

    def read(handle: int, size: int) -> bytes:
        data = original_read(handle, size)
        if data and handle == stdin_fd:
            try:
                bridge.on_stdin_bytes(data)
            except Exception:  # noqa: BLE001 - never affect the daemon's read path
                bridge.note_internal_error()
        return data

    os.read = read  # type: ignore[assignment]
    return True


def _exit_code(exc: BaseException) -> int:
    """Mirror CPython's ``sys.exit`` semantics for a SystemExit raised by the daemon."""
    code = getattr(exc, "code", None)
    if code is None:
        return 0
    if isinstance(code, int):
        return int(code)
    try:
        sys.stderr.write(f"{code}\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass
    return 1


# ----------------------------------------------------------------------- main


def main() -> int:
    cfg, config_path, configured = _load_config()
    real_daemon = _resolve_real_daemon(cfg)
    if not real_daemon:
        _log(
            "FATAL: the real TTS daemon (tts_daemon.py) was not found. Set 'realDaemon' in "
            f"{config_path!r} or DSH_TTS_DAEMON / LIVE2D_TTS_REAL_DAEMON; TTS cannot work "
            "through this shim without it."
        )
        return 3

    _log(
        f"live2d tts shim {SHIM_VERSION} starting (pid {os.getpid()}); "
        f"real daemon: {real_daemon}; bridge: "
        f"{'ON -> ' + str(cfg.get('ingestUrl')) if configured else 'OFF (no config)'}"
    )

    # The real daemon's own directory first, so `import ttslib` resolves there.
    daemon_dir = os.path.dirname(os.path.abspath(real_daemon))
    sys.path.insert(0, daemon_dir)
    try:
        import ttslib.events as events_module  # noqa: PLC0415 - must follow sys.path setup
        import ttslib.runtime as runtime_module  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001 - report clearly and fail like a broken daemon
        _log(f"FATAL: cannot import ttslib from {daemon_dir!r}: {exc!r}")
        traceback.print_exc(file=sys.stderr)
        return 4

    bridge = Bridge(cfg, configured)
    try:
        _install_stdin_tee(bridge)
        _install_event_tee(bridge, events_module)
        _install_player_tee(bridge, runtime_module)

        import runpy  # noqa: PLC0415 - stdlib, cheap

        exit_code = 0
        try:
            runpy.run_path(real_daemon, run_name="__main__")
        except SystemExit as exc:  # the daemon's own exit; preserve its code
            exit_code = _exit_code(exc)
        except KeyboardInterrupt:
            raise
        except BaseException:  # noqa: BLE001 - a crash must look like the daemon crashing
            _log("real daemon raised an unhandled exception:")
            traceback.print_exc(file=sys.stderr)
            exit_code = 1
        return int(exit_code)
    finally:
        try:
            bridge.shutdown()
        except Exception:  # noqa: BLE001 - shutdown must never change the exit path
            pass


if __name__ == "__main__":
    sys.exit(main())

