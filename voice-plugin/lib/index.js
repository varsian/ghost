import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
/** Reject one argument with the shared prefix the tool's error text uses. */
function invalid(reason) {
	throw new Error(`invalid tts arguments: ${reason}`);
}
/** Fail unless `value` is a finite number greater than zero. */
function requirePositiveNumber(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`\`${field}\` must be a positive number, got ${JSON.stringify(value)}`);
	return value;
}
/**
* Normalize one string item's trim-non-empty form.
* @param value - the raw string field.
* @param field - field name for the error message.
* @returns the trimmed value.
*/
function requireText(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) invalid(`\`${field}\` must be a non-empty string, got ${JSON.stringify(value)}`);
	return value.trim();
}
/**
* Normalize one optional string field: a blank value carries no information, so it is dropped
* exactly as if the model had omitted the field (an absent emotion must reach the daemon absent,
* not as an empty string the engine would have to interpret).
* @param value - the raw field.
* @param field - field name for the error message.
* @returns the trimmed value, or `undefined` for a blank or omitted field.
*/
function optionalText(value, field) {
	if (typeof value !== "string") invalid(`\`${field}\` must be a string, got ${JSON.stringify(value)}`);
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Validate one canonical object item and drop its empty optional fields, so the daemon receives
* only the fields the model actually set (an absent emotion means the daemon's default label,
* which must not be rewritten into a requested emotion).
* @param item - the model-supplied object item.
* @param position - the item's index in `segments`, for the error message.
* @returns the canonical segment.
*/
function parseObjectSegment(item, position) {
	const record = item;
	const segment = { content: requireText(record.content, `segments[${position}].content`) };
	if (record.emotion !== void 0) {
		const emotion = optionalText(record.emotion, `segments[${position}].emotion`);
		if (emotion !== void 0) segment.emotion = emotion;
	}
	if (record.speed !== void 0) segment.speed = requirePositiveNumber(record.speed, `segments[${position}].speed`);
	return segment;
}
/**
* Validate and default the `tts` arguments.
*
* String items use the flat alternating form: within the sequence of string items, positions
* 0, 2, 4… are emotions and 1, 3, 5… are their contents, so a trailing emotion without its content
* is rejected. Object items are canonical and may be interleaved freely.
* @param args - the registry-validated model arguments.
* @returns canonical segments plus the defaulted call-level options.
*/
function parseTtsArgs(args) {
	const raw = args.segments;
	if (!Array.isArray(raw)) invalid("`segments` must be an array");
	if (raw.length === 0) invalid("`segments` must contain at least one segment");
	const items = raw;
	const segments = [];
	let pendingEmotion;
	for (const [position, item] of items.entries()) {
		if (typeof item === "string") {
			if (pendingEmotion === void 0) pendingEmotion = requireText(item, `segments[${position}]`);
			else {
				segments.push({
					emotion: pendingEmotion,
					content: requireText(item, `segments[${position}]`)
				});
				pendingEmotion = void 0;
			}
			continue;
		}
		if (item === null || typeof item !== "object" || Array.isArray(item)) invalid(`\`segments[${position}]\` must be an object or a string, got ${JSON.stringify(item)}`);
		segments.push(parseObjectSegment(item, position));
	}
	if (pendingEmotion !== void 0) invalid(`\`segments\` ends with the emotion ${JSON.stringify(pendingEmotion)} without its content; the flat string form is emotion, content, emotion, content, …`);
	const play = args.play ?? true;
	if (typeof play !== "boolean") invalid(`\`play\` must be a boolean, got ${JSON.stringify(play)}`);
	const gapMs = args.gap_ms ?? 120;
	if (typeof gapMs !== "number" || !Number.isInteger(gapMs) || gapMs < 0) invalid(`\`gap_ms\` must be a non-negative integer, got ${JSON.stringify(gapMs)}`);
	const speed = args.speed ?? 1;
	requirePositiveNumber(speed, "speed");
	return {
		segments,
		play,
		saveDir: args.save_dir?.trim() === "" ? void 0 : args.save_dir,
		gapMs,
		speed
	};
}
//#endregion
//#region lib/types/daemon.js
/**
* Client for the Python TTS daemon (`PROTOCOL.md` §4/§6): one lazily spawned child per plugin
* lifetime, JSON Lines over stdin/stdout, exactly one outstanding `speak` (calls are serialized),
* a per-call deadline, and a single restart when a daemon exits unexpectedly.
*
* The child is a process boundary, so every frame read from it is validated here: a malformed line
* is dropped as a protocol violation, and an unusable terminal frame fails the call instead of
* producing a result nobody can trust. Transport failures (spawn, exit, deadline, abort) kill the
* daemon, because a daemon that overran its deadline may still be generating the previous utterance
* and must not be reused. An engine `error` event is not a transport failure: the daemon stays
* alive and serves the next call.
* @module @deepseek-ai/dsh-tool-tts/daemon
*/
/** Grace period between closing the daemon's stdin and forcing it down, in milliseconds. */
const KILL_GRACE_MS = 2e3;
/** Number of trailing daemon stderr lines retained for diagnostics. */
const LOG_TAIL_LINES = 20;
/**
* The daemon child's environment: the host environment plus the two settings that make its stdout a
* decodable, promptly flushed UTF-8 JSON Lines channel. Python defaults a piped stdout to the host
* locale encoding, which would mangle every non-ASCII emotion and text, and buffers it, which would
* stall the request/response framing.
* @returns the child environment.
*/
function daemonEnvironment() {
	return {
		...process.env,
		PYTHONIOENCODING: "utf-8",
		PYTHONUNBUFFERED: "1"
	};
}
/** Adapt a real child process to {@link DaemonChild}. */
const defaultSpawn = (command, args, options) => {
	const child = spawn(command, [...args], options);
	return {
		get pid() {
			return child.pid;
		},
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		kill: (signal) => child.kill(signal),
		onExit: (listener) => {
			child.on("exit", listener);
		},
		onError: (listener) => {
			child.on("error", listener);
		}
	};
};
/** Render an unknown thrown value for a model-facing message. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Read one finite number from a decoded frame, falling back to `0` for a missing or invalid field. */
function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** Read one string from a decoded frame, falling back to `''`. */
function toText(value) {
	return typeof value === "string" ? value : "";
}
/** Read a string list from a decoded frame, dropping non-string entries. */
function toTextList(value) {
	return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
/** Read the emotion names from a `ready` frame, accepting bare names or `{name}` records. */
function toEmotions(value) {
	if (!Array.isArray(value)) return [];
	const names = [];
	for (const item of value) if (typeof item === "string") names.push(item);
	else if (item !== null && typeof item === "object" && typeof item.name === "string") names.push(item.name);
	return names;
}
/** Read one segment result from a decoded `speak_done` frame. */
function toSegmentResult(value) {
	if (value === null || typeof value !== "object") return void 0;
	const segment = value;
	return {
		index: toNumber(segment.index),
		requestedEmotion: toText(segment.requestedEmotion),
		usedEmotion: toText(segment.usedEmotion),
		fallback: segment.fallback === true,
		seconds: toNumber(segment.seconds),
		sentences: toNumber(segment.sentences)
	};
}
/** Read a `speak_done` frame's payload, or `undefined` when the frame cannot describe an utterance. */
function toSpeakDone(payload) {
	const rawSegments = payload.segments;
	if (!Array.isArray(rawSegments)) return void 0;
	const segments = [];
	for (const raw of rawSegments) {
		const segment = toSegmentResult(raw);
		if (segment === void 0) return void 0;
		segments.push(segment);
	}
	return {
		totalSeconds: toNumber(payload.totalSeconds),
		playedMs: toNumber(payload.playedMs),
		genMs: toNumber(payload.genMs),
		rtf: toNumber(payload.rtf),
		firstAudioMs: toNumber(payload.firstAudioMs),
		modelLoadMs: toNumber(payload.modelLoadMs),
		modelWasLoaded: payload.modelWasLoaded === true,
		segments,
		files: toTextList(payload.files),
		notes: toTextList(payload.notes),
		engine: toText(payload.engine)
	};
}
/** Read a `ready` frame's payload, or `undefined` when it cannot describe a daemon. */
function toReady(payload) {
	if (payload.defaultEmotion === void 0 && payload.emotions === void 0) return void 0;
	return {
		pid: toNumber(payload.pid),
		voicesDir: toText(payload.voicesDir),
		defaultEmotion: toText(payload.defaultEmotion),
		emotions: toEmotions(payload.emotions),
		device: toText(payload.device),
		modelLoaded: payload.modelLoaded === true,
		engine: toText(payload.engine)
	};
}
/** Read an `error` frame's payload, or `undefined` when it cannot describe a failure. */
function toError(payload) {
	if (payload.code === void 0 && payload.message === void 0) return void 0;
	return {
		code: toText(payload.code) || "INTERNAL",
		message: toText(payload.message)
	};
}
/** Decode one JSON Lines frame, or `undefined` for a line that is not a protocol frame. */
function decodeFrame(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return void 0;
	const frame = parsed;
	if (typeof frame.event !== "string") return void 0;
	return {
		id: typeof frame.id === "string" ? frame.id : null,
		event: frame.event,
		payload: frame
	};
}
/**
* Race one operation against a deadline and the caller's abort signal, clearing whichever listener
* loses so a settled call leaves no timer or abort registration behind.
* @param operation - the request settlement promise.
* @param signal - caller-owned cancellation.
* @param remainingMs - time left in the call's deadline; a non-positive value fires immediately.
* @param timeoutMessage - message for the deadline rejection.
* @returns the operation's value, or a rejection carrying the deadline/abort message.
*/
function raceDeadline(operation, signal, remainingMs, timeoutMessage) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			finish(() => {
				reject(/* @__PURE__ */ new Error("tts 调用已被取消"));
			});
		};
		const timer = setTimeout(() => {
			finish(() => {
				reject(new Error(timeoutMessage));
			});
		}, remainingMs);
		function finish(settle) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			settle();
		}
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		operation.then((value) => {
			finish(() => {
				resolve(value);
			});
		}, (error) => {
			finish(() => {
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	});
}
/** Wait for one settlement, or `false` when `ms` elapsed first. */
async function settledWithin(settlement, ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(false);
		}, ms);
		settlement.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
