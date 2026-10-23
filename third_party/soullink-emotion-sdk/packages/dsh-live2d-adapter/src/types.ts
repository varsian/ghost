import type { AudioLevelAnalyzer, ModelProfile, RuntimeSnapshot } from "@soullink-emotion/engine";
import type { Live2DRenderer } from "@soullink-emotion/live2d-pixi";

/** A native Cubism expression (`.exp3.json`) discovered for this model. */
export interface SoullinkNativeExpression {
  /** Expression name as registered in the model3 parent (Chinese names for the DS-Whale-Girl model). */
  name: string;
  /** File path relative to the model3 file. */
  file: string;
}

/** A native Cubism motion (`.motion3.json`) discovered for this model. */
export interface SoullinkNativeMotion {
  group: string;
  index: number;
  file: string;
}

/**
 * Model description handed to {@link createSoullinkStage}. All paths are
 * resolved relative to `baseUrl`, so the host can move the plugin assets
 * without regenerating the profile (e.g. `baseUrl: "/assets/models/ds-whale-girl"`).
 */
export interface SoullinkModelSpec {
  /** Directory URL of the model (relative to the page or absolute). */
  baseUrl: string;
  /** Model3 file name inside `baseUrl`, e.g. `"c_0120.model3.json"`. */
  modelFile: string;
  /** Optional explicit profile URL; defaults to `<baseUrl>/soullink.profile.json`. */
  profileUrl?: string;
  /** Optional pre-parsed profile (skips the network fetch). */
  profile?: ModelProfile;
  /** Native expressions (normally read from `live2d.manifest.json`). */
  expressions?: SoullinkNativeExpression[];
  /** Native motions (normally read from `live2d.manifest.json`). */
  motions?: SoullinkNativeMotion[];
  /**
   * Cubism part ids that are forced invisible on every frame (desk scene,
   * mouse pad, keyboard, phone, omurice, menu board, gamepad, bubble-gum, ...).
   * Keep the array in `live2d.manifest.json` / the plugin model manifest.
   */
  hiddenParts?: string[];
  /** Human readable part names, kept for diagnostics/acceptance. */
  hiddenPartNames?: string[];
  /** Chinese TTS emotion name -> engine preset override (merged over defaults). */
  emotionMap?: Record<string, string>;
  /** Emotion/preset name -> native expression name override (merged over profile.expressionMap). */
  expressionMap?: Record<string, string>;
}

/** Optional runtime configuration for {@link createSoullinkStage}. */
export interface SoullinkStageConfig {
  /** Render frame cap (default 30). */
  fps?: number;
  /** Optional canvas cap; only applied when the container has no size yet. */
  maxWidth?: number;
  maxHeight?: number;
  /** Cap for devicePixelRatio (default 1 for the DSH overlay). */
  devicePixelRatioCap?: number;
  /** URL of `live2dcubismcore.min.js`. Required unless the page already defines `window.Live2DCubismCore`. */
  coreUrl?: string;
  /** Multiplier applied to the measured envelope RMS before it drives the mouth. */
  lipSyncGain?: number;
  /** Global FACS parameter gain (engine `setParameterGain`). */
  parameterGain?: number;
  /** Body/head motion gain (engine `setBodyMotionGain`). */
  bodyMotionGain?: number;
  /** Envelope smoothing hint in seconds (kept for API compatibility). */
  lipSyncSmoothing?: number;
  /** Maximum real-time envelope backlog before old frames are dropped (default 500ms). */
  envelopeMaxBacklogMs?: number;
  /** Pre-fetch the native expression files after ready (default true). */
  expressionPreload?: boolean;
  /** Enable the engine idle layer (default true). */
  idle?: boolean;
  /** Overrides `model.hiddenParts`. */
  hiddenParts?: string[];
  /** Chinese TTS emotion name -> engine preset override (overrides `model.emotionMap`). */
  emotionMap?: Record<string, string>;
  /** Emotion/preset name -> native expression name override (overrides `model.expressionMap`). */
  expressionMap?: Record<string, string>;
  /** Deterministic expression reset (default true for the DSH overlay). */
  randomExpressionOnReset?: boolean;
  /** Keep the WebGL buffer readable for screenshot self-tests (default false). */
  preserveDrawingBuffer?: boolean;
  /**
   * Speech-performance tuning (SpeechPerformancePlanner).
   *
   * The planner's own amplitude chain is `contribution × energyScale ×
   * maxGestureAmplitude × gestureAmplitudeGain` (channelScales can only reduce).
   * `gestureAmplitudeGain` is the intended "how big are the talking gestures"
   * knob; the SDK allows 0..2.6 (default 1). 1.8–2.2 reads as an animated talker.
   */
  gestureAmplitudeGain?: number;
  /** Max gestures per planned block (SDK default 4; planner caps at 3 per block). */
  gestureLimit?: number;
  /** Fraction of the segment length the planned gestures may occupy (default 1). */
  motionDensity?: number;
  /** Minimum rest between two planned gestures in ms (default 0). */
  minRestWindowMs?: number;
  /** Planner confidence 0..1: raises gesture energy (default 0.95). */
  speechGestureConfidence?: number;
  /** Default emotion intensity for TTS-driven speech (default 1). */
  speechIntensity?: number;
  /** Debug logger. */
  log?: (...args: unknown[]) => void;
}

export type SoullinkStagePhase = "loading" | "ready" | "error" | "disposed";

export interface SoullinkStageStatus {
  phase: SoullinkStagePhase;
  message?: string;
  error?: Error;
}

