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
import { spawn } from 'node:child_process';
/** Grace period between closing the daemon's stdin and forcing it down, in milliseconds. */
const KILL_GRACE_MS = 2_000;
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
    return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
}
/** Adapt a real child process to {@link DaemonChild}. */
const defaultSpawn = (command, args, options) => {
    const child = spawn(command, [...args], options);
    return {
        get pid() { return child.pid; },
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: signal => child.kill(signal),
        onExit: (listener) => { child.on('exit', listener); },
        onError: (listener) => { child.on('error', listener); },
    };
};
/** Render an unknown thrown value for a model-facing message. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Read one finite number from a decoded frame, falling back to `0` for a missing or invalid field. */
function toNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** Read one string from a decoded frame, falling back to `''`. */
function toText(value) {
    return typeof value === 'string' ? value : '';
}
/** Read a string list from a decoded frame, dropping non-string entries. */
function toTextList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
/** Read the emotion names from a `ready` frame, accepting bare names or `{name}` records. */
function toEmotions(value) {
    if (!Array.isArray(value))
        return [];
    const names = [];
    for (const item of value) {
        if (typeof item === 'string')
            names.push(item);
        else if (item !== null && typeof item === 'object' && typeof item.name === 'string') {
            names.push(item.name);
        }
    }
    return names;
}
/** Read one segment result from a decoded `speak_done` frame. */
function toSegmentResult(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const segment = value;
    return {
        index: toNumber(segment.index),
        requestedEmotion: toText(segment.requestedEmotion),
        usedEmotion: toText(segment.usedEmotion),
        fallback: segment.fallback === true,
        seconds: toNumber(segment.seconds),
        sentences: toNumber(segment.sentences),
    };
}
/** Read a `speak_done` frame's payload, or `undefined` when the frame cannot describe an utterance. */
function toSpeakDone(payload) {
    const rawSegments = payload.segments;
    if (!Array.isArray(rawSegments))
        return undefined;
    const segments = [];
    for (const raw of rawSegments) {
        const segment = toSegmentResult(raw);
        if (segment === undefined)
            return undefined;
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
        engine: toText(payload.engine),
    };
}
/** Read a `ready` frame's payload, or `undefined` when it cannot describe a daemon. */
function toReady(payload) {
    if (payload.defaultEmotion === undefined && payload.emotions === undefined)
        return undefined;
    return {
        pid: toNumber(payload.pid),
        voicesDir: toText(payload.voicesDir),
        defaultEmotion: toText(payload.defaultEmotion),
        emotions: toEmotions(payload.emotions),
        device: toText(payload.device),
        modelLoaded: payload.modelLoaded === true,
        engine: toText(payload.engine),
    };
}
/** Read an `error` frame's payload, or `undefined` when it cannot describe a failure. */
function toError(payload) {
    if (payload.code === undefined && payload.message === undefined)
        return undefined;
    return { code: toText(payload.code) || 'INTERNAL', message: toText(payload.message) };
}
/** Decode one JSON Lines frame, or `undefined` for a line that is not a protocol frame. */
function decodeFrame(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        // A non-JSON stdout line is a protocol violation; the caller records and drops it.
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const frame = parsed;
    if (typeof frame.event !== 'string')
        return undefined;
    const id = typeof frame.id === 'string' ? frame.id : null;
    return { id, event: frame.event, payload: frame };
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
        const onAbort = () => { finish(() => { reject(new Error('tts 调用已被取消')); }); };
        const timer = setTimeout(() => { finish(() => { reject(new Error(timeoutMessage)); }); }, remainingMs);
        function finish(settle) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            settle();
        }
        signal.addEventListener('abort', onAbort, { once: true });
        // An abort between the caller's check and this registration never fires the listener.
        if (signal.aborted)
            onAbort();
        void operation.then((value) => { finish(() => { resolve(value); }); }, (error) => {
            finish(() => { reject(error instanceof Error ? error : new Error(String(error))); });
        });
    });
}
/** Wait for one settlement, or `false` when `ms` elapsed first. */
async function settledWithin(settlement, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(false); }, ms);
        void settlement.then(() => { clearTimeout(timer); resolve(true); });
    });
}
/**
 * One plugin's daemon: spawns it lazily, keeps it for the plugin lifetime, serializes requests,
 * restarts it once on the call after an unexpected exit, and kills it on disposal.
 */
