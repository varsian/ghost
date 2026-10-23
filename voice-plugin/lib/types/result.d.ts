/**
 * `tts` result rendering: the exact success and failure text the model reads, including the fallback
 * sentence and the `(a,b,c)` list of usable emotions that lets the model correct an unknown emotion.
 * @module @deepseek-ai/dsh-tool-tts/result
 */
import type { TtsFallback, TtsResult, TtsSegmentResult } from './types.ts';
/**
 * Render the `(a,b,c)` emotion list every result carries.
 * @param emotions - usable emotions, in the daemon's order.
 * @returns the parenthesized comma-joined list, or `(未知)` when no daemon ever reported one.
 */
export declare function emotionListText(emotions: readonly string[]): string;
/**
 * Collect the requested-to-used emotion substitutions worth reporting: exactly one entry per
 * distinct emotion the daemon resolved to something else, in first-requested order. A segment
 * without a requested emotion resolved by default rather than by correction, so it is not a
 * fallback the model needs told about.
 * @param segments - the daemon's per-segment results.
 * @returns one distinct substitution per unresolved request.
 */
export declare function fallbacksOf(segments: readonly TtsSegmentResult[]): TtsFallback[];
/** When a successful result repeats the usable-emotion list. */
export type EmotionListMode = 'always' | 'onFallback';
/**
 * Render one successful call exactly as `PROTOCOL.md` §8 specifies: totals, the emotions used with
 * any substitution sentence, then the usable-emotion list.
 * @param result - a validated `ok: true` result.
 * @param listMode - `always` (default) repeats the usable list every call; `onFallback` repeats it
 *   only when an emotion was substituted.
 * @returns the multi-line model-facing text.
 */
export declare function renderSuccessText(result: TtsResult, listMode?: EmotionListMode): string;
/**
 * Render one failed call exactly as `PROTOCOL.md` §8 specifies: the reason, then the usable-emotion
 * list so an unknown emotion is corrected on the next call.
 * @param reason - the failure message (or the error code when the daemon sent no message).
 * @param emotions - usable emotions known at settlement.
 * @returns the two-line model-facing text.
 */
export declare function renderFailureText(reason: string, emotions: readonly string[]): string;
//# sourceMappingURL=result.d.ts.map