export interface SoullinkEmotionState {
  /** Emotion name as requested by the TTS bridge (Chinese, or an engine preset). */
  requested: string | null;
  /** Mapped engine preset (`neutral`, `affectionate`, ...). */
  preset: string | null;
  /** Native expression that is being played, if any. */
  nativeExpression: string | null;
  intensity: number;
}

export interface SoullinkEnvelopeStats {
  pendingFrames: number;
  hopMs: number;
  level: number;
  peak: number;
  active: boolean;
  speechActive: boolean;
  /** Frames discarded because the renderer was paused and the queue exceeded its budget. */
  droppedFrames: number;
  /** Number of hard resyncs (occlusion/minimise/long frame gap). */
  flushCount: number;
  /** Wall clock of the latest flush (0 = never). */
  lastFlushAt: number;
}

export interface SoullinkStageStats {
  backend: "soullink";
  ready: boolean;
  fps: number;
  frameCount: number;
  state: string;
  emotion: SoullinkEmotionState;
  vad: { valence: number; arousal: number; dominance: number } | null;
  /** Current mouth open parameter value (0..1). */
  mouth: number;
  nativeExpression: string | null;
  envelope: SoullinkEnvelopeStats;
  hiddenParts: string[];
  missingParameters: string[];
  canvas: {
    canvasWidth: number;
    canvasHeight: number;
    resolution: number;
    hiddenParts: number;
    suppressedParams: number;
    expressionOverlayParams: number;
  } | null;
  runtimeTimeSeconds: number;
  modelUrl: string | null;
  /** Latest frame gap observed by the render loop (ms). */
  frameGapMs: number;
  /** Number of gap-driven envelope flushes. */
  frameGaps: number;
  /** Native expressions pre-fetched after ready. */
  expressionsPreloaded: number;
  /** Emotion switching counters (used by acceptance: idle must not grow). */
  emotionSwitch: {
    fullIntent: number;
    smooth: number;
    skipped: number;
  };
}

export interface SoullinkSpeakStartOptions {
  /** Chinese TTS emotion name (`默认`, `亲切`, `强调`, `否认`, ...) or an engine preset. */
  emotion?: string;
  /** Segment text (used for an estimated speech duration and debug output). */
  text?: string;
  /** 0..1 intensity used for the engine intent and for the native expression overlay. */
  intensity?: number;
  /**
   * Estimated duration of the **whole utterance** in seconds. Keeps the engine in
   * SPEAKING until the audio really ends (defaults to a text-length estimate).
   */
  durationSeconds?: number;
  /** Estimated duration of the first segment's gesture plan in ms (defaults to a text estimate). */
  durationMs?: number;
}

/** One following TTS segment inside an already-running utterance. */
export interface SoullinkSpeakSegmentOptions {
  /** Chinese TTS emotion name for this segment. */
  emotion?: string;
  /** Segment text (used for the gesture plan duration and debug output). */
  text?: string;
  /** 0..1 intensity for the emotion / native expression. */
  intensity?: number;
  /** Gesture-plan duration in ms (defaults to a text-length estimate). */
  durationMs?: number;
}

/** Public surface returned by {@link createSoullinkStage}. */
export interface SoullinkStage {
  /** Resolves once profile + model are loaded and the render loop is running. */
  ready: Promise<SoullinkStageReadyInfo>;
  /** Maps a TTS emotion name (Chinese) or engine preset to the engine + native expression. */
  setEmotion(name: string, intensity?: number, options?: { smooth?: boolean }): void;
  /** Starts a speech segment: triggers the emotion and enables measured lip-sync. */
  speakStart(options?: SoullinkSpeakStartOptions): void;
  /**
   * Applies the next TTS segment of the running utterance: switches the emotion
   * (native expression + VAD) and appends a planned gesture block to the
   * speech-performance queue. A mid-utterance switch never resets the engine
   * state machine (no LISTENING transition, no queue replay).
   */
  speakSegment(options?: SoullinkSpeakSegmentOptions): void;
  /**
   * Enqueues a chunk of 0..1 RMS envelope frames. Chunks are consumed on the
   * render clock at `hopMs` per frame (default 20ms), matching the TTS shim.
   */
  pushEnvelope(frames: readonly number[], hopMs?: number): void;
  /** Ends the current speech segment (envelope drains, lip-sync falls back to the engine). */
  speakEnd(): void;
  /**
   * Re-arms the render loop and drops stale envelope frames after the window was
   * occluded/minimised (rAF stops without losing the event loop). Safe to call
   * while already running.
   */
  resume(): void;
  setVisible(visible: boolean): void;
  setScale(scale: number): void;
  setPosition(anchor?: string, offsetX?: number, offsetY?: number): void;
  stats(): SoullinkStageStats;
  dispose(): void;
  /** Escape hatch for the host verification page (renderer/runtime/snapshot). */
  readonly debug: SoullinkStageDebug;
}

export interface SoullinkStageReadyInfo {
  profile: ModelProfile;
  modelUrl: string;
  profileUrl: string;
  expressions: SoullinkNativeExpression[];
  motions: SoullinkNativeMotion[];
  hiddenParts: string[];
  parameterCount: number;
}

export interface SoullinkStageDebug {
  renderer: Live2DRenderer | null;
  runtime: unknown;
  analyzer: AudioLevelAnalyzer | null;
  getSnapshot(): RuntimeSnapshot | null;
  getPartOpacities(): Record<string, number>;
  getCanvas(): HTMLCanvasElement | null;
  getVisibleParts(): Array<{ id: string; opacity: number }>;
}

export interface SoullinkStageOptions {
  container: HTMLElement;
  model: SoullinkModelSpec;
  config?: SoullinkStageConfig;
  onStatus?: (status: SoullinkStageStatus) => void;
}
