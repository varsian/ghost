#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Real end-to-end acceptance test for the Live2D TTS shim.

Uses the **real TTS venv and the real VoxCPM 1.5 daemon** (GPU, audible):

1. ``direct``   -- spawn ``tts_daemon.py`` directly (the reference behaviour), send one
   short ``speak`` request, keep every protocol frame.
2. ``shim``     -- spawn ``live2d_tts_shim.py`` with a local ingest listener, send the
   same request plus a ``play:false`` request, collect both the raw stdout frames and
   the ingest event stream.  Asserts the shim's stdout frames carry exactly the same
   structure/values as the direct run (relay fidelity), and that the envelope matches
   the reported audio duration with real levels.
3. ``bare``     -- spawn the shim with **no** side-channel config at all (bridge disabled,
   real daemon auto-detected): TTS must behave exactly like the direct daemon.

Run with the TTS venv (numpy is only needed by the shim, the test is stdlib):

    <python> tests/test_shim.py
    ... tests/test_shim.py --scenario shim --keep

Environment overrides: ``DSH_TTS_PYTHON``, ``LIVE2D_TTS_REAL_DAEMON``,
``LIVE2D_TTS_VOICES_DIR``.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

PLUGIN_DIR = Path(__file__).resolve().parents[1]
SHIM = PLUGIN_DIR / "packages" / "plugin" / "python" / "live2d_tts_shim.py"
DEFAULT_PYTHON = os.environ.get("DSH_TTS_PYTHON", "")
DEFAULT_DAEMON = os.environ.get("LIVE2D_TTS_REAL_DAEMON", "")
DEFAULT_VOICES = os.environ.get("LIVE2D_TTS_VOICES_DIR", "")
TOKEN = "dsh-live2d-local"
HOP_MS = 20
SENTENCE = "你好呀"

# Python child processes here cannot write to %TEMP% (sandbox ACL), so test artifacts
# live under the package's own ignored cache directory instead.
TEMP_ROOT = Path(os.environ.get("LIVE2D_TTS_TEST_TMP") or (PLUGIN_DIR / ".test-cache"))
STARTED = time.time()


def log(message: str) -> None:
    print(f"[test-shim] {message}", flush=True)


def now_ms() -> int:
    return int(round(time.time() * 1000))


