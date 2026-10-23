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
import { type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { DaemonSpeakRequest, SpeakOutcome } from './types.ts';
/**
 * The child-process surface the client drives. Structural (not `ChildProcess`) so a test can supply
 * a fake daemon without spawning Python; the default spawn adapter narrows the real process to it.
 */
export interface DaemonChild {
    /** Child pid, when the platform reported one. */
    readonly pid: number | undefined;
    /** Request pipe: one JSON request object per line. */
    readonly stdin: Writable;
    /** Event pipe: JSON Lines only. */
    readonly stdout: Readable;
    /** Diagnostic pipe: one log record per line. */
    readonly stderr: Readable;
    /** Terminate the child. */
    kill(signal?: NodeJS.Signals): boolean;
    /** Observe child exit. */
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    /** Observe a spawn or kill failure. */
    onError(listener: (error: Error) => void): void;
}
/** Spawns one daemon child. */
export type SpawnDaemon = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => DaemonChild;
/** Construction parameters for {@link DaemonClient}. */
export interface DaemonClientOptions {
    /** Python interpreter that runs the daemon (`…\dsh-tts-runtime\.venv-vox\Scripts\python.exe`). */
    pythonPath: string;
    /** Absolute path of the daemon entry script (`python\tts_daemon.py`). */
    script: string;
    /**
     * Daemon argv after the script path. One engine runs in one interpreter, so the argv never
     * depends on a selected provider.
     * @returns the daemon argv after the script path.
     */
    argsFor: () => string[];
    /** Deadline for one call, covering lazy startup and the whole utterance. */
    timeoutMs: number;
    /** Test seam for the child process; defaults to `node:child_process` spawn. */
    spawnDaemon?: SpawnDaemon;
    /** Receives one line per daemon stderr record, for diagnostics. */
    onLog?: (line: string) => void;
}
/**
 * One plugin's daemon: spawns it lazily, keeps it for the plugin lifetime, serializes requests,
 * restarts it once on the call after an unexpected exit, and kills it on disposal.
 */
export declare class DaemonClient {
    private readonly options;
    private readonly spawnDaemon;
    private readonly pending;
    private readonly logTail;
    private child;
    private childAlive;
    private everStarted;
    private stdoutBuffer;
    private ready;
    private lastReady;
    private readyPromise;
    private readySettle;
    private nextId;
    private queue;
    private disposed;
    /**
     * @param options - interpreter, script, argv, deadline, and optional spawn/log seams.
     */
    constructor(options: DaemonClientOptions);
    /** Emotions reported by the daemon, or the last known list when no daemon is currently ready. */
    get emotions(): string[];
    /** The daemon's effective default emotion, or the last known one. */
    get defaultEmotion(): string;
    /** Engine the daemon reported, or `''` when no daemon has reported one yet. */
    get reportedEngine(): string;
    /** Trailing daemon stderr lines, oldest first; diagnostics only. */
    get logs(): string[];
    /**
     * Speak one utterance and resolve only after the daemon reports playback drained. Serialized
     * against every other call on this client, so the daemon never sees overlapping requests.
     * @param request - canonical segments plus the call-level playback options.
     * @param signal - caller cancellation; an aborted call kills the daemon.
     * @returns the drained utterance or the failure, never a throw.
     */
    speak(request: DaemonSpeakRequest, signal: AbortSignal): Promise<SpeakOutcome>;
    /**
     * Kill the daemon and settle every outstanding call. Idempotent; safe after an exit.
     */
    dispose(): Promise<void>;
    /** Serialize one operation behind every earlier one. */
    private enqueue;
    /** One serialized call: ensure a ready daemon, send the request, map the settlement. */
    private speakOnce;
    /**
     * Spawn the daemon and wait for its `ready` frame.
     * @param signal - caller cancellation.
     * @param deadline - the call's absolute deadline.
     * @returns `ok` with whether the daemon replaced an earlier one, or the startup failure message.
     */
    private startDaemon;
    /**
     * Send one request on the ready daemon and map its settlement. A transport failure here kills the
     * daemon and fails the call.
     * @param request - the utterance to send.
     * @param signal - caller cancellation.
     * @param deadline - the call's absolute deadline.
     * @param engineRestarted - whether this call started a daemon after a previous one exited.
     * @returns the drained utterance or the failure.
     */
    private callOnBackend;
    /** One failed outcome, with the engine known at settlement. */
    private errorOutcome;
    /** The engine this call ran on: the daemon's report, else the one this build ships. */
    private get engineName();
    /**
     * Spawn the daemon and wire its pipes; the caller either awaited readiness or abandoned it.
     */
    private spawnChild;
    /** Await the current child's `ready` frame. */
    private awaitReady;
    /** Send one request frame and await its terminal reply. */
    private send;
    /** Append one stdout chunk and handle every complete line. */
    private onStdout;
    /** Append one stderr chunk to the retained log tail. */
    private onStderr;
    /** Retain one diagnostic line and forward it to the configured log sink. */
    private recordLog;
    /** Route one decoded frame to the startup handshake or the matching pending request. */
    private onFrame;
    /** Mark the child dead and fail every outstanding call and the pending handshake. */
    private onExit;
    /** Fail the pending handshake when the child cannot start at all (a spawn failure). */
    private onChildError;
    /** Kill the current child after a transport failure, so a busy daemon cannot serve the next call. */
    private killDaemon;
    /** End one child with SIGKILL, tolerating an exit that raced the liveness check. */
    private killChild;
}
//# sourceMappingURL=daemon.d.ts.map