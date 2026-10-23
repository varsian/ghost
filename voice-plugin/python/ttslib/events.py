"""JSON Lines event writer and stderr logger for the TTS daemon.

stdout carries only protocol events (one JSON object per line, UTF-8, no BOM);
every human-readable record goes to stderr so a plugin can parse stdout blindly.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any, Optional, TextIO


class EventWriter:
    """Serializes protocol events onto a byte stream and logs to another stream.

    Writes are atomic per line: concurrent callers (generation worker, playback
    thread, idle timer) each emit one complete JSON line under a lock, so a
    plugin reading line by line never sees a partial or interleaved record.
    """

    def __init__(self, stdout=None, stderr=None) -> None:
        self._out = stdout if stdout is not None else sys.stdout.buffer
        self._err: TextIO = stderr if stderr is not None else sys.stderr
        self._lock = threading.Lock()
        self._log_lock = threading.Lock()

    def emit(self, payload: dict) -> dict:
        """Write one event object as a single UTF-8 JSON line and flush it."""
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        data = (line + "\n").encode("utf-8")
        with self._lock:
            try:
                self._out.write(data)
                self._out.flush()
            except Exception as exc:  # noqa: BLE001 - stdout may be a closed pipe
                self.log(f"event write failed: {exc!r}")
        return payload

    def event(self, name: str, request_id: Optional[str] = None, **fields: Any) -> dict:
        """Emit ``{"id":..., "event":name, **fields}``."""
        payload: dict = {"id": request_id, "event": name}
        payload.update(fields)
        return self.emit(payload)

    def error(self, request_id: Optional[str], code: str, message: str, detail: str = "") -> dict:
        """Emit a protocol ``error`` event; the daemon keeps serving."""
        return self.event(
            "error",
            request_id,
            ok=False,
            code=code,
            message=message,
            detail=detail,
        )

    def log(self, message: str) -> None:
        """Write one timestamped record to stderr; never raises."""
        stamp = time.strftime("%H:%M:%S", time.localtime())
        with self._log_lock:
            try:
                self._err.write(f"[tts {stamp}] {message}\n")
                self._err.flush()
            except Exception:  # noqa: BLE001 - logging must never break the daemon
                pass
