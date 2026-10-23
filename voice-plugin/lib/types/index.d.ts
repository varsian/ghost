/**
 * Model-facing `tts` tool: speaks text through a locally resident VoxCPM 1.5 daemon and resolves only
 * after the audio has finished playing. The engine clones one installed reference voice; every call
 * that runs reports the available emotion labels, which are forwarded as expression labels and never
 * choose a different voice. Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-tts
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "tool-tts";
export declare const inject: string[];
/** Environment-declared options for the `tts` tool. */
export interface Config {
    /** Python interpreter that runs the daemon, e.g. `…\dsh-tts-runtime\.venv\Scripts\python.exe`. */
    pythonPath: string;
    /** Entry script of the daemon; defaults to the `python\tts_daemon.py` shipped in this package. */
    daemonScript?: string;
    /** Folder holding the one reference voice: one audio file plus its same-stem `.txt` transcript. */
    voicesDir: string;
    /** Default emotion label (default `默认`): reported when a segment requests none. It is a label only. */
    defaultEmotion?: string;
    /** Directory of the VoxCPM 1.5 model weights. */
    modelDir: string;
    /**
     * Device the engine runs on, as `cuda:N` (default `cuda:0`). VoxCPM 1.5's constructor takes no
     * device argument, so the daemon applies this to the process's current CUDA device before
     * loading; any other value fails the load.
     */
    device?: string;
    /** Classifier-free guidance scale the engine samples with (default 2.7, valid 0.1–10). */
    cfgValue?: number;
    /** Diffusion steps per generation (default 10, valid 1–100); fewer steps are faster and coarser. */
    inferenceTimesteps?: number;
    /**
     * Compile the engine with `torch.compile` (default false). Without Triton — the case on Windows —
     * compilation is skipped with a warning, and the engine still pays the constructor's warm-up
     * generation either way.
     */
    optimize?: boolean;
    /** Expand numbers and abbreviations through the engine's text normalizer (default false). */
    normalizeText?: boolean;
    /** Cache directory for the default WAV output. */
    cacheDir: string;
    /** Daemon-level WAV output directory (default empty, meaning `<cacheDir>\wav`). */
    saveDir?: string;
    /** Sentence split threshold passed to the daemon (default 60). */
    maxSentenceChars?: number;
    /**
     * First-sentence character cap passed to the daemon (default 20). Only the non-streaming backends
     * apply it; the streaming backend splits a segment without a first-sentence cap. The daemon's own
     * flag accepts `0` to disable the cap, but this field requires a positive value (the same
     * discipline as `maxSentenceChars`), so a composition cannot silently drop the latency guard.
     */
    firstSentenceMaxChars?: number;
    /** Seconds of idleness after which the daemon unloads the model; `0` disables unloading (default 1800). */
    idleUnloadSec?: number;
    /** Load the model during daemon startup instead of on the first `speak` (default false). */
    preload?: boolean;
    /** Output device name for the daemon's audio backend; empty means the system default. */
    outputDevice?: string;
    /**
     * How adjacent short sentences inside one segment become one generation unit. `short` (default)
     * appends a sentence of at most `shortSentenceChars` to the previous unit, `all` merges while the
     * character bound holds, and `off` restores one generation per sentence. Merging never crosses a
     * segment, and it is what keeps consecutive short utterances in one acoustic context instead of
     * sampling a fresh timbre per sentence.
     */
    mergeSentences?: 'off' | 'short' | 'all';
    /** Character bound one merged generation unit may reach; `0` uses `maxSentenceChars` (default 0). */
    mergeMaxChars?: number;
    /** Under `short` merging, the longest sentence that may join the previous unit (default 20). */
    shortSentenceChars?: number;
    /**
     * `>0` reseeds torch before every generation (default 0 = leave the model's own sampling).
     * A fixed seed makes the same text reproducible; it does NOT make different short sentences
     * share a timbre, so it is a debugging aid rather than the consistency fix.
     */
    samplingSeed?: number;
    /**
     * Whether every successful result repeats the available emotion-label list. `always` (default)
     * keeps a model that lost the list correctable at any point; `onFallback` repeats it only when a
     * label was resolved differently, which shortens routine results (failures always carry the list).
     */
    emotionListInResults?: 'always' | 'onFallback';
    /** Per-call deadline in milliseconds, covering lazy daemon startup and the whole utterance (default 600000). */
    toolTimeoutMs?: number;
}
/** Schemastery configuration for the `tts` tool. */
export declare const Config: z<Config>;
/**
 * Register the `tts` tool on `ctx.tools` and own one daemon for this plugin's lifetime.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment paths, engine options, and the per-call deadline.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map
