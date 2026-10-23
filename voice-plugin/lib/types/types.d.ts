/**
 * Wire and result types shared by the `tts` tool, its argument parser, its result renderer, and the
 * daemon client. The daemon's JSON Lines protocol is defined in `PROTOCOL.md`.
 * @module @deepseek-ai/dsh-tool-tts/types
 */
/** One canonical segment as sent to the daemon. */
export interface TtsSegment {
    /** Emotion label forwarded to the Live2D renderer (it never selects a different voice); omitted means the default label. */
    emotion?: string;
    /** Speakable text; non-empty after trimming. */
    content: string;
    /** Speech-rate multiplier for this segment; omitted means the tool-level `speed`. */
    speed?: number;
}
/** One model-supplied `segments` item: the canonical object or a flat-form string. */
export type TtsSegmentInput = TtsSegment | string;
/** A segment's reported emotion label, as returned in `speak_done.segments`. */
export interface TtsSegmentResult {
    /** Position of the segment in the request. */
    index: number;
    /** Emotion label the caller asked for. */
    requestedEmotion: string;
    /** Emotion label carried on the segment events (the requested label, or the default). */
    usedEmotion: string;
    /** Whether an unresolved request was replaced; always false for the single reference voice. */
    fallback: boolean;
    /** Audible seconds produced for this segment. */
    seconds: number;
    /** Sentences this segment was split into. */
    sentences: number;
}
/** One requested-to-used emotion-label substitution, as reported by the daemon. */
export interface TtsFallback {
    /** Emotion label the caller asked for. */
    requestedEmotion: string;
    /** Emotion label the daemon used instead. */
    usedEmotion: string;
}
/** Engine or transport failure carried by an `ok: false` tool result. */
export interface TtsErrorPayload {
    /** Daemon error code (`BAD_REQUEST`, `MODEL_LOAD_FAILED`, …) or `INTERNAL` for a transport failure. */
    code: string;
    /** Human-readable reason rendered into the failure text. */
    message: string;
}
/** Canonical `tts` tool result, validated by the declared output schema. */
export interface TtsResult {
    /** Whether audio was produced for every requested segment. */
    ok: boolean;
    /** Sum of audible audio seconds actually produced. */
    totalSeconds: number;
    /** Per-segment resolution and duration, in request order. */
    segments: TtsSegmentResult[];
    /** Available emotion labels at call time. */
    emotions: string[];
    /** The daemon's default emotion label. */
    defaultEmotion: string;
    /** Every requested emotion label that the daemon resolved differently. */
    fallbacks: TtsFallback[];
    /** Generation seconds divided by audio seconds for the whole call. */
    rtf: number;
    /** Wall milliseconds from `speak_start` to the first audible sample. */
    firstAudioMs: number;
    /** Milliseconds spent loading the model, non-zero only on the loading call. */
    modelLoadMs: number;
    /** Whether the model was already resident when this call started. */
    modelWasLoaded: boolean;
    /** WAV files produced for this call. */
    files: string[];
    /** Directory the produced WAV files were written to, when this call saved any. */
    savedTo?: string;
    /** Engine notes, e.g. an unsupported speed or a skipped empty segment. */
    notes: string[];
    /** Present exactly when `ok` is false. */
    error?: TtsErrorPayload;
    /** Whether this call ran on a daemon started after a previous daemon exited. */
    engineRestarted: boolean;
    /** Engine that served this call (`voxcpm`), as the daemon reported it. */
    backend: string;
}
/** One `speak` request as sent to the daemon. */
export interface DaemonSpeakRequest {
    /** Operation name. */
    op: 'speak';
    /** Canonical segments, in order. */
    segments: TtsSegment[];
    /** Play on this machine's speakers. */
    play: boolean;
    /** Write one WAV file per segment. */
    save: boolean;
    /** Requested save directory; empty means the daemon's configured/cache default. */
    saveDir: string;
    /** Silence between segments, in milliseconds. */
    gapMs: number;
    /** Default speech-rate multiplier for segments that do not set their own. */
    speed: number;
}
/** The daemon's `ready` event, emitted once per daemon process with id `null`. */
export interface DaemonReadyEvent {
    /** Daemon process id. */
    pid: number;
    /** Folder of the single reference voice scanned at startup. */
    voicesDir: string;
    /** Default emotion label. */
    defaultEmotion: string;
    /** Available emotion labels, normalized to names. */
    emotions: string[];
    /** Torch device the model loads onto. */
    device: string;
    /** Whether the model was loaded during startup (`--preload true`). */
    modelLoaded: boolean;
    /** Engine the daemon resolved and will serve calls with; empty when it does not report one. */
    engine: string;
}
/** The daemon's `speak_done` event, emitted after playback drained. */
export interface DaemonSpeakDoneEvent {
    /** Sum of audible audio seconds. */
    totalSeconds: number;
    /** Wall-clock milliseconds spent playing. */
    playedMs: number;
    /** Generation milliseconds for the whole call. */
    genMs: number;
    /** Generation seconds divided by audio seconds. */
    rtf: number;
    /** Wall milliseconds from `speak_start` to the first audible sample. */
    firstAudioMs: number;
    /** Milliseconds spent loading the model during this call. */
    modelLoadMs: number;
    /** Whether the model was resident when the call started. */
    modelWasLoaded: boolean;
    /** Per-segment resolution and duration. */
    segments: TtsSegmentResult[];
    /** WAV files produced by this call. */
    files: string[];
    /** Engine notes, when the daemon reports any. */
    notes: string[];
    /** Engine that served this call; empty when the daemon does not report one. */
    engine: string;
}
/** The daemon's `error` event: the call failed and the daemon stays alive. */
export interface DaemonErrorEvent {
    /** One of the daemon's error codes. */
    code: string;
    /** Human-readable reason. */
    message: string;
}
/** One parsed daemon JSON Lines event. */
export type DaemonEvent = {
    kind: 'ready';
    ready: DaemonReadyEvent;
} | {
    kind: 'speak_done';
    done: DaemonSpeakDoneEvent;
} | {
    kind: 'speak_start';
    modelWasLoaded: boolean;
} | {
    kind: 'error';
    error: DaemonErrorEvent;
} | {
    kind: 'other';
    event: string;
};
/** Outcome of one `speak` operation: a drained utterance or a failure, never a throw. */
export type SpeakOutcome = {
    kind: 'done';
    /** Whether this call ran on a daemon spawned after a previous daemon exited. */
    engineRestarted: boolean;
    /** Emotion labels known at settlement (this daemon's, or the last known list). */
    emotions: string[];
    /** Default emotion label known at settlement. */
    defaultEmotion: string;
    /** Engine known at settlement: the daemon's report, or `voxcpm` before any report. */
    backend: string;
    /** The drained utterance. */
    done: DaemonSpeakDoneEvent;
} | {
    kind: 'error';
    /** Whether this call ran on a daemon spawned after a previous daemon exited. */
    engineRestarted: boolean;
    /** Emotion labels known at settlement; empty when no daemon ever reported any. */
    emotions: string[];
    /** Default emotion label known at settlement. */
    defaultEmotion: string;
    /** Engine known at settlement: the daemon's report, or `voxcpm` before any report. */
    backend: string;
    /** The failure. */
    error: TtsErrorPayload;
};
//# sourceMappingURL=types.d.ts.map