/**
* One plugin's daemon: spawns it lazily, keeps it for the plugin lifetime, serializes requests,
* restarts it once on the call after an unexpected exit, and kills it on disposal.
*/
var DaemonClient = class {
	options;
	spawnDaemon;
	pending = /* @__PURE__ */ new Map();
	logTail = [];
	child;
	childAlive = false;
	everStarted = false;
	stdoutBuffer = "";
	ready;
	lastReady;
	readyPromise;
	readySettle;
	nextId = 0;
	queue = Promise.resolve();
	disposed = false;
	/**
	* @param options - interpreter, script, argv, deadline, and optional spawn/log seams.
	*/
	constructor(options) {
		this.options = options;
		this.spawnDaemon = options.spawnDaemon ?? defaultSpawn;
	}
	/** Emotions reported by the daemon, or the last known list when no daemon is currently ready. */
	get emotions() {
		return [...this.ready?.emotions ?? this.lastReady?.emotions ?? []];
	}
	/** The daemon's effective default emotion, or the last known one. */
	get defaultEmotion() {
		return this.ready?.defaultEmotion ?? this.lastReady?.defaultEmotion ?? "";
	}
	/** Engine the daemon reported, or `''` when no daemon has reported one yet. */
	get reportedEngine() {
		return this.ready?.engine ?? this.lastReady?.engine ?? "";
	}
	/** Trailing daemon stderr lines, oldest first; diagnostics only. */
	get logs() {
		return [...this.logTail];
	}
	/**
	* Speak one utterance and resolve only after the daemon reports playback drained. Serialized
	* against every other call on this client, so the daemon never sees overlapping requests.
	* @param request - canonical segments plus the call-level playback options.
	* @param signal - caller cancellation; an aborted call kills the daemon.
	* @returns the drained utterance or the failure, never a throw.
	*/
	speak(request, signal) {
		return this.enqueue(() => this.speakOnce(request, signal));
	}
	/**
	* Kill the daemon and settle every outstanding call. Idempotent; safe after an exit.
	*/
	async dispose() {
		this.disposed = true;
		const child = this.child;
		if (child === void 0 || !this.childAlive) return;
		for (const [id, call] of [...this.pending]) {
			this.pending.delete(id);
			call.settle({
				kind: "transport-error",
				message: "tts 引擎已关闭（插件已卸载）"
			});
		}
		const exited = new Promise((resolve) => {
			child.onExit(() => {
				resolve();
			});
		});
		try {
			child.stdin.end();
		} catch {}
		if (await settledWithin(exited, KILL_GRACE_MS)) return;
		this.killChild(child);
		await settledWithin(exited, KILL_GRACE_MS);
	}
	/** Serialize one operation behind every earlier one. */
	enqueue(operation) {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(() => void 0, () => void 0);
		return result;
	}
	/** One serialized call: ensure a ready daemon, send the request, map the settlement. */
	async speakOnce(request, signal) {
		if (this.disposed) return this.errorOutcome("INTERNAL", "tts 引擎已关闭（插件已卸载）", false);
		if (signal.aborted) return this.errorOutcome("INTERNAL", "tts 调用已被取消", false);
		const deadline = Date.now() + this.options.timeoutMs;
		const startup = await this.startDaemon(signal, deadline);
		if (!startup.ok) return this.errorOutcome("INTERNAL", `无法启动 tts 引擎：${startup.message}`, startup.restarted);
		return this.callOnBackend(request, signal, deadline, startup.restarted);
	}
	/**
	* Spawn the daemon and wait for its `ready` frame.
	* @param signal - caller cancellation.
	* @param deadline - the call's absolute deadline.
	* @returns `ok` with whether the daemon replaced an earlier one, or the startup failure message.
	*/
	async startDaemon(signal, deadline) {
		let restarted = false;
		if (!this.childAlive) {
			restarted = this.everStarted;
			try {
				this.spawnChild();
			} catch (error) {
				return {
					ok: false,
					restarted,
					message: messageOf(error)
				};
			}
		}
		try {
			await raceDeadline(this.awaitReady(), signal, deadline - Date.now(), `tts 引擎在 ${this.options.timeoutMs}ms 内未就绪`);
			return {
				ok: true,
				restarted
			};
		} catch (error) {
			this.killDaemon();
			return {
				ok: false,
				restarted,
				message: messageOf(error)
			};
		}
	}
	/**
	* Send one request on the ready daemon and map its settlement. A transport failure here kills the
	* daemon and fails the call.
	* @param request - the utterance to send.
	* @param signal - caller cancellation.
	* @param deadline - the call's absolute deadline.
	* @param engineRestarted - whether this call started a daemon after a previous one exited.
	* @returns the drained utterance or the failure.
	*/
	async callOnBackend(request, signal, deadline, engineRestarted) {
		const id = String(++this.nextId);
		const reply = await this.send(id, {
			id,
			...request
		}, signal, deadline);
		if (reply.kind === "done") return {
			kind: "done",
			engineRestarted,
			emotions: this.emotions,
			defaultEmotion: this.defaultEmotion,
			backend: reply.done.engine !== "" ? reply.done.engine : this.engineName,
			done: {
				...reply.done,
				modelWasLoaded: reply.modelWasLoaded
			}
		};
		if (reply.kind === "engine-error") return this.errorOutcome(reply.error.code, reply.error.message, engineRestarted);
		this.killDaemon();
		return this.errorOutcome("INTERNAL", reply.message, engineRestarted);
	}
	/** One failed outcome, with the engine known at settlement. */
	errorOutcome(code, message, engineRestarted) {
		return {
			kind: "error",
			engineRestarted,
			emotions: this.emotions,
			defaultEmotion: this.defaultEmotion,
			backend: this.engineName,
			error: {
				code,
				message
			}
		};
	}
	/** The engine this call ran on: the daemon's report, else the one this build ships. */
	get engineName() {
		return this.reportedEngine !== "" ? this.reportedEngine : "voxcpm";
	}
	/**
	* Spawn the daemon and wire its pipes; the caller either awaited readiness or abandoned it.
	*/
	spawnChild() {
		const child = this.spawnDaemon(this.options.pythonPath, [this.options.script, ...this.options.argsFor()], {
			env: daemonEnvironment(),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.everStarted = true;
		this.child = child;
		this.childAlive = true;
		this.ready = void 0;
		this.stdoutBuffer = "";
		this.logTail.length = 0;
		const ready = new Promise((resolve, reject) => {
			this.readySettle = {
				resolve,
				reject
			};
		});
		this.readyPromise = ready;
		ready.catch(() => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			this.onStdout(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			this.onStderr(chunk);
		});
		child.stdin.on("error", () => {});
		child.onExit((code, signal) => {
			this.onExit(code, signal);
		});
		child.onError((error) => {
			this.onChildError(error);
		});
	}
	/** Await the current child's `ready` frame. */
	async awaitReady() {
		const ready = this.readyPromise;
		/* v8 ignore next -- spawnChild set this promise in the same serialized operation. */
		if (ready === void 0) throw new Error("tts 守护进程未启动");
		return ready;
	}
	/** Send one request frame and await its terminal reply. */
	async send(id, request, signal, deadline) {
		const child = this.child;
		/* v8 ignore next -- spawnChild ran in this same serialized operation before send(). */
		if (child === void 0) return {
			kind: "transport-error",
			message: "tts 守护进程未启动"
		};
		const reply = new Promise((resolve) => {
			let settled = false;
			this.pending.set(id, {
				modelWasLoaded: false,
				settle: (value) => {
					if (settled) return;
					settled = true;
					resolve(value);
				}
			});
		});
		try {
			child.stdin.write(`${JSON.stringify(request)}\n`);
		} catch (error) {
			this.pending.delete(id);
			return {
				kind: "transport-error",
				message: `无法写入 tts 守护进程：${messageOf(error)}`
			};
		}
		try {
			return await raceDeadline(reply, signal, deadline - Date.now(), `tts 调用超过 ${this.options.timeoutMs}ms 未完成`);
		} catch (error) {
			return {
				kind: "transport-error",
				message: messageOf(error)
			};
		} finally {
			this.pending.delete(id);
		}
	}
	/** Append one stdout chunk and handle every complete line. */
	onStdout(chunk) {
		this.stdoutBuffer += typeof chunk === "string" ? chunk : String(chunk);
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			this.onFrame(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}
	/** Append one stderr chunk to the retained log tail. */
	onStderr(chunk) {
		const text = typeof chunk === "string" ? chunk : String(chunk);
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			this.recordLog(line);
		}
	}
	/** Retain one diagnostic line and forward it to the configured log sink. */
	recordLog(line) {
		this.logTail.push(line);
		while (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
		this.options.onLog?.(line);
	}
	/** Route one decoded frame to the startup handshake or the matching pending request. */
	onFrame(line) {
		if (line.trim() === "") return;
		const frame = decodeFrame(line);
		if (frame === void 0) {
			this.recordLog(`[protocol] 忽略无法解析的守护进程输出行: ${line.slice(0, 200)}`);
			return;
		}
		if (frame.id === null) {
			if (frame.event !== "ready") return;
			const ready = toReady(frame.payload);
			if (ready === void 0) return;
			this.ready = ready;
			this.lastReady = ready;
			const settle = this.readySettle;
			this.readySettle = void 0;
			settle?.resolve(ready);
			return;
		}
		const call = this.pending.get(frame.id);
		if (call === void 0) return;
		switch (frame.event) {
			case "speak_start":
				call.modelWasLoaded = frame.payload.modelWasLoaded === true;
				return;
			case "speak_done": {
				const done = toSpeakDone(frame.payload);
				if (done === void 0) {
					call.settle({
						kind: "transport-error",
						message: "tts 引擎返回了无法解析的 speak_done 事件"
					});
					return;
				}
				call.settle({
					kind: "done",
					done,
					modelWasLoaded: call.modelWasLoaded
				});
				return;
			}
			case "error": {
				const error = toError(frame.payload);
				if (error === void 0) {
					call.settle({
						kind: "transport-error",
						message: "tts 引擎返回了无法解析的 error 事件"
					});
					return;
				}
				call.settle({
					kind: "engine-error",
					error
				});
				return;
			}
			default: return;
		}
	}
	/** Mark the child dead and fail every outstanding call and the pending handshake. */
	onExit(code, signal) {
		this.childAlive = false;
		this.ready = void 0;
		const reason = `tts 守护进程意外退出（code=${String(code)}, signal=${String(signal)}）`;
		const settle = this.readySettle;
		this.readySettle = void 0;
		settle?.reject(new Error(reason));
		for (const [id, call] of [...this.pending]) {
			this.pending.delete(id);
			call.settle({
				kind: "transport-error",
				message: reason
			});
		}
	}
	/** Fail the pending handshake when the child cannot start at all (a spawn failure). */
	onChildError(error) {
		this.childAlive = false;
		this.ready = void 0;
		const settle = this.readySettle;
		this.readySettle = void 0;
		settle?.reject(new Error(messageOf(error)));
	}
	/** Kill the current child after a transport failure, so a busy daemon cannot serve the next call. */
	killDaemon() {
		if (this.disposed) return;
		const child = this.child;
		if (child === void 0 || !this.childAlive) return;
		this.killChild(child);
	}
	/** End one child with SIGKILL, tolerating an exit that raced the liveness check. */
	killChild(child) {
		this.childAlive = false;
		try {
			child.stdin.destroy();
		} catch {}
		try {
			child.kill("SIGKILL");
		} catch {}
	}
};
//#endregion
//#region lib/types/result.js
/**
* `tts` result rendering: the exact success and failure text the model reads, including the
* `(a,b,c)` list of emotion labels available at call time.
* @module @deepseek-ai/dsh-tool-tts/result
*/
/**
* Render the `(a,b,c)` emotion-label list every result carries.
* @param emotions - available emotion labels, in the daemon's order.
* @returns the parenthesized comma-joined list, or `(未知)` when no daemon ever reported one.
*/
function emotionListText(emotions) {
	return emotions.length === 0 ? "(未知)" : `(${emotions.join(",")})`;
}
/**
* Collect the requested-to-used emotion-label substitutions worth reporting: exactly one entry per
* distinct label the daemon resolved to something else, in first-requested order. A segment
* without a requested emotion label resolved by default rather than by correction, so it is not a
* fallback the model needs told about.
* @param segments - the daemon's per-segment results.
* @returns one distinct substitution per unresolved request.
*/
function fallbacksOf(segments) {
	const fallbacks = [];
	const seen = /* @__PURE__ */ new Set();
	for (const segment of segments) {
		if (!segment.fallback || segment.requestedEmotion === "" || segment.requestedEmotion === segment.usedEmotion) continue;
		if (seen.has(segment.requestedEmotion)) continue;
		seen.add(segment.requestedEmotion);
		fallbacks.push({
			requestedEmotion: segment.requestedEmotion,
			usedEmotion: segment.usedEmotion
		});
	}
	return fallbacks;
}
/** The trailing sentence shared by the success and failure texts. */
const EMOTION_GUIDANCE = " —— 情绪会作为表情标签原样转发给 Live2D。";
/**
* Render one successful call exactly as `PROTOCOL.md` §8 specifies: totals, the emotion labels used,
* then the available-label list.
* @param result - a validated `ok: true` result.
* @param listMode - `always` (default) repeats the available-label list every call; `onFallback`
*   repeats it only when an emotion label was resolved differently.
* @returns the multi-line model-facing text.
*/
function renderSuccessText(result, listMode = "always") {
	const sentences = result.segments.reduce((total, segment) => total + segment.sentences, 0);
	const lines = [`tts 成功：共 ${result.totalSeconds.toFixed(2)}s（${result.segments.length} 段 / ${sentences} 句），实时率 ${result.rtf.toFixed(2)}。`];
	const used = [...new Set(result.segments.map((segment) => segment.usedEmotion))];
	if (used.length > 0) {
		const substitutions = result.fallbacks.map((fallback) => `情绪「${fallback.requestedEmotion}」不在可用列表中，已改用默认情绪「${fallback.usedEmotion}」。`).join("");
		lines.push(`使用表情标签：${used.join("、")}。${substitutions}`);
	}
	if (listMode === "always" || result.fallbacks.length > 0) lines.push(`可用表情标签：${emotionListText(result.emotions)}${EMOTION_GUIDANCE}`);
	return lines.join("\n");
}
/**
* Render one failed call exactly as `PROTOCOL.md` §8 specifies: the reason, then the available
* emotion-label list.
* @param reason - the failure message (or the error code when the daemon sent no message).
* @param emotions - available labels known at settlement.
* @returns the two-line model-facing text.
*/
function renderFailureText(reason, emotions) {
	const trimmed = reason.trim();
	const withoutStop = /[。.]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
	return `tts 失败：${withoutStop.length === 0 ? "未知错误" : withoutStop}。\n可用表情标签：${emotionListText(emotions)}${EMOTION_GUIDANCE}`;
}
//#endregion
//#region lib/types/index.js
/**
* Model-facing `tts` tool: speaks text through a locally resident VoxCPM 1.5 daemon and resolves only
* after the audio has finished playing. The engine clones one installed reference voice; every call
* that runs reports the available emotion labels, which are forwarded as expression labels and never
* choose a different voice. Named exports preserve loader injection metadata.
* @module @deepseek-ai/dsh-tool-tts
*/
const name = "tool-tts";
const inject = ["tools"];
/** The daemon script shipped inside this package, used when `daemonScript` is not configured. */
const DEFAULT_DAEMON_SCRIPT = fileURLToPath(new URL("../python/tts_daemon.py", import.meta.url));
/**
* Where a call's WAV files go when the model asked to save but named no directory: the configured
* `saveDir`, else `<cacheDir>\wav` — the same fallback the daemon applies, reported so the model
* can find the files it asked for.
* @param saveDir - the model-supplied directory, or `''` when it named none.
* @param config - the deployment configuration.
* @returns the directory the daemon will write to.
*/
function saveTarget(saveDir, config) {
	if (saveDir !== "") return saveDir;
	return config.saveDir !== "" ? config.saveDir : join(config.cacheDir, "wav");
}
/**
* Build the daemon argv. Every entry is a configured value: the daemon's behavior must be
* reproducible from the composition, never from a constant buried in this plugin.
* @param config - the deployment configuration.
* @returns the daemon argv after the script path.
*/
function daemonArgs(config) {
	return [
		"--voices-dir",
		config.voicesDir,
		"--default-emotion",
		config.defaultEmotion,
		"--model-dir",
		config.modelDir,
		"--device",
		config.device,
		"--cfg-value",
		String(config.cfgValue),
		"--timesteps",
		String(config.inferenceTimesteps),
		"--optimize",
		String(config.optimize),
		"--normalize",
		String(config.normalizeText),
		"--cache-dir",
		config.cacheDir,
		"--save-dir",
		config.saveDir,
		"--max-sentence-chars",
		String(config.maxSentenceChars),
		"--first-sentence-max-chars",
		String(config.firstSentenceMaxChars),
		"--merge-sentences",
		config.mergeSentences,
		"--merge-max-chars",
		String(config.mergeMaxChars),
		"--short-sentence-chars",
		String(config.shortSentenceChars),
		"--seed",
		String(config.samplingSeed),
		"--idle-unload-sec",
		String(config.idleUnloadSec),
		"--preload",
		String(config.preload),
		"--output-device",
		config.outputDevice
	];
}
/**
* Reject a configuration whose values are meaningless before the daemon ever starts. The daemon is
* lazy, so a bad path surfaces on the first call; these are self-contained and fail at load. The
* merge mode itself needs no check here: the `Config` schema's union already admits only
* `off | short | all`, and the Loader validates the row against that schema before `apply` runs.
* @param config - the deployment configuration.
*/
function assertConfig(config) {
	if (config.pythonPath === "") throw new Error("tool-tts: config.pythonPath must name the Python interpreter that runs the daemon");
	if (!Number.isFinite(config.toolTimeoutMs) || config.toolTimeoutMs <= 0) throw new Error(`tool-tts: config.toolTimeoutMs must be a positive finite number, got ${String(config.toolTimeoutMs)}`);
	if (!Number.isInteger(config.maxSentenceChars) || config.maxSentenceChars < 1) throw new Error(`tool-tts: config.maxSentenceChars must be a positive integer, got ${String(config.maxSentenceChars)}`);
	if (!Number.isInteger(config.firstSentenceMaxChars) || config.firstSentenceMaxChars < 1) throw new Error(`tool-tts: config.firstSentenceMaxChars must be a positive integer, got ${String(config.firstSentenceMaxChars)}`);
	if (!Number.isInteger(config.idleUnloadSec) || config.idleUnloadSec < 0) throw new Error(`tool-tts: config.idleUnloadSec must be a non-negative integer, got ${String(config.idleUnloadSec)}`);
	if (!Number.isInteger(config.mergeMaxChars) || config.mergeMaxChars < 0) throw new Error(`tool-tts: config.mergeMaxChars must be a non-negative integer, got ${String(config.mergeMaxChars)}`);
	if (!Number.isInteger(config.shortSentenceChars) || config.shortSentenceChars < 0) throw new Error(`tool-tts: config.shortSentenceChars must be a non-negative integer, got ${String(config.shortSentenceChars)}`);
	if (!Number.isInteger(config.samplingSeed) || config.samplingSeed < 0) throw new Error(`tool-tts: config.samplingSeed must be a non-negative integer, got ${String(config.samplingSeed)}`);
	if (!Number.isFinite(config.cfgValue) || config.cfgValue < .1 || config.cfgValue > 10) throw new Error(`tool-tts: config.cfgValue must be a finite number in [0.1, 10], got ${String(config.cfgValue)}`);
	if (!Number.isInteger(config.inferenceTimesteps) || config.inferenceTimesteps < 1 || config.inferenceTimesteps > 100) throw new Error(`tool-tts: config.inferenceTimesteps must be an integer in [1, 100], got ${String(config.inferenceTimesteps)}`);
}
/**
* The model-facing description, written to the repository's tool-description conventions. The
* reusable rules were distilled from the shipped tools and apply here as noted:
*
* 1. Open with what the tool does and its one-shot or blocking cost
*    (`tool-pwsh` "Execute a PowerShell command … Each call runs in a fresh pwsh process";
*    `tool-fs` read.ts "Read a UTF-8 text file and return line-numbered content"). Here: the first
*    paragraph says the tool speaks locally, that the call blocks until playback drains, and that
*    the first call loads the voice model.
* 2. Give every input form with a concrete example and name the canonical one (`tool-todo`,
*    `tool-web` search.ts). Here: object items are canonical, the flat string form is the shorthand,
*    and both appear with examples.
* 3. Per parameter, state the default and the exact reach of the value (`tool-pwsh` `timeoutMs` /
*    `workdir`; read.ts "Defaults to 1."). Here: the parameter descriptions own the `play`,
*    `save_dir`, and `gap_ms` defaults and reach, so the description keeps only the cross-parameter
*    fact they cannot state — `gap_ms` has no effect with `play: false`.
* 4. Enumerate the closed value set the model chooses from, instead of describing it in prose
*    (`tool-subagent`'s provider wording, plan-mode's outcome labels). Here: the emotion-label list
*    every call that runs reports, which is the only closed set the model chooses from.
* 5. State the failure semantics the model must avoid (`tool-pwsh`'s denial/escalation rules). Here:
*    text in a script the installed model cannot read fails the whole call, while any emotion label
*    is accepted and never fails one.
* 6. No implementation vocabulary and no knobs the model cannot use: engine flags, daemon details,
*    sentence-splitting limits, language-resolution internals, and tunables stay out. Here: nothing
*    about the engine, the sentence cap, or the reference transcript machinery appears.
* 7. One topic per short paragraph, so a long description stays scannable (`tool-pwsh`); the wording
*    is stable, because the generated tool catalog and the README quote it verbatim.
* 8. Compose from configuration where a clause genuinely depends on the deployment
*    (`pwshDescription`, `tool-todo`'s `describe()`). Here: the emotion-label clause follows
*    `emotionListInResults`, because `onFallback` shortens a routine success while `always` repeats
*    the list on every call that runs. Everything else is deployment-independent — the voice
*    paragraph states the clone relationship generically, and the installed reference voice is
*    README data.
*/
/**
* Build the model-facing description for one deployment.
* @param emotionListInResults - whether a successful call repeats the available emotion-label list.
* @returns the description with its paragraphs joined by blank lines.
*/
function describe(emotionListInResults) {
	return [
		"Speak text aloud on this machine through a local voice model. The call returns after the audio has finished playing — or after the WAV files are written, either with `play: false` or into a `save_dir` — so a long utterance keeps the call running; the first call also loads the model, which delays that first utterance by about ten seconds.",
		"",
		"`segments` takes either objects `{ emotion?, content }` — for example `[{\"emotion\":\"开心\",\"content\":\"你好\"}]` — or a flat alternating list whose positions 0, 2, 4… are emotions and 1, 3, 5… their contents, for example `[\"开心\",\"你好\",\"默认\",\"再见\"]`. In the string form every emotion must be followed by its content; use object items for content that needs no emotion. Several segments play back to back — prefer one call with several segments over one per sentence.",
		"",
		"The engine speaks with the one reference recording installed on this machine: it clones that recording and continues from its transcript, so the recording's timbre and delivery carry into the speech. The installed voice model speaks Chinese and English only: text in a script it cannot read — Japanese, Korean, or Russian, for example — fails the call instead of being read as Chinese, so pass Chinese or English text only.",
		"",
		emotionListInResults === "always" ? "`emotion` is an expression label forwarded to the Live2D renderer; it never selects a different voice and any label is accepted. Every call that runs — success or failure — reports the available labels as `(a,b,c)`." : "`emotion` is an expression label forwarded to the Live2D renderer; it never selects a different voice and any label is accepted. Every failure reports the available labels as `(a,b,c)`, and a successful call reports them when a label was resolved differently.",
		"",
		"With `play: false` nothing is played, so `gap_ms` has no effect."
	].join("\n");
}
/** Schemastery configuration for the `tts` tool. */
const Config = z.object({
	pythonPath: z.string().required(),
	daemonScript: z.string().default(DEFAULT_DAEMON_SCRIPT),
	voicesDir: z.string().required(),
	defaultEmotion: z.string().default("默认"),
	modelDir: z.string().required(),
	device: z.string().default("cuda:0"),
	cfgValue: z.number().default(2.7),
	inferenceTimesteps: z.number().default(10),
	optimize: z.boolean().default(false),
	normalizeText: z.boolean().default(false),
	cacheDir: z.string().required(),
	saveDir: z.string().default(""),
	maxSentenceChars: z.number().default(60),
	firstSentenceMaxChars: z.number().default(20),
	idleUnloadSec: z.number().default(1800),
	preload: z.boolean().default(false),
	outputDevice: z.string().default(""),
	mergeSentences: z.union([
		"off",
		"short",
		"all"
	]).default("short"),
	mergeMaxChars: z.number().default(0),
	shortSentenceChars: z.number().default(20),
	samplingSeed: z.number().default(0),
	emotionListInResults: z.union(["always", "onFallback"]).default("always"),
	toolTimeoutMs: z.number().default(6e5)
});
/**
* Register the `tts` tool on `ctx.tools` and own one daemon for this plugin's lifetime.
* @param ctx - registrant context carrying the tool registry.
* @param config - deployment paths, engine options, and the per-call deadline.
*/
function apply(ctx, config) {
	const resolved = config;
	assertConfig(resolved);
	const client = new DaemonClient({
		pythonPath: resolved.pythonPath,
		script: resolved.daemonScript,
		argsFor: () => daemonArgs(resolved),
		timeoutMs: resolved.toolTimeoutMs,
		onLog: (line) => {
			ctx.logger.warn(`[tool-tts] ${line}`);
		}
	});
	ctx.effect(() => () => client.dispose(), "tool-tts daemon");
	ctx.tools.register(defineTool({
		name: "tts",
		description: describe(resolved.emotionListInResults),
		parameters: {
			segments: {
				type: "array",
				required: true,
				description: "The utterance: `{emotion?,content}` items, or the flat alternating string form (`emotion`, `content`, `emotion`, `content`, …). Several segments play back to back.",
				items: { oneOf: [{
					type: "object",
					additionalProperties: false,
					properties: {
						emotion: {
							type: "string",
							description: "Expression label forwarded to the Live2D renderer; it never selects a different voice. Omit for the default label."
						},
						content: {
							type: "string",
							required: true,
							description: "Text to speak."
						}
					}
				}, { type: "string" }] }
			},
			play: {
				type: "boolean",
				description: "Play on this machine's speakers (default true). `false` saves WAV files only."
			},
			save_dir: {
				type: "string",
				description: "Directory for the produced WAV files (created if missing); naming one writes the files even while the audio plays."
			},
			gap_ms: {
				type: "integer",
				description: "Silence played between segments, in milliseconds (default 120). Playback only: not written to the saved files and not counted in the reported total."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true,
						description: "Whether every segment produced audio."
					},
					totalSeconds: {
						type: "number",
						required: true,
						description: "Audible audio seconds produced."
					},
					segments: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								index: {
									type: "integer",
									required: true
								},
								requestedEmotion: {
									type: "string",
									required: true
								},
								usedEmotion: {
									type: "string",
									required: true
								},
								fallback: {
									type: "boolean",
									required: true
								},
								seconds: {
									type: "number",
									required: true
								},
								sentences: {
									type: "integer",
									required: true
								}
							}
						}
					},
					emotions: {
						type: "array",
						required: true,
						description: "Available emotion labels at call time.",
						items: { type: "string" }
					},
					defaultEmotion: {
						type: "string",
						required: true,
						description: "The engine's default emotion label."
					},
					fallbacks: {
						type: "array",
						required: true,
						description: "Every requested emotion label the engine resolved differently.",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								requestedEmotion: {
									type: "string",
									required: true
								},
								usedEmotion: {
									type: "string",
									required: true
								}
							}
						}
					},
					rtf: {
						type: "number",
						required: true,
						description: "Generation seconds ÷ audio seconds for this call."
					},
					firstAudioMs: {
						type: "integer",
						required: true,
						description: "Wall milliseconds from `speak_start` to the first audible sample."
					},
					modelLoadMs: {
						type: "integer",
						required: true,
						description: "Model load milliseconds; 0 once resident."
					},
					modelWasLoaded: {
						type: "boolean",
						required: true,
						description: "Whether the model was already resident."
					},
					files: {
						type: "array",
						required: true,
						description: "WAV files produced by this call.",
						items: { type: "string" }
					},
					savedTo: {
						type: "string",
						description: "Directory the WAV files were written to."
					},
					notes: {
						type: "array",
						required: true,
						description: "Engine notes, e.g. an unsupported speed.",
						items: { type: "string" }
					},
					error: {
						type: "object",
						additionalProperties: false,
						description: "Present exactly when `ok` is false.",
						properties: {
							code: {
								type: "string",
								required: true
							},
							message: {
								type: "string",
								required: true
							}
						}
					},
					engineRestarted: {
						type: "boolean",
						required: true,
						description: "This call ran on a restarted daemon."
					},
					backend: {
						type: "string",
						required: true,
						description: "Engine that served this call (`voxcpm`)."
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.ok ? renderSuccessText(value, resolved.emotionListInResults) : renderFailureText(value.error?.message ?? value.error?.code ?? "未知错误", value.emotions)
			}]
		},
		timeoutMs: resolved.toolTimeoutMs,
		presentCall: (args) => ({
			card: "generic",
			title: "Speak text aloud",
			kind: "other",
			rawInput: args.segments
		}),
		async execute(args, exec) {
			const parsed = parseTtsArgs(args);
			const requestedSaveDir = parsed.saveDir ?? "";
			const save = parsed.saveDir !== void 0 || !parsed.play || resolved.saveDir !== "";
			const request = {
				op: "speak",
				segments: parsed.segments,
				play: parsed.play,
				save,
				saveDir: requestedSaveDir,
				gapMs: parsed.gapMs,
				speed: parsed.speed
			};
			const outcome = await client.speak(request, exec.signal);
			const savedTo = save ? saveTarget(requestedSaveDir, resolved) : void 0;
			if (outcome.kind === "done") return {
				ok: true,
				totalSeconds: outcome.done.totalSeconds,
				segments: outcome.done.segments,
				emotions: outcome.emotions,
				defaultEmotion: outcome.defaultEmotion,
				fallbacks: fallbacksOf(outcome.done.segments),
				rtf: outcome.done.rtf,
				firstAudioMs: outcome.done.firstAudioMs,
				modelLoadMs: outcome.done.modelLoadMs,
				modelWasLoaded: outcome.done.modelWasLoaded,
				files: outcome.done.files,
				notes: outcome.done.notes,
				engineRestarted: outcome.engineRestarted,
				backend: outcome.backend,
				...savedTo === void 0 ? {} : { savedTo }
			};
			const logs = client.logs;
			return {
				ok: false,
				totalSeconds: 0,
				segments: [],
				emotions: outcome.emotions,
				defaultEmotion: outcome.defaultEmotion,
				fallbacks: [],
				rtf: 0,
				firstAudioMs: 0,
				modelLoadMs: 0,
				modelWasLoaded: false,
				files: [],
				notes: logs.length === 0 ? [] : [`引擎日志（末行）：${logs[logs.length - 1]}`],
				error: outcome.error,
				engineRestarted: outcome.engineRestarted,
				backend: outcome.backend,
				...savedTo === void 0 ? {} : { savedTo }
			};
		}
	}));
}
//#endregion
export { Config, apply, inject, name };
