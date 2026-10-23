"""Shared harness: boot ``tts_daemon.py`` against the faked ``voxcpm`` package.

Used by the daemon-level engine tests so every one of them drives the real
protocol over stdin/stdout without a GPU, a model download, or playback.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
DAEMON = os.path.join(PYTHON_DIR, "tts_daemon.py")
FAKE_VOX = os.path.join(HERE, "fake_voxcpm")


def write_wav(path: str, seconds: float = 0.2, rate: int = 44100) -> None:
    """Write a silent mono WAV the voice scanner accepts."""
    frames = int(seconds * rate)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)


def write_text(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def make_voice(voices_dir: str, name: str = "默认", transcript: str = "你好呀", seconds: float = 0.2) -> str:
    """Create ``<name>.wav`` plus its ``<name>.txt`` transcript; returns the audio path."""
    path = os.path.join(voices_dir, name + ".wav")
    write_wav(path, seconds=seconds)
    if transcript is not None:
        write_text(os.path.join(voices_dir, name + ".txt"), transcript)
    return path


class FakeVoxDaemon:
    """One daemon subprocess with a JSON-event queue and marker-file access."""

    def __init__(
        self,
        voices_dir: str,
        marker_path: str,
        extra_args=(),
        fake_env=None,
        python: str = "",
    ) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = FAKE_VOX + os.pathsep + env.get("PYTHONPATH", "")
        env["FAKE_VOX_MARKER"] = marker_path
        env["PYTHONIOENCODING"] = "utf-8"
        env.update({key: str(value) for key, value in (fake_env or {}).items()})
        self.marker_path = marker_path
        self.stdout_lines: list[str] = []
        self.stderr_lines: list[str] = []
        self.events: list[dict] = []
        self.queue: "queue.Queue[dict]" = queue.Queue()
        argv = [
            python or sys.executable,
            DAEMON,
            "--voices-dir",
            voices_dir,
            "--default-emotion",
            "默认",
            "--model-dir",
            os.path.join(voices_dir, "model"),
            # Tests must not build a CUDA context: the engine only touches the device
            # when the value names one (PROTOCOL.md §3).
            "--device",
            "auto",
            "--cache-dir",
            os.path.join(voices_dir, "cache"),
            "--first-sentence-max-chars",
            "0",
            "--cfg-value",
            "2.7",
            "--timesteps",
            "10",
            "--optimize",
            "false",
            "--normalize",
            "false",
        ] + list(extra_args)
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        for target in (self._pump_stdout, self._pump_stderr):
            threading.Thread(target=target, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            self.stdout_lines.append(line)
            event = {"__unparsable__": line}
            try:
                event = json.loads(line)
            except Exception:  # noqa: BLE001 - the tests assert on stdout purity
                pass
            self.events.append(event)
            self.queue.put(event)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr_lines.append(raw.decode("utf-8", "replace").rstrip())

    def send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def speak(self, segments, **fields) -> dict:
        payload = {"id": "1", "op": "speak", "segments": segments, "play": False}
        payload.update(fields)
        self.send(payload)

    def expect(self, name: str, timeout: float = 60.0, **fields) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timeout waiting for {name!r} {fields}; stderr tail:\n{self.stderr_tail()}"
                )
            try:
                event = self.queue.get(timeout=remaining)
            except queue.Empty:
                raise AssertionError(
                    f"timeout waiting for {name!r} {fields}; events so far: "
                    f"{[item.get('event') for item in self.events]}; stderr tail:\n{self.stderr_tail()}"
                ) from None
            if event.get("event") == name and all(event.get(key) == value for key, value in fields.items()):
                return event

    def ready(self) -> dict:
        return self.expect("ready")

    def of(self, name: str) -> list:
        """Every event of one name received so far, in arrival order."""
        return [event for event in self.events if event.get("event") == name]

    def stderr_tail(self, count: int = 20) -> str:
        return "\n".join(self.stderr_lines[-count:])

    def marker(self) -> dict:
        if not os.path.exists(self.marker_path):
            return {}
        try:
            with open(self.marker_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:  # noqa: BLE001 - a half-written marker is a failed assertion
            return {}

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(timeout=15)
        except Exception:  # noqa: BLE001 - teardown
            pass
