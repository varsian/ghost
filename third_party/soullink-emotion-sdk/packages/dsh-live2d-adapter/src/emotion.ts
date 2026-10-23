import type { EmotionIntent, VADVector } from "@soullink-emotion/engine";
import { getVADPreset } from "@soullink-emotion/engine";

/**
 * Default mapping of the Chinese TTS emotion names (current TTS sound presets:
 * 默认 / 亲切 / 强调 / 否认, plus common extras) onto engine VAD presets.
 * Hosts can override any entry through `config.emotionMap`.
 */
export const DEFAULT_TTS_EMOTION_MAP: Record<string, string> = {
  默认: "neutral",
  中性: "neutral",
  平静: "calm",
  亲切: "affectionate",
  亲昵: "affectionate",
  温柔: "affectionate",
  强调: "excited",
  刻意强调: "excited",
  否认: "confused",
  否定: "confused",
  反驳: "confused",
  开心: "happy",
  高兴: "happy",
  兴奋: "excited",
  害羞: "shy",
  脸红: "shy",
  好奇: "curious",
  困惑: "confused",
  疑惑: "confused",
  疲惫: "tired",
  累了: "tired",
  难过: "sad",
  悲伤: "sad",
  伤心: "sad",
  焦虑: "anxiety",
  紧张: "anxiety",
  愤怒: "anger",
  生气: "angry",
  恼火: "angry",
  关切: "concerned",
  关心: "concerned",
  惊讶: "surprised",
  吃惊: "surprised",
  无奈: "tired",
  嫌弃: "angry"
};

/** Engine preset -> engine expression variant (mirrors the SDK demo controls). */
export const DEFAULT_EMOTION_VARIANT: Record<string, string> = {
  neutral: "neutral_ack",
  calm: "soft_calm",
  happy: "bright_smile",
  excited: "sparkle",
  shy: "bashful",
  affectionate: "warm",
  curious: "tilt",
  confused: "confused",
  tired: "drained",
  sad: "downcast",
  anxiety: "nervous",
  anger: "firm",
  angry: "annoyed",
  concerned: "soft_concern",
  surprised: "startled"
};

/**
 * Engine preset -> native Cubism expression name for the DS-Whale-Girl model.
 * The generated profile already contributes its heuristic `expressionMap`
 * (affectionate→爱心眼, sad→悲伤, excited→开心兴奋, shy→脸红); this table fills
 * in the remaining presets so every TTS emotion can play an `exp3` file by its
 * Chinese name. Resolved names are validated against the model's expression
 * catalog before use, so a missing name is simply ignored.
 */
export const DEFAULT_NATIVE_EXPRESSION_MAP: Record<string, string> = {
  affectionate: "爱心眼",
  shy: "脸红",
  sad: "悲伤",
  happy: "开心兴奋",
  excited: "开心兴奋",
  angry: "生气",
  anger: "生气",
  surprised: "感叹号",
  confused: "问号",
  anxiety: "流汗",
  tired: "闭眼口水"
};

export function resolvePreset(
  name: string,
  emotionMap: Record<string, string> = DEFAULT_TTS_EMOTION_MAP
): string | null {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "neutral";
  // Mapped presets are validated: a stale/invalid manifest entry falls back to
  // the built-in defaults instead of poisoning the engine state.
  const mapped = emotionMap[trimmed];
  if (mapped && KNOWN_PRESETS.has(mapped)) return mapped;
  // Native Chinese expression name used directly (e.g. setEmotion("生气")).
  if (DEFAULT_TTS_EMOTION_MAP[trimmed]) return DEFAULT_TTS_EMOTION_MAP[trimmed];
  // Already an engine preset?
  if (KNOWN_PRESETS.has(trimmed)) return trimmed;
  return null;
}

const KNOWN_PRESETS = new Set([
  "neutral",
  "calm",
  "happy",
  "excited",
  "shy",
  "affectionate",
  "curious",
  "confused",
  "tired",
  "sad",
  "anxiety",
  "anger",
  "angry",
  "concerned",
  "surprised"
]);

export function resolveVariant(preset: string | null): string | undefined {
  if (!preset) return undefined;
  return DEFAULT_EMOTION_VARIANT[preset];
}

export function resolveVAD(preset: string | null, variant?: string): VADVector | null {
  if (!preset) return null;
  return getVADPreset(preset, variant);
}

export function buildEmotionIntent(options: {
  preset: string | null;
  variant?: string;
  intensity: number;
  text?: string;
}): EmotionIntent {
  const preset = options.preset ?? "neutral";
  return {
    emotion: preset,
    variant: resolveVariant(preset),
    intensity: clamp(options.intensity, 0, 1),
    contextTags: ["tts_segment"],
    sourceMessage: options.text
  };
}

/**
 * Resolve the native expression name to play for a requested emotion.
 * Precedence: explicit override (requested name or engine preset) -> profile
 * expressionMap (generated heuristics) -> adapter defaults -> direct catalog hit.
 */
export function resolveNativeExpressionName(options: {
  requested: string;
  preset: string | null;
  expressionMap?: Record<string, string>;
  profileExpressionMap?: Record<string, unknown>;
  catalog: ReadonlySet<string>;
}): string | null {
  const { requested, preset, expressionMap, profileExpressionMap, catalog } = options;
  if (catalog.size === 0) return null;
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
  };

  push(expressionMap?.[requested]);
  if (preset) push(expressionMap?.[preset]);

  const profileEntry = (key: string): unknown => profileExpressionMap?.[key];
  if (preset) {
    const entry = profileEntry(preset);
    push(typeof entry === "string" ? entry : (entry as { expression?: string } | undefined)?.expression);
  }
  const direct = profileEntry(requested);
  push(typeof direct === "string" ? direct : (direct as { expression?: string } | undefined)?.expression);

  push(DEFAULT_NATIVE_EXPRESSION_MAP[requested]);
  if (preset) push(DEFAULT_NATIVE_EXPRESSION_MAP[preset]);
  push(requested);

  for (const candidate of candidates) {
    if (catalog.has(candidate)) return candidate;
  }
  // Last resort: unique substring match (e.g. "爱心" -> "爱心眼").
  for (const candidate of candidates) {
    if (candidate.length < 2) continue;
    const hits = [...catalog].filter((name) => name.includes(candidate) || candidate.includes(name));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
