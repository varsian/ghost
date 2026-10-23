/**
 * @soullink-emotion/dsh-live2d-adapter
 *
 * DSH (DeepSeek Harness) glue on top of the soullink-emotion-sdk:
 *
 *   createSoullinkStage({ container, model, profileUrl?, cubismLoader?, config })
 *     -> { ready, speakStart, pushEnvelope, speakEnd, setEmotion,
 *          setVisible, setScale, setPosition, stats, dispose, debug }
 *
 * The returned stage renders a transparent Live2D canvas, drives the mouth from
 * a host-pushed RMS envelope (real TTS audio), and drives expressions / idle
 * motion from Chinese TTS emotion names through the engine VAD presets plus the
 * model's native `exp3` expressions.
 */
export { createSoullinkStage, estimateSpeechDuration } from "./stage";
export {
  DEFAULT_EMOTION_VARIANT,
  DEFAULT_NATIVE_EXPRESSION_MAP,
  DEFAULT_TTS_EMOTION_MAP,
  buildEmotionIntent,
  resolveNativeExpressionName,
  resolvePreset,
  resolveVAD,
  resolveVariant
} from "./emotion";
export { EnvelopeAudioLevelAnalyzer, buildMockEnvelope } from "./envelope";
export type {
  SoullinkEmotionState,
  SoullinkEnvelopeStats,
  SoullinkModelSpec,
  SoullinkNativeExpression,
  SoullinkNativeMotion,
  SoullinkSpeakStartOptions,
  SoullinkStage,
  SoullinkStageConfig,
  SoullinkStageDebug,
  SoullinkStageOptions,
  SoullinkStagePhase,
  SoullinkStageReadyInfo,
  SoullinkStageStats,
  SoullinkStageStatus
} from "./types";
