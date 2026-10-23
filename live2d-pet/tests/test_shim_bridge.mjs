#!/usr/bin/env node
/**
 * Host-style integration test for `python/live2d_tts_shim.py`.
 *
 * It starts a local ingest listener (the same endpoint the Live2D plugin host exposes),
 * spawns the shim exactly like `@deepseek-ai/dsh-tool-tts` does
 * (`pythonPath [shim, ...daemonArgs]`, stdin/stdout pipes, PYTHONIOENCODING/PYTHONUNBUFFERED),
 * drives a speak request, and asserts:
 *
 *  - stdout is untouched JSONL (ready/speak_start/segment_start/sentence_end/segment_end/
 *    speak_done), byte-identical in values to a direct spawn of the same daemon;
 *  - the ingest stream carries speak_request / speak_start / segment_start / sentence_end /
 *    segment_end / envelope batches / speak_done, in that order, with the token header;
 *  - the envelope frame count matches the reported audio duration and carries real levels
 *    (leading silence ~0, speech > 0), all frames in 0..1;
 *  - `play:false` produces no envelope, and an absent enabledFile / dead ingest endpoint
 *    leave TTS completely functional.
 *
 * Default mode uses a tiny in-process fake TTS daemon (stdlib + numpy only, no GPU, ~3 s).
 * `--real` runs the same assertions against the installed real VoxCPM 1.5 daemon (GPU,
 * ~10-20 s, audible): `node tests/test_shim_bridge.mjs --real`.
 *
 * Run:  node tests/test_shim_bridge.mjs [--real] [--python <path>] [--keep] [--verbose]
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const SHIM = path.join(PLUGIN_DIR, "packages", "plugin", "python", "live2d_tts_shim.py");
const DEFAULT_PYTHON = process.env.DSH_TTS_PYTHON || "python";
const DEFAULT_REAL_DAEMON = process.env.LIVE2D_TTS_REAL_DAEMON || "";
const VOICES_DIR = process.env.LIVE2D_TTS_VOICES_DIR || "";
const CACHE_DIR = path.join(PLUGIN_DIR, ".test-cache");
const HOP_MS = 20;

const argv = process.argv.slice(2);
const REAL = argv.includes("--real");
const VERBOSE = argv.includes("--verbose");
const KEEP = argv.includes("--keep");
const pythonArg = argv.indexOf("--python");
const PYTHON = pythonArg >= 0 && argv[pythonArg + 1] ? argv[pythonArg + 1] : DEFAULT_PYTHON;
const REAL_DAEMON = process.env.LIVE2D_TTS_REAL_DAEMON || DEFAULT_REAL_DAEMON;
const TOKEN = "test-token-live2d-42";
if (REAL && (!REAL_DAEMON || !VOICES_DIR)) {
  console.error(
    "[test-shim-bridge] --real needs the real daemon and voices dir; set\n" +
      "  LIVE2D_TTS_REAL_DAEMON=<dsh profile>/node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py\n" +
      "  LIVE2D_TTS_VOICES_DIR=<voices dir>"
  );
  process.exit(2);
}
/** Every spawned daemon; killed on failure so a temp dir can be removed. */
const LIVE_PROCS = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanupProcs() {
	for (const proc of LIVE_PROCS.splice(0)) {
		if (proc.exitCode === undefined && proc.child?.exitCode === null) {
			try {
				proc.child.kill();
			} catch {
				/* already gone */
			}
		}
	}
}

async function removeDir(root) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			await rm(root, { recursive: true, force: true });
			return;
		} catch {
			await sleep(150);
		}
	}
	log(`warning: could not remove temp dir ${root}`);
}

function log(message) {
	process.stdout.write(`[test-shim-bridge] ${message}\n`);
}

async function waitUntil(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(15);
	}
	throw new Error(`timeout waiting for ${label}`);
}

function daemonArgs() {
	const modelDir = process.env.LIVE2D_TEST_MODEL_DIR || "<MODELS_DIR>";
	if (REAL) {
		return [
			"--voices-dir", VOICES_DIR,
			"--default-emotion", "默认",
			"--model-dir", modelDir,
			"--device", "cuda:0",
			"--cfg-value", "2.7",
			"--timesteps", "10",
			"--cache-dir", CACHE_DIR,
			"--preload", "false",
		];
	}
	return [
		"--voices-dir", path.join(tmpdir(), "live2d-test-voices"),
		"--default-emotion", "默认",
		"--model-dir", modelDir,
		"--device", "cuda:0",
		"--cfg-value", "2.7",
		"--timesteps", "10",
		"--cache-dir", path.join(tmpdir(), "live2d-test-cache"),
		"--preload", "false",
	];
}

