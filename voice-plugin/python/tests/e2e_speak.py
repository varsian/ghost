"""GPU end-to-end acceptance driver for the tts daemon.

Loads the real VoxCPM 1.5 model through the daemon, speaks two segments with
emotion labels (which are echoed on the protocol events and never select another
reference), proves the model was not reloaded on the second call, and prints every
protocol event with timings.

    <venv python> tests\\e2e_speak.py [--no-play] [--save] [--idle-unload-sec N]

Real-time factor is reported, not asserted: at the shipped default (cfg 2.7, 10
timesteps) VoxCPM 1.5 measures ~0.79-0.80 while streaming on this box, and an
earlier probe with more timesteps measured 1.07-1.54. Either way the streaming
path is what keeps first audio early. Exit code 0 = every correctness check passed.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
DAEMON = os.path.join(PYTHON_DIR, "tts_daemon.py")

_HOME = os.path.expanduser("~")
RUNTIME = os.environ.get("DSH_TTS_RUNTIME") or os.path.join(_HOME, "dsh-tts-runtime")
VENV_PYTHON = os.path.join(RUNTIME, ".venv-vox", "Scripts", "python.exe")
VOICES_DIR = os.environ.get("LIVE2D_TTS_VOICES_DIR") or os.path.join(_HOME, "sound")
MODEL_DIR = os.path.join(RUNTIME, "models", "VoxCPM1.5")
CACHE_DIR = os.path.join(RUNTIME, "cache")

SEGMENT_ONE = "你好，这是本地 VoxCPM 1.5 的第一段测试。今天天气不错！"
SEGMENT_TWO = "第二段携带一个表情标签，只影响协议事件里的标签，不改变参考音色。"


class Daemon:
    """Minimal JSONL client for the daemon subprocess."""

    def __init__(self, python: str, extra_args) -> None:
        self.events: list[dict] = []
        self.raw_lines: list[str] = []
        self.queue: "queue.Queue[dict]" = queue.Queue()
        self.stderr: list[str] = []
        command = [
            python,
            DAEMON,
            "--voices-dir",
            VOICES_DIR,
            "--default-emotion",
            "默认",
            "--model-dir",
            MODEL_DIR,
            "--cache-dir",
            CACHE_DIR,
            "--device",
            "cuda:0",
            "--cfg-value",
            "2.7",
            "--timesteps",
            "10",
            "--optimize",
            "false",
            "--normalize",
            "false",
            "--max-sentence-chars",
            "60",
        ] + list(extra_args)
        print("spawn:", " ".join(command), flush=True)
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            command,
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
            self.raw_lines.append(line)
            try:
                event = json.loads(line)
            except Exception:
                event = {"__unparsable__": line}
            self.events.append(event)
            self.queue.put(event)
            stamp = time.strftime("%H:%M:%S")
            print(f"[{stamp}] {json.dumps(event, ensure_ascii=False)}", flush=True)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            text = raw.decode("utf-8", "replace").rstrip()
            self.stderr.append(text)
            print(f"    stderr | {text}", flush=True)

    def send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        print(f"  -> {json.dumps(payload, ensure_ascii=False)}", flush=True)
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def expect(self, name: str, timeout: float = 600.0, **fields) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"timeout waiting for {name!r} ({fields})")
            try:
                event = self.queue.get(timeout=remaining)
            except queue.Empty:
                raise AssertionError(f"timeout waiting for {name!r} ({fields})") from None
            if event.get("event") != name:
                continue
            if all(event.get(key) == value for key, value in fields.items()):
                return event

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=20)


def check(label: str, condition: bool, detail: str = "") -> None:
    print(f"{'PASS' if condition else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}", flush=True)
    if not condition:
        raise AssertionError(label)


def main() -> int:
    parser = argparse.ArgumentParser(description="Real VoxCPM 1.5 end-to-end speak check")
    parser.add_argument("--no-play", action="store_true", help="do not touch the speakers")
    parser.add_argument("--save", action="store_true", help="write WAVs to the cache dir")
    parser.add_argument("--json", action="store_true", help="print the raw request JSON only")
    parser.add_argument("--idle-unload-sec", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=600.0)
    parser.add_argument("--python", default="", help="interpreter that runs the daemon (default: .venv-vox)")
    parser.add_argument("--no-warmup", action="store_true", help="accepted for compatibility; VoxCPM warms up in its constructor")
    parser.add_argument("--no-stream", action="store_true", help="disable chunk streaming")
    parser.add_argument("--gate-db", type=float, default=None, help="override --silence-gate-db in the daemon")
    parser.add_argument("--max-trailing-ms", type=float, default=None, help="override --max-trailing-silence-ms")
    args = parser.parse_args()

    python = args.python or (VENV_PYTHON if os.path.exists(VENV_PYTHON) else sys.executable)
    print(f"interpreter: {python}", flush=True)
    daemon = Daemon(
        python,
        [
            "--idle-unload-sec",
            str(args.idle_unload_sec),
            "--output-device",
            "",
            "--preload",
            "false",
            "--stream",
            "false" if args.no_stream else "true",
        ]
        + (["--silence-gate-db", str(args.gate_db)] if args.gate_db is not None else [])
        + (["--max-trailing-silence-ms", str(args.max_trailing_ms)] if args.max_trailing_ms is not None else []),
    )
    try:
        ready = daemon.expect("ready", timeout=60)
        check("ready: first stdout line is JSON with event=ready", bool(daemon.raw_lines) and json.loads(daemon.raw_lines[0]).get("event") == "ready", daemon.raw_lines[0][:120] if daemon.raw_lines else "<no output>")
        check("ready: default emotion", ready["defaultEmotion"] == "默认", str(ready["defaultEmotion"]))
        check("ready: model not preloaded", ready["modelLoaded"] is False)
        check("ready: engine is voxcpm", ready["engine"] == "voxcpm", str(ready["engine"]))
        print(
            f"  [ready] engine={ready['engine']} sampleRate={ready.get('sampleRate')} "
            f"optimize={ready.get('optimize')} cfgValue={ready.get('cfgValue')} timesteps={ready.get('timesteps')}",
            flush=True,
        )
        emotions = [item["name"] for item in ready["emotions"]]
        check("ready: one reference voice", len(emotions) == 1 and emotions == ["默认"], ",".join(emotions))
        check("ready: reference text present", ready["emotions"][0]["refText"] is True, str(ready["emotions"][0]))

        daemon.send({"id": "1", "op": "ping"})
        pong = daemon.expect("pong", id="1", timeout=30)
        check("ping -> pong", pong["ok"] and pong["pid"] == ready["pid"])

        # --- first speak: emotion labels pass through unchanged -----------------
        t0 = time.monotonic()
        daemon.send(
            {
                "id": "2",
                "op": "speak",
                "segments": [
                    {"emotion": "开心", "content": SEGMENT_ONE},
                    {"emotion": "默认", "content": SEGMENT_TWO},
                ],
                "play": not args.no_play,
                "save": args.save,
                "gapMs": 120,
            }
        )
        start = daemon.expect("speak_start", id="2", timeout=args.timeout)
        print(f"  [speak_start after {time.monotonic() - t0:.1f}s wall]")
        check("speak 1: sentences split", start["sentences"] >= 3, f"sentences={start['sentences']}")
        check("speak 1: cold load reported", start["modelLoadMs"] > 0, f"modelLoadMs={start['modelLoadMs']}")
        check("speak 1: model was not resident", start["modelWasLoaded"] is False)
        done1 = daemon.expect("speak_done", id="2", timeout=args.timeout)
        check("speak 1: ok", done1["ok"] is True)
        check("speak 1: audio produced", done1["totalSeconds"] > 0, f"totalSeconds={done1['totalSeconds']}")
        check("speak 1: real time factor reported", done1["rtf"] > 0, f"rtf={done1['rtf']}")
        if done1["rtf"] >= 1.0:
            print(
                f"INFO  speak 1 is {done1['rtf']}x real time (model property, not a protocol failure); "
                "playback still overlaps generation, see playedMs vs genMs",
                flush=True,
            )
        first_audio = done1.get("firstAudioMs")
        check("speak 1: first audio latency reported", isinstance(first_audio, int) and first_audio > 0, f"firstAudioMs={first_audio}")
        check("speak 1: two segments", len(done1["segments"]) == 2)
        labelled = done1["segments"][0]
        check(
            "speak 1: emotion label echoed",
            labelled["fallback"] is False and labelled["requestedEmotion"] == "开心" and labelled["usedEmotion"] == "开心",
            json.dumps(labelled, ensure_ascii=False),
        )
        check("speak 1: per-segment seconds", all(segment["seconds"] > 0 for segment in done1["segments"]), json.dumps([s["seconds"] for s in done1["segments"]]))
        print(
            f"  [speak 1 metrics] totalSeconds={done1['totalSeconds']} genMs={done1['genMs']} "
            f"playedMs={done1['playedMs']} rtf={done1['rtf']} firstAudioMs={done1.get('firstAudioMs')} "
            f"modelLoadMs={done1['modelLoadMs']} trimmedSeconds={done1.get('trimmedSeconds')} "
            f"engine={done1.get('engine')} notes={json.dumps(done1.get('notes', []), ensure_ascii=False)}"
        )
        check("speak 1: engine reported", done1.get("engine") == "voxcpm", str(done1.get("engine")))
        check("speak 1: trim accounting reported", isinstance(done1.get("trimmedSeconds"), (int, float)))

        sentence_events = [e for e in daemon.events if e.get("event") == "sentence_end" and e.get("id") == "2"]
        check(
            "speak 1: per-sentence timings",
            bool(sentence_events) and all(e["genMs"] >= 0 and e["audioSec"] > 0 for e in sentence_events),
            json.dumps([(e["genMs"], e["audioSec"]) for e in sentence_events]),
        )
        check(
            "speak 1: every unit reports Auto language",
            bool(sentence_events) and all(e.get("language") == "Auto" for e in sentence_events),
            json.dumps([e.get("language") for e in sentence_events], ensure_ascii=False),
        )
        check(
            "speak 1: units respect the 60-char sentence cap (rev 7)",
            all(len(e["text"]) <= 60 for e in sentence_events),
            json.dumps([len(e["text"]) for e in sentence_events]),
        )
        ttfa = min(e["firstAudioMs"] for e in sentence_events) if sentence_events else -1
        print(f"  [TTFA] best first-audio latency {ttfa} ms over {len(sentence_events)} sentence(s)", flush=True)
        if done1.get("engine") == "voxcpm" and done1.get("streaming"):
            check(
                "speak 1: streamed in multiple chunks",
                all(e.get("chunks", 0) > 1 for e in sentence_events),
                json.dumps([e.get("chunks") for e in sentence_events]),
            )
            check("speak 1: time to first audio below 1 s", ttfa < 1000, f"firstAudioMs={ttfa}")

        daemon.send({"id": "3", "op": "stats"})
        stats1 = daemon.expect("stats", id="3", timeout=30)
        check("stats: model resident", stats1["modelLoaded"] is True)
        check(
            "stats: vram reported",
            stats1["allocatedMb"] > 0,
            f"allocatedMb={stats1['allocatedMb']} reservedMb={stats1['reservedMb']} peakMb={stats1['peakMb']} freeMb={stats1['freeMb']}",
        )
        check("stats: engine is voxcpm", stats1["engine"] == "voxcpm", str(stats1["engine"]))
        check("stats: no prompt cache is claimed", "voicesCached" not in stats1 and "promptsCached" not in stats1)
        check("stats: pid stable", stats1["pid"] == ready["pid"])

        # --- second speak: must reuse the resident model -----------------------
        daemon.send(
            {
                "id": "4",
                "op": "speak",
                "segments": [{"emotion": "默认", "content": "第二次调用不应该重新加载模型。"}],
                "play": not args.no_play,
                "gapMs": 0,
            }
        )
        start2 = daemon.expect("speak_start", id="4", timeout=args.timeout)
        check("speak 2: model already resident", start2["modelWasLoaded"] is True)
        check("speak 2: no reload", start2["modelLoadMs"] == 0, f"modelLoadMs={start2['modelLoadMs']}")
        done2 = daemon.expect("speak_done", id="4", timeout=args.timeout)
        check("speak 2: ok", done2["ok"] is True and done2["totalSeconds"] > 0, f"totalSeconds={done2['totalSeconds']}")
        impure = [event for event in daemon.events if "__unparsable__" in event]
        detail = impure[0]["__unparsable__"][:160] if impure else ""
        check("stdout: JSONL clean across import + load + speaks", not impure, detail)
        print(f"  [stdout] {len(daemon.raw_lines)} JSON lines, stderr carries the library banner:", flush=True)
        for line in daemon.stderr[:6]:
            if "flash-attn" in line or "SoX" in line or "sox" in line:
                print(f"    (stderr) {line}", flush=True)

        daemon.send({"id": "5", "op": "stats"})
        stats2 = daemon.expect("stats", id="5", timeout=30)
        check("stats: same pid", stats2["pid"] == stats1["pid"], f"pid={stats2['pid']}")
        check("stats: calls counted", stats2["calls"] >= 2, f"calls={stats2['calls']}")
        check(
            "stats: vram stable",
            abs(stats2["allocatedMb"] - stats1["allocatedMb"]) < 256,
            f"{stats1['allocatedMb']} -> {stats2['allocatedMb']}",
        )

        # --- rev-3 hygiene: a short, silence-heavy utterance ------------------
        daemon.send({"id": "9", "op": "speak", "segments": [{"content": "你好呀。"}], "play": not args.no_play, "gapMs": 0})
        daemon.expect("speak_start", id="9", timeout=args.timeout)
        hygiene = daemon.expect("speak_done", id="9", timeout=args.timeout)
        check(
            "hygiene: 4-char utterance stays bounded",
            0 < hygiene["totalSeconds"] < 12,
            f"totalSeconds={hygiene['totalSeconds']}",
        )
        print(
            f"  [hygiene] totalSeconds={hygiene['totalSeconds']} trimmedSeconds={hygiene.get('trimmedSeconds')} "
            f"notes={json.dumps(hygiene.get('notes', []), ensure_ascii=False)}",
            flush=True,
        )

        daemon.send({"id": "6", "op": "unload"})
        unloaded = daemon.expect("unloaded", id="6", timeout=60)
        check("unload: vram freed", unloaded["freedMb"] > 0, f"freedMb={unloaded['freedMb']}")
        daemon.send({"id": "7", "op": "stats"})
        stats3 = daemon.expect("stats", id="7", timeout=30)
        check("stats: model released", stats3["modelLoaded"] is False)
        check("stats: vram released", stats3["allocatedMb"] < 128, f"allocatedMb={stats3['allocatedMb']}")

        daemon.send({"id": "8", "op": "shutdown"})
        daemon.expect("shutdown", id="8", timeout=30)
        check("shutdown: exit code 0", daemon.proc.wait(timeout=30) == 0)
        print("\nALL E2E CHECKS PASSED", flush=True)
        return 0
    except AssertionError as exc:
        print(f"\nE2E FAILED: {exc}", flush=True)
        return 1
    finally:
        daemon.stop()


if __name__ == "__main__":
    sys.exit(main())