export class DaemonClient {
    options;
    spawnDaemon;
    pending = new Map();
    logTail = [];
    child;
    childAlive = false;
    everStarted = false;
    stdoutBuffer = '';
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
        return [...(this.ready?.emotions ?? this.lastReady?.emotions ?? [])];
    }
    /** The daemon's effective default emotion, or the last known one. */
    get defaultEmotion() {
        return this.ready?.defaultEmotion ?? this.lastReady?.defaultEmotion ?? '';
    }
    /** Engine the daemon reported, or `''` when no daemon has reported one yet. */
    get reportedEngine() {
        return this.ready?.engine ?? this.lastReady?.engine ?? '';
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
        if (child === undefined || !this.childAlive)
            return;
        for (const [id, call] of [...this.pending]) {
            this.pending.delete(id);
            call.settle({ kind: 'transport-error', message: 'tts 引擎已关闭（插件已卸载）' });
        }
        const exited = new Promise((resolve) => { child.onExit(() => { resolve(); }); });
        try {
            child.stdin.end();
        }
        catch {
            // The stdin pipe is already closed. The daemon's own EOF handling owns its exit, and the
            // wait below covers it either way.
        }
        if (await settledWithin(exited, KILL_GRACE_MS))
            return;
        this.killChild(child);
        await settledWithin(exited, KILL_GRACE_MS);
    }
    /** Serialize one operation behind every earlier one. */
    enqueue(operation) {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
    /** One serialized call: ensure a ready daemon, send the request, map the settlement. */
    async speakOnce(request, signal) {
        if (this.disposed)
            return this.errorOutcome('INTERNAL', 'tts 引擎已关闭（插件已卸载）', false);
        if (signal.aborted)
            return this.errorOutcome('INTERNAL', 'tts 调用已被取消', false);
        const deadline = Date.now() + this.options.timeoutMs;
        const startup = await this.startDaemon(signal, deadline);
        if (!startup.ok) {
            return this.errorOutcome('INTERNAL', `无法启动 tts 引擎：${startup.message}`, startup.restarted);
        }
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
            }
            catch (error) {
                return { ok: false, restarted, message: messageOf(error) };
            }
        }
        try {
            await raceDeadline(this.awaitReady(), signal, deadline - Date.now(), `tts 引擎在 ${this.options.timeoutMs}ms 内未就绪`);
            return { ok: true, restarted };
        }
        catch (error) {
            this.killDaemon();
            return { ok: false, restarted, message: messageOf(error) };
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
        const reply = await this.send(id, { id, ...request }, signal, deadline);
        if (reply.kind === 'done') {
            return {
                kind: 'done',
                engineRestarted,
                emotions: this.emotions,
                defaultEmotion: this.defaultEmotion,
                backend: reply.done.engine !== '' ? reply.done.engine : this.engineName,
                done: { ...reply.done, modelWasLoaded: reply.modelWasLoaded },
            };
        }
        if (reply.kind === 'engine-error') {
            return this.errorOutcome(reply.error.code, reply.error.message, engineRestarted);
        }
        this.killDaemon();
        return this.errorOutcome('INTERNAL', reply.message, engineRestarted);
    }
    /** One failed outcome, with the engine known at settlement. */
    errorOutcome(code, message, engineRestarted) {
        return {
            kind: 'error',
            engineRestarted,
            emotions: this.emotions,
            defaultEmotion: this.defaultEmotion,
            backend: this.engineName,
            error: { code, message },
        };
    }
    /** The engine this call ran on: the daemon's report, else the one this build ships. */
    get engineName() {
        return this.reportedEngine !== '' ? this.reportedEngine : 'voxcpm';
    }
    /**
     * Spawn the daemon and wire its pipes; the caller either awaited readiness or abandoned it.
     */
    spawnChild() {
        const child = this.spawnDaemon(this.options.pythonPath, [
            this.options.script,
            ...this.options.argsFor(),
        ], {
            env: daemonEnvironment(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.everStarted = true;
        this.child = child;
        this.childAlive = true;
        this.ready = undefined;
        this.stdoutBuffer = '';
        this.logTail.length = 0;
        const ready = new Promise((resolve, reject) => {
            this.readySettle = { resolve, reject };
        });
        this.readyPromise = ready;
        // A daemon nobody awaits (a call abandoned by an abort) must not surface as an unhandled rejection.
        void ready.catch(() => { });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { this.onStdout(chunk); });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { this.onStderr(chunk); });
        // A broken pipe surfaces as an 'error' event; the call that wrote it reports the failure.
        child.stdin.on('error', () => { });
        child.onExit((code, signal) => { this.onExit(code, signal); });
        child.onError((error) => { this.onChildError(error); });
    }
    /** Await the current child's `ready` frame. */
    async awaitReady() {
        const ready = this.readyPromise;
        /* v8 ignore next -- spawnChild set this promise in the same serialized operation. */
        if (ready === undefined)
            throw new Error('tts 守护进程未启动');
        return ready;
    }
    /** Send one request frame and await its terminal reply. */
    async send(id, request, signal, deadline) {
        const child = this.child;
        /* v8 ignore next -- spawnChild ran in this same serialized operation before send(). */
        if (child === undefined)
            return { kind: 'transport-error', message: 'tts 守护进程未启动' };
        const reply = new Promise((resolve) => {
            let settled = false;
            this.pending.set(id, {
                modelWasLoaded: false,
                settle: (value) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(value);
                },
            });
        });
        try {
            child.stdin.write(`${JSON.stringify(request)}\n`);
        }
        catch (error) {
            this.pending.delete(id);
            return { kind: 'transport-error', message: `无法写入 tts 守护进程：${messageOf(error)}` };
        }
        try {
            return await raceDeadline(reply, signal, deadline - Date.now(), `tts 调用超过 ${this.options.timeoutMs}ms 未完成`);
        }
        catch (error) {
            return { kind: 'transport-error', message: messageOf(error) };
        }
        finally {
            this.pending.delete(id);
        }
    }
    /** Append one stdout chunk and handle every complete line. */
    onStdout(chunk) {
        this.stdoutBuffer += typeof chunk === 'string' ? chunk : String(chunk);
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.stdoutBuffer.slice(0, newline);
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            this.onFrame(line);
            newline = this.stdoutBuffer.indexOf('\n');
        }
    }
    /** Append one stderr chunk to the retained log tail. */
    onStderr(chunk) {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        for (const line of text.split('\n')) {
            if (line.trim() === '')
                continue;
            this.recordLog(line);
        }
    }
    /** Retain one diagnostic line and forward it to the configured log sink. */
    recordLog(line) {
        this.logTail.push(line);
        while (this.logTail.length > LOG_TAIL_LINES)
            this.logTail.shift();
        this.options.onLog?.(line);
    }
    /** Route one decoded frame to the startup handshake or the matching pending request. */
    onFrame(line) {
        if (line.trim() === '')
            return;
        const frame = decodeFrame(line);
        if (frame === undefined) {
            // A non-JSON stdout line never fails the call: the engine's own imports can print banners,
            // and the request/response frames that matter are still parseable. Retain it for diagnostics.
            this.recordLog(`[protocol] 忽略无法解析的守护进程输出行: ${line.slice(0, 200)}`);
            return;
        }
        if (frame.id === null) {
            if (frame.event !== 'ready')
                return;
            const ready = toReady(frame.payload);
            if (ready === undefined)
                return;
            this.ready = ready;
            this.lastReady = ready;
            const settle = this.readySettle;
            this.readySettle = undefined;
            settle?.resolve(ready);
            return;
        }
        const call = this.pending.get(frame.id);
        if (call === undefined)
            return;
        switch (frame.event) {
            case 'speak_start':
                call.modelWasLoaded = frame.payload.modelWasLoaded === true;
                return;
            case 'speak_done': {
                const done = toSpeakDone(frame.payload);
                if (done === undefined) {
                    call.settle({ kind: 'transport-error', message: 'tts 引擎返回了无法解析的 speak_done 事件' });
                    return;
                }
                call.settle({ kind: 'done', done, modelWasLoaded: call.modelWasLoaded });
                return;
            }
            case 'error': {
                const error = toError(frame.payload);
                if (error === undefined) {
                    call.settle({ kind: 'transport-error', message: 'tts 引擎返回了无法解析的 error 事件' });
                    return;
                }
                call.settle({ kind: 'engine-error', error });
                return;
            }
            default:
                return;
        }
    }
    /** Mark the child dead and fail every outstanding call and the pending handshake. */
    onExit(code, signal) {
        this.childAlive = false;
        this.ready = undefined;
        const reason = `tts 守护进程意外退出（code=${String(code)}, signal=${String(signal)}）`;
        const settle = this.readySettle;
        this.readySettle = undefined;
        settle?.reject(new Error(reason));
        for (const [id, call] of [...this.pending]) {
            this.pending.delete(id);
            call.settle({ kind: 'transport-error', message: reason });
        }
    }
    /** Fail the pending handshake when the child cannot start at all (a spawn failure). */
    onChildError(error) {
        this.childAlive = false;
        this.ready = undefined;
        const settle = this.readySettle;
        this.readySettle = undefined;
        settle?.reject(new Error(messageOf(error)));
    }
    /** Kill the current child after a transport failure, so a busy daemon cannot serve the next call. */
    killDaemon() {
        // Disposal owns its own teardown: it gives the daemon stdin EOF and a grace period first.
        if (this.disposed)
            return;
        const child = this.child;
        if (child === undefined || !this.childAlive)
            return;
        this.killChild(child);
    }
    /** End one child with SIGKILL, tolerating an exit that raced the liveness check. */
    killChild(child) {
        this.childAlive = false;
        try {
            child.stdin.destroy();
        }
        catch {
            // The request pipe is already closed; the signal below is the remaining terminator.
        }
        try {
            child.kill('SIGKILL');
        }
        catch {
            // The daemon exited between the liveness check and the signal; nothing left to kill.
        }
    }
}
//# sourceMappingURL=daemon.js.map