// --------------------------------------------------------------- ingest listener

async function startIngest() {
	const state = { requests: [], events: [], tokens: new Set(), bodies: [] };
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			if (request.method !== "POST" || request.url !== "/ingest") {
				response.writeHead(404).end("not found");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = null;
			}
			const events = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
			state.requests.push({ token: request.headers["x-live2d-token"], bytes: body.length });
			state.tokens.add(request.headers["x-live2d-token"]);
			state.bodies.push(body);
			state.events.push(...events);
			response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
			response.end('{"ok":true}');
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return { state, port, url: `http://127.0.0.1:${port}/ingest`, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------- daemon process

class DaemonProc {
	constructor({ label, script, configPath, cwd }) {
		this.label = label;
		LIVE_PROCS.push(this);
		this.frames = [];
		this.stderr = [];
		this.stdoutRaw = "";
		this.exitCode = undefined;
		this._waiters = [];
		const env = {
			...process.env,
			PYTHONIOENCODING: "utf-8",
			PYTHONUNBUFFERED: "1",
		};
		if (configPath) env.LIVE2D_TTS_SHIM_CONFIG = configPath;
		this.child = spawn(PYTHON, [script, ...daemonArgs()], {
			env,
			cwd: cwd ?? PLUGIN_DIR,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this._stdoutBuffer = "";
		this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
		this.child.stderr.on("data", (chunk) => {
			for (const line of chunk.split(/\r?\n/)) if (line) this.stderr.push(line);
			if (VERBOSE) for (const line of chunk.split(/\r?\n/)) if (line) log(`  stderr| ${line}`);
		});
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code, signal) => {
				this.exitCode = code;
				this.signal = signal;
				for (const waiter of this._waiters.splice(0)) waiter();
				resolve({ code, signal });
			});
			this.child.on("error", (error) => {
				this.exitCode = -1;
				this.spawnError = error;
				resolve({ code: -1, signal: null });
			});
		});
	}

	_onStdout(chunk) {
		this.stdoutRaw += chunk;
		this._stdoutBuffer += chunk;
		while (this._stdoutBuffer.includes("\n")) {
			const index = this._stdoutBuffer.indexOf("\n");
			const line = this._stdoutBuffer.slice(0, index);
			this._stdoutBuffer = this._stdoutBuffer.slice(index + 1);
			if (!line.trim()) continue;
			let parsed;
			let error = null;
			try {
				parsed = JSON.parse(line);
			} catch (exc) {
				error = exc;
			}
			this.frames.push({ line, frame: parsed, error });
			for (const waiter of this._waiters.splice(0)) waiter();
		}
	}

	send(value) {
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	async waitFrame(predicate, timeoutMs = 120_000) {
		await waitUntil(() => this.frames.some((entry) => predicate(entry.frame)), timeoutMs, `${this.label} frame`);
		return this.frames.find((entry) => predicate(entry.frame)).frame;
	}

	async waitExit(timeoutMs = 20_000) {
		const timeout = sleep(timeoutMs).then(() => ({ timeout: true }));
		const outcome = await Promise.race([this.exited, timeout]);
		if (outcome.timeout) throw new Error(`${this.label} did not exit within ${timeoutMs}ms`);
		return outcome;
	}

	async stop() {
		try {
			this.child.stdin.end();
		} catch {
			/* already closed */
		}
		return this.waitExit();
	}
}

// ----------------------------------------------------------- fake daemon fixture

const FAKE_EVENTS = String.raw`
import json, sys, threading, time


class EventWriter:
    def __init__(self, stdout=None, stderr=None):
        self._out = stdout if stdout is not None else sys.stdout.buffer
        self._err = stderr if stderr is not None else sys.stderr
        self._lock = threading.Lock()
        self._log_lock = threading.Lock()

    def emit(self, payload):
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        data = (line + "\n").encode("utf-8")
        with self._lock:
            try:
                self._out.write(data)
                self._out.flush()
            except Exception as exc:
                self.log("event write failed: %r" % (exc,))
        return payload

    def event(self, name, request_id=None, **fields):
        payload = {"id": request_id, "event": name}
        payload.update(fields)
        return self.emit(payload)

    def error(self, request_id, code, message, detail=""):
        return self.event("error", request_id, ok=False, code=code, message=message, detail=detail)

    def log(self, message):
        with self._log_lock:
            try:
                self._err.write("[fake %s] %s\n" % (time.strftime("%H:%M:%S"), message))
                self._err.flush()
            except Exception:
                pass
`;

const FAKE_RUNTIME = String.raw`
class SoundDevicePlayer:
    persistent = True

    def __init__(self, device=None, log=None, in_device_sec_ms=-1):
        self._device = device
        self._rate = 0
        self._audio = []

    @property
    def rate(self):
        return int(self._rate)

    def open(self, sample_rate):
        self._rate = int(sample_rate)

    def write(self, audio, sample_rate):
        import numpy as np
        self._audio.append(np.asarray(audio, dtype=np.float32).reshape(-1).copy())

    def write_silence(self, seconds):
        import numpy as np
        if seconds and seconds > 0:
            self._audio.append(np.zeros(max(1, int(round(seconds * self.rate))), dtype=np.float32))

    def _callback(self, outdata, frames, _time_info, _status):
        need = int(frames)
        pos = 0
        while need > 0 and self._audio:
            chunk = self._audio[0]
            take = min(need, int(chunk.size))
            outdata[pos:pos + take, 0] = chunk[:take]
            pos += take
            need -= take
            if take >= int(chunk.size):
                self._audio.pop(0)
            else:
                self._audio[0] = chunk[take:]
        if need > 0:
            outdata[pos:, 0] = 0.0

    def close(self):
        self._audio.clear()
`;

const FAKE_DAEMON = String.raw`
import argparse, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ttslib import runtime
from ttslib.events import EventWriter

RATE = 44100
LEAD_SILENCE_SEC = 0.2
TONE_SEC = 1.0


def build_parser():
    parser = argparse.ArgumentParser(prog="tts_daemon.py")
    parser.add_argument("--voices-dir", default="")
    parser.add_argument("--default-emotion", default="默认")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--device", default="")
    parser.add_argument("--cfg-value", type=float, default=2.7)
    parser.add_argument("--timesteps", type=int, default=10)
    parser.add_argument("--cache-dir", default="")
    parser.add_argument("--preload", default="false")
    parser.add_argument("--output-device", default="")
    return parser


def main():
    args = build_parser().parse_args()
    writer = EventWriter(stdout=getattr(sys.stdout, "buffer", None))
    sys.stdout = sys.stderr
    writer.log("fake daemon starting")
    writer.event(
        "ready", None, ok=True, pid=os.getpid(), voicesDir=args.voices_dir,
        defaultEmotion=args.default_emotion, emotions=[{"name": "默认"}],
        emotionNames=["默认"], device=args.device, modelLoaded=False, sampleRate=RATE,
        modelDir=args.model_dir, engine="voxcpm",
        preloadError="", version="fake-1.0", streaming=False,
    )
    player = runtime.SoundDevicePlayer(args.output_device or None, log=writer.log)
    import numpy as np
    fd = sys.stdin.fileno()
    buffer = b""
    stopping = False
    while not stopping:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        buffer += chunk
        while b"\n" in buffer:
            raw, buffer = buffer.split(b"\n", 1)
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            request = json.loads(line)
            op = request.get("op")
            rid = request.get("id")
            if op == "shutdown":
                writer.event("shutdown", rid, ok=True, pid=os.getpid())
                stopping = True
                break
            if op != "speak":
                writer.event("pong", rid, ok=True)
                continue
            segments = request.get("segments") or []
            play = request.get("play", True)
            writer.event(
                "speak_start", rid, ok=True, segments=len(segments), sentences=1, units=1,
                modelLoadMs=0, modelWasLoaded=False, warmupMs=0, engine="voxcpm",
                streaming=False,
            )
            writer.event(
                "segment_start", rid, index=0,
                requestedEmotion=(segments[0].get("emotion") if segments else ""),
                usedEmotion="默认", fallback=False, text="你好呀", sentences=1,
            )
            silence = np.zeros(int(LEAD_SILENCE_SEC * RATE), dtype=np.float32)
            t = np.arange(int(TONE_SEC * RATE)) / float(RATE)
            tone = (0.35 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
            audio = np.concatenate([silence, tone])
            if play:
                player.open(RATE)
                player.write(audio, RATE)
                blocksize = 512
                pos = 0
                total = int(audio.size)
                while pos < total:
                    frames = min(blocksize, total - pos)
                    out = np.zeros((frames, 1), dtype=np.float32)
                    player._callback(out, frames, None, None)
                    pos += frames
                for _ in range(3):
                    out = np.zeros((blocksize, 1), dtype=np.float32)
                    player._callback(out, blocksize, None, None)
            total_sec = float(audio.size) / float(RATE)
            writer.event(
                "sentence_end", rid, index=0, sentenceIndex=0, usedEmotion="默认",
                language="Auto", text="你好呀", chars=2, genMs=5,
                audioSec=round(total_sec, 3),
            )
            writer.event(
                "segment_end", rid, index=0, requestedEmotion="默认", usedEmotion="默认",
                fallback=False, seconds=round(total_sec, 3), sentences=1,
            )
            writer.event(
                "speak_done", rid, ok=True, totalSeconds=round(total_sec, 3),
                playedMs=int(total_sec * 1000), genMs=5, units=1, rtf=0.05,
                modelLoadMs=0, modelWasLoaded=False, warmupMs=0, engine="voxcpm",
                sampleRate=RATE, streaming=False, trimmedSeconds=0.0,
                segments=[{
                    "index": 0, "requestedEmotion": "默认", "usedEmotion": "默认",
                    "fallback": False, "seconds": round(total_sec, 3),
                    "sentences": 1, "files": [],
                }],
                files=[], firstAudioMs=0, notes=[], early=True, remainingMs=100,
                queuedAudioFrames=0, cbFrames=int(audio.size), underrunFrames=0,
                underrunMs=0, clock="frames",
            )
    player.close()
    writer.log("fake daemon done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

async function createFakeDaemon(root) {
	const fake = path.join(root, "fake_tts");
	await mkdir(path.join(fake, "ttslib"), { recursive: true });
	await writeFile(path.join(fake, "ttslib", "__init__.py"), "", "utf8");
	await writeFile(path.join(fake, "ttslib", "events.py"), FAKE_EVENTS, "utf8");
	await writeFile(path.join(fake, "ttslib", "runtime.py"), FAKE_RUNTIME, "utf8");
	const daemon = path.join(fake, "tts_daemon.py");
	await writeFile(daemon, FAKE_DAEMON, "utf8");
	return daemon;
}

// -------------------------------------------------------------------- helpers

function stdoutFrames(daemon) {
	return daemon.frames.map((entry) => entry.frame);
}

function eventsOfType(state, type, id) {
	return state.events.filter((event) => event.type === type && (id === undefined || event.id === id));
}

function speakRequest(id, content, play = true) {
	return {
		id,
		op: "speak",
		segments: [{ emotion: "默认", content }],
		play,
		gapMs: 120,
	};
}

async function writeConfig(root, realDaemon, ingestUrl, extra = {}) {
	const config = {
		realDaemon,
		ingestUrl,
		token: TOKEN,
		enabledFile: "",
		hopMs: HOP_MS,
		envelopeGain: 3.0,
		batchFrames: 4,
		...extra,
	};
	const file = path.join(root, "live2d_tts_shim.json");
	await writeFile(file, JSON.stringify(config, null, 2), "utf8");
	return file;
}

function assertEnvelope(events, id, doneFrame, label, { strictLead = false } = {}) {
	const batches = eventsOfType({ events }, "envelope", id);
	assert.ok(batches.length > 0, `${label}: expected envelope batches for ${id}`);
	const frames = batches.flatMap((batch) => batch.frames);
	assert.ok(frames.length > 5, `${label}: expected a stream of envelope frames, got ${frames.length}`);
	for (const value of frames) {
		assert.equal(typeof value, "number", `${label}: envelope frame is not a number`);
		assert.ok(value >= 0 && value <= 1, `${label}: envelope frame ${value} outside 0..1`);
	}
	const seqs = batches.map((batch) => batch.seq);
	assert.deepEqual(seqs, seqs.map((_, index) => index), `${label}: envelope seq is not 0..n`);
	for (const batch of batches) {
		assert.equal(batch.frameMs, HOP_MS, `${label}: envelope frameMs`);
		assert.ok(batch.sampleRate > 0, `${label}: envelope sampleRate`);
		if (batch.latencyMs !== undefined) {
			assert.equal(typeof batch.latencyMs, "number", `${label}: latencyMs is not a number`);
			assert.ok(Number.isInteger(batch.latencyMs) && batch.latencyMs >= 0, `${label}: latencyMs ${batch.latencyMs} is not an int >= 0`);
		}
	}
	const latencies = [...new Set(batches.map((batch) => batch.latencyMs).filter((value) => value !== undefined))];
	const max = Math.max(...frames);
	const min = Math.min(...frames);
	assert.ok(max > 0.2, `${label}: envelope never reaches speech level (max ${max})`);
	assert.ok(frames[0] < 0.05, `${label}: first frame is not silence: ${frames[0]}`);
	// The real daemon trims edges (only a short pad survives), so "silence" is not
	// necessarily 4+ leading frames there; fake mode keeps a fixed 0.2 s lead-in.
	if (strictLead) {
		assert.ok(frames.slice(0, 4).every((value) => value < 0.05), `${label}: leading frames are not silence: ${frames.slice(0, 4)}`);
	}
	assert.ok(min < 0.01, `${label}: envelope never drops to silence (min ${min})`);
	const durationMs = frames.length * HOP_MS;
	const reportedMs = Number(doneFrame.totalSeconds || 0) * 1000;
	assert.ok(
		durationMs >= reportedMs * 0.85 && durationMs <= reportedMs + 500,
		`${label}: envelope duration ${durationMs}ms does not match totalSeconds ${reportedMs}ms`,
	);
	return { frames, durationMs, max, min, latencies };
}

function assertRelayedFrames(frames, label) {
	const names = frames.map((frame) => frame.event);
	for (const expected of ["speak_start", "segment_start", "sentence_end", "segment_end", "speak_done"]) {
		assert.ok(names.includes(expected), `${label}: stdout is missing ${expected}`);
	}
	for (const entry of frames) {
		assert.equal(typeof entry, "object", `${label}: stdout line is not a JSON object`);
		assert.equal(typeof entry.event, "string", `${label}: frame without event name`);
	}
	const ready = frames.find((frame) => frame.event === "ready");
	assert.ok(ready, `${label}: stdout is missing ready`);
	return ready;
}

// ------------------------------------------------------------------ scenarios

async function fakeScenario() {
	const root = await mkdtemp(path.join(tmpdir(), "live2d-shim-test-"));
	let ingest;
	let directRun;
	let shimRun;
	try {
		log("fake daemon: start direct reference run");
		const fakeDaemon = await createFakeDaemon(root);
		const direct = new DaemonProc({ label: "direct", script: fakeDaemon, configPath: null, cwd: root });
		await direct.waitFrame((frame) => frame?.event === "ready", 30_000);
		direct.send(speakRequest("d1", "你好呀"));
		await direct.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "d1", 30_000);
		const directFrames = stdoutFrames(direct);
		const directExit = await direct.stop();
		assert.equal(directExit.code, 0, "direct fake daemon exit code");
		assert.equal(direct.frames.filter((entry) => entry.error).length, 0, "direct stdout contains non-JSON lines");
		console.log("  direct frames:", directFrames.map((frame) => `${frame.event}${frame.id ? `(${frame.id})` : ""}`).join(" "));
		directRun = direct;

		log("fake daemon: ingest-enabled shim run");
		ingest = await startIngest();
		const configPath = await writeConfig(root, fakeDaemon, ingest.url);
		const shim = new DaemonProc({ label: "shim", script: SHIM, configPath, cwd: root });
		await shim.waitFrame((frame) => frame?.event === "ready", 30_000);
		shim.send(speakRequest("t1", "你好呀", true));
		const done1 = await shim.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "t1", 60_000);
		await waitUntil(() => ingest.state.events.some((event) => event.type === "speak_done" && event.id === "t1"), 15_000, "ingest speak_done t1");

		// ---- relay fidelity: same daemon, same request -> same frames (except pid)
		assert.equal(shim.frames.filter((entry) => entry.error).length, 0, "shim stdout contains non-JSON lines");
		const ready = assertRelayedFrames(stdoutFrames(shim), "shim");
		const directReady = directFrames.find((frame) => frame.event === "ready");
		assert.deepEqual({ ...ready, pid: 0 }, { ...directReady, pid: 0 }, "ready frame changed by the shim");
		const relayNames = stdoutFrames(shim).map((frame) => frame.event);
		const directNames = directFrames.map((frame) => frame.event);
		assert.deepEqual(relayNames, directNames, "stdout frame sequence changed by the shim");
		for (const name of ["speak_start", "segment_start", "sentence_end", "segment_end", "speak_done"]) {
			const relayed = stdoutFrames(shim).find((frame) => frame.event === name);
			const baseline = directFrames.find((frame) => frame.event === name);
			// Both runs used the same daemon but different request ids.
			assert.deepEqual({ ...relayed, id: "<request>" }, { ...baseline, id: "<request>" }, `${name} frame changed by the shim`);
		}

		log("  relay fidelity: OK");
		// ---- ingest protocol
		const requests = ingest.state.requests;
		assert.ok(requests.length > 0, "no ingest requests arrived");
		assert.deepEqual([...ingest.state.tokens], [TOKEN], "X-Live2D-Token header mismatch");
		for (const body of ingest.state.bodies) {
			assert.ok(Array.isArray(JSON.parse(body)), "ingest body must be a JSON array");
		}
		const speakRequestEvent = eventsOfType(ingest.state, "speak_request", "t1")[0];
		assert.ok(speakRequestEvent, "missing speak_request event");
		assert.equal(speakRequestEvent.play, true);
		assert.equal(speakRequestEvent.segments[0].emotion, "默认");
		assert.equal(speakRequestEvent.segments[0].content, "你好呀");
		assert.equal(speakRequestEvent.sampleRate, 44_100);
		const startEvent = eventsOfType(ingest.state, "speak_start", "t1")[0];
		assert.ok(startEvent, "missing speak_start event");
		assert.equal(eventsOfType(ingest.state, "segment_start", "t1").length, 1);
		assert.equal(eventsOfType(ingest.state, "segment_start", "t1")[0].usedEmotion, "默认");
		assert.equal(eventsOfType(ingest.state, "sentence_end", "t1").length, 1);
		assert.equal(eventsOfType(ingest.state, "segment_end", "t1").length, 1);
		const envelopeStats = assertEnvelope(ingest.state.events, "t1", done1, "t1", { strictLead: true });
		const lastEnvelopeIndex = ingest.state.events.findLastIndex((event) => event.type === "envelope" && event.id === "t1");
		const doneIndex = ingest.state.events.findIndex((event) => event.type === "speak_done" && event.id === "t1");
		assert.ok(doneIndex > lastEnvelopeIndex, "speak_done must arrive after the last envelope of its utterance");
		const ingestDone = eventsOfType(ingest.state, "speak_done", "t1")[0];
		assert.equal(ingestDone.ok, true);
		assert.equal(ingestDone.cancelled, false);
		console.log(
			`  t1: totalSeconds=${done1.totalSeconds} envelopeFrames=${envelopeStats.frames.length} (${envelopeStats.durationMs}ms) max=${envelopeStats.max.toFixed(3)} ` +
				`latencyMs=${envelopeStats.latencies.length ? envelopeStats.latencies.join("/") : "(none: fake player has no output stream)"}`,
		);

		log("  ingest protocol: OK");
		// ---- play:false: no envelope, still a normal utterance
		const eventsBefore = ingest.state.events.length;
		shim.send(speakRequest("t2", "安静", false));
		const done2 = await shim.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "t2", 60_000);
		await waitUntil(() => ingest.state.events.some((event) => event.type === "speak_done" && event.id === "t2"), 15_000, "ingest speak_done t2");
		assert.equal(done2.ok, true, "play:false speak_done not ok");
		assert.equal(eventsOfType(ingest.state, "envelope", "t2").length, 0, "play:false produced an envelope");
		const t2Start = ingest.state.events.findIndex((event) => event.type === "speak_start" && event.id === "t2");
		const t1Done = ingest.state.events.findIndex((event) => event.type === "speak_done" && event.id === "t1");
		assert.ok(t2Start > t1Done, "previous speak_done must be settled before the next speak_start");
		assert.ok(eventsOfType(ingest.state, "speak_start", "t2")[0].ts > 0);
		assert.ok(ingest.state.events.length > eventsBefore, "no events for the second utterance");
		console.log(`  t2 (play:false): ok=${done2.ok} envelopes=0`);

		log("  second utterance: OK");
		const shimExit = await shim.stop();
		assert.equal(shimExit.code, 0, "shim exit code");
		console.log(`  shim exit=${shimExit.code}, ingest requests=${requests.length}, events=${ingest.state.events.length}`);
		shimRun = shim;
	} finally {
		if (ingest) await ingest.close();
		await cleanupProcs();
		if (!KEEP) await removeDir(root);
	}
	return { directRun, shimRun };
}

async function realScenario() {
	const root = await mkdtemp(path.join(tmpdir(), "live2d-shim-real-"));
	let ingest;
	let shim;
	let runCwd;
	try {
		log(`real daemon run: ${REAL_DAEMON}`);
		log(`python: ${PYTHON}`);
		if (!(await import("node:fs")).existsSync(REAL_DAEMON)) {
			throw new Error(`real daemon not found: ${REAL_DAEMON}`);
		}
		ingest = await startIngest();
		const configPath = await writeConfig(root, REAL_DAEMON, ingest.url);
		runCwd = await mkdtemp(path.join(tmpdir(), "live2d-shim-cwd-"));
		shim = new DaemonProc({ label: "real-shim", script: SHIM, configPath, cwd: runCwd });
		const startedAt = Date.now();
		await shim.waitFrame((frame) => frame?.event === "ready", 60_000);
		log(`ready after ${Date.now() - startedAt}ms`);
		shim.send(speakRequest("r1", "你好呀", true));
		const done = await shim.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "r1", 180_000);
		log(
			`speak_done after ${Date.now() - startedAt}ms: totalSeconds=${done.totalSeconds} playedMs=${done.playedMs} ` +
				`genMs=${done.genMs} modelLoadMs=${done.modelLoadMs} firstAudioMs=${done.firstAudioMs} ` +
				`sampleRate=${done.sampleRate} remainingMs=${done.remainingMs} early=${done.early} ok=${done.ok}`,
		);
		await waitUntil(() => ingest.state.events.some((event) => event.type === "speak_done" && event.id === "r1"), 20_000, "ingest speak_done r1");
		assertRelayedFrames(stdoutFrames(shim), "real-shim");
		assert.equal(shim.frames.filter((entry) => entry.error).length, 0, "shim stdout contains non-JSON lines");
		assert.equal(done.ok, true, "real speak_done not ok");
		assert.ok(done.totalSeconds > 0.3, `real totalSeconds too small: ${done.totalSeconds}`);
		assert.deepEqual([...ingest.state.tokens], [TOKEN], "X-Live2D-Token header mismatch");
		assert.equal(eventsOfType(ingest.state, "segment_start", "r1").length, 1);
		assert.equal(eventsOfType(ingest.state, "sentence_end", "r1").length, 1);
		assert.equal(eventsOfType(ingest.state, "segment_end", "r1").length, 1);
		assert.equal(eventsOfType(ingest.state, "speak_request", "r1").length, 1);
		const stats = assertEnvelope(ingest.state.events, "r1", done, "r1");
		// T8: the real sounddevice stream reports its output latency; every envelope batch
		// (and, once the stream is open, speak_start) must carry it for mouth alignment.
		const batches = eventsOfType(ingest.state, "envelope", "r1");
		assert.ok(batches.length > 0, "r1: no envelope batches to inspect for latencyMs");
		const latencyValues = [...new Set(batches.map((batch) => batch.latencyMs))];
		assert.equal(latencyValues.length, 1, `r1: envelope latencyMs is not constant: ${JSON.stringify(latencyValues)}`);
		const latencyMs = latencyValues[0];
		assert.ok(Number.isInteger(latencyMs) && latencyMs > 0, `r1: envelope batches must carry a positive int latencyMs, got ${latencyMs}`);
		log(`  real: reported latencyMs=${latencyMs} (for ${batches.length} envelope batches)`);
		const lastEnvelopeIndex = ingest.state.events.findLastIndex((event) => event.type === "envelope" && event.id === "r1");
		const doneIndex = ingest.state.events.findIndex((event) => event.type === "speak_done" && event.id === "r1");
		assert.ok(doneIndex > lastEnvelopeIndex, "speak_done must arrive after the last envelope");
		const frames = stats.frames;
		const zeros = frames.filter((value) => value < 0.01).length;
		console.log(
			`  real: frames=${frames.length} duration≈${stats.durationMs}ms totalSeconds=${done.totalSeconds}s ` +
				`samples ${done.sampleRate}Hz, near-zero frames=${zeros}, max=${stats.max.toFixed(3)} min=${stats.min.toFixed(4)}, latencyMs=${latencyMs}`,
		);
		console.log(`  real: first frames=${JSON.stringify(frames.slice(0, 5))} last frames=${JSON.stringify(frames.slice(-5))}`);
		console.log(
			`  real: ingest events=${ingest.state.events.length} requests=${ingest.state.requests.length} ` +
				`segments=${JSON.stringify(done.segments)}`,
		);
		const exit = await shim.stop();
		assert.equal(exit.code, 0, "real shim exit code");
		console.log(`  real shim exit=${exit.code}`);
	} finally {
		if (ingest) await ingest.close();
		await cleanupProcs();
		if (!KEEP) {
			await removeDir(root);
			if (runCwd) await removeDir(runCwd);
		}
	}
}

async function robustnessScenario() {
	const root = await mkdtemp(path.join(tmpdir(), "live2d-shim-robust-"));
	const ingest = await startIngest();
	try {
		const fakeDaemon = await createFakeDaemon(root);

		log("robustness: enabledFile missing -> bridge off");
		const disabledFlag = path.join(root, "tts-bridge.enabled");
		const offConfig = await writeConfig(root, fakeDaemon, ingest.url, { enabledFile: disabledFlag });
		const offRun = new DaemonProc({ label: "off", script: SHIM, configPath: offConfig, cwd: root });
		await offRun.waitFrame((frame) => frame?.event === "ready", 30_000);
		offRun.send(speakRequest("o1", "你好呀", true));
		const offDone = await offRun.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "o1", 60_000);
		await sleep(500);
		assert.equal(offDone.ok, true);
		assert.equal(ingest.state.requests.length, 0, "enabledFile missing must produce no ingest traffic");
		assert.equal((await offRun.stop()).code, 0, "enabledFile-off exit code");
		console.log("  enabledFile missing: TTS ok, 0 requests");

		log("robustness: enabledFile appears mid-flight -> bridge on");
		await mkdir(path.dirname(disabledFlag), { recursive: true });
		await writeFile(disabledFlag, "1", "utf8");
		const onRun = new DaemonProc({ label: "on", script: SHIM, configPath: offConfig, cwd: root });
		await onRun.waitFrame((frame) => frame?.event === "ready", 30_000);
		onRun.send(speakRequest("o2", "你好呀", true));
		const onDone = await onRun.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "o2", 60_000);
		await waitUntil(() => eventsOfType(ingest.state, "speak_done", "o2").length > 0, 15_000, "ingest speak_done o2");
		assert.equal(onDone.ok, true);
		assert.ok(eventsOfType(ingest.state, "envelope", "o2").length > 0, "enabledFile present must forward");
		assert.equal((await onRun.stop()).code, 0, "enabledFile-on exit code");
		console.log("  enabledFile present: envelope forwarded");

		log("robustness: dead ingest endpoint -> TTS unaffected");
		const deadConfig = await writeConfig(root, fakeDaemon, "http://127.0.0.1:1/ingest", { enabledFile: "" });
		const deadRun = new DaemonProc({ label: "dead", script: SHIM, configPath: deadConfig, cwd: root });
		await deadRun.waitFrame((frame) => frame?.event === "ready", 30_000);
		const startedAt = Date.now();
		deadRun.send(speakRequest("d2", "你好呀", true));
		const deadDone = await deadRun.waitFrame((frame) => frame?.event === "speak_done" && frame.id === "d2", 60_000);
		const elapsed = Date.now() - startedAt;
		assert.equal(deadDone.ok, true, "dead ingest must not fail the speak");
		assert.equal((await deadRun.stop()).code, 0, "dead ingest exit code");
		console.log(`  dead ingest: speak_done ok in ${elapsed}ms, exit 0`);
	} finally {
		await ingest.close();
		await cleanupProcs();
		if (!KEEP) await removeDir(root);
	}
}

async function main() {
	if (!(await import("node:fs")).existsSync(SHIM)) throw new Error(`shim not found: ${SHIM}`);
	log(REAL ? "mode: REAL daemon" : "mode: fake daemon");
	if (REAL) {
		await realScenario();
	} else {
		await fakeScenario();
		await robustnessScenario();
	}
	log("PASS");
}

main().catch((error) => {
	process.stderr.write(`[test-shim-bridge] FAIL: ${error?.stack ?? error}\n`);
	process.exitCode = 1;
});




