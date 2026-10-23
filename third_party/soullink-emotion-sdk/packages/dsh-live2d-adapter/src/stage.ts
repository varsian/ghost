import type {
  AudioLevelAnalyzer,
  ModelProfile,
  RuntimeSnapshot,
  SpeechPerformanceCapabilities,
  SpeechPerformancePlan
} from "@soullink-emotion/engine";
import {
  SoullinkRuntime,
  SpeechPerformancePlanner,
  createSpeechPerformanceSeed,
  deriveSpeechPerformanceCapabilities
} from "@soullink-emotion/engine";
import type { ExpressionOverlayEntry } from "@soullink-emotion/live2d-pixi";
import { Live2DRenderer } from "@soullink-emotion/live2d-pixi";
import {
  DEFAULT_EMOTION_VARIANT,
  DEFAULT_TTS_EMOTION_MAP,
  buildEmotionIntent,
  clamp,
  resolveNativeExpressionName,
  resolvePreset,
  resolveVAD,
  resolveVariant
} from "./emotion";
import { EnvelopeAudioLevelAnalyzer } from "./envelope";
import type {
  SoullinkEmotionState,
  SoullinkModelSpec,
  SoullinkNativeExpression,
  SoullinkNativeMotion,
  SoullinkSpeakSegmentOptions,
  SoullinkSpeakStartOptions,
  SoullinkStage,
  SoullinkStageConfig,
  SoullinkStageDebug,
  SoullinkStageOptions,
  SoullinkStageReadyInfo,
  SoullinkStageStats,
  SoullinkStageStatus
} from "./types";

const GLOBAL_KEY = "__DSH_SOULLINK_STAGE__";
const DEFAULT_FPS = 30;
const IDLE_STATES = new Set(["IDLE", "RECOVERING"]);

interface ActiveExpression {
  name: string;
  overlay: ExpressionOverlayEntry[];
  weight: number;
  target: number;
}

/**
 * Creates the DSH Live2D stage: a transparent Pixi canvas that renders a
 * Soullink-driven Live2D model, lips-synced from a pushed RMS envelope and
 * emotionally driven by Chinese TTS emotion names.
 *
 * Everything is host-controlled: the adapter never opens sockets or audio
 * devices. The host (DSH client plugin) forwards `speakStart` / envelope
 * frames / `speakEnd` from the TTS bridge SSE stream and `/live2d` commands.
 */
