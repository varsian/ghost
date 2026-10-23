/**
 * `tts` argument parsing: turns the two model-facing `segments` forms into canonical segments and
 * validates every value the parameter schema cannot constrain (empty content, pair counts, ranges).
 * Invalid arguments throw, so the model sees a tool error instead of a silently altered utterance.
 * @module @deepseek-ai/dsh-tool-tts/args
 */
/** Default silence between segments, fixed by the tool contract (PROTOCOL.md §8). */
export const DEFAULT_GAP_MS = 120;
/** Default speech-rate multiplier, fixed by the tool contract (PROTOCOL.md §8). */
export const DEFAULT_SPEED = 1;
/** Reject one argument with the shared prefix the tool's error text uses. */
function invalid(reason) {
    throw new Error(`invalid tts arguments: ${reason}`);
}
/** Fail unless `value` is a finite number greater than zero. */
function requirePositiveNumber(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        invalid(`\`${field}\` must be a positive number, got ${JSON.stringify(value)}`);
    }
    return value;
}
/**
 * Normalize one string item's trim-non-empty form.
 * @param value - the raw string field.
 * @param field - field name for the error message.
 * @returns the trimmed value.
 */
function requireText(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        invalid(`\`${field}\` must be a non-empty string, got ${JSON.stringify(value)}`);
    }
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
    if (typeof value !== 'string')
        invalid(`\`${field}\` must be a string, got ${JSON.stringify(value)}`);
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/**
 * Validate one canonical object item and drop its empty optional fields, so the daemon receives
 * only the fields the model actually set (an absent emotion means the daemon's default emotion,
 * which must not be rewritten into a requested emotion).
 * @param item - the model-supplied object item.
 * @param position - the item's index in `segments`, for the error message.
 * @returns the canonical segment.
 */
function parseObjectSegment(item, position) {
    const record = item;
    const content = requireText(record.content, `segments[${position}].content`);
    const segment = { content };
    if (record.emotion !== undefined) {
        const emotion = optionalText(record.emotion, `segments[${position}].emotion`);
        if (emotion !== undefined)
            segment.emotion = emotion;
    }
    if (record.speed !== undefined) {
        segment.speed = requirePositiveNumber(record.speed, `segments[${position}].speed`);
    }
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
export function parseTtsArgs(args) {
    // Model arguments are a JSON boundary: the registry's schema admitted their declared types, and
    // every semantic rule below reads them as unknown so a malformed item is a thrown error.
    const raw = args.segments;
    if (!Array.isArray(raw))
        invalid('`segments` must be an array');
    if (raw.length === 0)
        invalid('`segments` must contain at least one segment');
    const items = raw;
    const segments = [];
    let pendingEmotion;
    for (const [position, item] of items.entries()) {
        if (typeof item === 'string') {
            if (pendingEmotion === undefined) {
                pendingEmotion = requireText(item, `segments[${position}]`);
            }
            else {
                segments.push({ emotion: pendingEmotion, content: requireText(item, `segments[${position}]`) });
                pendingEmotion = undefined;
            }
            continue;
        }
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            invalid(`\`segments[${position}]\` must be an object or a string, got ${JSON.stringify(item)}`);
        }
        segments.push(parseObjectSegment(item, position));
    }
    if (pendingEmotion !== undefined) {
        invalid(`\`segments\` ends with the emotion ${JSON.stringify(pendingEmotion)} without its content;`
            + ' the flat string form is emotion, content, emotion, content, …');
    }
    const play = args.play ?? true;
    if (typeof play !== 'boolean')
        invalid(`\`play\` must be a boolean, got ${JSON.stringify(play)}`);
    const gapMs = args.gap_ms ?? DEFAULT_GAP_MS;
    if (typeof gapMs !== 'number' || !Number.isInteger(gapMs) || gapMs < 0) {
        invalid(`\`gap_ms\` must be a non-negative integer, got ${JSON.stringify(gapMs)}`);
    }
    const speed = args.speed ?? DEFAULT_SPEED;
    requirePositiveNumber(speed, 'speed');
    const saveDir = args.save_dir?.trim() === '' ? undefined : args.save_dir;
    return { segments, play, saveDir, gapMs, speed };
}
//# sourceMappingURL=args.js.map