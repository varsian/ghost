/**
 * backend-soullink.js — optional "perform" backend built on the vendored
 * Soullink Emotion SDK adapter (`vendor/soullink/dsh-live2d-adapter.js`,
 * global `DSHLive2DAdapter`).
 *
 * The adapter package (built from the Soullink adapter sources) combines:
 *   - `@soullink-emotion/live2d-pixi`  (Live2DRenderer: PIXI v7 + pixi-live2d-display)
 *   - `@soullink-emotion/engine`        (SoullinkRuntime: VAD/FACS, idle, lip-sync)
 *   - `EnvelopeAudioLevelAnalyzer`      (RMS envelope player)
 *
 * Its public stage API is intentionally close to ours; this wrapper adapts the
 * remaining differences (status shape, stats shape, clearEmotion, resize, …)
 * so `createLive2DStage()` can switch between `soullink` and `direct` without
 * the host noticing.
 *
 * The adapter is vendored as an IIFE and expects the *already loaded* vendor
 * globals — no second copy of PIXI / pixi-live2d-display is bundled:
 *   window.PIXI, window.PIXI.live2d, window.Live2DCubismCore.
 */

import { joinUrl } from './assets.js';

const TAG = '[live2d:soullink]';
const noop = () => {};

/** Is the vendored Soullink adapter available in this page? */
export function hasSoullinkAdapter() {
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  const adapter = scope.DSHLive2DAdapter;
  return !!(adapter && typeof adapter.createSoullinkStage === 'function');
}

function resolveContainer(options) {
  if (options.container) return options.container;
  const canvas = options.canvas;
  if (!canvas) return null;
  if (canvas.parentElement) return canvas.parentElement;
  const host = document.createElement('div');
  host.style.width = (options.config && options.config.width ? options.config.width : 360) + 'px';
  host.style.height = (options.config && options.config.height ? options.config.height : 520) + 'px';
  host.style.background = 'transparent';
  document.body.appendChild(host);
  host.appendChild(canvas);
  return host;
}

/**
 * Resolve a possibly-relative URL to an absolute one (the Soullink adapter
 * resolves its profile/model URLs with `new URL(...)`, so relative URLs would
 * be double-resolved against the model URL directory).
 */
function toAbsolute(url) {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    if (typeof document !== 'undefined' && document.baseURI) return new URL(url, document.baseURI).href;
    if (typeof location !== 'undefined' && location.href) return new URL(url, location.href).href;
  } catch (e) {
    /* fall through */
  }
  return url;
}

/**
 * Create a stage backed by the Soullink adapter.
 *
 * @param {object} args
 * @param {object} args.options     original createLive2DStage options
 * @param {object|null} args.assets pre-discovered model assets (expressions/motions/hiddenParts)
 * @param {(status:object)=>void} args.onStatus status sink (kind/phase shape)
 * @returns {object} a stage-shaped implementation (same method names as the direct backend)
 */
