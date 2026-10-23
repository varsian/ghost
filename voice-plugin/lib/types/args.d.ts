/**
 * `tts` argument parsing: turns the two model-facing `segments` forms into canonical segments and
 * validates every value the parameter schema cannot constrain (empty content, pair counts, ranges).
 * Invalid arguments throw, so the model sees a tool error instead of a silently altered utterance.
 * @module @deepseek-ai/dsh-tool-tts/args
 */
import type { TtsSegment, TtsSegmentInput } from './types.ts';
/** Default silence between segments, fixed by the tool contract (PROTOCOL.md §8). */
export declare const DEFAULT_GAP_MS = 120;
/** Default speech-rate multiplier, fixed by the tool contract (PROTOCOL.md §8). */
export declare const DEFAULT_SPEED = 1;
/** The model-facing `tts` arguments after the registry validated their types. */
export interface TtsArgs {
    /** The utterance, in either the canonical object form or the flat alternating string form. */
    segments: TtsSegmentInput[];
    /** Play on this machine's speakers; `false` saves WAV files only. */
    play?: boolean;
    /** Directory for the produced WAV files; an empty or blank value means "not provided". */
    save_dir?: string;
    /** Silence between segments in milliseconds. */
    gap_ms?: number;
    /** Default speech-rate multiplier for segments that do not set their own. */
    speed?: number;
}
/** {@link TtsArgs} after validation and defaulting. */
export interface ParsedTtsArgs {
    /** Canonical segments, in request order. */
    segments: TtsSegment[];
    /** Whether to play on this machine's speakers. */
    play: boolean;
    /** Requested save directory, or `undefined` when the call did not ask to save. */
    saveDir: string | undefined;
    /** Silence between segments in milliseconds. */
    gapMs: number;
    /** Default speech-rate multiplier for segments without their own. */
    speed: number;
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
export declare function parseTtsArgs(args: TtsArgs): ParsedTtsArgs;
//# sourceMappingURL=args.d.ts.map