export function createSoullinkStage(options: SoullinkStageOptions): SoullinkStage {
  const { container, model } = options;
  const config: SoullinkStageConfig = options.config ?? {};
  const log = config.log ?? (() => {});
  const fps = clamp(config.fps ?? DEFAULT_FPS, 5, 60);

  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const modelUrl = new URL(model.modelFile, baseUrl).href;
  const profileUrl = model.profileUrl
    ? new URL(model.profileUrl, baseUrl).href
    : new URL("soullink.profile.json", modelUrl).href;

  const scene = {
    phase: "loading" as SoullinkStageStatus["phase"],
    ready: false,
    visible: true,
    disposed: false,
    scale: 1,
    anchor: "bottom-right",
    offsetX: 0,
    offsetY: 0
  };

  const state = {
    voiceActive: false,
    speechStartedAt: 0,
    /** Estimated duration of the whole utterance, used to keep the engine in SPEAKING. */
    utteranceSeconds: 0,
    lastSpeechText: "",
    emotion: {
      requested: null as string | null,
      preset: null as string | null,
      nativeExpression: null as string | null,
      intensity: 0.7
    } satisfies SoullinkEmotionState
  };

  let runtime: SoullinkRuntime | null = null;
  let renderer: Live2DRenderer | null = null;
  let analyzer: EnvelopeAudioLevelAnalyzer | null = null;
  let profile: ModelProfile | null = null;
  let lastSnapshot: RuntimeSnapshot | null = null;
  let activeExpression: ActiveExpression | null = null;
  let expressionCatalog: SoullinkNativeExpression[] = [...(model.expressions ?? [])];
  let motionCatalog: SoullinkNativeMotion[] = [...(model.motions ?? [])];
  const expressionNames = new Set<string>((model.expressions ?? []).map((entry) => entry.name));
  const expressionCache = new Map<string, ExpressionOverlayEntry[] | null>();
  const loadingExpressions = new Map<string, Promise<ExpressionOverlayEntry[] | null>>();
  const missingParameters = new Set<string>();
  const mergedEmotionMap: Record<string, string> = {
    ...DEFAULT_TTS_EMOTION_MAP,
    ...(model.emotionMap ?? {}),
    ...(config.emotionMap ?? {})
  };

  /**
   * Continuous speech motion (Soullink SpeechPerformancePlanner).
   *
   * The engine only drives lip sync + (damped) idle while it is in SPEAKING, so
   * without a speech-performance plan a talking character looks frozen except
   * for the LipSync accent flicking its head left and right — the "mocap jitter"
   * look. This is the SDK's intended layer for long speech: semantic gestures
   * (nods, tilts, sways, emphasis) planned from emotion/VAD/duration and sampled
   * as smooth curves on the head/body/gaze channels.
   *
   * TTS delivers one *utterance* as several *segments*. We plan one performance
   * per segment and append them (the queue plays them back to back), and when a
   * segment changes the emotion we replay the exact same queue from its original
   * start time, so the gesture timeline never jumps.
   */
  const speechPerformance = {
    planner: null as SpeechPerformancePlanner | null,
    capabilities: null as SpeechPerformanceCapabilities | null,
    plans: [] as SpeechPerformancePlan[],
    startedAt: 0,
    token: 0,
    segmentOrdinal: 0,
    confidence: 0.95
  };

  let startedAtMs = 0;
  let lastFrameAbsMs = 0;
  let lastRenderAtMs = 0;
  let rafId = 0;
  let frameCount = 0;
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  let measuredFps = 0;
  let hiddenParts = [...(config.hiddenParts ?? model.hiddenParts ?? [])];
  /** Diagnostics for the occlusion/resume and emotion-smoothing acceptance checks. */
  const counters = {
    frameGaps: 0,
    lastFrameGapMs: 0,
    expressionsPreloaded: 0,
    fullIntent: 0,
    smooth: 0,
    skipped: 0
  };
  let preloadStarted = false;

  const statusListeners: Array<(status: SoullinkStageStatus) => void> = [];
  if (options.onStatus) statusListeners.push(options.onStatus);

  function emitStatus(status: SoullinkStageStatus): void {
    scene.phase = status.phase;
    if (status.phase === "ready") scene.ready = true;
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch (error) {
        log("[dsh-live2d] onStatus listener threw", error);
      }
    }
  }

  const api: SoullinkStage = {
    ready: Promise.resolve() as unknown as Promise<SoullinkStageReadyInfo>,
    setEmotion,
    speakStart,
    speakSegment,
    pushEnvelope,
    speakEnd,
    resume,
    setVisible,
    setScale,
    setPosition,
    stats,
    dispose,
    get debug() {
      return debugApi;
    }
  };

  const debugApi: SoullinkStageDebug = {
    get renderer() {
      return renderer;
    },
    get runtime() {
      return runtime;
    },
    get analyzer() {
      return analyzer;
    },
    getSnapshot: () => lastSnapshot,
    getPartOpacities: () => renderer?.getPartOpacities() ?? {},
    getCanvas: () => renderer?.getCanvas() ?? null,
    getVisibleParts: () => {
      const opacities = renderer?.getPartOpacities() ?? {};
      return Object.entries(opacities)
        .filter(([, opacity]) => opacity > 0.001)
        .map(([id, opacity]) => ({ id, opacity }));
    }
  };

  const ready = bootstrap();
  api.ready = ready;
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = api;
  }

  return api;

  // -------------------------------------------------------------------------

  async function bootstrap(): Promise<SoullinkStageReadyInfo> {
    try {
      emitStatus({ phase: "loading", message: "loading profile" });
      profile = model.profile ?? (await fetchJson<ModelProfile>(profileUrl));
      if (!expressionCatalog.length || !motionCatalog.length) {
        await hydrateCatalogsFromModel3();
      }

      runtime = new SoullinkRuntime({ profile });
      analyzer = new EnvelopeAudioLevelAnalyzer({
        gain: config.lipSyncGain ?? 1,
        maxBacklogMs: config.envelopeMaxBacklogMs ?? 500
      });
      runtime.setAudioLevelAnalyzer(analyzer);
      if (config.parameterGain !== undefined) runtime.setParameterGain(config.parameterGain);
      if (config.bodyMotionGain !== undefined) runtime.setBodyMotionGain(config.bodyMotionGain);
      if (config.idle === false) runtime.setIdleEnabled(false);
      // Speech gestures come from the planner (see the speechPerformance block
      // above); slightly amplify and loosen the density so a talking character
      // clearly moves instead of standing still between two gestures.
      speechPerformance.planner = new SpeechPerformancePlanner();
      speechPerformance.confidence = clamp(
        Number.isFinite(config.speechGestureConfidence) ? Number(config.speechGestureConfidence) : 0.95,
        0,
        1
      );
      speechPerformance.capabilities = deriveSpeechPerformanceCapabilities(profile, {
        // "How big are the talking gestures": SDK range 0..2.6, default 1.
        gestureAmplitudeGain: clamp(
          Number.isFinite(config.gestureAmplitudeGain) ? Number(config.gestureAmplitudeGain) : 2,
          0,
          2.6
        ),
        gestureLimit: clamp(Math.trunc(Number.isFinite(config.gestureLimit) ? Number(config.gestureLimit) : 4), 0, 4),
        motionBudget: {
          maxMotionDensity: clamp(Number.isFinite(config.motionDensity) ? Number(config.motionDensity) : 1, 0.12, 1),
          minRestWindowMs: clamp(Number.isFinite(config.minRestWindowMs) ? Number(config.minRestWindowMs) : 0, 0, 2000)
        }
      });

      applyContainerSize();
      emitStatus({ phase: "loading", message: "loading model" });
      renderer = new Live2DRenderer(container, {
        cubismLoader: createCubismLoader(config.coreUrl),
        onMissingParameter: (id) => missingParameters.add(id),
        hiddenPartIds: hiddenParts,
        devicePixelRatioCap: config.devicePixelRatioCap ?? 1,
        randomExpressionOnReset: config.randomExpressionOnReset ?? true,
        preserveDrawingBuffer: config.preserveDrawingBuffer === true
      });
      const parameterInfo = await renderer.load(modelUrl);
      renderer.setHiddenPartIds(hiddenParts);
      runtime.setPrivateVADParameters(parameterInfo);

      startedAtMs = performance.now();
      lastFrameAbsMs = startedAtMs;
      lastRenderAtMs = startedAtMs;
      fpsWindowStart = startedAtMs;
      emitStatus({ phase: "ready", message: "stage ready" });
      log(
        `[dsh-live2d] ready: ${Object.keys(parameterInfo).length} parameters, ` +
          `${expressionCatalog.length} expressions, ${motionCatalog.length} motions, ` +
          `${hiddenParts.length} hidden parts`
      );
      startLoop();
      // Warm the expression cache while the character idles: the first emotion
      // switch during speech must not wait for an HTTP fetch.
      if (config.expressionPreload !== false) {
        if (typeof globalThis.requestIdleCallback === "function") {
          globalThis.requestIdleCallback(() => {
            void preloadExpressions();
          });
        } else {
          setTimeout(() => {
            void preloadExpressions();
          }, 50);
        }
      }
      return {
        profile,
        modelUrl,
        profileUrl,
        expressions: expressionCatalog,
        motions: motionCatalog,
        hiddenParts: [...hiddenParts],
        parameterCount: Object.keys(parameterInfo).length
      };
    } catch (error) {
      const err = toError(error);
      emitStatus({ phase: "error", message: err.message, error: err });
      throw err;
    }
  }

  function targetFps(): number {
    const override = Number((globalThis as { __DSH_LIVE2D_FPS__?: number }).__DSH_LIVE2D_FPS__);
    return Number.isFinite(override) && override > 0 ? clamp(override, 2, 60) : fps;
  }

  /** (Re)start the render loop. rAF can be stopped by Chromium while occluded. */
  function startLoop(): void {
    if (scene.disposed || !scene.visible) return;
    if (rafId) cancelAnimationFrame(rafId);
    const now = performance.now();
    lastFrameAbsMs = now;
    lastRenderAtMs = now;
    rafId = requestAnimationFrame(frame);
  }

  /**
   * Called when the window becomes exposed/focused again. Re-arms the render
   * loop (a paused rAF never restarts itself) and drops the envelope backlog
   * accumulated while the renderer was frozen.
   */
  function resume(): void {
    if (scene.disposed) return;
    // Only drop the envelope when the render loop was actually stalled. A
    // normal focus/click while the window is rendering must not create a mouth
    // gap. A paused rAF naturally leaves a large gap here.
    const stalled = performance.now() - lastFrameAbsMs > 250;
    if (stalled) analyzer?.flush();
    renderer?.setRenderingEnabled(true);
    startLoop();
  }

  function frame(timestamp: number): void {
    if (scene.disposed) return;
    rafId = requestAnimationFrame(frame);
    const minFrameMs = 1000 / targetFps();
    if (timestamp - lastRenderAtMs < minFrameMs - 0.75) return;

    const gapMs = timestamp - lastFrameAbsMs;
    if (gapMs > 250) {
      // rAF was paused (window occluded/minimised). Do not replay the audio the
      // user did not see: resync the envelope to the current audio.
      counters.frameGaps += 1;
      counters.lastFrameGapMs = Math.round(gapMs);
      analyzer?.flush();
      log(`[dsh-live2d] render resumed after ${Math.round(gapMs)}ms gap; envelope resynced`);
    }
    const delta = clamp(gapMs / 1000, 0.001, 0.12);
    lastFrameAbsMs = timestamp;
    lastRenderAtMs = timestamp;
    if (!runtime || !renderer || !analyzer) return;
    if (!scene.visible) return;

    frameCount++;
    fpsWindowFrames++;
    if (timestamp - fpsWindowStart >= 500) {
      measuredFps = Math.round((fpsWindowFrames * 1000) / (timestamp - fpsWindowStart));
      fpsWindowStart = timestamp;
      fpsWindowFrames = 0;
    }

    const nowSeconds = (timestamp - startedAtMs) / 1000;
    analyzer.advance(delta);

    if (state.voiceActive && lastSnapshot?.state === "RECOVERING") {
      // Keep the engine in SPEAKING while the TTS audio is still playing.
      runtime.startSpeechMotion(undefined, nowSeconds, estimateSpeechDuration(state.lastSpeechText));
      setEngineSpeechDuration(remainingUtteranceSeconds(nowSeconds));
    }
    if (state.voiceActive && lastSnapshot?.state === "IDLE") {
      // Audio is still playing but the engine ran out of planned speech: re-enter
      // SPEAKING (replaying the planned gesture queue when there is one).
      if (speechPerformance.plans.length > 0) restoreSpeechPerformance();
      else runtime.startSpeechMotion(undefined, nowSeconds, 6);
      setEngineSpeechDuration(remainingUtteranceSeconds(nowSeconds));
    }

    const snapshot = runtime.update(nowSeconds, delta);
    lastSnapshot = snapshot;

    updateExpressionOverlay(delta, snapshot);

    let directive = IDLE_STATES.has(snapshot.state) ? null : snapshot.nativeAnimation;
    if (directive) {
      // Native expressions are driven only by this adapter (setEmotion /
      // speakStart / smooth segment switch): it supports an intensity weight,
      // Cubism blend modes and plain Chinese exp3 names. The engine's
      // `nativeAnimation.expression` is stale after a smooth switch (it still
      // points at the previous triggerIntent), so never let it override the
      // adapter's explicit choice — including "no expression" for 默认.
      //
      // The engine params are NOT suppressed: expression entries are blended
      // on top of the FACS layer (Add/Multiply/Overwrite per exp3 file).
      directive = { ...directive, expression: null, suppressParamIds: [] };
    }
    renderer.applyNativeAnimation(directive);
    renderer.setParameters(snapshot.live2dParams);
  }

  function updateExpressionOverlay(delta: number, snapshot: RuntimeSnapshot): void {
    if (!renderer) return;
    if (!activeExpression) {
      renderer.clearExpressionOverlay();
      return;
    }

    if (!state.voiceActive && IDLE_STATES.has(snapshot.state) && activeExpression.target > 0) {
      // Relax the native expression once the segment is over and the engine is
      // back to idle; the engine FACS layer keeps the softer residual emotion.
      activeExpression.target = 0;
    }

    // Switch expressions at full weight, never at a partial one.
    //
    // These exp3 files do not only move continuous parameters: entries such as
    // ParamCheek17 / Paramhh2 / ParamCheek74 / ParamCheek76 toggle extra eye and
    // face overlay drawables (heart pupils, closed-eye lashes, question mark).
    // Drawing such an overlay at a fractional weight makes the base eyes AND the
    // overlay eyes visible at the same time — the "ghost double eyes" seen when
    // the idle moods switch automatically. A fade also leaves a half-transparent
    // copy of the previous expression on screen. So: 0 or 1, no fade.
    // Intensity still shapes the FACS parameter layer (continuous eye/brow/mouth
    // motion), which is where a softer mood is actually visible.
    if (activeExpression.target <= 0) {
      renderer.clearExpressionOverlay();
      if (state.emotion.nativeExpression === activeExpression.name) state.emotion.nativeExpression = null;
      activeExpression = null;
      return;
    }
    activeExpression.weight = 1;
    renderer.setExpressionOverlay(activeExpression.overlay, 1);
  }

  function setEmotion(name: string, intensity = 0.7, options: { smooth?: boolean } = {}): void {
    if (!runtime || !profile) {
      log("[dsh-live2d] setEmotion before ready ignored", name);
      return;
    }
    const preset = resolvePreset(name, mergedEmotionMap);
    const clampedIntensity = clamp(intensity, 0, 1);
    const nativeName = resolveNativeExpressionName({
      requested: name,
      preset,
      expressionMap: { ...(model.expressionMap ?? {}), ...(config.expressionMap ?? {}) },
      profileExpressionMap: profile.expressionMap,
      catalog: expressionNames
    });

    state.emotion = {
      requested: name,
      preset: preset ?? "neutral",
      nativeExpression: nativeName,
      intensity: clampedIntensity
    };
    requestNativeExpression(nativeName, clampedIntensity);

    const enginePreset = preset ?? "neutral";
    const variant = resolveVariant(enginePreset);
    const vad = resolveVAD(enginePreset, variant);
    const nowSeconds = runtimeNow();

    // During speech (and for opt-in smooth switches such as idle moods) never
    // call triggerIntent(): it resets the state machine to LISTENING, clears the
    // speech-performance queue and restarts the reaction, which is exactly the
    // body jolt seen at every TTS segment boundary. Move the VAD target smoothly
    // and let the engine's own FACS blend carry the face over instead.
    if (options.smooth === true || state.voiceActive) {
      counters.smooth += 1;
      if (vad) runtime.applyVADTarget(vad, 0.55);
      log(`[dsh-live2d] emotion ${name} -> ${enginePreset}${nativeName ? ` / exp3 ${nativeName}` : ""} (smooth)`);
      return;
    }

    counters.fullIntent += 1;
    const intent = buildEmotionIntent({ preset: enginePreset, variant, intensity: clampedIntensity });
    runtime.triggerIntent(intent, nowSeconds, {
      seed: nextSeed(),
      ...(vad ? { vadTarget: vad } : {})
    });
    if (vad) runtime.applyVADTarget(vad, 0.85);
    log(`[dsh-live2d] emotion ${name} -> ${enginePreset}${nativeName ? ` / exp3 ${nativeName}` : ""} @${clampedIntensity}`);
  }

  /** Duration estimate for a TTS segment (Chinese ≈ 4–5 chars/s, plus lead-in). */
  function estimateSegmentDurationMs(text: string): number {
    const length = text.trim().length;
    return clamp((0.6 + length * 0.22) * 1000, 900, 12000);
  }

  /** Plan one speech performance for a segment (semantic gestures, smooth curves). */
  function planSegmentPerformance(
    emotionName: string,
    text: string,
    intensity: number,
    durationMs: number
  ): SpeechPerformancePlan | null {
    const planner = speechPerformance.planner;
    const capabilities = speechPerformance.capabilities;
    if (!planner || !capabilities) return null;
    const preset = resolvePreset(emotionName, mergedEmotionMap) ?? "neutral";
    const duration = clamp(Number.isFinite(durationMs) ? durationMs : estimateSegmentDurationMs(text), 400, 30000);
    const plan = planner.plan({
      emotion: preset,
      durationMs: duration,
      intensity: clamp(intensity, 0, 1),
      confidence: speechPerformance.confidence,
      capabilities,
      lifecycleToken: ++speechPerformance.token,
      seed: createSpeechPerformanceSeed({
        segmentOrdinal: speechPerformance.segmentOrdinal++,
        emotion: preset,
        durationMs: duration
      })
    });
    return plan;
  }

  /**
   * Re-apply the planned speech-performance queue from its original start time.
   *
   * `triggerIntent()` (used by `setEmotion` / `speakStart`) clears the runtime's
   * speech-performance plan. Replaying the queue with the same start time makes
   * the gesture timeline continue exactly where it was instead of restarting or
   * snapping to a different pose.
   */
  function restoreSpeechPerformance(): void {
    if (!runtime) return;
    const plans = speechPerformance.plans;
    if (plans.length === 0) return;
    runtime.startSpeechPerformance(plans[0], speechPerformance.startedAt, "replace");
    for (let index = 1; index < plans.length; index += 1) {
      runtime.startSpeechPerformance(plans[index], speechPerformance.startedAt, "append");
    }
  }

  function clearSpeechPerformance(): void {
    speechPerformance.plans = [];
    speechPerformance.startedAt = 0;
    try {
      runtime?.clearSpeechPerformance();
    } catch {
      /* runtime may already be gone */
    }
  }

  function speakStart(speakOptions: SoullinkSpeakStartOptions = {}): void {
    if (!runtime || !analyzer || !renderer || !profile) {
      log("[dsh-live2d] speakStart before ready ignored");
      return;
    }
    const emotion = speakOptions.emotion ?? "默认";
    const intensity = clamp(speakOptions.intensity ?? config.speechIntensity ?? 1, 0, 1);
    const text = speakOptions.text ?? "";
    const preset = resolvePreset(emotion, mergedEmotionMap) ?? "neutral";
    const nativeName = resolveNativeExpressionName({
      requested: emotion,
      preset,
      expressionMap: { ...(model.expressionMap ?? {}), ...(config.expressionMap ?? {}) },
      profileExpressionMap: profile.expressionMap,
      catalog: expressionNames
    });

    state.emotion = { requested: emotion, preset, nativeExpression: nativeName, intensity };
    requestNativeExpression(nativeName, intensity);
    state.voiceActive = true;
    state.lastSpeechText = text;
    analyzer.beginSpeech();
    runtime.setVoicePlaybackActive(true);

    const nowSeconds = runtimeNow();
    state.speechStartedAt = nowSeconds;
    const variant = resolveVariant(preset);
    const vad = resolveVAD(preset, variant);
    const intent = buildEmotionIntent({ preset, variant, intensity, text });
    counters.fullIntent += 1;
    runtime.triggerIntent(intent, nowSeconds, {
      seed: nextSeed(),
      ...(vad ? { vadTarget: vad } : {})
    });

    // The whole utterance's estimated duration keeps the engine in SPEAKING until
    // the audio really ends; the speech-performance plan below uses the first
    // segment's estimate (later segments append to the same queue).
    const utteranceSeconds = Number(speakOptions.durationSeconds);
    const speechSeconds = Number.isFinite(utteranceSeconds) && utteranceSeconds > 0.4
      ? clamp(utteranceSeconds, 0.4, 120)
      : estimateSpeechDuration(text);
    state.utteranceSeconds = speechSeconds;
    runtime.startSpeechMotion(undefined, nowSeconds, speechSeconds);

    // Plan + start the gesture performance for this first segment.
    speechPerformance.plans = [];
    speechPerformance.startedAt = nowSeconds;
    const planDurationMs = Number.isFinite(Number(speakOptions.durationMs)) && Number(speakOptions.durationMs) > 0
      ? Number(speakOptions.durationMs)
      : estimateSegmentDurationMs(text);
    const plan = planSegmentPerformance(emotion, text, intensity, planDurationMs);
    if (plan) {
      speechPerformance.plans = [plan];
      runtime.startSpeechPerformance(plan, nowSeconds, "replace");
    }
    // startSpeechPerformance() overwrites the engine's SPEAKING budget with the
    // first segment plan's duration; restore the whole-utterance budget so the
    // engine does not leave SPEAKING between segments.
    setEngineSpeechDuration(speechSeconds);
    // A new utterance also re-arms a render loop that Chromium stopped while the
    // window was occluded between utterances.
    if (scene.visible) startLoop();
    log(
      `[dsh-live2d] speakStart ${emotion} -> ${preset}${nativeName ? ` / exp3 ${nativeName}` : ""} ` +
        `(${text.length} chars, ${speechSeconds.toFixed(2)}s est., speech plan ${Math.round(planDurationMs)}ms)`
    );
  }

  /**
   * Applies one *following* TTS segment inside the running utterance.
   *
   * A segment boundary must not restart the performance: `triggerIntent()` would
   * reset the state machine to LISTENING and clear the speech-performance queue,
   * which is the body jolt seen at every sentence. So a mid-utterance emotion
   * change only moves the VAD target + native expression smoothly, and the new
   * gesture block is appended to the running queue.
   */
  function speakSegment(segmentOptions: SoullinkSpeakSegmentOptions = {}): void {
    if (!runtime || !analyzer || !renderer || !profile) return;
    if (!state.voiceActive) {
      // A segment without a preceding speakStart (window reloaded mid-speech):
      // behave like a fresh start instead of silently doing nothing.
      speakStart({ ...segmentOptions, emotion: segmentOptions.emotion ?? "默认" });
      return;
    }
    const emotion = segmentOptions.emotion ?? state.emotion.requested ?? "默认";
    const intensity = clamp(segmentOptions.intensity ?? config.speechIntensity ?? 1, 0, 1);
    const text = segmentOptions.text ?? "";
    if (text) state.lastSpeechText = text;

    const changed =
      emotion !== state.emotion.requested ||
      Math.abs(intensity - state.emotion.intensity) > 0.02;
    if (changed) {
      setEmotion(emotion, intensity, { smooth: true });
    } else {
      counters.skipped += 1;
    }

    const plan = planSegmentPerformance(
      emotion,
      text,
      intensity,
      Number.isFinite(Number(segmentOptions.durationMs)) ? Number(segmentOptions.durationMs) : estimateSegmentDurationMs(text)
    );
    if (plan) {
      speechPerformance.plans.push(plan);
      runtime.startSpeechPerformance(plan, runtimeNow(), "append");
      // Keep the whole-utterance budget; see speakStart().
      setEngineSpeechDuration(state.utteranceSeconds > 0 ? state.utteranceSeconds : 6);
    }
    log(
      `[dsh-live2d] speakSegment ${emotion}${changed ? "" : " (same)"} ` +
        `(${text.length} chars, ${speechPerformance.plans.length} planned)`
    );
  }

  function pushEnvelope(frames: readonly number[], hopMs = 20): void {
    analyzer?.push(frames, hopMs);
  }

  function speakEnd(): void {
    if (!runtime || !analyzer) return;
    state.voiceActive = false;
    analyzer.endSpeech();
    runtime.setVoicePlaybackActive(false);
    clearSpeechPerformance();
    // The audio really ended: do not hold the SPEAKING pose for the rest of the
    // estimated utterance. The engine's normal recovery takes over quickly.
    setEngineSpeechDuration(0.45);
    state.utteranceSeconds = 0;
    if (activeExpression) activeExpression.target = 0;
    log("[dsh-live2d] speakEnd");
  }

  function setVisible(visible: boolean): void {
    const wasVisible = scene.visible;
    scene.visible = visible;
    container.style.visibility = visible ? "" : "hidden";
    renderer?.setRenderingEnabled(visible);
    if (visible) {
      // Re-arm only on the hidden -> visible transition. The host sends a state
      // heartbeat every 10s; re-arming on every heartbeat would flush the
      // envelope and create a visible mouth gap.
      if (!wasVisible) resume();
    } else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function setScale(scale: number): void {
    scene.scale = scale;
    renderer?.setViewScale(scale);
  }

  function setPosition(anchor = "bottom-right", offsetX = 0, offsetY = 0): void {
    scene.anchor = anchor;
    scene.offsetX = offsetX;
    scene.offsetY = offsetY;
    renderer?.setViewOffset({ x: offsetX, y: offsetY });
  }

  function stats(): SoullinkStageStats {
    const rendered = renderer?.getParameters() ?? {};
    const mouth = rendered.ParamMouthOpenY ?? rendered.ParamMouthOpen ?? 0;
    return {
      backend: "soullink",
      ready: scene.ready,
      fps: measuredFps,
      frameCount,
      state: lastSnapshot?.state ?? "LOADING",
      emotion: { ...state.emotion },
      vad: lastSnapshot?.vad
        ? {
            valence: round(lastSnapshot.vad.current.valence),
            arousal: round(lastSnapshot.vad.current.arousal),
            dominance: round(lastSnapshot.vad.current.dominance)
          }
        : null,
      mouth: round(clamp(mouth, 0, 1)),
      // Prefer the requested native expression so a fading-out previous
      // expression does not show up as the current one.
      nativeExpression: state.emotion.nativeExpression ?? activeExpression?.name ?? null,
      envelope: analyzer?.stats() ?? {
        pendingFrames: 0,
        hopMs: 20,
        level: 0,
        peak: 0,
        active: false,
        speechActive: false,
        droppedFrames: 0,
        flushCount: 0,
        lastFlushAt: 0
      },
      hiddenParts: [...hiddenParts],
      missingParameters: [...missingParameters].slice(0, 64),
      canvas: renderer?.getDebugStats() ?? null,
      runtimeTimeSeconds: runtime ? round(runtimeNow()) : 0,
      modelUrl,
      frameGapMs: counters.lastFrameGapMs,
      frameGaps: counters.frameGaps,
      expressionsPreloaded: counters.expressionsPreloaded,
      emotionSwitch: {
        fullIntent: counters.fullIntent,
        smooth: counters.smooth,
        skipped: counters.skipped
      }
    };
  }

  function dispose(): void {
    if (scene.disposed) return;
    scene.disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    analyzer?.reset();
    try {
      renderer?.destroy();
    } catch (error) {
      log("[dsh-live2d] renderer destroy failed", error);
    }
    renderer = null;
    runtime = null;
    analyzer = null;
    if (typeof globalThis !== "undefined") {
      const globalRecord = globalThis as Record<string, unknown>;
      if (globalRecord[GLOBAL_KEY] === api) delete globalRecord[GLOBAL_KEY];
    }
    emitStatus({ phase: "disposed" });
  }

  // ---- helpers -----------------------------------------------------------

  function runtimeNow(): number {
    if (!startedAtMs) return 0;
    return (performance.now() - startedAtMs) / 1000;
  }

  /**
   * Set the engine's SPEAKING budget.
   *
   * `SoullinkRuntime.startSpeechPerformance()` currently overwrites its
   * `speechDuration` with a single segment's plan duration. The adapter feeds it
   * the whole-utterance duration, so re-assert it here after starting/replaying
   * a plan; otherwise the engine leaves SPEAKING every segment plan (~1.3s) and
   * the frame keep-alive has to bounce it back — visible as a periodic body
   * twitch. The field is a plain property of the vendored engine build (TS
   * `private` is erased), not a `#private` field.
   */
  function setEngineSpeechDuration(seconds: number): void {
    const target = runtime as unknown as { speechDuration?: number } | null;
    if (!target || typeof target.speechDuration !== "number") return;
    target.speechDuration = clamp(seconds, 0.4, 120);
  }

  /** Remaining whole-utterance budget, measured from the current SPEAKING entry. */
  function remainingUtteranceSeconds(nowSeconds: number): number {
    const total = state.utteranceSeconds > 0 ? state.utteranceSeconds : 6;
    return Math.max(0.5, total - Math.max(0, nowSeconds - state.speechStartedAt));
  }

  function nextSeed(): number {
    return Math.max(1, Math.floor(Math.random() * 0x7fffffff));
  }

  function applyContainerSize(): void {
    const maxWidth = config.maxWidth;
    const maxHeight = config.maxHeight;
    if (!maxWidth && !maxHeight) return;
    if (maxWidth && !container.style.width && container.clientWidth === 0) {
      container.style.width = `${maxWidth}px`;
    }
    if (maxHeight && !container.style.height && container.clientHeight === 0) {
      container.style.height = `${maxHeight}px`;
    }
  }

  function createCubismLoader(coreUrl?: string): () => Promise<void> {
    let pending: Promise<void> | null = null;
    return () => {
      if ((globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore) return Promise.resolve();
      if (!coreUrl) {
        return Promise.reject(
          new Error(
            "[dsh-live2d-adapter] Cubism Core is not loaded. Load live2dcubismcore.min.js before the adapter " +
              "or pass config.coreUrl."
          )
        );
      }
      pending ??= new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = coreUrl;
        script.async = true;
        script.onload = () => {
          if ((globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore) resolve();
          else reject(new Error("Cubism Core script loaded but window.Live2DCubismCore is missing."));
        };
        script.onerror = () => reject(new Error(`Failed to load Cubism Core from ${coreUrl}`));
        document.head.appendChild(script);
      });
      return pending;
    };
  }

  async function hydrateCatalogsFromModel3(): Promise<void> {
    try {
      const model3 = await fetchJson<{
        FileReferences?: {
          Expressions?: Array<{ Name?: string; File?: string }>;
          Motions?: Record<string, Array<{ File?: string }>>;
        };
      }>(modelUrl);
      if (!expressionCatalog.length) {
        expressionCatalog = (model3.FileReferences?.Expressions ?? [])
          .map((entry) => ({ name: String(entry.Name ?? ""), file: String(entry.File ?? "") }))
          .filter((entry) => entry.name && entry.file);
        for (const entry of expressionCatalog) expressionNames.add(entry.name);
      }
      if (!motionCatalog.length) {
        const motions: SoullinkNativeMotion[] = [];
        for (const [group, entries] of Object.entries(model3.FileReferences?.Motions ?? {})) {
          entries.forEach((entry, index) => {
            if (entry?.File) motions.push({ group, index, file: String(entry.File) });
          });
        }
        motionCatalog = motions;
      }
    } catch (error) {
      log("[dsh-live2d] failed to hydrate animations from model3", error);
    }
  }

  function requestNativeExpression(name: string | null, intensity: number): void {
    if (name === null) {
      if (activeExpression) activeExpression.target = 0;
      state.emotion.nativeExpression = null;
      return;
    }
    state.emotion.nativeExpression = name;
    const target = clamp(intensity, 0, 1);
    const cached = expressionCache.get(name);
    if (cached !== undefined) {
      activateExpression(name, cached, target);
      return;
    }
    if (activeExpression?.name === name) {
      activeExpression.target = target;
      return;
    }
    const pending = loadingExpressions.get(name);
    const promise = pending ?? loadExpressionParams(name);
    loadingExpressions.set(name, promise);
    void promise.then((params) => {
      expressionCache.set(name, params);
      loadingExpressions.delete(name);
      if (state.emotion.nativeExpression === name) activateExpression(name, params, target);
    });
  }

  /**
   * Fetch every native exp3 once, after the first frame is on screen. Without
   * this the first TTS segment to use an emotion blocks on an HTTP round trip
   * and pops the expression in late (the "emotion switch stutters" symptom).
   */
  async function preloadExpressions(): Promise<void> {
    if (preloadStarted) return;
    preloadStarted = true;
    const entries = expressionCatalog.filter(
      (entry) => !!entry.file && !expressionCache.has(entry.name) && !loadingExpressions.has(entry.name)
    );
    if (entries.length === 0) return;
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < entries.length) {
        const entry = entries[index++];
        const params = await loadExpressionParams(entry.name);
        expressionCache.set(entry.name, params);
        if (params) counters.expressionsPreloaded += 1;
      }
    };
    const workers = Math.max(1, Math.min(4, entries.length));
    await Promise.allSettled(Array.from({ length: workers }, () => worker()));
    log(`[dsh-live2d] preloaded ${counters.expressionsPreloaded}/${entries.length} native expressions`);
  }

  function activateExpression(
    name: string,
    overlay: ExpressionOverlayEntry[] | null,
    target: number
  ): void {
    if (!overlay || overlay.length === 0) return;
    if (activeExpression && activeExpression.name === name) {
      activeExpression.target = target;
      return;
    }
    // Fade the new expression in from 0. Inheriting the previous overlay's weight
    // made every exp3 switch a full-strength pop (heart eyes -> happy -> question
    // mark on each TTS segment boundary).
    activeExpression = {
      name,
      overlay,
      weight: 0,
      target
    };
  }

  async function loadExpressionParams(name: string): Promise<ExpressionOverlayEntry[] | null> {
    const entry =
      expressionCatalog.find((item) => item.name === name) ??
      expressionCatalog.find((item) => item.name.includes(name) || name.includes(item.name));
    if (!entry) return null;
    try {
      const url = new URL(entry.file, modelUrl).href;
      const data = await fetchJson<{
        Parameters?: Array<{ Id?: string; Value?: number; Blend?: string }>;
      }>(url);
      const overlay: ExpressionOverlayEntry[] = [];
      for (const param of data.Parameters ?? []) {
        if (typeof param.Id !== "string" || typeof param.Value !== "number") continue;
        // Cubism expression files default to Add when Blend is omitted.
        const blend =
          param.Blend === "Multiply"
            ? "multiply"
            : param.Blend === "Overwrite"
              ? "overwrite"
              : "add";
        overlay.push({ id: param.Id, value: param.Value, blend });
      }
      return overlay;
    } catch (error) {
      log("[dsh-live2d] failed to load native expression", name, error);
      return null;
    }
  }
}

export function estimateSpeechDuration(text: string): number {
  const length = text.trim().length;
  return clamp(1.4 + length * 0.16, 1.4, 30);
}

function normalizeBaseUrl(baseUrl: string): string {
  const resolved = new URL(baseUrl, globalThis.location?.href ?? "http://localhost/").href;
  return resolved.endsWith("/") ? resolved : `${resolved}/`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { DEFAULT_EMOTION_VARIANT };
