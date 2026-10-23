/**
 * index.js — Live2D renderer public API (pixi.js 7 + pixi-live2d-display).
 *
 * This is the "direct" backend. It is designed to run in a transparent overlay
 * canvas (no background, no filters, small canvas, capped FPS/DPR) and to be
 * driven by a host that relays TTS RMS envelopes and emotion names.
 *
 * Public exports:
 *   createLive2DStage(options)  — create a stage bound to a <canvas>
 *   Stage                       — typedef/documentation helper (not a class)
 *   runtimeStatus()             — vendor runtime diagnostics
 *   detectFormat()              — model format detection helper
 *   syntheticEnvelope()         — demo/test envelope generator
 *   listEmotionNames()          — supported emotion names/aliases
 *   DEFAULT_EMOTION_MAP         — default emotion -> expression/motion/params map
 *   STANDARD_PARAMS             — logical parameter table
 *
 * See docs/RENDERER.md for the full API contract.
 */

import { getRuntime, runtimeStatus, ensureCore } from './runtime.js';
import { ParamAdapter, clamp, STANDARD_PARAMS } from './params.js';
import {
  resolveEmotion,
  DEFAULT_EMOTION_MAP,
  TEXT_EMOTION_CUES,
  listEmotionNames,
} from './emotions.js';
import { EnvelopePlayer, syntheticEnvelope } from './envelope.js';
import { loadModelAssets, joinUrl, detectFormat } from './assets.js';
import { hasSoullinkAdapter, createSoullinkBackend } from './backend-soullink.js';

export {
  runtimeStatus,
  detectFormat,
  syntheticEnvelope,
  listEmotionNames,
  DEFAULT_EMOTION_MAP,
  STANDARD_PARAMS,
};
export { detectFormat as detectModelFormat };

const TAG = '[live2d]';

const DEFAULT_CONFIG = {
  /** CSS pixel canvas size cap (CPU/GPU budget, see DESIGN.md §4.9). */
  width: 360,
  height: 520,
  /** render frame-rate cap; idle mode uses a lower cap to save CPU/GPU. */
  fps: 30,
  idleFps: 15,
  /** never render above 1 device pixel per CSS pixel. */
  devicePixelRatioCap: 1,
  /** transparent overlay is the whole point. */
  backgroundAlpha: 0,
  autoStart: false,
  antialias: false, // CPU/GPU: MSAA off by default (window/overlay); aliasing is acceptable at this size
  preserveDrawingBuffer: false,
  /** fit the model into the canvas. */
  autoFit: true,
  fitRatio: 0.98,
  scale: 1,
  /** normalized anchor inside the canvas + CSS pixel offsets. */
  anchor: { x: 0.5, y: 1 },
  offsetX: 0,
  offsetY: 0,
  /** lip sync tuning. */
  lipSync: {
    enabled: true,
    gain: 1,
    maxOpen: 1,
    // jitter buffer was 120ms (felt laggy); 40ms is enough for local SSE and
    // keeps the mouth close to the audio. attack/release are faster for the
    // same reason but still smooth enough to avoid flapping.
    bufferMs: 40,
    attackTau: 0.03,
    releaseTau: 0.07,
    underrunGraceMs: 220,
    mouthFormBias: 0.12,
    // extra constant delay before envelope playback (host/latency calibration)
    startDelayMs: 0,
    // host-reported audio *output* latency; may also be updated per envelope
    // chunk via pushEnvelope(frames, hopMs, {latencyMs}) or setAudioLatency(ms)
    audioLatencyMs: 0,
  },
  /** idle behaviour. */
  idle: {
    gaze: true,
    gazeIntervalMs: [2500, 6000],
    gazeRadius: 0.35,
    headWobble: true,
    motion: true,
  },
  /** procedural speaking gestures (CPU rules, see _queueSpeechGestures). */
  gestures: true,
  /** expression cross-fade time (ms). */
  expressionFadeMs: 220,
  emotionEaseMs: 260,
  /** collect fps/drawcall stats (tiny overhead, needed for acceptance). */
  collectStats: true,
  /** model descriptor overrides / extra "hide these prop parts" ids. */
  model: null,
};