class IngestListener:
    """The plugin-host side of the bridge: POST /ingest with a token header."""

    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []
        self.requests: List[Dict[str, Any]] = []
        self.tokens: List[Optional[str]] = []
        self.bodies: List[str] = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server API
                if self.path != "/ingest":
                    self.send_response(404)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                token = self.headers.get("X-Live2D-Token")
                try:
                    parsed = json.loads(body.decode("utf-8"))
                    items = parsed if isinstance(parsed, list) else [parsed]
                except Exception:  # noqa: BLE001 - record it and fail the assertion later
                    items = []
                    parsed = None
                with outer._lock:
                    outer.requests.append({"bytes": len(body), "ts": now_ms()})
                    outer.tokens.append(token)
                    outer.bodies.append(body.decode("utf-8", "replace"))
                    outer.events.extend(item for item in items if isinstance(item, dict))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = int(self.server.server_address[1])
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/ingest"

    def of_type(self, event_type: str, rid: Optional[str] = None) -> List[Dict[str, Any]]:
        return [
            event
            for event in self.events
            if event.get("type") == event_type and (rid is None or event.get("id") == rid)
        ]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class DaemonRun:
    """One spawned daemon/shim process: JSONL stdout frames + stderr tail."""

    def __init__(self, label: str, script: Path, args: List[str], env: Dict[str, str], cwd: Path) -> None:
        self.label = label
        self.frames: List[Dict[str, Any]] = []
        self.raw_lines: List[str] = []
        self.stderr: List[str] = []
        self.bad_lines: List[str] = []
        self._queue: "queue.Queue[Optional[str]]" = queue.Queue()
        self.proc = subprocess.Popen(
            [env["_PYTHON"], str(script), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(cwd),
        )
        threading.Thread(target=self._read_stdout, name=f"{label}-stdout", daemon=True).start()
        threading.Thread(target=self._read_stderr, name=f"{label}-stderr", daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            self._queue.put(raw.decode("utf-8", "replace"))
        self._queue.put(None)

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            self.stderr.append(raw.decode("utf-8", "replace").rstrip("\r\n"))

    def send(self, request: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def wait_frame(self, predicate: Callable[[Dict[str, Any]], bool], timeout: float, what: str) -> Dict[str, Any]:
        deadline = time.time() + timeout
        for frame in self.frames:
            if predicate(frame):
                return frame
        while time.time() < deadline:
            try:
                line = self._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                break
            text = line.strip()
            if not text:
                continue
            self.raw_lines.append(text)
            try:
                frame = json.loads(text)
            except Exception:  # noqa: BLE001 - stdout purity is asserted afterwards
                self.bad_lines.append(text)
                continue
            if not isinstance(frame, dict):
                self.bad_lines.append(text)
                continue
            self.frames.append(frame)
            if predicate(frame):
                return frame
        raise TimeoutError(
            f"{self.label}: no {what} within {timeout:.0f}s; frames={[f.get('event') for f in self.frames]} "
            f"stderr={self.stderr[-6:]}"
        )

    def close(self, timeout: float = 20.0) -> int:
        if self.proc.stdin is not None:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            return int(self.proc.wait(timeout=timeout))
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return -1

    def tail(self, count: int = 8) -> List[str]:
        return self.stderr[-count:]


def daemon_args(voices_dir: str, cache_dir: str) -> List[str]:
    model_dir = os.environ.get("LIVE2D_TEST_MODEL_DIR", "<MODELS_DIR>")
    return [
        "--voices-dir",
        voices_dir,
        "--default-emotion",
        "默认",
        "--model-dir",
        model_dir,
        "--device",
        "cuda:0",
        "--cfg-value",
        "2.7",
        "--timesteps",
        "10",
        "--cache-dir",
        cache_dir,
        "--preload",
        "false",
    ]


def speak_request(rid: str, content: str, play: bool = True) -> Dict[str, Any]:
    return {
        "id": rid,
        "op": "speak",
        "segments": [{"emotion": "默认", "content": content}],
        "play": play,
        "gapMs": 120,
    }


def base_env(python: str) -> Dict[str, str]:
    env = dict(os.environ)
    env["_PYTHON"] = python
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    env.pop("LIVE2D_TTS_SHIM_CONFIG", None)
    return env


class Harness:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.python = args.python
        self.real_daemon = Path(args.real_daemon)
        self.voices = args.voices_dir
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.work = Path(tempfile.mkdtemp(prefix="live2d-tts-e2e-", dir=str(TEMP_ROOT)))
        self.cache = PLUGIN_DIR / ".test-cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.runs: List[DaemonRun] = []
        log(f"work dir: {self.work}")
        log(f"python: {self.python}")
        log(f"real daemon: {self.real_daemon}")

    def spawn(self, label: str, script: Path, config: Optional[Dict[str, Any]]) -> DaemonRun:
        env = base_env(self.python)
        if config is not None:
            config_path = self.work / f"{label}.json"
            config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
            env["LIVE2D_TTS_SHIM_CONFIG"] = str(config_path)
        run = DaemonRun(label, script, daemon_args(self.voices, str(self.cache)), env, self.work)
        self.runs.append(run)
        return run

    # ------------------------------------------------------------------ cases
    def run_direct(self) -> Dict[str, Any]:
        log("scenario direct: reference run of the real daemon")
        started = time.time()
        run = self.spawn("direct", self.real_daemon, None)
        ready = run.wait_frame(lambda f: f.get("event") == "ready", 60, "ready")
        log(f"  ready in {time.time() - started:.1f}s: engine={ready.get('engine')} sampleRate={ready.get('sampleRate')} "
            f"emotions={ready.get('emotionNames')}")
        run.send(speak_request("d1", SENTENCE, True))
        done = run.wait_frame(lambda f: f.get("event") == "speak_done", 180, "speak_done")
        code = run.close()
        assert code == 0, f"direct daemon exit code {code}; stderr={run.tail()}"
        assert not run.bad_lines, f"direct stdout contains non-JSON lines: {run.bad_lines}"
        log(f"  direct speak_done: totalSeconds={done.get('totalSeconds')} playedMs={done.get('playedMs')} "
            f"genMs={done.get('genMs')} modelLoadMs={done.get('modelLoadMs')} firstAudioMs={done.get('firstAudioMs')} "
            f"sampleRate={done.get('sampleRate')} remainingMs={done.get('remainingMs')} early={done.get('early')}")
        return {"ready": ready, "done": done, "frames": [f.get("event") for f in run.frames]}

    def run_shim(self) -> Dict[str, Any]:
        log("scenario shim: ingest-enabled shim around the real daemon")
        listener = IngestListener()
        result: Dict[str, Any] = {}
        try:
            config = {
                "realDaemon": str(self.real_daemon),
                "ingestUrl": listener.url,
                "token": TOKEN,
                "enabledFile": "",
                "hopMs": HOP_MS,
                "envelopeGain": 3.0,
                "batchFrames": 4,
            }
            started = time.time()
            run = self.spawn("shim", SHIM, config)
            ready = run.wait_frame(lambda f: f.get("event") == "ready", 60, "ready")
            log(f"  ready in {time.time() - started:.1f}s")
            run.send(speak_request("t1", SENTENCE, True))
            done1 = run.wait_frame(lambda f: f.get("event") == "speak_done" and f.get("id") == "t1", 180, "speak_done t1")
            t1_at = time.time() - started
            deadline = time.time() + 20
            while time.time() < deadline and not listener.of_type("speak_done", "t1"):
                time.sleep(0.05)
            log(f"  t1 done at {t1_at:.1f}s: totalSeconds={done1.get('totalSeconds')} remainingMs={done1.get('remainingMs')} "
                f"playedMs={done1.get('playedMs')} genMs={done1.get('genMs')} firstAudioMs={done1.get('firstAudioMs')}")

            # ---- play:false must be a normal utterance with zero envelope
            run.send(speak_request("t2", "安静", False))
            done2 = run.wait_frame(lambda f: f.get("event") == "speak_done" and f.get("id") == "t2", 180, "speak_done t2")
            deadline = time.time() + 20
            while time.time() < deadline and not listener.of_type("speak_done", "t2"):
                time.sleep(0.05)
            code = run.close()
            assert code == 0, f"shim exit code {code}; stderr={run.tail()}"
            assert not run.bad_lines, f"shim stdout contains non-JSON lines: {run.bad_lines}"

            # ---- stdout relay fidelity vs the direct run
            # The shim must not add, remove or rewrite a single frame: identical field names,
            # identical event order, identical stable values.  Volatile measurements
            # (modelLoadMs/genMs/audioSec, ...) legitimately differ between two live runs.
            direct = self.direct
            assert ready == self._normalized_ready(direct["ready"], ready), "ready frame changed by the shim"
            STABLE_FIELDS = {
                "speak_start": ("segments", "sentences", "units", "engine", "streaming"),
                "segment_start": ("index", "requestedEmotion", "usedEmotion", "fallback", "text", "sentences"),
                "sentence_end": ("index", "sentenceIndex", "usedEmotion", "language", "text", "chars", "sentences", "merged", "maxLen"),
                "segment_end": ("index", "requestedEmotion", "usedEmotion", "fallback", "sentences"),
            }
            for name in ("speak_start", "segment_start", "sentence_end", "segment_end"):
                relayed = next((f for f in run.frames if f.get("event") == name), None)
                baseline = next((f for f in direct["frames_raw"] if f.get("event") == name), None)
                assert relayed is not None, f"shim stdout missing {name}"
                assert baseline is not None, f"direct stdout missing {name}"
                assert set(relayed) == set(baseline), (
                    f"{name} field set changed by the shim: extra={set(relayed) - set(baseline)} "
                    f"missing={set(baseline) - set(relayed)}"
                )
                for field in STABLE_FIELDS[name]:
                    assert relayed.get(field) == baseline.get(field), f"{name}.{field} changed by the shim: {relayed.get(field)!r} != {baseline.get(field)!r}"
            assert [f.get("event") for f in run.frames if f.get("id") == "t1"] == [
                f.get("event") for f in direct["frames_raw"] if f.get("id") == "d1"
            ], "shim stdout event sequence changed"
            direct_done = direct["done"]
            assert set(done1.keys()) == set(direct_done.keys()), (
                f"speak_done field set changed by the shim: "
                f"extra={set(done1) - set(direct_done)} missing={set(direct_done) - set(done1)}"
            )
            assert done1["ok"] is True and done2["ok"] is True
            assert done1["engine"] == direct_done["engine"]
            assert done1["sampleRate"] == direct_done["sampleRate"] == 44100
            assert len(done1["segments"]) == len(direct_done["segments"]) == 1
            assert done1["segments"][0]["usedEmotion"] == direct_done["segments"][0]["usedEmotion"] == "默认"
            total1 = float(done1["totalSeconds"])
            total_direct = float(direct_done["totalSeconds"])
            assert total1 > 0.3 and total_direct > 0.3
            assert abs(total1 - total_direct) <= max(0.6, 0.6 * total_direct), (
                f"totalSeconds differs too much: shim={total1} direct={total_direct}"
            )

            # ---- ingest protocol
            assert listener.requests, "no ingest requests arrived"
            assert set(listener.tokens) == {TOKEN}, f"token header mismatch: {set(listener.tokens)}"
            assert all(isinstance(json.loads(body), list) for body in listener.bodies), "ingest body is not a JSON array"
            speak_request_event = listener.of_type("speak_request", "t1")
            assert speak_request_event, "missing speak_request event"
            assert speak_request_event[0]["segments"] == [{"emotion": "默认", "content": SENTENCE}]
            assert speak_request_event[0]["play"] is True
            assert listener.of_type("speak_start", "t1"), "missing speak_start event"
            assert len(listener.of_type("segment_start", "t1")) == 1
            assert listener.of_type("segment_start", "t1")[0]["usedEmotion"] == "默认"
            assert len(listener.of_type("sentence_end", "t1")) == 1
            assert len(listener.of_type("segment_end", "t1")) == 1

            batches = listener.of_type("envelope", "t1")
            assert batches, "no envelope events"
            frames = [value for batch in batches for value in batch["frames"]]
            assert len(frames) > 10, f"too few envelope frames: {len(frames)}"
            assert all(isinstance(value, (int, float)) and 0.0 <= value <= 1.0 for value in frames), "envelope frame out of 0..1"
            assert [batch["seq"] for batch in batches] == list(range(len(batches))), "envelope seq is not 0..n"
            assert all(batch["frameMs"] == HOP_MS for batch in batches), "envelope frameMs mismatch"
            assert all(batch["sampleRate"] == 44100 for batch in batches), "envelope sampleRate mismatch"
            # T8: the real sounddevice stream reports its output latency on every batch.
            latencies = sorted({int(batch["latencyMs"]) for batch in batches if batch.get("latencyMs") is not None})
            assert len(latencies) == 1, f"envelope latencyMs is not constant: {latencies}"
            assert latencies[0] > 0, f"envelope latencyMs must be a positive int, got {latencies[0]}"
            latency_ms = latencies[0]
            # The stream stays open between calls, so the second speak_start (t2) must
            # already carry the measured latency; the first one (t1) cannot know it yet.
            t2_start = listener.of_type("speak_start", "t2")[0]
            assert isinstance(t2_start.get("latencyMs"), int) and t2_start["latencyMs"] > 0, (
                f"speak_start must carry latencyMs once the stream is open: {t2_start.get('latencyMs')!r}"
            )
            log(f"  ingest latency: envelope latencyMs={latency_ms}, speak_start t2 latencyMs={t2_start['latencyMs']}")
            duration_ms = len(frames) * HOP_MS
            reported_ms = total1 * 1000
            assert duration_ms >= reported_ms * 0.85, f"envelope too short: {duration_ms}ms vs audio {reported_ms}ms"
            assert duration_ms <= reported_ms + 900, f"envelope too long: {duration_ms}ms vs audio {reported_ms}ms"
            assert frames[0] < 0.05, f"first envelope frame is not silence: {frames[0]}"
            assert min(frames) < 0.01, f"envelope never reaches silence: min={min(frames)}"
            assert max(frames) > 0.2, f"envelope never reaches speech level: max={max(frames)}"
            done_index = next(
                index for index, event in enumerate(listener.events)
                if event.get("type") == "speak_done" and event.get("id") == "t1"
            )
            last_envelope_index = max(
                index for index, event in enumerate(listener.events)
                if event.get("type") == "envelope" and event.get("id") == "t1"
            )
            assert done_index > last_envelope_index, "speak_done arrived before the last envelope"
            # play:false: no envelope, but a normal protocol stream
            assert listener.of_type("envelope", "t2") == [], "play:false produced an envelope"
            assert listener.of_type("speak_request", "t2")[0]["play"] is False
            assert listener.of_type("speak_done", "t2"), "missing play:false speak_done"
            t1_done_index = next(
                index for index, event in enumerate(listener.events)
                if event.get("type") == "speak_done" and event.get("id") == "t1"
            )
            t2_start_index = next(
                index for index, event in enumerate(listener.events)
                if event.get("type") == "speak_start" and event.get("id") == "t2"
            )
            assert t2_start_index > t1_done_index, "previous speak_done must precede the next speak_start"

            log(
                f"  ingest: requests={len(listener.requests)} events={len(listener.events)} "
                f"envelope_batches={len(batches)} frames={len(frames)} duration={duration_ms}ms "
                f"(audio {reported_ms:.0f}ms) max={max(frames):.3f} min={min(frames):.4f} "
                f"near_zero={sum(1 for v in frames if v < 0.01)}"
            )
            log(f"  ingest event order: {[event.get('type') for event in listener.events]}")
            result = {
                "frames": frames,
                "duration_ms": duration_ms,
                "total_seconds": total1,
                "batches": len(batches),
                "events": listener.events,
                "done": done1,
                "play_false_done": done2,
                "latency_ms": latency_ms,
            }
        finally:
            listener.close()
        return result

    def _normalized_ready(self, direct: Dict[str, Any], shim: Dict[str, Any]) -> Dict[str, Any]:
        normalized = dict(direct)
        normalized["pid"] = shim.get("pid")  # pids necessarily differ
        return normalized

    def run_bare(self) -> Dict[str, Any]:
        log("scenario bare: shim without side-channel config (bridge disabled, auto-detected daemon)")
        env = base_env(self.python)
        missing = self.work / "no-such-config.json"
        env["LIVE2D_TTS_SHIM_CONFIG"] = str(missing)
        run = DaemonRun("bare", SHIM, daemon_args(self.voices, str(self.cache)), env, self.work)
        self.runs.append(run)
        started = time.time()
        run.wait_frame(lambda f: f.get("event") == "ready", 60, "ready")
        log(f"  ready in {time.time() - started:.1f}s")
        assert any("not found; live2d bridge disabled" in line for line in run.stderr), (
            f"expected the disabled-bridge diagnostic; stderr={run.tail()}"
        )
        run.send(speak_request("b1", SENTENCE, True))
        done = run.wait_frame(lambda f: f.get("event") == "speak_done" and f.get("id") == "b1", 180, "speak_done b1")
        code = run.close()
        assert code == 0, f"bare shim exit code {code}; stderr={run.tail()}"
        assert not run.bad_lines, f"bare stdout contains non-JSON lines: {run.bad_lines}"
        assert done.get("ok") is True and float(done.get("totalSeconds") or 0) > 0.3
        assert not any("ingest connected" in line for line in run.stderr), "bridge should be disabled"
        log(f"  bare speak_done ok, totalSeconds={done.get('totalSeconds')}, exit=0, bridge off")
        return {"done": done}

    # ------------------------------------------------------------------- main
    def execute(self) -> None:
        self.direct: Dict[str, Any] = {}
        if self.args.scenario in ("all", "direct", "shim"):
            self.direct = self.run_direct()
            self.direct["frames_raw"] = self.runs[0].frames
        if self.args.scenario == "direct":
            log(f"PASS (scenario=direct) in {time.time() - STARTED:.1f}s")
            return
        if self.args.scenario in ("all", "shim"):
            result = self.run_shim()
            self.print_summary(result)
        if self.args.scenario in ("all", "bare"):
            self.run_bare()
        log(f"PASS (scenario={self.args.scenario}) in {time.time() - STARTED:.1f}s")

    def print_summary(self, result: Dict[str, Any]) -> None:
        done = result["done"]
        summary = {
            "sentence": SENTENCE,
            "speak_done": {
                key: done.get(key)
                for key in ("ok", "engine", "sampleRate", "totalSeconds", "playedMs", "genMs", "modelLoadMs", "firstAudioMs", "remainingMs", "early")
            },
            "envelope": {
                "batches": result["batches"],
                "frames": len(result["frames"]),
                "frameMs": HOP_MS,
                "durationMs": result["duration_ms"],
                "audioMs": round(float(done.get("totalSeconds") or 0) * 1000),
                "latencyMs": result.get("latency_ms"),
                "first5": result["frames"][:5],
                "last5": result["frames"][-5:],
                "min": min(result["frames"]),
                "max": max(result["frames"]),
            },
        }
        log("SUMMARY " + json.dumps(summary, ensure_ascii=False))

    def cleanup(self) -> None:
        for run in self.runs:
            if run.proc.poll() is None:
                run.proc.kill()
        if not self.args.keep:
            shutil.rmtree(self.work, ignore_errors=True)
        else:
            log(f"kept work dir: {self.work}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Real e2e test for live2d_tts_shim.py")
    parser.add_argument("--scenario", choices=["all", "direct", "shim", "bare"], default="all")
    parser.add_argument("--python", default=os.environ.get("DSH_TTS_PYTHON", DEFAULT_PYTHON))
    parser.add_argument("--real-daemon", default=os.environ.get("LIVE2D_TTS_REAL_DAEMON", DEFAULT_DAEMON))
    parser.add_argument("--voices-dir", default=os.environ.get("LIVE2D_TTS_VOICES_DIR", DEFAULT_VOICES))
    parser.add_argument("--keep", action="store_true")
    ns = parser.parse_args()
    if not Path(ns.python).is_file():
        print(f"python not found: {ns.python!r} (pass --python or set DSH_TTS_PYTHON)", file=sys.stderr)
        return 2
    if not Path(ns.real_daemon).is_file():
        print(
            f"real daemon not found: {ns.real_daemon!r} (pass --real-daemon or set LIVE2D_TTS_REAL_DAEMON)",
            file=sys.stderr,
        )
        return 2
    harness = Harness(ns)
    try:
        harness.execute()
        return 0
    except Exception:  # noqa: BLE001 - print the assertion and any daemon stderr
        traceback.print_exc()
        for run in harness.runs:
            if run.stderr:
                log(f"--- stderr of {run.label} (last 10) ---")
                for line in run.tail(10):
                    print(f"  {line}", flush=True)
        return 1
    finally:
        harness.cleanup()


if __name__ == "__main__":
    sys.exit(main())