export function createSoullinkBackend({ options, assets, onStatus = noop }) {
  const scope = typeof globalThis !== 'undefined' ? globalThis : {};
  const Adapter = scope.DSHLive2DAdapter;
  if (!Adapter || typeof Adapter.createSoullinkStage !== 'function') {
    throw new Error('[live2d] Soullink adapter bundle is not loaded (window.DSHLive2DAdapter missing)');
  }
  const model = Object.assign({}, options.model);
  const cfg = options.config || {};
  const container = resolveContainer(options);
  if (!container) throw new Error('[live2d] Soullink backend requires a container element');

  // Same discovery source for both backends: our assets loader result.
  const manifest = (assets && assets.manifest) || null;
  const profileFile =
    model.profileFile ||
    (manifest && manifest.profileFile) ||
    'soullink.profile.json';
  const absBaseUrl = toAbsolute(model.baseUrl);
  const profileUrl = toAbsolute(
    model.profileUrl || (absBaseUrl ? joinUrl(absBaseUrl, profileFile) : undefined)
  );

  const expressions = ((assets && assets.expressions) || []).map((e) => ({
    name: e.name,
    file: e.file,
  }));
  const disableIdleMotion = !!(assets && assets.disableIdleMotion);
  const motions = ((assets && assets.motions) || [])
    // Some VTube exports bake props/eye gimmicks into the Idle motion; the
    // manifest can request procedural-only idle. Never register those groups.
    .filter((m) => !(disableIdleMotion && String(m.group || 'Idle') === 'Idle'))
    .map((m, index) => ({
      group: m.group || 'Idle',
      index: typeof m.index === 'number' ? m.index : index,
      file: m.file,
    }));
  const hiddenParts = (assets && assets.hiddenParts) || model.hiddenParts || [];
  const emotionMap =
    model.emotionMap || (manifest && manifest.emotionMap) || cfg.emotionMap || undefined;

  const soullinkConfig = {
    fps: cfg.fps || 30,
    maxWidth: cfg.width || model.maxWidth || 360,
    maxHeight: cfg.height || model.maxHeight || 520,
    devicePixelRatioCap: cfg.devicePixelRatioCap === undefined ? 1 : cfg.devicePixelRatioCap,
    hiddenParts,
    preserveDrawingBuffer: !!cfg.preserveDrawingBuffer,
    // Never pick a random native expression on (re)activation: the DS model
    // has 40+ prop expressions (glasses, bubble, desk, ...) and the overlay must
    // stay "character only" until the host explicitly sets an emotion.
    randomExpressionOnReset: false,
    idle: cfg.idle ? cfg.idle.motion !== false : true,
    lipSyncGain: (cfg.lipSync && cfg.lipSync.gain) || 1,
    emotionMap,
    expressionMap: cfg.expressionMap || model.expressionMap,
    // Speech-performance ("talking gestures") tuning — see types.ts in the
    // adapter and the plugin config docs. `speechGestureGain` is the main
    // "how big should the talking motion be" knob (SDK range 0..2.6).
    gestureAmplitudeGain: Number.isFinite(Number(cfg.speechGestureGain)) ? Number(cfg.speechGestureGain) : 2.6,
    gestureLimit: Number.isFinite(Number(cfg.speechGestureLimit)) ? Math.trunc(Number(cfg.speechGestureLimit)) : 4,
    motionDensity: Number.isFinite(Number(cfg.speechMotionDensity)) ? Number(cfg.speechMotionDensity) : 1,
    minRestWindowMs: Number.isFinite(Number(cfg.speechGestureRestMs)) ? Number(cfg.speechGestureRestMs) : 0,
    speechGestureConfidence: Number.isFinite(Number(cfg.speechGestureConfidence)) ? Number(cfg.speechGestureConfidence) : 0.95,
    speechIntensity: Number.isFinite(Number(cfg.speechIntensity)) ? Number(cfg.speechIntensity) : 1,
    log: (message) => emit({ kind: 'log', phase: 'log', message: String(message) }),
  };
  if (!profileUrl) throw new Error('[live2d] Soullink backend requires model.baseUrl or model.profileUrl');

  const emit = (status) => {
    try {
      onStatus(status);
    } catch (e) {
      // A throwing status sink must never break the backend.
      console.warn(TAG, 'onStatus handler threw', e);
    }
  };

  const stage = Adapter.createSoullinkStage({
    container,
    model: {
      baseUrl: absBaseUrl,
      modelFile: model.modelFile,
      profileUrl,
      expressions,
      motions,
      hiddenParts,
      emotionMap: model.emotionMap || emotionMap,
      expressionMap: cfg.expressionMap || model.expressionMap,
    },
    config: soullinkConfig,
    onStatus: (status) => {
      const phase = status && status.phase ? status.phase : 'loading';
      const message = status && (status.message || (status.error && status.error.message));
      emit({ kind: phase, phase, message, backend: 'soullink' });
    },
  });

  const state = {
    disposed: false,
    visible: true,
    canvas: null,
  };

  const ready = Promise.resolve(stage.ready)
    .then((info) => {
      try {
        const debug = stage.debug || {};
        state.canvas = typeof debug.getCanvas === 'function' ? debug.getCanvas() : null;
      } catch (e) {
        /* diagnostics only */
      }
      applyPerf();
      applyLiveliness();
      scheduleIdleMood(liveliness.idleMoodMinMs);
      emit({
        kind: 'ready',
        phase: 'ready',
        backend: 'soullink',
        modelUrl: info && info.modelUrl,
        expressions: expressions.map((e) => e.name),
        motions: motions.length,
        hiddenParts,
        modelFile: model.modelFile,
      });
      return impl;
    })
    .catch((err) => {
      emit({
        kind: 'error',
        phase: 'error',
        backend: 'soullink',
        message: String((err && err.message) || err),
        error: String((err && err.message) || err),
      });
      throw err;
    });

  const motionGroups = Array.from(new Set(motions.map((m) => m.group)));

  // ---- performance state: idle fps --------------------------------------
  // The adapter's RAF loop reads window.__DSH_LIVE2D_FPS__ (vendored patch,
  // see vendor/soullink/patch-adapter.mjs). Idle used to be capped at 12 fps,
  // which made breathing/gaze/head sway visibly stutter; up to 24 fps keeps
  // the character lively. Software WebGL (the only mode that starts reliably
  // on this machine) costs CPU per pixel, so the targets are additionally
  // limited by a pixel budget: small windows run at 24 fps, big windows drop
  // to ~12-14 fps instead of burning every core.
  const ACTIVE_FPS = Math.max(2, Math.min(60, Number(cfg.fps) || 30));
  const IDLE_FPS = Math.max(2, Math.min(30, Number(cfg.idleFps) || 24));
  // pixels/second targets for idle and speaking/reacting
  const IDLE_PIXEL_BUDGET = Math.max(2e6, Number(cfg.idlePixelBudget) || 7.0e6);
  const ACTIVE_PIXEL_BUDGET = Math.max(4e6, Number(cfg.activePixelBudget) || 10.0e6);
  const perf = { speaking: false, lastSpeechEndAt: 0, emotionUntil: 0, state: 'idle', timer: 0, speechWatchdog: 0, speechEmotion: '' };
  let latencyPrepended = false;
  let baseFpsOverrideSet = false;

  function currentStateName() {
    if (!state.visible) return 'hidden';
    if (perf.speaking) return 'speaking';
    const now = Date.now();
    if (now < perf.emotionUntil) return 'reacting';
    if (perf.lastSpeechEndAt && now - perf.lastSpeechEndAt < 700) return 'recovering';
    return 'idle';
  }

  /** Current drawable area in CSS pixels (the software renderer cost driver). */
  function canvasArea() {
    const element = state.canvas || container;
    const width = Number(element && (element.clientWidth || element.width)) || 0;
    const height = Number(element && (element.clientHeight || element.height)) || 0;
    if (width > 0 && height > 0) return width * height;
    return 420 * 620;
  }

  function budgetFps(budget, cap) {
    const fps = Math.round(budget / Math.max(1, canvasArea()));
    return Math.max(2, Math.min(cap, fps));
  }

  function targetFpsFor(stateName) {
    if (stateName === 'speaking' || stateName === 'reacting') return budgetFps(ACTIVE_PIXEL_BUDGET, ACTIVE_FPS);
    if (stateName === 'hidden') return 2;
    return budgetFps(IDLE_PIXEL_BUDGET, IDLE_FPS);
  }

  /**
   * PIXI renders/updates the stage on its own ticker (60 fps by default) — the
   * adapter's fps cap alone only throttles parameter updates, so software WebGL
   * keeps compositing the whole transparent canvas at 60 fps. Cap PIXI's
   * tickers too: that is what actually saves CPU on this machine.
   */
  function applyPixiFps(fps) {
    try {
      const pixi = scope.PIXI;
      if (pixi && pixi.Ticker && pixi.Ticker.shared && typeof pixi.Ticker.shared === 'object') {
        pixi.Ticker.shared.maxFPS = fps;
      }
      const debug = (stage && stage.debug) || {};
      const renderer = debug.renderer;
      const app = renderer && renderer.app;
      if (app && app.ticker) {
        app.ticker.maxFPS = fps;
        if (typeof app.ticker.start === 'function' && app.ticker.started === false) app.ticker.start();
      }
    } catch (e) {
      /* ignore — ticker throttling is best effort */
    }
  }

  function applyPerf() {
    if (state.disposed) return;
    const st = currentStateName();
    perf.state = st;
    const fps = targetFpsFor(st);
    try {
      scope.__DSH_LIVE2D_FPS__ = fps;
      baseFpsOverrideSet = true;
    } catch (e) {
      /* ignore */
    }
    applyPixiFps(fps);
    if (perf.timer) {
      clearTimeout(perf.timer);
      perf.timer = 0;
    }
    if (st === 'recovering') {
      const remaining = Math.max(50, 700 - (Date.now() - perf.lastSpeechEndAt));
      perf.timer = setTimeout(applyPerf, remaining + 20);
    }
  }
  // start in idle mode (lower CPU from the first frame)
  applyPerf();

  // ---- liveliness ---------------------------------------------------------
  // The SDK's default motion style is deliberately gentle; the DSH pet wants
  // visible life: looking around, head turns/tilts, body sway and occasional
  // spontaneous expressions. All of it is CPU-side parameter animation (no
  // extra GPU work); the frame rate cap stays the only real cost.
  const liveliness = {
    motionStyle: {
      spontaneity: 1.5,
      gestureFrequency: 1.3,
      gazeStability: 0.42,
      blinkRate: 1.1,
      breathRate: 1.05,
      breathVariance: 0.55,
      microMotionGain: 1.5,
      idleActionGain: 1.5,
      avoidRepeatWindow: 4,
      // Very small audio accents: the LipSync accent toggles headZ left/right on
      // every loud syllable, which at 1.15 looked like mocap jitter. The smooth
      // sway below carries the "alive" feeling instead.
      speechAccentGain: 0.45,
      ...(cfg.motionStyle && typeof cfg.motionStyle === 'object' ? cfg.motionStyle : {}),
    },
    parameterGain: Number.isFinite(Number(cfg.parameterGain)) ? Number(cfg.parameterGain) : 1.8,
    bodyMotionGain: Number.isFinite(Number(cfg.bodyMotionGain)) ? Number(cfg.bodyMotionGain) : 1.6,
    idleMoods:
      Array.isArray(cfg.idleMoods) && cfg.idleMoods.length > 0
        ? cfg.idleMoods.filter((name) => typeof name === 'string')
        : Array.isArray(model.idleMoods) && model.idleMoods.length > 0
          ? model.idleMoods.filter((name) => typeof name === 'string')
          : [],
    idleMoodMinMs: Math.max(4000, Number(cfg.idleMoodMinMs) || 11000),
    idleMoodMaxMs: Math.max(6000, Number(cfg.idleMoodMaxMs) || 22000),
    idleMoodHoldMs: Math.max(1500, Number(cfg.idleMoodHoldMs) || 4200),
    // Gentle extra sine sway on top of the planned speech gestures. The planner
    // drives discrete nods/tilts/sways; this keeps a slow continuous drift under
    // them so the body never looks frozen between two planned gestures.
    // `gain` scales all channels; units are final Live2D parameter units.
    speechSway: {
      enabled: !(cfg.speechSway && cfg.speechSway.enabled === false),
      gain: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.gain)) ? Number(cfg.speechSway.gain) : 1.6,
      headX: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.headX)) ? Number(cfg.speechSway.headX) : 1.5,
      headY: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.headY)) ? Number(cfg.speechSway.headY) : 1.0,
      headZ: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.headZ)) ? Number(cfg.speechSway.headZ) : 2.4,
      bodyX: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.bodyX)) ? Number(cfg.speechSway.bodyX) : 1.0,
      bodyZ: Number.isFinite(Number(cfg.speechSway && cfg.speechSway.bodyZ)) ? Number(cfg.speechSway.bodyZ) : 1.6,
    },
    // 响度峰值驱动的“强调点头”（对上游 planner audioPeaks 的实时版实现）。
    // 上游的 `audioPeaks` 需要提前知道整段音频的峰值位置，而 TTS 包络是随播
    // 放实时到达的，没有前瞻；所以这里改成：包络一过阈值就触发一个平滑的
    // 升余弦脉冲（角度叠加），点头正好落在响度峰值上，并且用 0.5s 的宽脉冲
    // 而不是引擎原本 0.16s 的尖刺，不会变成“动捕抖”。
    speechPeakAccent: {
      enabled: !(cfg.speechPeakAccent && cfg.speechPeakAccent.enabled === false),
      threshold: Number.isFinite(Number(cfg.speechPeakAccent && cfg.speechPeakAccent.threshold)) ? Number(cfg.speechPeakAccent.threshold) : 0.55,
      minIntervalMs: Math.max(120, Number(cfg.speechPeakAccent && cfg.speechPeakAccent.minIntervalMs) || 420),
      durationMs: Math.max(180, Number(cfg.speechPeakAccent && cfg.speechPeakAccent.durationMs) || 520),
      headY: Number.isFinite(Number(cfg.speechPeakAccent && cfg.speechPeakAccent.headY)) ? Number(cfg.speechPeakAccent.headY) : 3.2,
      headZ: Number.isFinite(Number(cfg.speechPeakAccent && cfg.speechPeakAccent.headZ)) ? Number(cfg.speechPeakAccent.headZ) : 1.6,
      bodyY: Number.isFinite(Number(cfg.speechPeakAccent && cfg.speechPeakAccent.bodyY)) ? Number(cfg.speechPeakAccent.bodyY) : 1.2,
    },
  };

  // TTS emotion -> engine VAD preset (mirrors the adapter's DEFAULT_TTS_EMOTION_MAP).
  // Mid-utterance emotion changes are applied as a smooth VAD blend instead of a
  // full emotion intent, so the speech performance is never restarted mid-sentence.
  const SPEECH_EMOTION_PRESET = {
    默认: 'neutral',
    中性: 'neutral',
    亲切: 'affectionate',
    亲昵: 'affectionate',
    温柔: 'affectionate',
    强调: 'excited',
    刻意强调: 'excited',
    否认: 'confused',
    否定: 'confused',
    反驳: 'confused',
    开心: 'happy',
    高兴: 'happy',
    兴奋: 'excited',
    害羞: 'shy',
    好奇: 'curious',
    困惑: 'confused',
    疲惫: 'tired',
    累: 'tired',
    难过: 'sad',
    悲伤: 'sad',
    焦虑: 'anxiety',
    紧张: 'anxiety',
    关切: 'concerned',
    关心: 'concerned',
  };
  const VAD_PRESETS = {
    neutral: { valence: 0, arousal: 0, dominance: 0 },
    calm: { valence: 0.25, arousal: -0.45, dominance: 0.2 },
    happy: { valence: 0.75, arousal: 0.45, dominance: 0.35 },
    excited: { valence: 0.85, arousal: 0.85, dominance: 0.45 },
    shy: { valence: 0.35, arousal: 0.6, dominance: -0.45 },
    affectionate: { valence: 0.65, arousal: 0.1, dominance: 0.1 },
    curious: { valence: 0.35, arousal: 0.55, dominance: 0.2 },
    confused: { valence: -0.1, arousal: 0.35, dominance: -0.3 },
    tired: { valence: -0.25, arousal: -0.7, dominance: -0.3 },
    sad: { valence: -0.65, arousal: -0.45, dominance: -0.5 },
    anxiety: { valence: -0.6, arousal: 0.7, dominance: -0.55 },
    concerned: { valence: -0.18, arousal: 0.28, dominance: -0.2 },
  };

  function soullinkRuntime() {
    try {
      return (stage.debug && stage.debug.runtime) || null;
    } catch (e) {
      return null;
    }
  }

  function runtimeSeconds() {
    try {
      const stats = stage.stats();
      const seconds = stats && Number(stats.runtimeTimeSeconds);
      if (Number.isFinite(seconds)) return seconds;
    } catch (e) {
      /* fall through */
    }
    return 0;
  }

  function wallSeconds() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  // ---- loudness-peak accents ------------------------------------------------
  // Real-time stand-in for the planner's `audioPeaks` input: the TTS envelope
  // arrives while the audio plays (no lookahead), so instead of placing planned
  // gesture beats on future peaks we trigger a smooth raised-cosine impulse the
  // moment the envelope crosses the threshold. The nod therefore lands on the
  // loud syllable, but lasts ~0.5 s instead of the engine's 0.16 s spike.
  const peakAccents = [];
  let lastPeakAccentAt = 0;
  let peakAccentDirection = 1;

  function feedEnvelopePeaks(frames) {
    const accent = liveliness.speechPeakAccent;
    if (!accent || !accent.enabled || !perf.speaking || !frames || !frames.length) return;
    let peak = 0;
    for (const value of frames) {
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    if (peak < accent.threshold) return;
    const now = wallSeconds();
    if (now - lastPeakAccentAt < accent.minIntervalMs / 1000) return;
    lastPeakAccentAt = now;
    peakAccentDirection = -peakAccentDirection;
    const headroom = Math.max(0.15, 1 - accent.threshold);
    const strength = Math.max(0.25, Math.min(1, (peak - accent.threshold) / headroom + 0.25));
    peakAccents.push({ at: now, strength, direction: peakAccentDirection });
    if (peakAccents.length > 8) peakAccents.shift();
  }

  function applyLiveliness() {
    try {
      const debug = stage.debug || {};
      const runtime = debug.runtime;
      if (!runtime) return;
      if (typeof runtime.setMotionStyle === 'function') runtime.setMotionStyle(liveliness.motionStyle);
      if (typeof runtime.setParameterGain === 'function') runtime.setParameterGain(liveliness.parameterGain);
      if (typeof runtime.setBodyMotionGain === 'function') runtime.setBodyMotionGain(liveliness.bodyMotionGain);
      if (typeof runtime.setProactiveRepeatEnabled === 'function') runtime.setProactiveRepeatEnabled(false);
      installSpeechTuning(runtime, debug);
      emit({ kind: 'liveliness', phase: 'liveliness', backend: 'soullink', motionStyle: liveliness.motionStyle });
    } catch (e) {
      emit({ kind: 'log', phase: 'log', message: 'liveliness tuning failed: ' + String(e && e.message) });
    }
  }

  /**
   * Keep the engine in SPEAKING while the TTS audio is playing, and add the
   * slow "speaking sway" on top of the rendered parameters.
   *
   * 1) The engine ends the speech phase when its own duration estimate expires;
   *    real utterances often run longer, and falling back to IDLE mid-sentence
   *    flips the body from the speech pose to idle sway (the "stiff then jerky"
   *    complaint). The host knows when speech really ends (`speakEnd`), so we
   *    re-enter SPEAKING whenever the engine drops to IDLE while a voice is
   *    still active. A long extension avoids repeated re-entry transitions.
   * 2) In SPEAKING the engine damps its own idle head/body sway, leaving the body
   *    almost frozen (the "stiff" half of the complaint). The LipSync accent
   *    adds a fast left/right head toggle on every loud syllable instead, which
   *    reads as mocap jitter. So: shrink the accent (speechAccentGain) and add a
   *    smooth, slow sine sway on top of the final parameters — sine cannot twitch.
   *    The sway fades in/out over ~1s so the speech start/end never snaps.
   */
  function installSpeechTuning(runtime, debug) {
    if (!runtime || runtime.__dshSpeechTuning) return;
    const update = typeof runtime.update === 'function' ? runtime.update.bind(runtime) : null;
    const startSpeechMotion = typeof runtime.startSpeechMotion === 'function' ? runtime.startSpeechMotion.bind(runtime) : null;
    if (!update) return;

    const sway = liveliness.speechSway;
    const swayEnabled = !!(sway && sway.enabled) && Number(sway.gain) > 0;
    const swayGain = swayEnabled ? Math.max(0, Number(sway.gain) || 0) : 0;
    const renderer = debug && debug.renderer;
    let swayAmp = 0;
    let lastFrameAt = 0;

    // Final-parameter low pass. The engine already smooths its targets, but an
    // emotion switch replaces the expression archetype instantly (peak FACS held
    // at 0.82 weight), and those archetypes contain head channels scaled ×30 —
    // i.e. a 4–6° head snap on every TTS segment boundary. The engine's own 8/s
    // smoothing only softens that to ~1.2°/frame at 30 fps, which still reads as
    // a twitch. A slightly slower low pass here turns it into a natural head turn,
    // and it also absorbs the LipSync accent's left/right toggling.
    const SMOOTH_IDS = {
      ParamAngleX: 0.18,
      ParamAngleY: 0.18,
      ParamAngleZ: 0.18,
      ParamBodyAngleX: 0.18,
      ParamBodyAngleY: 0.18,
      ParamBodyAngleZ: 0.18,
      ParamMouthForm: 0.14,
      ParamEyeBallX: 0.18,
      ParamEyeBallY: 0.18,
    };
    const smoothedParams = {};

    if (renderer && typeof renderer.setParameters === 'function') {
      const applyParameters = renderer.setParameters.bind(renderer);
      // The adapter's native-expression overlay keeps the *previous* overlay
      // weight when it swaps exp3 files (activateExpression: weight = old weight),
      // so 爱心眼 -> 开心兴奋 pops instantly at a segment boundary. Re-fade every
      // new overlay from 0 here; same-entry frames pass the adapter weight through.
      let overlayEntries = null;
      let overlayFade = 1;
      let overlayAt = 0;
      if (typeof renderer.setExpressionOverlay === 'function' && typeof renderer.clearExpressionOverlay === 'function') {
        const applyOverlay = renderer.setExpressionOverlay.bind(renderer);
        const clearOverlay = renderer.clearExpressionOverlay.bind(renderer);
        renderer.setExpressionOverlay = (entries, weight) => {
          const at = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
          const dt = overlayAt > 0 ? Math.min(0.2, Math.max(0, at - overlayAt)) : 1 / 30;
          overlayAt = at;
          if (entries !== overlayEntries) {
            overlayEntries = entries;
            overlayFade = 0;
          }
          overlayFade += (1 - overlayFade) * (1 - Math.exp(-dt / 0.15));
          const w = Math.min(1, Math.max(0, typeof weight === 'number' ? weight : 1));
          applyOverlay(entries, w * overlayFade);
        };
        renderer.clearExpressionOverlay = () => {
          overlayEntries = null;
          overlayFade = 1;
          clearOverlay();
        };
        renderer.__dshExpressionFade = true;
      }
      renderer.setParameters = (params) => {
        if (!params || typeof params !== 'object') return applyParameters(params);
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
        const dt = lastFrameAt > 0 ? Math.min(0.15, Math.max(0, now - lastFrameAt)) : 1 / 30;
        lastFrameAt = now;

        const out = Object.assign({}, params);
        for (const id of Object.keys(SMOOTH_IDS)) {
          const raw = params[id];
          if (typeof raw !== 'number') continue;
          const tau = SMOOTH_IDS[id];
          const previous = typeof smoothedParams[id] === 'number' ? smoothedParams[id] : raw;
          const alpha = 1 - Math.exp(-dt / tau);
          const next = previous + (raw - previous) * alpha;
          smoothedParams[id] = next;
          out[id] = next;
        }

        if (swayGain > 0) {
          const target = perf.speaking ? 1 : 0;
          const tau = target > swayAmp ? 0.7 : 1.0;
          swayAmp += (target - swayAmp) * Math.min(1, dt / tau);
          if (swayAmp > 0.004) {
            const add = (id, value) => {
              const offset = value * swayAmp;
              if (!Number.isFinite(offset)) return;
              out[id] = (typeof out[id] === 'number' ? out[id] : 0) + offset;
            };
            const w = Math.PI * 2;
            // Distinct slow frequencies per channel: nothing pulses in sync, so the
            // motion reads as a wandering body rather than a machine oscillation.
            add('ParamAngleX', sway.headX * swayGain * Math.sin(now * w * 0.085 + 0.4));
            add('ParamAngleY', sway.headY * swayGain * Math.sin(now * w * 0.061 + 2.1));
            add('ParamAngleZ', sway.headZ * swayGain * (Math.sin(now * w * 0.112 + 4.0) + 0.35 * Math.sin(now * w * 0.031 + 1.7)));
            add('ParamBodyAngleX', sway.bodyX * swayGain * Math.sin(now * w * 0.047 + 1.1));
            add('ParamBodyAngleZ', sway.bodyZ * swayGain * Math.sin(now * w * 0.073 + 5.2));
          }
        }

        // Loudness-peak accents: smooth raised-cosine nod/bump on each detected
        // syllable peak (real-time stand-in for the planner's audioPeaks).
        if (peakAccents.length > 0) {
          const accent = liveliness.speechPeakAccent;
          const duration = Math.max(0.18, accent.durationMs / 1000);
          let headY = 0;
          let headZ = 0;
          let bodyY = 0;
          while (peakAccents.length > 0 && now - peakAccents[0].at > duration) peakAccents.shift();
          for (const item of peakAccents) {
            const age = now - item.at;
            if (age < 0 || age > duration) continue;
            const shape = Math.sin(Math.PI * (age / duration));
            headY += accent.headY * item.strength * shape;
            headZ += accent.headZ * item.strength * shape * item.direction;
            bodyY += accent.bodyY * item.strength * shape;
          }
          const addOffset = (id, value) => {
            if (!Number.isFinite(value) || value === 0) return;
            out[id] = (typeof out[id] === 'number' ? out[id] : 0) + value;
          };
          addOffset('ParamAngleY', headY);
          addOffset('ParamAngleZ', headZ);
          addOffset('ParamBodyAngleY', bodyY);
        }
        return applyParameters(out);
      };
      renderer.__dshSpeechSway = true;
    }

    runtime.update = (timeSeconds, deltaSeconds) => {
      let snapshot = update(timeSeconds, deltaSeconds);
      if (perf.speaking && startSpeechMotion && snapshot && snapshot.state === 'IDLE') {
        try {
          // 30 s, not 6 s: every re-entry is a state transition, and repeating
          // it every few seconds would itself become a visible snap.
          startSpeechMotion(undefined, timeSeconds, 30);
          snapshot = update(timeSeconds, deltaSeconds);
        } catch (e) {
          /* keep-alive is best effort */
        }
      }
      return snapshot;
    };
    runtime.__dshSpeechTuning = true;
  }

  // Idle moods: occasionally trigger a soft emotion so the native exp3 layer
  // (爱心眼 / 开心兴奋 / 问号 ...) and the FACS layer change on their own.
  // They never fight TTS: a host emotion, a speech start or a recent TTS
  // segment cancels the mood immediately.
  let lastHostEmotionAt = 0;
  let moodTimer = 0;
  let moodResetTimer = 0;
  let internalMood = false;
  let idleMoodTriggers = 0;

  function nextMoodDelay() {
    const min = liveliness.idleMoodMinMs;
    const max = Math.max(min + 1000, liveliness.idleMoodMaxMs);
    return min + Math.random() * (max - min);
  }

  function clearIdleMood(reset) {
    if (moodTimer) {
      clearTimeout(moodTimer);
      moodTimer = 0;
    }
    if (moodResetTimer) {
      clearTimeout(moodResetTimer);
      moodResetTimer = 0;
    }
    if (reset !== false && internalMood) {
      internalMood = false;
    }
  }

  function scheduleIdleMood(delay) {
    if (state.disposed || liveliness.idleMoods.length === 0) return;
    if (moodTimer) clearTimeout(moodTimer);
    moodTimer = setTimeout(() => {
      moodTimer = 0;
      fireIdleMood();
    }, Math.max(1000, delay === undefined ? nextMoodDelay() : delay));
  }

  function fireIdleMood() {
    if (state.disposed) return;
    if (!state.visible || perf.speaking || Date.now() - lastHostEmotionAt < 8000) {
      scheduleIdleMood(4000);
      return;
    }
    const moods = liveliness.idleMoods;
    const mood = moods[Math.floor(Math.random() * moods.length)];
    const intensity = 0.3 + Math.random() * 0.15;
    internalMood = true;
    idleMoodTriggers += 1;
    try {
      stage.setEmotion(mood, intensity, { smooth: true });
    } catch (e) {
      internalMood = false;
      scheduleIdleMood();
      return;
    }
    emit({ kind: 'idle-mood', phase: 'idle-mood', message: mood, backend: 'soullink' });
    moodResetTimer = setTimeout(() => {
      moodResetTimer = 0;
      if (state.disposed) return;
      internalMood = false;
      if (perf.speaking || Date.now() - lastHostEmotionAt < 8000) {
        scheduleIdleMood(6000);
        return;
      }
      try {
        stage.setEmotion('默认', 0.2, { smooth: true });
      } catch (e) {
        /* ignore */
      }
      scheduleIdleMood();
    }, liveliness.idleMoodHoldMs);
  }

  const impl = {
    backend: 'soullink',
    ready,
    get model() {
      return stage;
    },
    get canvas() {
      return state.canvas;
    },
    container,
    config: cfg,
    get raw() {
      return { soullink: stage };
    },
    setVisible(visible) {
      state.visible = !!visible;
      stage.setVisible(state.visible);
      applyPerf();
      return state.visible;
    },
    /**
     * Called after the window was occluded/minimised: the adapter re-arms its
     * rAF loop and drops the stale envelope backlog. No-op on older adapter
     * builds that only implement setVisible().
     */
    resume() {
      try {
        if (typeof stage.resume === 'function') stage.resume();
        else if (state.visible) stage.setVisible(true);
      } catch (e) {
        emit({ kind: 'log', phase: 'log', message: 'resume failed: ' + String(e && e.message) });
      }
      applyPerf();
      return true;
    },
    setScale(scale) {
      stage.setScale(Number(scale) || 1);
      return Number(scale) || 1;
    },
    setPosition(anchor, offsetX, offsetY) {
      try {
        stage.setPosition(anchor, offsetX, offsetY);
      } catch (e) {
        emit({ kind: 'log', phase: 'log', message: 'setPosition failed: ' + String(e && e.message) });
      }
      return { anchor, offsetX, offsetY };
    },
    setAnchor(anchor) {
      return impl.setPosition(anchor, 0, 0);
    },
    setEmotion(name, intensity, options) {
      if (!internalMood) {
        lastHostEmotionAt = Date.now();
        clearIdleMood();
      }
      const opts = options && typeof options === 'object' ? options : undefined;
      stage.setEmotion(String(name), intensity === undefined ? 1 : Number(intensity), opts);
      perf.emotionUntil = Date.now() + 2000;
      applyPerf();
      return { requested: String(name), intensity: intensity === undefined ? 1 : Number(intensity), backend: 'soullink', smooth: !!opts?.smooth };
    },
    clearEmotion() {
      if (!internalMood) {
        lastHostEmotionAt = Date.now();
        clearIdleMood();
      }
      try {
        stage.setEmotion('默认', 0, { smooth: true });
      } catch (e) {
        /* ignore */
      }
      perf.emotionUntil = 0;
      applyPerf();
    },
    speakStart(opts) {
      // A real TTS segment always wins over an idle mood.
      lastHostEmotionAt = Date.now();
      clearIdleMood(false);
      const o = opts || {};
      const duration = Number(o.durationSeconds);
      stage.speakStart({
        emotion: o.emotion,
        text: o.text,
        intensity: o.intensity,
        // The whole-utterance estimate keeps the engine out of IDLE until the
        // audio really ends (the adapter also plans the speech gestures from it).
        durationSeconds: Number.isFinite(duration) && duration > 0.4 ? Math.min(120, duration) : undefined,
      });
      latencyPrepended = false;
      perf.speaking = true;
      perf.lastSpeechEndAt = 0;
      perf.speechEmotion = o.emotion ? String(o.emotion) : '';
      // Legacy adapter builds (no speech-performance planner) estimate the
      // utterance duration from the first segment text only; override it here so
      // the engine does not fall back to idle mid-utterance. With the planner
      // build the adapter already handles this and the plan must not be cleared.
      if (typeof stage.speakSegment !== 'function' && Number.isFinite(duration) && duration > 0.4) {
        const runtime = soullinkRuntime();
        if (runtime && typeof runtime.startSpeechMotion === 'function') {
          try {
            runtime.startSpeechMotion(undefined, runtimeSeconds(), Math.min(120, duration));
          } catch (e) {
            /* duration override is best effort */
          }
        }
      }
      // Watchdog: if the host's speak_end is lost (window connected mid-speech,
      // SSE hiccup, injected test, ...) the engine must not stay in a speech
      // emotion forever. Estimate the utterance length and force an end.
      if (perf.speechWatchdog) clearTimeout(perf.speechWatchdog);
      const estimatedMs = Number.isFinite(duration) && duration > 0
        ? Math.min(180000, Math.max(duration * 1000 * 1.6 + 8000, 20000))
        : Math.min(180000, 25000 + String(o.text || '').length * 350);
      perf.speechWatchdog = setTimeout(() => {
        perf.speechWatchdog = 0;
        if (perf.speaking) impl.speakEnd();
      }, estimatedMs);
      applyPerf();
      return impl;
    },
    /**
     * Apply the next TTS segment of the running utterance.
     *
     * The adapter plans a native gesture block (nod / tilt / sway / emphasis from
     * the Soullink SpeechPerformancePlanner) for this segment, appends it to the
     * running speech-performance queue and switches the emotion (native exp3 +
     * VAD + reaction). That is the SDK's intended "连贯语音动作" path — without it
     * the engine only has damped idle motion while it talks.
     *
     * Older adapter builds without `speakSegment` fall back to the previous
     * behavior (full intent + immediate return to SPEAKING, or a VAD-only blend).
     */
    speakSegment(opts) {
      const o = opts || {};
      const requested = o.emotion === undefined || o.emotion === null ? '默认' : String(o.emotion);
      const value = o.intensity === undefined ? 0.85 : Number(o.intensity);
      if (!perf.speaking) return impl.setEmotion(requested, value);
      if (perf.speechEmotion === requested && !o.text) {
        return { requested, intensity: value, backend: 'soullink', mode: 'planner', applied: false };
      }
      if (typeof stage.speakSegment === 'function') {
        try {
          stage.speakSegment({
            emotion: requested,
            text: o.text === undefined ? '' : String(o.text),
            intensity: value,
            durationMs: Number.isFinite(Number(o.durationMs)) ? Number(o.durationMs) : undefined,
          });
          perf.speechEmotion = requested;
          lastHostEmotionAt = Date.now();
          perf.emotionUntil = Date.now() + 2000;
          return { requested, intensity: value, backend: 'soullink', mode: 'planner', applied: true };
        } catch (e) {
          emit({ kind: 'log', phase: 'log', message: 'speech segment plan failed: ' + String(e && e.message) });
        }
      }
      return impl.speakEmotion(requested, value);
    },
    speakEmotion(name, intensity) {
      const requested = name === undefined || name === null ? '默认' : String(name);
      const value = intensity === undefined ? 0.85 : Number(intensity);
      if (!perf.speaking) return impl.setEmotion(requested, value);
      if (perf.speechEmotion === requested) {
        return { requested, intensity: value, backend: 'soullink', mode: 'expression', applied: false };
      }
      const runtime = soullinkRuntime();
      const wantedMode = String((cfg.speechEmotionMode || 'expression')).toLowerCase();
      if (wantedMode !== 'vad' && runtime && typeof runtime.startSpeechMotion === 'function') {
        try {
          stage.setEmotion(requested, value, { smooth: true });
          // Same frame: back to SPEAKING with a long duration. The engine now
          // holds the new expression; the parameter smoother carries the face
          // over, and the native exp3 crossfades in the adapter.
          runtime.startSpeechMotion(undefined, runtimeSeconds(), 30);
          perf.speechEmotion = requested;
          lastHostEmotionAt = Date.now();
          perf.emotionUntil = Date.now() + 2000;
          return { requested, intensity: value, backend: 'soullink', mode: 'expression', applied: true };
        } catch (e) {
          emit({ kind: 'log', phase: 'log', message: 'speech emotion switch failed: ' + String(e && e.message) });
        }
      }
      const preset = SPEECH_EMOTION_PRESET[requested];
      const vad = preset ? VAD_PRESETS[preset] : VAD_PRESETS.neutral;
      if (!runtime || typeof runtime.applyVADTarget !== 'function' || !vad) {
        return impl.setEmotion(requested, value);
      }
      try {
        // Fallback: move the VAD target part-way so the face mood glides without
        // a native expression change.
        runtime.applyVADTarget(vad, 0.35);
      } catch (e) {
        return impl.setEmotion(requested, value);
      }
      perf.speechEmotion = requested;
      lastHostEmotionAt = Date.now();
      return {
        requested,
        intensity: value,
        backend: 'soullink',
        mode: 'vad',
        applied: true,
      };
    },
    /**
     * @param {number[]} frames RMS envelope frames (0..1)
     * @param {number|object} [hopMsOrOpts] hop ms (default 20) or options object
     * @param {{latencyMs?:number}} [options] host-reported audio output latency
     */
    pushEnvelope(frames, hopMsOrOpts, options) {
      const second = hopMsOrOpts;
      const hop =
        typeof second === 'number'
          ? second
          : second && typeof second === 'object'
            ? second.hopMs
            : undefined;
      const opts = Object.assign(
        {},
        second && typeof second === 'object' ? second : null,
        options && typeof options === 'object' ? options : null
      );
      if (!frames || !frames.length) return impl;
      const latency =
        typeof opts.latencyMs === 'number'
          ? Math.max(0, opts.latencyMs)
          : Math.max(0, Number(cfg.lipSync && cfg.lipSync.audioLatencyMs) || 0);
      if (typeof opts.latencyMs === 'number') {
        // remember it so stats()/later chunks reflect the host-reported value
        cfg.lipSync = Object.assign({}, cfg.lipSync, { audioLatencyMs: latency });
      }
      const hopMs = hop === undefined ? 20 : hop;
      let out = frames;
      if (latency > 0 && !latencyPrepended) {
        // The Soullink analyzer consumes frames on its own render clock; shift
        // the mouth by `latency` by feeding silence first (once per speech).
        latencyPrepended = true;
        const zeros = new Array(Math.max(0, Math.round(latency / hopMs))).fill(0);
        out = zeros.concat(Array.from(frames));
      }
      stage.pushEnvelope(out, hopMs);
      // Loud-syllable accents (see feedEnvelopePeaks): triggered from the same
      // frames that drive the mouth, so they align with what is audible.
      feedEnvelopePeaks(frames);
      return impl;
    },
    speakEnd() {
      if (perf.speechWatchdog) {
        clearTimeout(perf.speechWatchdog);
        perf.speechWatchdog = 0;
      }
      // speak_done and speech_end both arrive for one utterance; ending twice
      // re-triggers the engine's recovery phase and shows up as a body jolt.
      if (perf.speaking) stage.speakEnd();
      perf.speaking = false;
      perf.speechEmotion = '';
      perf.lastSpeechEndAt = Date.now();
      latencyPrepended = false;
      applyPerf();
      return impl;
    },
    setAudioLatency(latencyMs) {
      const ms = Math.max(0, Number(latencyMs) || 0);
      cfg.lipSync = Object.assign({}, cfg.lipSync, { audioLatencyMs: ms });
      return ms;
    },
    setEnvelopeConfig() {
      // The Soullink adapter takes lip sync config at construction time only.
      return {};
    },
    playMotion(group, index, priority) {
      const debug = stage.debug;
      const renderer = debug && debug.renderer;
      if (renderer && typeof renderer.playMotion === 'function') {
        try {
          return Promise.resolve(renderer.playMotion(group, index, priority));
        } catch (e) {
          return Promise.resolve(false);
        }
      }
      return Promise.resolve(false);
    },
    setExpression(name) {
      return impl.setEmotion(name, 1);
    },
    resize(width, height) {
      const w = Math.max(1, Math.round(Number(width) || 0));
      const h = Math.max(1, Math.round(Number(height) || 0));
      try {
        if (container) {
          container.style.width = w + 'px';
          container.style.height = h + 'px';
        }
        if (state.canvas) {
          state.canvas.style.width = w + 'px';
          state.canvas.style.height = h + 'px';
        }
      } catch (e) {
        /* ignore */
      }
      // The pixel budget depends on the drawable size: adapt the frame cap now.
      applyPerf();
      return { width: w, height: h, limited: 'soullink backend keeps its internal canvas size' };
    },
    stats() {
      let s = null;
      try {
        s = stage.stats();
      } catch (e) {
        s = null;
      }
      const canvas = s && s.canvas;
      const mouth = s && typeof s.mouth === 'number' ? s.mouth : 0;
      const emotion = s && s.emotion ? s.emotion.requested || s.emotion.preset || null : null;
      return {
        backend: 'soullink',
        phase: s && s.ready ? 'ready' : 'loading',
        fps: (s && s.fps) || 0,
        frames: (s && s.frameCount) || 0,
        drawCalls: 0,
        drawCallsLastFrame: 0,
        avgRenderMs: 0,
        visible: state.visible,
        speaking: !!(s && s.envelope && s.envelope.speechActive),
        speechSeconds: (s && Math.round(s.runtimeTimeSeconds * 10) / 10) || 0,
        emotion,
        emotionDetail: s && s.emotion,
        mouth,
        width: (canvas && canvas.canvasWidth) || soullinkConfig.maxWidth,
        height: (canvas && canvas.canvasHeight) || soullinkConfig.maxHeight,
        dpr: (canvas && canvas.resolution) || 1,
        model: {
          file: model.modelFile,
          format: 'cubism4',
          expressions: expressions.length,
          motionGroups,
          hiddenParts: hiddenParts.length,
          baseWidth: 0,
          baseHeight: 0,
        },
        envelope: s && s.envelope
          ? {
              active: !!s.envelope.active,
              queued: s.envelope.pendingFrames || 0,
              total: 0,
              hopMs: s.envelope.hopMs || 20,
              level: s.envelope.level,
              peak: s.envelope.peak,
              delayMs: Math.max(0, Number(cfg.lipSync && cfg.lipSync.audioLatencyMs) || 0),
              droppedFrames: s.envelope.droppedFrames || 0,
              flushCount: s.envelope.flushCount || 0,
            }
          : null,
        currentState: perf.state,
        targetFps: targetFpsFor(perf.state),
        engineState: (s && s.state) || null,
        frameGapMs: (s && s.frameGapMs) || 0,
        frameGaps: (s && s.frameGaps) || 0,
        expressionsPreloaded: (s && s.expressionsPreloaded) || 0,
        emotionSwitch: (s && s.emotionSwitch) || { fullIntent: 0, smooth: 0, skipped: 0 },
        idleMoodEnabled: liveliness.idleMoods.length > 0,
        idleMoodTriggers: idleMoodTriggers,
        lipSync: {
          enabled: true,
          bufferMs: 0,
          startDelayMs: 0,
          audioLatencyMs: Math.max(0, Number(cfg.lipSync && cfg.lipSync.audioLatencyMs) || 0),
          // the Soullink analyzer smooths internally; values are informational
          attackTau: null,
          releaseTau: null,
          latencyPrependFrames: 0,
        },
        params: { mouthOpenY: { id: 'ParamMouthOpenY', value: mouth } },
        missingParameters: (s && s.missingParameters) || [],
        soullink: s,
      };
    },
    sampleParams() {
      let snapshot = null;
      try {
        snapshot = stage.debug && typeof stage.debug.getSnapshot === 'function' ? stage.debug.getSnapshot() : null;
      } catch (e) {
        /* ignore */
      }
      const params = (snapshot && snapshot.live2dParams) || {};
      const pick = (id) => (typeof params[id] === 'number' ? params[id] : null);
      return {
        mouthOpenY: pick('ParamMouthOpenY') ?? impl.stats().mouth,
        angleX: pick('ParamAngleX'),
        angleY: pick('ParamAngleY'),
        angleZ: pick('ParamAngleZ'),
        bodyX: pick('ParamBodyAngleX'),
        bodyY: pick('ParamBodyAngleY'),
        bodyZ: pick('ParamBodyAngleZ'),
        eyeBallX: pick('ParamEyeBallX'),
        eyeBallY: pick('ParamEyeBallY'),
        eyeLOpen: pick('ParamEyeLOpen'),
        breath: pick('ParamBreath'),
        mouthForm: pick('ParamMouthForm'),
      };
    },
    debugState() {
      let snapshot = null;
      try {
        snapshot = stage.debug && typeof stage.debug.getSnapshot === 'function' ? stage.debug.getSnapshot() : null;
      } catch (e) {
        /* ignore */
      }
      return {
        backend: 'soullink',
        stats: impl.stats(),
        snapshot,
        profileUrl,
        modelFile: model.modelFile,
      };
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      clearIdleMood(false);
      if (perf.speechWatchdog) {
        clearTimeout(perf.speechWatchdog);
        perf.speechWatchdog = 0;
      }
      if (perf.timer) {
        clearTimeout(perf.timer);
        perf.timer = 0;
      }
      try {
        if (baseFpsOverrideSet) delete scope.__DSH_LIVE2D_FPS__;
      } catch (e) {
        /* ignore */
      }
      try {
        stage.dispose();
      } catch (e) {
        console.warn(TAG, 'dispose failed', e);
      }
      emit({ kind: 'disposed', phase: 'disposed', backend: 'soullink' });
    },
  };

  return impl;
}