function mergeConfig(base, over) {
  const out = JSON.parse(JSON.stringify(base));
  if (!over || typeof over !== 'object') return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = Object.assign({}, out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function nowMs() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

function ease(rate, dtMs) {
  return 1 - Math.exp(-Math.max(0, dtMs) / Math.max(1, rate));
}

/**
 * @typedef {object} Live2DStageOptions
 * @property {HTMLCanvasElement} canvas required
 * @property {{baseUrl:string, modelFile:string, format?:string,
 *             expressions?:Array, motions?:Array, hiddenParts?:string[]}} model
 * @property {object} [config] see DEFAULT_CONFIG
 * @property {(status:object)=>void} [onStatus] loading/ready/error/disposed events
 */

/**
 * Create a Live2D stage.
 *
 * The returned object is usable immediately; async work happens behind
 * `stage.ready`. Calls made before the model is ready (emotion, speaking,
 * envelopes) are buffered and applied once ready.
 *
 * @param {Live2DStageOptions} options
 * @returns {object} stage
 */
function createDirectStage(options) {
  if (!options || (!options.canvas && !options.container)) {
    throw new Error(`${TAG} createLive2DStage: canvas or container is required`);
  }
  if (!options.model || !options.model.baseUrl || !options.model.modelFile) {
    throw new Error(`${TAG} createLive2DStage: model.baseUrl and model.modelFile are required`);
  }
  // Accept both a ready-made <canvas> and a container element (the DSH client
  // glue hands us a div; the proto hands us a canvas).
  const container = options.container || null;
  let canvas = options.canvas || null;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'dsh-live2d-canvas';
    canvas.style.pointerEvents = 'none';
    container.appendChild(canvas);
  }
  // Size hints: explicit config > host descriptor > container box > defaults.
  const hintW =
    (options.config && Number(options.config.width)) ||
    Number(options.model.maxWidth) ||
    (container && container.clientWidth) ||
    DEFAULT_CONFIG.width;
  const hintH =
    (options.config && Number(options.config.height)) ||
    Number(options.model.maxHeight) ||
    (container && container.clientHeight) ||
    DEFAULT_CONFIG.height;
  const cfg = mergeConfig(DEFAULT_CONFIG, Object.assign({}, options.config, { width: hintW, height: hintH }));
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  // Accept both the phase (renderer) and kind (DSH client glue) naming.
  const emitStatus = (status) => {
    try {
      onStatus(Object.assign({ kind: status.phase }, status));
    } catch (e) {
      console.warn(TAG, 'onStatus handler threw', e);
    }
  };
  if (options.expressionMap) cfg.expressionMap = options.expressionMap;
  const modelDesc = Object.assign({}, options.model);
  if (cfg.model) Object.assign(modelDesc, cfg.model);
  const optsAssets = options.assets || null;

  const state = {
    phase: 'init',
    ready: false,
    visible: true,
    disposed: false,
    speaking: false,
    emotion: null,
    error: null,
    backend: 'direct',
    frames: 0,
    drawCalls: 0,
    frameDrawCalls: 0,
    fps: 0,
    lastRenderMs: 0,
    avgRenderMs: 0,
    lastApplyAt: 0,
    speakStartedAt: 0,
    speakEndedAt: 0,
    gestureQueue: [],
    pending: [],
  };

  let app = null;
  let model = null;
  let assets = null;
  let adapter = null;
  let internal = null;
  let envelope = null;
  let rafId = 0;
  let running = false;
  let lastFrameAt = 0;
  let lastStatsAt = 0;
  let statsFrames = 0;
  let glPatched = false;
  let gl = null;
  let origDrawElements = null;
  let origDrawArrays = null;

  // Expressions: at most ONE is active at a time. Switching fades the old one
  // out completely before the next fades in. Overlapping expressions add their
  // parameters (exp3 "Add" blends toggle eye/face overlay drawables such as the
  // heart pupils), so a cross-fade showed both overlays half-transparent — the
  // ghost double eyes seen when the idle moods switched automatically.
  const activeExpressions = [];
  let pendingExpression = null;
  let expressionCache = new Map();
  let expressionLookup = new Map();

  // eased emotion parameter offsets (logical/raw key -> current value)
  const emotionCurrent = new Map();
  let emotionTarget = new Map();
  let emotionKey = null;
  let emotionIntensity = 1;

  // idle scheduling
  let nextGazeAt = 0;
  const gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  let idleMotionTimer = 0;

  // gesture pulses: [{key, value, t0, durationMs}]
  const gesturePulses = [];

  const stage = {
    // -------- data --------
    canvas,
    container,
    config: cfg,
    backend: 'direct',
    /** @type {Promise<object>} resolves with the stage when ready */
    ready: null,
    model: null,

    // -------- lifecycle --------
    setVisible,
    resume,
    setScale,
    setPosition,
    setAnchor,
    setEmotion,
    clearEmotion,
    speakStart,
    pushEnvelope,
    speakEnd,
    setEnvelopeConfig,
    setAudioLatency,
    playMotion,
    setExpression,
    resize,
    stats,
    debugState,
    sampleParams,
    dispose,
    /** internal: direct backend object (pixi) for advanced hosts/tests */
    get raw() {
      return { app, model, internalModel: internal, adapter, assets };
    },
  };

  stage.ready = init();
  return stage;

  // ==========================================================================
  // init
  // ==========================================================================
  async function init() {
    try {
      emitStatus({ phase: 'loading', message: 'loading Live2D runtime', model: modelDesc });
      const { PIXI, Live2D } = getRuntime();
      const format = detectFormat(modelDesc.modelFile, modelDesc.format);
      ensureCore(format);

      // ---- canvas sizing (CSS pixels; DPR capped) ----
      const dpr = Math.min(
        cfg.devicePixelRatioCap,
        (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      );
      const width = Math.max(1, Math.round(cfg.width));
      const height = Math.max(1, Math.round(cfg.height));
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      canvas.style.display = 'block';
      canvas.style.background = 'transparent';
      canvas.style.backgroundColor = 'transparent';
      if (canvas.width !== width * dpr) canvas.width = Math.round(width * dpr);
      if (canvas.height !== height * dpr) canvas.height = Math.round(height * dpr);
      // WebGL context creation + renderer
      app = new PIXI.Application({
        view: canvas,
        width,
        height,
        resolution: dpr,
        autoDensity: false,
        backgroundAlpha: cfg.backgroundAlpha,
        backgroundColor: 0x000000,
        transparent: true,
        antialias: !!cfg.antialias,
        autoStart: false,
        sharedTicker: false,
        preserveDrawingBuffer: !!cfg.preserveDrawingBuffer,
        powerPreference: 'low-power',
        hello: false,
      });
      app.renderer.clear();
      app.stage.alpha = 1;

      // ---- model assets + creation ----
      assets = optsAssets || (await loadModelAssets(modelDesc));
      emitStatus({
        phase: 'model',
        message: 'loading model',
        format: assets.format,
        modelUrl: assets.modelUrl,
        expressions: assets.expressions.length,
        motions: assets.motions.length,
        hiddenParts: assets.hiddenParts.length,
      });

      model = await Live2D.Live2DModel.from(assets.settings, {
        autoUpdate: false,
        autoHitTest: false,
        autoFocus: false,
      });
      internal = model.internalModel;
      const coreModel = internal.coreModel;
      adapter = new ParamAdapter(coreModel, assets.format);

      // ---- expression bookkeeping ----
      expressionLookup = new Map();
      for (const e of assets.expressions) {
        expressionLookup.set(String(e.name).toLowerCase(), e);
      }
      if (!assets.expressions.length && internal.motionManager && internal.motionManager.expressionManager) {
        const defs = internal.motionManager.expressionManager.definitions || [];
        defs.forEach((def, index) => {
          const name = def.Name || def.name || String(index);
          const file = def.File || def.file || '';
          expressionLookup.set(String(name).toLowerCase(), {
            name,
            file,
            url: file ? joinUrl(modelDesc.baseUrl, file) : null,
            index,
          });
        });
      }
      model.expression = async () => false; // never used: we blend exp3 ourselves

      // ---- stage attach + fit ----
      app.stage.addChild(model);
      fitModel();

      // ---- lip sync player ----
      envelope = new EnvelopePlayer({
        bufferMs: cfg.lipSync.bufferMs,
        attackTau: cfg.lipSync.attackTau,
        releaseTau: cfg.lipSync.releaseTau,
        underrunGraceMs: cfg.lipSync.underrunGraceMs,
        gain: cfg.lipSync.gain,
        startDelayMs: cfg.lipSync.startDelayMs || 0,
        audioLatencyMs: cfg.lipSync.audioLatencyMs || 0,
      });

      // ---- parameter hook (after motions/eyes/breath/physics/pose) ----
      hookModel(internal);

      // ---- optional: strip the model's own Idle motion ----
      // VTube-Studio exports often bake props / eye-style gimmicks into their
      // idle animation; those must not show up in a transparent overlay.
      // The manifest can request procedural-only idle for such models.
      if (assets.disableIdleMotion && internal.motionManager) {
        const mm = internal.motionManager;
        try {
          if (mm.definitions) mm.definitions.Idle = [];
          if (typeof mm.stopAllMotions === 'function') mm.stopAllMotions();
        } catch (e) {
          console.warn(TAG, 'failed to disable idle motion', e);
        }
      }

      // ---- stats / GL drawcall counter ----
      if (cfg.collectStats) patchGL(app);

      state.phase = 'ready';
      state.ready = true;
      stage.model = model;
      stage.backend = 'direct';
      emitStatus({
        phase: 'ready',
        backend: 'direct',
        format: assets.format,
        width,
        height,
        dpr,
        modelFile: modelDesc.modelFile,
        expressions: assets.expressions.map((e) => e.name),
        motionGroups: Object.keys(internal.motionManager.definitions || {}),
        hiddenParts: assets.hiddenParts,
        params: adapter.describe(),
      });

      // apply anything requested while loading
      const queued = state.pending.splice(0, state.pending.length);
      for (const fn of queued) {
        try {
          fn();
        } catch (e) {
          console.warn(TAG, 'pending call failed', e);
        }
      }
      if (state.visible) start();
      return stage;
    } catch (err) {
      state.phase = 'error';
      state.error = err;
      emitStatus({ phase: 'error', kind: 'error', message: String((err && err.message) || err), error: String((err && err.message) || err), cause: err });
      throw err;
    }
  }

  // ==========================================================================
  // model fitting / sizing
  // ==========================================================================
  function fitModel() {
    if (!model) return;
    const w = cfg.width;
    const h = cfg.height;
    const im = internal || model.internalModel;
    const baseW = im.width || im.originalWidth || 1;
    const baseH = im.height || im.originalHeight || 1;
    let scale = Math.min((w * cfg.fitRatio) / baseW, (h * cfg.fitRatio) / baseH);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    scale *= cfg.scale;
    model.scale.set(scale);
    model.anchor.set(cfg.anchor.x, cfg.anchor.y);
    model.position.set(w * cfg.anchor.x + cfg.offsetX, h * cfg.anchor.y + cfg.offsetY);
    model.visible = state.visible;
  }

  function setScale(value) {
    cfg.scale = Number(value) || 1;
    if (state.ready) fitModel();
    return cfg.scale;
  }

  function setPosition(anchor, value, valueY) {
    if (typeof anchor === 'string') {
      const map = {
        'bottom-right': { x: 1, y: 1 },
        'bottom-left': { x: 0, y: 1 },
        'bottom-center': { x: 0.5, y: 1 },
        'top-right': { x: 1, y: 0 },
        'top-left': { x: 0, y: 0 },
        'top-center': { x: 0.5, y: 0 },
        center: { x: 0.5, y: 0.5 },
        'center-bottom': { x: 0.5, y: 1 },
      };
      const a = map[anchor] || map['bottom-right'];
      cfg.anchor = { x: a.x, y: a.y };
    } else if (anchor && typeof anchor === 'object') {
      cfg.anchor = { x: Number(anchor.x) || 0, y: Number(anchor.y) || 0 };
    }
    if (value && typeof value === 'object') {
      if (typeof value.x === 'number') cfg.offsetX = value.x;
      if (typeof value.y === 'number') cfg.offsetY = value.y;
    } else if (typeof value === 'number') {
      // both call shapes are supported:
      //   setPosition(anchor, offsetX, offsetY)  (DSH client glue)
      //   setPosition(anchor, {x, y}) / setPosition(anchor, offsetX)
      cfg.offsetX = value;
      if (typeof valueY === 'number') cfg.offsetY = valueY;
    }
    if (state.ready) fitModel();
    return { anchor: cfg.anchor, offsetX: cfg.offsetX, offsetY: cfg.offsetY };
  }

  function setAnchor(anchor) {
    return setPosition(anchor, {});
  }

  function resize(width, height) {
    cfg.width = Math.max(1, Math.round(width || cfg.width));
    cfg.height = Math.max(1, Math.round(height || cfg.height));
    if (!state.ready || !app) return { width: cfg.width, height: cfg.height };
    const dpr = app.renderer.resolution || 1;
    canvas.style.width = cfg.width + 'px';
    canvas.style.height = cfg.height + 'px';
    canvas.width = Math.round(cfg.width * dpr);
    canvas.height = Math.round(cfg.height * dpr);
    app.renderer.resize(cfg.width, cfg.height);
    fitModel();
    return { width: cfg.width, height: cfg.height, dpr };
  }

  // ==========================================================================
  // render loop
  // ==========================================================================
  function start() {
    if (running || state.disposed || !state.ready) return;
    running = true;
    lastFrameAt = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /**
   * Coarse performance state used for frame-rate budgeting and `stats()`.
   *   hidden     — not visible: RAF stops entirely (0 fps)
   *   speaking   — lip sync active: full fps
   *   recovering — mouth release / speech tail: full fps while the mouth is
   *                still closing, then idleFps
   *   reacting   — expression / emotion / gesture: full fps
   *   idle       — breathing/blink/gaze only: idleFps
   */
  function currentStateName() {
    if (!state.visible) return 'hidden';
    if (state.speaking) return 'speaking';
    const mouth = stage.__lastMouth || 0;
    const envActive = !!(envelope && (envelope.active || envelope.queued > 0));
    if (envActive || mouth > 0.01) return 'recovering';
    if (activeExpressions.length || emotionTarget.size || gesturePulses.length) return 'reacting';
    if (state.speakEndedAt && nowMs() - state.speakEndedAt < 700) return 'recovering';
    return 'idle';
  }

  function targetFps() {
    const s = currentStateName();
    if (s === 'speaking' || s === 'reacting') return cfg.fps;
    if (s === 'recovering') {
      // keep full fps while the mouth is still visibly releasing; the tail of
      // the recovery window may already drop to the idle rate
      const mouth = stage.__lastMouth || 0;
      const envActive = !!(envelope && (envelope.active || envelope.queued > 0));
      if (envActive || mouth > 0.01) return cfg.fps;
      return cfg.idleFps || cfg.fps;
    }
    return Math.min(cfg.fps, cfg.idleFps || cfg.fps);
  }

  function tick(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    const now = typeof ts === 'number' ? ts : nowMs();
    const minDelta = 1000 / Math.max(1, targetFps()) - 1.5;
    if (lastFrameAt && now - lastFrameAt < minDelta) return;
    const dt = lastFrameAt ? Math.min(100, now - lastFrameAt) : 16.7;
    lastFrameAt = now;

    const t0 = nowMs();
    state.frameDrawCalls = 0;
    try {
      // pixi-live2d-display: model.update() only stores dt; the actual
      // internal model update happens in model._render() (called by app.render)
      model.update(dt);
      updateIdle(dt, now);
      app.render();
      state.frames++;
      statsFrames++;
    } catch (err) {
      console.warn(TAG, 'render failed', err);
    }
    state.lastRenderMs = nowMs() - t0;
    state.avgRenderMs = state.avgRenderMs
      ? state.avgRenderMs * 0.9 + state.lastRenderMs * 0.1
      : state.lastRenderMs;

    if (!lastStatsAt) lastStatsAt = now;
    if (now - lastStatsAt >= 1000) {
      state.fps = Math.round((statsFrames * 1000) / (now - lastStatsAt));
      statsFrames = 0;
      lastStatsAt = now;
    }
  }

  function updateIdle(dt, now) {
    if (!state.ready) return;
    // Idle gaze: pick a small random target every few seconds; the movement is
    // applied directly as *small* parameter offsets in applyParams() (we do not
    // use model.focus(): its world->model mapping can saturate head angles).
    if (cfg.idle.gaze) {
      if (!nextGazeAt) nextGazeAt = now + 600;
      if (now >= nextGazeAt) {
        const r = cfg.idle.gazeRadius;
        gaze.tx = (Math.random() * 2 - 1) * r;
        gaze.ty = (Math.random() * 2 - 1) * r * 0.55;
        const [lo, hi] = cfg.idle.gazeIntervalMs;
        nextGazeAt = now + lo + Math.random() * Math.max(1, hi - lo);
      }
    }
    // breathing is handled natively by pixi-live2d-display (Cubism breath).
    // Occasionally re-trigger the idle motion group to keep it lively (disabled
    // for models whose idle motion reveals props — see manifest.disableIdleMotion).
    if (cfg.idle.motion && !(assets && assets.disableIdleMotion) && internal && internal.motionManager) {
      idleMotionTimer += dt;
      const groups = internal.motionManager.definitions || {};
      const groupName = internal.motionManager.groups && internal.motionManager.groups.idle;
      if (groupName && Array.isArray(groups[groupName]) && groups[groupName].length) {
        const motionState = internal.motionManager.state;
        const should =
          motionState && typeof motionState.shouldRequestIdleMotion === 'function'
            ? motionState.shouldRequestIdleMotion()
            : false;
        if (should) {
          try {
            model.motion(groupName, undefined, 1 /* MotionPriority.IDLE */);
          } catch (e) {
            /* ignore */
          }
          idleMotionTimer = 0;
        }
      }
    }
  }

  // ==========================================================================
  // parameter application (called on every internal model update)
  // ==========================================================================
  function hookModel(internalModel) {
    const handler = () => applyParams();
    internalModel.on('beforeModelUpdate', handler);
    internalModel.__live2dBridge = { handler };
  }

  function applyParams() {
    if (!adapter) return;
    const now = nowMs();
    const dtMs = state.lastApplyAt ? Math.min(100, now - state.lastApplyAt) : 16.7;
    state.lastApplyAt = now;

    // 1) hidden prop/background parts (transparent character-only overlay)
    applyHiddenParts();

    // 2) expressions (single active expression, faded sequentially)
    applyExpressions(dtMs);

    // 3) emotion eased parameter offsets
    applyEmotionParams();

    // 4) procedural gesture pulses
    applyGesturePulses(now);

    // 5) idle micro-motion: gaze offsets + breathing-like sway (CPU only)
    applyIdleMotion(dtMs, now);

    // 6) lip sync
    applyLipSync(now);
  }

  function applyIdleMotion(dtMs, now) {
    if (cfg.idle.gaze) {
      const k = ease(220, dtMs);
      gaze.x += (gaze.tx - gaze.x) * k;
      gaze.y += (gaze.ty - gaze.y) * k;
      if (Math.abs(gaze.x) > 1e-3 || Math.abs(gaze.y) > 1e-3) {
        adapter.add('eyeBallX', gaze.x * 0.7);
        adapter.add('eyeBallY', gaze.y * 0.7);
        adapter.add('angleX', gaze.x * 4.5);
        adapter.add('angleY', gaze.y * 4.5);
        adapter.add('angleZ', -gaze.x * gaze.y * 2);
      }
    }
    if (cfg.idle.headWobble) {
      const t = now / 1000;
      // very slow breathing-like sway, always on (cheap sin only)
      adapter.add('angleZ', Math.sin(t * 0.61) * 0.6);
      adapter.add('bodyAngleX', Math.sin(t * 0.43) * 0.5);
    }
    if (state.speaking) {
      // gentle emphasis while talking
      const t = (now - state.speakStartedAt) / 1000;
      adapter.add('angleZ', Math.sin(t * 3.1) * 1.1);
    }
  }

  function applyHiddenParts() {
    const list = assets && assets.hiddenParts;
    if (!list || !list.length || !internal) return;
    const coreModel = internal.coreModel;
    for (const id of list) {
      try {
        if (typeof coreModel.setPartOpacityById === 'function') coreModel.setPartOpacityById(id, 0);
        else if (typeof coreModel.setPartsOpacity === 'function') coreModel.setPartsOpacity(id, 0);
      } catch (e) {
        /* part may not exist in this model */
      }
    }
  }

  function applyLipSync(now) {
    if (!cfg.lipSync.enabled) return;
    const v = envelope ? envelope.value(now) : 0;
    stage.__lastMouth = v;
    if (v <= 0.0001) return;
    const maxOpen = cfg.lipSync.maxOpen;
    adapter.set('mouthOpenY', clamp(v * maxOpen, 0, 1));
    const bias = cfg.lipSync.mouthFormBias * v;
    if (bias) adapter.add('mouthForm', bias);
  }

  function applyEmotionParams() {
    if (!emotionTarget.size) return;
    for (const [key, target] of emotionTarget) {
      let cur = emotionCurrent.get(key) || 0;
      cur += (target - cur) * 0.22;
      if (Math.abs(target - cur) < 0.001) cur = target;
      emotionCurrent.set(key, cur);
      if (cur) adapter.add(key, cur);
    }
  }

  function applyGesturePulses(now) {
    if (!gesturePulses.length) return;
    for (let i = gesturePulses.length - 1; i >= 0; i--) {
      const g = gesturePulses[i];
      const t = (now - g.t0) / g.durationMs;
      if (t >= 1) {
        gesturePulses.splice(i, 1);
        continue;
      }
      // fast attack, smooth release, single-period sine
      const env = Math.sin(Math.PI * clamp(t, 0, 1));
      const value = g.value * env * (g.attack === false ? 1 : 1);
      adapter.add(g.key, value);
    }
  }

  // ==========================================================================
  // expressions (exp3 applied by ourselves: intensity-aware cross-fade)
  // ==========================================================================
  async function ensureExpression(name) {
    const lookup = expressionLookup.get(String(name).toLowerCase());
    if (!lookup) return null;
    if (lookup.def) return lookup.def;
    if (expressionCache.has(lookup.url)) return expressionCache.get(lookup.url);
    if (!lookup.url) {
      // index-addressed native expression (settings JSON registered) — no file
      return null;
    }
    try {
      const json = await fetch(lookup.url, { cache: 'force-cache' }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
      const def = {
        name: lookup.name,
        params: Array.isArray(json.Parameters) ? json.Parameters : [],
      };
      expressionCache.set(lookup.url, def);
      lookup.def = def;
      return def;
    } catch (e) {
      console.warn(TAG, 'failed to load expression', lookup.name, e);
      return null;
    }
  }

  function applyExpressions(dtMs) {
    if (activeExpressions.length) {
      const fadeMs = Math.max(16, cfg.expressionFadeMs);
      const step = Math.max(0, Number.isFinite(dtMs) ? dtMs : 16.7) / fadeMs;
      for (let i = activeExpressions.length - 1; i >= 0; i--) {
        const item = activeExpressions[i];
        if (item.weight < item.target) item.weight = Math.min(item.target, item.weight + step);
        else if (item.weight > item.target) item.weight = Math.max(item.target, item.weight - step);
        if (item.weight <= 0.001 && item.target === 0) {
          activeExpressions.splice(i, 1);
          continue;
        }
        applyExpressionParams(item.def, item.weight);
      }
    }
    // Nothing on screen: start the queued expression. This guarantees a
    // single-expression transition — the old one is fully faded out first.
    if (activeExpressions.length === 0 && pendingExpression !== null) {
      const next = pendingExpression;
      pendingExpression = null;
      activeExpressions.push({ name: next.name, def: next.def, weight: 0, target: next.weight });
    }
  }

  function applyExpressionParams(def, weight) {
    if (!def || !def.params || !weight) return;
    for (const p of def.params) {
      const id = p.Id || p.id;
      const value = Number(p.Value !== undefined ? p.Value : p.value);
      if (!id || !Number.isFinite(value)) continue;
      const blend = String(p.Blend || p.blend || 'Add').toLowerCase();
      if (blend === 'multiply' || blend === 'mult') {
        adapter.multiply(id, 1 + (value - 1) * weight);
      } else if (blend === 'overwrite') {
        const cur = adapter.get(id);
        if (cur === null) continue;
        adapter.set(id, cur + (value - cur) * weight);
      } else {
        adapter.add(id, value * weight);
      }
    }
  }

  function setExpression(name, intensity) {
    const weight = clamp(intensity === undefined ? 1 : Number(intensity), 0, 1);
    if (!name) {
      pendingExpression = null;
      for (const item of activeExpressions) item.target = 0;
      return Promise.resolve(false);
    }
    const pending = (async () => {
      const def = await ensureExpression(name);
      if (!def) {
        pendingExpression = null;
        for (const item of activeExpressions) item.target = 0;
        return false;
      }
      const active = activeExpressions.find((i) => i.name === def.name);
      if (active) {
        // Same expression already on screen: just retarget its weight.
        active.target = weight;
        pendingExpression = null;
        return true;
      }
      // Queue the new expression; the old one fades out first and the queue
      // starts as soon as `activeExpressions` is empty (see applyExpressions).
      pendingExpression = { name: def.name, def, weight };
      for (const item of activeExpressions) item.target = 0;
      return true;
    })();
    state.pendingPromise = pending;
    return pending;
  }

  // ==========================================================================
  // emotion
  // ==========================================================================
  function setEmotion(name, intensity) {
    const apply = () => {
      const resolved = resolveEmotion(name, cfg.expressionMap);
      const weight = clamp(intensity === undefined ? 1 : Number(intensity), 0, 1);
      emotionKey = resolved.key;
      emotionIntensity = weight;
      state.emotion = resolved.key;
      const target = new Map();
      for (const [key, value] of Object.entries(resolved.params || {})) {
        target.set(key, Number(value) * weight);
      }
      emotionTarget = target;

      // expression layer: first candidate that the model actually has
      let appliedExpression = null;
      if (resolved.expressions && resolved.expressions.length) {
        for (const candidate of resolved.expressions) {
          const lookup = expressionLookup.get(String(candidate).toLowerCase());
          if (lookup) {
            appliedExpression = candidate;
            setExpression(candidate, weight);
            break;
          }
        }
      }

      // motion layer: first group that exists
      let appliedMotion = null;
      if (resolved.motions && resolved.motions.length) {
        const defs = (internal && internal.motionManager && internal.motionManager.definitions) || {};
        for (const m of resolved.motions) {
          const group = typeof m === 'string' ? m : m.group;
          if (group && Array.isArray(defs[group]) && defs[group].length) {
            try {
              model.motion(group, typeof m === 'object' ? m.index : undefined, 2 /* NORMAL */);
              appliedMotion = group;
            } catch (e) {
              /* ignore */
            }
            break;
          }
        }
      }

      // Eased parameter offsets belong to this emotion; an emotion without any
      // exp3 must also fade out an expression left over from the previous one
      // (otherwise it lingers until the next mood and both overlays stack).
      if (!appliedExpression) setExpression('', 0);

      const info = {
        requested: String(name),
        key: resolved.key,
        matched: resolved.matched,
        intensity: weight,
        expression: appliedExpression,
        motion: appliedMotion,
        params: Object.fromEntries(target),
      };
      emitStatus({ phase: 'emotion', emotion: info });
      return info;
    };

    if (state.disposed) return null;
    if (!state.ready) {
      state.pending.push(() => apply());
      // remember for buffered read-back
      state.emotion = name;
      return { requested: String(name), queued: true };
    }
    return apply();
  }

  function clearEmotion() {
    const doClear = () => {
      emotionTarget = new Map();
      emotionKey = null;
      pendingExpression = null;
      for (const item of activeExpressions) item.target = 0;
      state.emotion = null;
      emitStatus({ phase: 'emotion', emotion: null });
    };
    if (!state.ready) state.pending.push(doClear);
    else doClear();
  }

  // ==========================================================================
  // speech / lip sync
  // ==========================================================================
  function speakStart(opts) {
    const options = opts || {};
    const begin = () => {
      state.speaking = true;
      state.speakStartedAt = nowMs();
      if (envelope) {
        envelope.gain = cfg.lipSync.gain;
        envelope.begin(nowMs(), {
          latencyMs: cfg.lipSync.audioLatencyMs || 0,
          startDelayMs: cfg.lipSync.startDelayMs || 0,
        });
      }
      gesturePulses.length = 0;
      if (options.emotion) setEmotion(options.emotion, options.intensity === undefined ? 1 : options.intensity);
      else if (options.text) {
        const cue = detectTextEmotion(options.text);
        if (cue) setEmotion(cue, 1);
      }
      queueSpeechGestures(options);
      emitStatus({ phase: 'speak_start', text: options.text || '', emotion: options.emotion || state.emotion });
      if (state.visible) start();
    };
    if (!state.ready) state.pending.push(begin);
    else begin();
    return stage;
  }

  function detectTextEmotion(text) {
    const s = String(text || '');
    if (!s) return null;
    for (const cue of TEXT_EMOTION_CUES) {
      if (cue.re.test(s)) return cue.emotion;
    }
    return null;
  }

  function queueSpeechGestures(options) {
    if (!cfg.gestures) return;
    const text = String(options.text || '');
    const t0 = nowMs();
    const push = (delay, key, value, durationMs) => {
      gesturePulses.push({ key, value, t0: t0 + delay, durationMs });
    };
    // 句首：轻微点头/歪头
    push(60, 'angleY', -2.2, 420);
    push(120, 'angleZ', 1.6, 520);
    // 强调：感叹号/长句
    if (/[！!]/.test(text) || text.length >= 18) {
      push(520, 'angleY', 3.2, 380);
      push(560, 'browLY', 0.12, 360);
      push(560, 'browRY', 0.12, 360);
    }
    // 疑问：问号
    if (/[？?]/.test(text)) {
      push(420, 'angleZ', -5, 620);
      push(460, 'browLY', 0.18, 480);
      push(460, 'browRY', 0.06, 480);
    }
    // 长文本：每 ~2.2s 一次小幅度换气/点头
    if (text.length >= 24) {
      for (let d = 2200; d < Math.min(12000, text.length * 180); d += 2200) {
        push(d, 'angleY', 1.4, 460);
        push(d + 40, 'angleZ', -1.2, 520);
      }
    }
  }

  /**
   * Append a chunk of RMS envelope frames (host SSE `envelope` event).
   *
   * @param {number[]|Float32Array} frames 0..1 RMS frames
   * @param {number|object} [hopMsOrOptions] hop in ms (default 20) or options
   * @param {{latencyMs?:number, startDelayMs?:number}} [options]
   *   `latencyMs` = host-reported audio output latency; frames are consumed
   *   `latencyMs` later so the mouth matches what the listener actually hears.
   *   `startDelayMs` = extra constant delay (rarely needed).
   */
  function pushEnvelope(frames, hopMsOrOptions, options) {
    if (state.disposed) return stage;
    const second = hopMsOrOptions;
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
    const push = () => {
      if (!envelope) return;
      if (!state.speaking && !envelope.active) {
        // envelope without speech_start: auto-start for robustness
        speakStart({});
      }
      if (typeof opts.latencyMs === 'number') {
        cfg.lipSync.audioLatencyMs = Math.max(0, opts.latencyMs);
        envelope.setLatency(opts.latencyMs);
      }
      if (typeof opts.startDelayMs === 'number') envelope.setStartDelay(opts.startDelayMs);
      envelope.push(frames, hop);
    };
    if (!state.ready) state.pending.push(push);
    else push();
    return stage;
  }

  /**
   * Set the host-reported audio output latency (ms) used by lip sync.
   * Applies to the running speech too (playback clock is shifted by the delta).
   */
  function setAudioLatency(latencyMs) {
    const ms = Math.max(0, Number(latencyMs) || 0);
    cfg.lipSync.audioLatencyMs = ms;
    if (envelope) envelope.setLatency(ms);
    return ms;
  }

  function speakEnd() {
    const end = () => {
      state.speaking = false;
      state.speakEndedAt = nowMs();
      if (envelope) envelope.end(nowMs());
      gesturePulses.length = 0;
      emitStatus({ phase: 'speak_end' });
    };
    if (!state.ready) state.pending.push(end);
    else end();
    return stage;
  }

  function setEnvelopeConfig(partial) {
    if (!partial) return cfg.lipSync;
    Object.assign(cfg.lipSync, partial);
    if (envelope) {
      if (partial.gain !== undefined) envelope.gain = partial.gain;
      if (partial.hopMs !== undefined) envelope.hopMs = partial.hopMs;
    }
    return cfg.lipSync;
  }

  function playMotion(group, index, priority) {
    if (!state.ready || !model) return Promise.resolve(false);
    return model.motion(group, index, priority === undefined ? 2 : priority);
  }

  // ==========================================================================
  // visibility / stats / debug / dispose
  // ==========================================================================
  function setVisible(visible) {
    state.visible = !!visible;
    if (state.ready) {
      if (model) model.visible = state.visible;
      if (state.visible) start();
      else stop();
    }
    if (canvas && canvas.style) canvas.style.visibility = state.visible ? 'visible' : 'hidden';
    emitStatus({ phase: 'visibility', visible: state.visible });
    return state.visible;
  }

  /**
   * Re-arm the render loop after the window was occluded/minimised. Chromium can
   * stop delivering rAF without destroying the loop; start() is idempotent and
   * re-anchors the timing on its first frame.
   */
  function resume() {
    if (state.disposed) return stage;
    if (state.ready && state.visible) {
      if (model) model.visible = true;
      // A paused rAF leaves `running` true, so start() alone would no-op.
      stop();
      start();
    }
    return stage;
  }

  function stats() {
    const defs = (internal && internal.motionManager && internal.motionManager.definitions) || {};
    const seconds = state.speakStartedAt ? (nowMs() - state.speakStartedAt) / 1000 : 0;
    return {
      backend: state.backend,
      phase: state.phase,
      fps: state.fps,
      targetFps: targetFps(),
      frames: state.frames,
      drawCalls: state.drawCalls,
      drawCallsLastFrame: state.frameDrawCalls,
      avgRenderMs: Math.round(state.avgRenderMs * 100) / 100,
      visible: state.visible,
      speaking: state.speaking,
      speechSeconds: Math.round(seconds * 10) / 10,
      emotion: state.emotion,
      mouth: stage.__lastMouth || 0,
      width: cfg.width,
      height: cfg.height,
      dpr: app ? app.renderer.resolution : 1,
      model: {
        file: modelDesc.modelFile,
        format: assets ? assets.format : null,
        expressions: assets ? assets.expressions.length : 0,
        motionGroups: Object.keys(defs),
        hiddenParts: assets ? assets.hiddenParts.length : 0,
        baseWidth: internal ? internal.originalWidth : 0,
        baseHeight: internal ? internal.originalHeight : 0,
      },
      currentState: currentStateName(),
      envelope: envelope
        ? {
            active: envelope.active,
            queued: envelope.queued,
            total: envelope.totalFrames,
            hopMs: envelope.hopMs,
            delayMs: envelope.delayMs,
            audioLatencyMs: envelope.audioLatencyMs,
          }
        : null,
      lipSync: {
        enabled: !!cfg.lipSync.enabled,
        bufferMs: cfg.lipSync.bufferMs,
        startDelayMs: cfg.lipSync.startDelayMs || 0,
        audioLatencyMs: (envelope && envelope.audioLatencyMs) || cfg.lipSync.audioLatencyMs || 0,
        attackTau: cfg.lipSync.attackTau,
        releaseTau: cfg.lipSync.releaseTau,
      },
      params: adapter ? pickSeenParams() : null,
    };
  }

  function pickSeenParams() {
    const out = {};
    for (const key of ['mouthOpenY', 'mouthForm', 'eyeLOpen', 'eyeROpen', 'browLY', 'browRY', 'angleX', 'angleY', 'angleZ', 'cheek']) {
      const h = adapter.resolve(key);
      if (h) out[key] = { id: h.id, value: Math.round(adapter.get(key) * 1000) / 1000 };
    }
    return out;
  }

  function sampleParams(names) {
    if (!adapter) return {};
    const list = names && names.length ? names : Object.keys(STANDARD_PARAMS);
    const out = {};
    for (const name of list) {
      const h = adapter.resolve(name);
      out[name] = h ? adapter.get(name) : null;
    }
    return out;
  }

  function debugState() {
    return {
      state: Object.assign({}, state),
      config: cfg,
      assets: assets
        ? {
            format: assets.format,
            modelUrl: assets.modelUrl,
            expressions: assets.expressions.map((e) => e.name),
            motions: assets.motions,
            hiddenParts: assets.hiddenParts,
          }
        : null,
      expressions: activeExpressions.map((e) => ({ name: e.name, weight: e.weight, target: e.target })),
      emotion: { key: emotionKey, intensity: emotionIntensity, target: Object.fromEntries(emotionTarget) },
      gestures: gesturePulses.length,
      gaze,
    };
  }

  function patchGL(pixiApp) {
    try {
      gl = pixiApp.renderer.gl;
      if (!gl || glPatched) return;
      origDrawElements = gl.drawElements.bind(gl);
      origDrawArrays = gl.drawArrays.bind(gl);
      gl.drawElements = function () {
        state.drawCalls++;
        state.frameDrawCalls++;
        return origDrawElements.apply(null, arguments);
      };
      gl.drawArrays = function () {
        state.drawCalls++;
        state.frameDrawCalls++;
        return origDrawArrays.apply(null, arguments);
      };
      glPatched = true;
    } catch (e) {
      console.warn(TAG, 'could not patch GL for stats', e);
    }
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    stop();
    try {
      if (internal && internal.__live2dBridge) {
        internal.off('beforeModelUpdate', internal.__live2dBridge.handler);
        internal.__live2dBridge = null;
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (glPatched && gl) {
        if (origDrawElements) gl.drawElements = origDrawElements;
        if (origDrawArrays) gl.drawArrays = origDrawArrays;
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (model) model.destroy({ children: true });
    } catch (e) {
      /* ignore */
    }
    try {
      if (app) app.destroy(false, { children: true });
    } catch (e) {
      /* ignore */
    }
    model = null;
    app = null;
    internal = null;
    adapter = null;
    envelope = null;
    state.phase = 'disposed';
    emitStatus({ phase: 'disposed' });
  }
}

// ============================================================================
// Public facade: switchable backend
//
//   backend: 'auto' (default)  -> soullink adapter if vendored+loaded, else direct
//            'soullink'        -> force the Soullink Emotion SDK adapter
//            'direct'          -> force the built-in pixi-live2d-display path
//
// The facade exposes exactly the API documented in docs/RENDERER.md, buffers
// calls made before the backend is ready, and installs/removes the Playwright
// acceptance handle (window.__DSH_LIVE2D_STATS__ / window.__dshLive2D).
// ============================================================================

const FACADE_METHODS = [
  'setVisible',
  'resume',
  'setScale',
  'setPosition',
  'setAnchor',
  'setEmotion',
  'clearEmotion',
  'speakStart',
  'pushEnvelope',
  'speakEnd',
  'setEnvelopeConfig',
  'setAudioLatency',
  'playMotion',
  'setExpression',
  'resize',
  'stats',
  'sampleParams',
  'debugState',
  'dispose',
];

/**
 * Create a Live2D stage (backend-switching facade).
 *
 * @param {object} options see docs/RENDERER.md §1
 *   extra options: `backend: 'auto'|'soullink'|'direct'`, `debugHandle: false` to
 *   disable `window.__DSH_LIVE2D_STATS__`.
 * @returns {object} stage facade (usable immediately, `ready` resolves when the
 *   selected backend finished loading the model)
 */
export function createLive2DStage(options) {
  if (!options || (!options.canvas && !options.container)) {
    throw new Error(`${TAG} createLive2DStage: canvas or container is required`);
  }
  if (!options.model || !options.model.baseUrl || !options.model.modelFile) {
    throw new Error(`${TAG} createLive2DStage: model.baseUrl and model.modelFile are required`);
  }
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  const config = options.config || {};
  const requested = String(options.backend || config.backend || 'auto').toLowerCase();
  const wantDebug = options.debugHandle !== false;

  let impl = null;
  let disposed = false;
  const queued = [];

  const facade = {
    canvas: options.canvas || null,
    container: options.container || null,
    config,
    backend: 'pending',
    backendRequested: requested,
    model: null,
    ready: null,
    /** Debug only: the currently active backend implementation. */
    get impl() {
      return impl;
    },
  };
  for (const name of FACADE_METHODS) {
    facade[name] = (...args) => call(name, args);
  }
  /**
   * Apply the next TTS segment of a running utterance (planned speech gestures +
   * emotion switch, see backend-soullink.speakSegment). Backends without the
   * optimised path fall back to `speakEmotion` / `setEmotion`.
   */
  facade.speakSegment = (opts) => {
    if (impl && typeof impl.speakSegment === 'function') {
      try {
        return impl.speakSegment(opts);
      } catch (e) {
        console.warn(TAG, 'backend method speakSegment failed', e);
      }
    }
    if (impl && typeof impl.speakEmotion === 'function') return facade.speakEmotion(opts && opts.emotion, opts && opts.intensity);
    return facade.setEmotion(opts && opts.emotion, opts && opts.intensity);
  };
  /**
   * Change the emotion inside a running utterance without restarting the speech
   * performance (see backend-soullink.speakEmotion). Backends without the
   * optimised path simply go through `setEmotion`.
   */
  facade.speakEmotion = (name, intensity) => {
    if (impl && typeof impl.speakEmotion === 'function') {
      try {
        return impl.speakEmotion(name, intensity);
      } catch (e) {
        console.warn(TAG, 'backend method speakEmotion failed', e);
      }
    }
    return facade.setEmotion(name, intensity);
  };
  Object.defineProperty(facade, 'raw', { get: () => (impl ? impl.raw : null) });
  facade.ready = boot();
  return facade;

  function emptyStats() {
    return {
      backend: facade.backend,
      phase: 'loading',
      fps: 0,
      targetFps: config.idleFps || 15,
      currentState: 'loading',
      frames: 0,
      drawCalls: 0,
      drawCallsLastFrame: 0,
      avgRenderMs: 0,
      visible: true,
      speaking: false,
      speechSeconds: 0,
      emotion: null,
      mouth: 0,
      width: config.width || 360,
      height: config.height || 520,
      dpr: 1,
      model: {
        file: options.model.modelFile,
        format: options.model.format || null,
        expressions: 0,
        motionGroups: [],
        hiddenParts: 0,
        baseWidth: 0,
        baseHeight: 0,
      },
      envelope: null,
      params: {},
    };
  }

  function call(name, args) {
    if (name === 'dispose') {
      doDispose();
      return undefined;
    }
    if (impl && typeof impl[name] === 'function') {
      try {
        return impl[name].apply(impl, args);
      } catch (e) {
        console.warn(TAG, `backend method ${name} failed`, e);
        return name === 'stats' ? emptyStats() : undefined;
      }
    }
    if (name === 'stats') return emptyStats();
    if (name === 'debugState') return { backend: facade.backend, phase: 'loading', queued: queued.length };
    if (name === 'sampleParams') return {};
    queued.push([name, args]);
    return name === 'speakStart' || name === 'speakEnd' || name === 'pushEnvelope' ? facade : undefined;
  }

  function flushQueued() {
    if (!impl) return;
    for (const [name, args] of queued.splice(0)) {
      try {
        if (typeof impl[name] === 'function') impl[name].apply(impl, args);
      } catch (e) {
        console.warn(TAG, `queued call ${name} failed`, e);
      }
    }
  }

  async function boot() {
    if (disposed) return facade;
    onStatus({ kind: 'loading', phase: 'loading', message: 'discovering model assets' });
    let assets = null;
    try {
      assets = await loadModelAssets(options.model);
    } catch (e) {
      // Let the selected backend produce the canonical error (and onStatus).
      console.warn(TAG, 'model asset discovery failed, letting backend report', e);
    }
    if (disposed) return facade;

    let chosen = requested;
    if (chosen === 'auto') chosen = hasSoullinkAdapter() ? 'soullink' : 'direct';
    if (chosen === 'soullink' && !hasSoullinkAdapter()) {
      console.warn(TAG, 'soullink backend requested but adapter is not loaded; using direct');
      chosen = 'direct';
    }
    // The Soullink backend needs a model profile. For models without an explicit
    // profile hint (e.g. official Hiyori/Haru samples) probe for the default
    // `soullink.profile.json` so we can skip a doomed backend attempt.
    if (chosen === 'soullink') {
      const hasProfileHint = !!(
        options.model.profileUrl ||
        options.model.profileFile ||
        (assets && assets.manifest && assets.manifest.profileFile)
      );
      if (!hasProfileHint && options.model.baseUrl) {
        try {
          const probeUrl = joinUrl(options.model.baseUrl, 'soullink.profile.json');
          const res = await fetch(probeUrl, { method: 'HEAD', cache: 'no-store' });
          if (!res.ok) {
            console.info(TAG, 'no Soullink profile at', probeUrl, '(HTTP ' + res.status + '), using direct backend');
            chosen = 'direct';
          }
        } catch (e) {
          /* network error: let the soullink backend try and fall back on its own */
        }
      }
    }

    if (chosen === 'soullink') {
      try {
        impl = createSoullinkBackend({ options, assets, onStatus });
        facade.backend = 'soullink';
        await impl.ready;
      } catch (e) {
        const stack = (e && (e.stack || e.message)) || String(e);
        console.warn(TAG, 'soullink backend unavailable, falling back to direct:\n' + stack);
        onStatus({ kind: 'log', phase: 'log', message: 'soullink fallback: ' + String((e && e.message) || e) + '\n' + stack });
        try {
          if (impl && typeof impl.dispose === 'function') impl.dispose();
        } catch (e2) {
          /* ignore */
        }
        impl = null;
      }
    }

    if (!impl) {
      impl = createDirectStage(Object.assign({}, options, { assets }));
      facade.backend = 'direct';
      await impl.ready;
    }

    if (disposed) {
      try {
        if (impl && typeof impl.dispose === 'function') impl.dispose();
      } catch (e) {
        /* ignore */
      }
      return facade;
    }

    facade.model = impl.model || null;
    if (impl.canvas) facade.canvas = impl.canvas;
    if (impl.container) facade.container = impl.container;
    flushQueued();
    installDebugHandle();
    return facade;
  }

  // -- acceptance/debug handle (Playwright asserts against it) -----------------
  function installDebugHandle() {
    if (!wantDebug || typeof window === 'undefined') return;
    try {
      window.__DSH_LIVE2D_STATS__ = () => facade.stats();
      window.__dshLive2D = {
        stats: () => facade.stats(),
        setEmotion: (name, intensity, options) => facade.setEmotion(name, intensity, options),
        speakStart: (opts) => facade.speakStart(opts),
        speakEnd: () => facade.speakEnd(),
        pushEnvelope: (frames, hopMs) => facade.pushEnvelope(frames, hopMs),
        resume: () => facade.resume(),
        backend: () => facade.backend,
        stage: () => facade,
        canvas: () => facade.canvas,
      };
      onStatus({
        kind: 'debug-handle',
        phase: 'debug-handle',
        message: 'window.__DSH_LIVE2D_STATS__ / window.__dshLive2D installed',
        backend: facade.backend,
      });
    } catch (e) {
      console.warn(TAG, 'failed to install debug handle', e);
    }
  }

  function removeDebugHandle() {
    if (typeof window === 'undefined') return;
    try {
      if (typeof window.__DSH_LIVE2D_STATS__ === 'function') delete window.__DSH_LIVE2D_STATS__;
      const handle = window.__dshLive2D;
      if (handle && typeof handle.stage === 'function' && handle.stage() === facade) {
        delete window.__dshLive2D;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function doDispose() {
    if (disposed) return;
    disposed = true;
    removeDebugHandle();
    queued.length = 0;
    if (impl) {
      try {
        if (typeof impl.dispose === 'function') impl.dispose();
      } catch (e) {
        console.warn(TAG, 'dispose failed', e);
      }
      impl = null;
    }
  }
}