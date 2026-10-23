/**
 * `tts` result rendering: the exact success and failure text the model reads, including the fallback
 * sentence and the `(a,b,c)` list of usable emotions that lets the model correct an unknown emotion.
 * @module @deepseek-ai/dsh-tool-tts/result
 */
/**
 * Render the `(a,b,c)` emotion list every result carries.
 * @param emotions - usable emotions, in the daemon's order.
 * @returns the parenthesized comma-joined list, or `(未知)` when no daemon ever reported one.
 */
export function emotionListText(emotions) {
    return emotions.length === 0 ? '(未知)' : `(${emotions.join(',')})`;
}
/**
 * Collect the requested-to-used emotion substitutions worth reporting: exactly one entry per
 * distinct emotion the daemon resolved to something else, in first-requested order. A segment
 * without a requested emotion resolved by default rather than by correction, so it is not a
 * fallback the model needs told about.
 * @param segments - the daemon's per-segment results.
 * @returns one distinct substitution per unresolved request.
 */
export function fallbacksOf(segments) {
    const fallbacks = [];
    const seen = new Set();
    for (const segment of segments) {
        if (!segment.fallback || segment.requestedEmotion === '' || segment.requestedEmotion === segment.usedEmotion)
            continue;
        if (seen.has(segment.requestedEmotion))
            continue;
        seen.add(segment.requestedEmotion);
        fallbacks.push({ requestedEmotion: segment.requestedEmotion, usedEmotion: segment.usedEmotion });
    }
    return fallbacks;
}
/** The trailing sentence shared by the success and failure texts. */
const EMOTION_GUIDANCE = ' —— 请只使用列表中的情绪。';
/**
 * Render one successful call exactly as `PROTOCOL.md` §8 specifies: totals, the emotions used with
 * any substitution sentence, then the usable-emotion list.
 * @param result - a validated `ok: true` result.
 * @param listMode - `always` (default) repeats the usable list every call; `onFallback` repeats it
 *   only when an emotion was substituted.
 * @returns the multi-line model-facing text.
 */
export function renderSuccessText(result, listMode = 'always') {
    const sentences = result.segments.reduce((total, segment) => total + segment.sentences, 0);
    const lines = [
        `tts 成功：共 ${result.totalSeconds.toFixed(2)}s（${result.segments.length} 段 / ${sentences} 句），`
            + `实时率 ${result.rtf.toFixed(2)}。`,
    ];
    const used = [...new Set(result.segments.map(segment => segment.usedEmotion))];
    if (used.length > 0) {
        const substitutions = result.fallbacks
            .map(fallback => `情绪「${fallback.requestedEmotion}」不在可用列表中，`
            + `已改用默认情绪「${fallback.usedEmotion}」。`)
            .join('');
        lines.push(`使用情绪：${used.join('、')}。${substitutions}`);
    }
    if (listMode === 'always' || result.fallbacks.length > 0) {
        lines.push(`可用情绪列表：${emotionListText(result.emotions)}${EMOTION_GUIDANCE}`);
    }
    return lines.join('\n');
}
/**
 * Render one failed call exactly as `PROTOCOL.md` §8 specifies: the reason, then the usable-emotion
 * list so an unknown emotion is corrected on the next call.
 * @param reason - the failure message (or the error code when the daemon sent no message).
 * @param emotions - usable emotions known at settlement.
 * @returns the two-line model-facing text.
 */
export function renderFailureText(reason, emotions) {
    const trimmed = reason.trim();
    const withoutStop = /[。.]$/.test(trimmed) ? trimmed.slice(0, -1) : trimmed;
    const body = withoutStop.length === 0 ? '未知错误' : withoutStop;
    return `tts 失败：${body}。\n可用情绪列表：${emotionListText(emotions)}${EMOTION_GUIDANCE}`;
}
//# sourceMappingURL=result.js.map