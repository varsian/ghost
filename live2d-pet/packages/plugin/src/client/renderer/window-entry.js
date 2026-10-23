/**
 * window-entry.js — standalone Live2D window app (no DSH client-loader).
 *
 * Bundled by `build-client.mjs --window` into `lib/window.js` as a self-contained
 * IIFE (vendor runtime inlined). `window/index.html` loads it and it:
 *
 *   1. reads `?port=34567&scale=1&anchor=bottom-right&visible=1&fps=30&idleFps=24&debug=0&width=&height=`
 *      (or `window.__DSH_LIVE2D_WINDOW_CONFIG__` when the launcher injects it);
 *   2. creates a transparent `createLive2DStage({container, model, config})` once the
 *      host's SSE `state` event delivers the model payload;
 *   3. forwards SSE events (speech_start/segment_start, envelope + latencyMs,
 *      emotion, speech_end, model_changed, visibility) to the stage;
 *   4. exposes `window.__DSH_LIVE2D_WINDOW__` / `window.__DSH_LIVE2D_STATS__`
 *      handles for Playwright acceptance;
 *   5. handles window drag (CSS `-webkit-app-region: drag`) and the tiny
 *      auto-hiding close button (`window.close()`).
 *
 * The page itself is fully transparent (body/stage/canvas have no background),
 * so the Electron window can be created with `transparent: true`.
 */

import { createLive2DStage, runtimeStatus } from './index.js';

const TAG = '[live2d:window]';
const DEFAULT_PORT = 34567;

const query =
  typeof location !== 'undefined' && location.search
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const injected =
  (typeof window !== 'undefined' && window.__DSH_LIVE2D_WINDOW_CONFIG__) || {};
const merged = Object.assign({}, injected);

function q(name, fallback) {
  if (merged[name] !== undefined && merged[name] !== null) return merged[name];
  const v = query.get(name);
  return v === null || v === '' ? fallback : v;
}

function qNum(name, fallback) {
  const v = q(name, undefined);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function qBool(name, fallback) {
  const v = q(name, undefined);
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes';
}

const config = {
  port: Math.trunc(qNum('port', DEFAULT_PORT)),
  scale: qNum('scale', 1),
  anchor: String(q('anchor', 'bottom-right')),
  offsetX: qNum('offsetX', 0),
  offsetY: qNum('offsetY', 0),
  visible: qBool('visible', true),
  fps: qNum('fps', 30),
  idleFps: qNum('idleFps', 24),
  debug: qBool('debug', false),
  width: qNum('width', 0),
  height: qNum('height', 0),
};

const dom = {
  stage: document.getElementById('stage'),
  drag: document.getElementById('drag-region'),
  close: document.getElementById('close-btn'),
  hint: document.getElementById('hint'),
};

if (!dom.stage) {
  console.error(TAG, '#stage container missing in window/index.html');
}

const win = {
  stage: null,
  model: null,
  modelKey: '',
  source: null,
  retryTimer: 0,
  retryDelay: 1000,
  disposed: false,
  ready: false,
  lastEvent: null,
  /** Wall clock of the latest SSE frame (any type). */
  lastEventAt: 0,
  /** Wall clock of the latest TTS-related SSE frame (used by the self-heal watchdog). */
  lastTtsEventAt: 0,
  /** Frame watchdog: latest sampled stats().frames and when it was sampled. */
  lastFrameCount: 0,
  lastFrameSampleAt: 0,
  lastResumeAt: 0,
  /** Diagnostics: stale TTS frames discarded / resume events. */
  droppedStaleEvents: 0,
  resumeCount: 0,
  /** Number of performances started from envelope evidence because announce events were missed. */
  fallbackSpeeches: 0,
  statuses: [],
  errors: [],
  /** Segment announced but not yet audible: its performance starts at playback_start. */
  pendingSpeech: null,
  /** id of the utterance that pendingSpeech belongs to. */
  pendingSpeechId: null,
  /** Last emotion announced by the host state heartbeat (fallback when segment events are missed). */
  lastHostEmotion: '',
  /** Host heartbeat `speaking` flag, used by the mouth watchdog. */
  lastHostSpeaking: false,
  /** Wall-clock time of the first real audio callback of the current utterance (0 = not playing). */
  audioStartedAt: 0,
  /** Utterance whose speech performance is currently running (one speakStart per utterance). */
  performId: null,
  /** Emotion currently applied to the stage (avoids duplicate intent triggers). */
  appliedEmotion: '',
  /** Total characters of the planned utterance (used for a better duration estimate). */
  plannedChars: 0,
  /** Content length of each requested segment (fallback timing when audioSec is missing). */
  plannedSegmentChars: [],
  /** Planned number of segments in the current utterance (grows as segment_start arrives). */
  plannedSegmentCount: 0,
  /** index -> { emotion, text, seconds, startedAt } for the current utterance. */
  segments: new Map(),
  /** index of the next segment that still has to be applied on the audio clock. */
  nextSegmentIndex: 1,
  /** Wall clock of playback_start (audible beginning of the utterance). */
  playbackStartedAt: 0,
  /** Reported output latency of the current utterance. */
  audioLatencyMs: 0,
};

/** Resolve a host-provided URL against the window origin (relative assets). */
function absolute(url) {
  if (!url) return url;
  try {
    return new URL(url, location.href).href;
  } catch (e) {
    return url;
  }
}

function stageSize() {
  const w = config.width > 0 ? config.width : window.innerWidth || 360;
  const h = config.height > 0 ? config.height : window.innerHeight || 520;
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

function setHint(text, visible) {
  if (!dom.hint) return;
  dom.hint.textContent = text || '';
  dom.hint.style.display = visible ? 'block' : 'none';
}

function normalizeModel(input) {
  const m = Object.assign({}, input || {});
  return {
    id: m.id || 'model',
    name: m.name || m.id || 'model',
    baseUrl: absolute(m.baseUrl || ''),
    modelFile: m.modelFile || '',
    format: m.format || 'cubism4',
    expressions: m.expressions,
    motions: m.motions,
    hiddenParts: m.hiddenParts,
    disableIdleMotion: m.disableIdleMotion,
    emotionMap: m.emotionMap,
    idleMoods: m.idleMoods,
    profileUrl: m.profileUrl ? absolute(m.profileUrl) : undefined,
    // markers read by the renderer for canvas sizing
    maxWidth: m.maxWidth,
    maxHeight: m.maxHeight,
  };
}

function createStage(modelInput) {
  const model = normalizeModel(modelInput);
  const size = stageSize();
  if (win.stage) {
    try {
      win.stage.dispose();
    } catch (e) {
      /* ignore */
    }
    win.stage = null;
  }
  // remove a stale canvas (direct backend creates it inside the container)
  try {
    while (dom.stage.firstChild) dom.stage.removeChild(dom.stage.firstChild);
  } catch (e) {
    /* ignore */
  }
  win.model = model;
  win.ready = false;
  win.stage = createLive2DStage({
    container: dom.stage,
    model,
    // The window itself decides the backend: auto (Soullink if vendored and the
    // model has a profile) with a graceful fallback to the direct renderer.
    backend: 'auto',
    config: {
      width: size.width,
      height: size.height,
      fps: config.fps,
      idleFps: config.idleFps,
      antialias: false,
      backgroundAlpha: 0,
      fitRatio: 0.98,
      scale: config.scale,
      anchor: config.anchor === 'center' ? { x: 0.5, y: 0.5 } : config.anchor,
      offsetX: config.offsetX,
      offsetY: config.offsetY,
      lipSync: { bufferMs: 40, attackTau: 0.03, releaseTau: 0.07 },
      // Empty by default: idle is natural sway only. A non-empty list opt-ins
      // random idle moods again (config idleMoods).
      idleMoods: Array.isArray(model.idleMoods) ? model.idleMoods : [],
      // pixel self-test for Playwright needs a readable WebGL buffer
      preserveDrawingBuffer: config.debug,
      idle: { gaze: true, headWobble: true, motion: true },
    },
    onStatus: (status) => {
      win.statuses.push(status);
      if (win.statuses.length > 100) win.statuses.shift();
      if (status.kind === 'ready') {
        win.ready = true;
        setHint('', false);
        console.info(TAG, 'ready', status.backend, status.format);
      } else if (status.kind === 'error') {
        win.errors.push(status.message);
        setHint('Live2D 加载失败：' + status.message, true);
        console.error(TAG, 'error', status.message);
      } else if (status.kind === 'debug-handle') {
        // renderer already installed window.__DSH_LIVE2D_STATS__
      }
    },
  });
  win.stage.ready
    .then(() => {
      win.ready = true;
    })
    .catch((err) => {
      win.errors.push(String((err && err.message) || err));
      setHint('Live2D 加载失败：' + ((err && err.message) || err), true);
    });
  return win.stage;
}

// ---------------------------------------------------------------------------
// SSE transport
// ---------------------------------------------------------------------------
function eventsUrl() {
  // `client=window` lets the host track this stream and ask the Electron main
  // process to reload the page if the stream dies while the process stays alive.
  return 'http://127.0.0.1:' + config.port + '/events?client=window';
}

function forceReconnect(reason) {
  if (win.disposed) return;
  console.warn(TAG, 'SSE reconnect:', reason || 'manual');
  try {
    if (win.source) win.source.close();
  } catch (e) {
    /* ignore */
  }
  win.source = null;
  if (win.retryTimer) {
    window.clearTimeout(win.retryTimer);
    win.retryTimer = 0;
  }
  win.retryDelay = 1000;
  connect();
}

function scheduleReconnect() {
  if (win.disposed || win.retryTimer) return;
  win.retryTimer = window.setTimeout(() => {
    win.retryTimer = 0;
    connect();
  }, win.retryDelay);
  win.retryDelay = Math.min(15000, Math.round(win.retryDelay * 1.6));
}

function connect() {
  if (win.disposed) return;
  let source;
  try {
    source = new EventSource(eventsUrl());
  } catch (e) {
    scheduleReconnect();
    return;
  }
  win.source = source;
  source.onopen = () => {
    win.retryDelay = 1000;
    setHint('', false);
  };
  source.onmessage = (message) => {
    try {
      handleEvent(JSON.parse(message.data));
    } catch (e) {
      console.warn(TAG, 'bad SSE frame', e);
    }
  };
  source.onerror = () => {
    try {
      source.close();
    } catch (e) {
      /* ignore */
    }
    if (win.source === source) win.source = null;
    if (!win.stage) setHint('等待 DSH host 连接…', true);
    scheduleReconnect();
  };
}

function pickLatency(event) {
  if (!event) return undefined;
  if (typeof event.latencyMs === 'number') return event.latencyMs;
  if (typeof event.outputLatencyMs === 'number') return event.outputLatencyMs;
  if (typeof event.latency === 'number') return event.latency;
  return undefined;
}

function applyStateEvent(event) {
  const visible = event.visible !== false;
  if (typeof event.emotion === 'string' && event.emotion.trim() !== '') win.lastHostEmotion = event.emotion;
  const model = event.model;
  if (model && typeof model === 'object' && (model.baseUrl || model.modelFile)) {
    const key = [model.id, model.modelFile, model.baseUrl].join('|');
    if (key !== win.modelKey || !win.stage) {
      win.modelKey = key;
      createStage(model);
    }
  }
  if (win.stage) {
    if (typeof event.scale === 'number') win.stage.setScale(event.scale);
    else if (model && typeof model.scale === 'number') win.stage.setScale(model.scale);
    const anchor = event.anchor || (model && model.anchor);
    if (anchor) win.stage.setPosition(anchor, event.offsetX ?? (model && model.offsetX), event.offsetY ?? (model && model.offsetY));
    win.stage.setVisible(visible);
  }
  if (!visible) setHint('', false);
}

/**
 * Start (or continue) the visual performance for the current utterance.
 *
 * One `speakStart` per utterance: the host announces every TTS *segment*
 * separately, and calling `speakStart` again for each of them restarted the
 * engine's speech plan (LISTENING -> REACTING -> SPEAKING, new random gestures,
 * new duration estimate). On screen that reads as the body snapping/twitching
 * every sentence. Later segments of the same utterance now only blend the mood.
 */
function startSpeech(speech, utteranceId) {
  if (!win.stage || !speech) return;
  win.audioStartedAt = Date.now();
  win.pendingSpeech = null;
  win.pendingSpeechId = null;

  const id = utteranceId === undefined || utteranceId === null ? null : String(utteranceId);
  const emotion = speech.emotion || '';
  const isNewUtterance = win.performId === null || id === null || id !== win.performId;

  if (isNewUtterance) {
    // Duration of the whole utterance, not just this segment: the TTS pipeline
    // reports all segments up front, so the engine can stay in SPEAKING until
    // the audio really ends instead of falling back to idle sway mid-sentence.
    const chars = win.plannedChars || String(speech.text || '').length;
    const durationSeconds = Math.min(120, Math.max(1.6, 1.7 + chars * 0.17 + 1.5));
    const firstRecord = win.segments.get(0);
    const firstSeconds = firstRecord && firstRecord.seconds > 0 ? firstRecord.seconds : 0;
    const firstText = firstRecord && firstRecord.text ? firstRecord.text : (speech.text || '');
    const segmentDurationMs = firstSeconds > 0
      ? Math.round(firstSeconds * 1000)
      : Math.max(900, Math.round((0.3 + firstText.length * 0.2) * 1000));
    win.performId = id;
    win.appliedEmotion = emotion;
    if (!win.playbackStartedAt) win.playbackStartedAt = Date.now();
    if (win.nextSegmentIndex < 1) win.nextSegmentIndex = 1;
    win.stage.speakStart({
      emotion: speech.emotion || undefined,
      text: speech.text || '',
      intensity: typeof speech.intensity === 'number' ? speech.intensity : undefined,
      durationSeconds,
      durationMs: segmentDurationMs,
    });
    return;
  }

  // Same utterance: `segment_start` is a *synthesis* event and can lead the
  // audible audio by a second or more. Record it and let the audio clock apply
  // it at its real start time (see advanceSpeechSegments).
  const index = Number.isFinite(speech.index) ? speech.index : win.nextSegmentIndex;
  rememberSegment(index, speech);
  advanceSpeechSegments();
}

/**
 * Start a performance from audio evidence alone.
 *
 * If the page reloaded/reconnected while TTS was already speaking, it can miss
 * `speak_request`/`segment_start`/`playback_start` but still receive the
 * envelope stream. Without a performance the adapter keeps `voiceActive=false`
 * and the mouth stays shut even though frames arrive. Treat the first fresh
 * envelope as proof that audio is audible and start a minimal utterance.
 */
function startFallbackSpeech(emotion, latencyMs) {
  if (!win.stage) return;
  win.fallbackSpeeches += 1;
  const now = Date.now();
  win.audioStartedAt = now;
  win.playbackStartedAt = win.playbackStartedAt || now;
  win.pendingSpeech = null;
  win.pendingSpeechId = null;
  win.performId = win.performId || `fallback-${now}`;
  win.appliedEmotion = String(emotion || win.appliedEmotion || '默认');
  win.nextSegmentIndex = 1;
  win.plannedSegmentCount = 0;
  win.segments.clear();
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) win.audioLatencyMs = latencyMs;
  try {
    win.stage.speakStart({
      emotion: win.appliedEmotion === '默认' ? undefined : win.appliedEmotion,
      text: '',
      durationSeconds: 30,
    });
  } catch (e) {
    console.warn(TAG, 'fallback speakStart failed', e);
  }
  console.info(TAG, 'started speech performance from envelope (missed segment events)');
}

/** Store one announced TTS segment of the current utterance. */
function rememberSegment(index, speech) {
  if (!Number.isFinite(index) || index < 0) return;
  const previous = win.segments.get(index) || {};
  win.segments.set(index, {
    emotion: speech.emotion || previous.emotion || '',
    text: speech.text || previous.text || '',
    seconds: previous.seconds || 0,
    startedAt: previous.startedAt || Date.now(),
  });
  if (index + 1 > win.plannedSegmentCount) win.plannedSegmentCount = index + 1;
}

/** Exact audio start (s) of a segment: sum of the preceding segments' audioSec. */
function exactStartSeconds(index) {
  let total = 0;
  for (let k = 0; k < index; k += 1) {
    const record = win.segments.get(k);
    if (!record || !(record.seconds > 0)) return null;
    total += record.seconds;
  }
  return total;
}

/** Fallback audio start estimate from characters (TTS ≈ 4–5 chars/s + pauses). */
function estimatedStartSeconds(index) {
  let total = 0;
  for (let k = 0; k < index; k += 1) {
    const record = win.segments.get(k);
    const chars = record && record.text ? record.text.length : (win.plannedSegmentChars[k] || 0);
    total += 0.28 + chars * 0.2;
  }
  return total;
}

/** Apply one segment's emotion + gesture plan (called on the audio clock). */
function applySpeechSegment(index, record) {
  if (!win.stage || !record) return;
  const durationMs = record.seconds > 0 ? Math.round(record.seconds * 1000) : undefined;
  const payload = {
    emotion: record.emotion || undefined,
    text: record.text || '',
    intensity: 1,
    durationMs,
  };
  if (typeof win.stage.speakSegment === 'function') {
    win.stage.speakSegment(payload);
    if (record.emotion) win.appliedEmotion = record.emotion;
    return;
  }
  if (record.emotion && record.emotion !== win.appliedEmotion) {
    win.appliedEmotion = record.emotion;
    if (typeof win.stage.speakEmotion === 'function') win.stage.speakEmotion(record.emotion, 1);
    else win.stage.setEmotion(record.emotion, 1);
  }
}

/**
 * Apply the announced segments whose audio start has been reached.
 *
 * Called from every envelope (the audio clock) and from segment_end (which
 * delivers the exact per-segment duration). Using the real audio position —
 * instead of the synthesis lead — is what keeps the expression/gesture changes
 * aligned with what the viewer hears.
 */
function advanceSpeechSegments() {
  if (!win.stage || win.audioStartedAt === 0 || !win.playbackStartedAt) return;
  const audioPos = (Date.now() - win.playbackStartedAt - (win.audioLatencyMs || 0)) / 1000;
  let guard = 0;
  let dueIndex = -1;
  let dueRecord = null;
  while (win.nextSegmentIndex < win.plannedSegmentCount && guard < 8) {
    guard += 1;
    const index = win.nextSegmentIndex;
    const record = win.segments.get(index);
    if (!record) break;
    const exact = exactStartSeconds(index);
    const startSeconds = exact !== null ? exact : estimatedStartSeconds(index);
    if (audioPos + 0.06 < startSeconds) break;
    // Multiple segments can become due at once after a pause; applying each of
    // them would trigger several emotion switches in one frame. Jump to the
    // segment that matches the current audio position instead.
    dueIndex = index;
    dueRecord = record;
    win.nextSegmentIndex = index + 1;
  }
  if (dueRecord !== null) applySpeechSegment(dueIndex, dueRecord);
  return;
}

/** Forget the utterance-level performance state (speech ended / utterance changed). */
function resetSpeechPerformance() {
  win.performId = null;
  win.appliedEmotion = '';
  win.plannedChars = 0;
  win.plannedSegmentChars = [];
  win.plannedSegmentCount = 0;
  win.segments.clear();
  win.nextSegmentIndex = 1;
  win.playbackStartedAt = 0;
  win.audioLatencyMs = 0;
  win.audioStartedAt = 0;
  win.pendingSpeech = null;
  win.pendingSpeechId = null;
}

function healthUrl() {
  return 'http://127.0.0.1:' + config.port + '/health';
}

/**
 * Frame-rate watchdog. The host sends a tick every 2s even while idle; if the
 * stage's frame counter did not move between two ticks while the page is
 * visible, Chromium stopped the rAF loop (fully occluded window, restored
 * minimised window, GPU stall). Re-arm it without reloading the page.
 */
function sampleFrameWatchdog(reason) {
  if (win.disposed || !win.stage || !win.ready) return;
  let frames = 0;
  try {
    const stats = win.stage.stats ? win.stage.stats() : null;
    frames = stats && typeof stats.frames === 'number' ? stats.frames : 0;
  } catch (e) {
    return;
  }
  const now = Date.now();
  if (!win.lastFrameSampleAt) {
    win.lastFrameSampleAt = now;
    win.lastFrameCount = frames;
    return;
  }
  const elapsed = now - win.lastFrameSampleAt;
  if (elapsed < 1200) return;
  const stalled = frames <= win.lastFrameCount;
  win.lastFrameSampleAt = now;
  win.lastFrameCount = frames;
  if (!stalled || document.visibilityState !== 'visible') return;
  if (now - win.lastResumeAt < 2000) return;
  console.warn(TAG, 'frame watchdog: no frames for ' + elapsed + 'ms (' + reason + '); resuming');
  win.lastResumeAt = now;
  win.resumeCount += 1;
  try {
    win.stage.resume?.();
  } catch (e) {
    /* resume is best effort */
  }
}

function handleEvent(event) {
  if (!event || typeof event !== 'object') return;
  const now = Date.now();
  const previousEventAt = win.lastEventAt || 0;
  // A 3.5s+ gap in the SSE stream means the page was frozen/occluded. The host
  // sends a tick every 2s, so a normal stream never trips this; a frozen one
  // shows a >3.5s gap on the first queued tick after exposure.
  if (previousEventAt > 0 && now - previousEventAt > 3500 && win.stage) {
    console.warn(TAG, 'SSE gap', now - previousEventAt, 'ms; resuming stage');
    win.resumeCount += 1;
    try {
      win.stage.resume?.();
    } catch (e) {
      /* resume is best effort */
    }
  }
  win.lastEvent = event;
  win.eventCount = (win.eventCount || 0) + 1;
  win.lastSpeechEvent = event.type;
  win.lastEventAt = now;
  // TTS-related events are what the self-heal watchdog compares against the
  // host /health state: if the host is generating/playing speech but none of
  // these arrive, the page's SSE stream is stale.
  if (
    event.type === 'speak_request' ||
    event.type === 'speak_start' ||
    event.type === 'speech_start' ||
    event.type === 'segment_start' ||
    event.type === 'segment_end' ||
    event.type === 'playback_start' ||
    event.type === 'envelope' ||
    event.type === 'speak_done' ||
    event.type === 'speech_end' ||
    event.type === 'emotion'
  ) {
    win.lastTtsEventAt = now;
  }
  const type = event.type;
  if (type === 'tick') {
    sampleFrameWatchdog('tick');
    return;
  }
  if (type === 'state') {
    applyStateEvent(event);
    win.lastHostSpeaking = event.speaking === true;
    if (event.speaking === false && (win.audioStartedAt !== 0 || win.performId !== null)) {
      // We missed the speech_end while the page was frozen; the host heartbeat is
      // authoritative. End once and reset the segment scheduler.
      try {
        win.stage?.speakEnd?.();
      } catch (e) {
        /* ignore */
      }
      resetSpeechPerformance();
    } else if (event.speaking === true && win.stage) {
      // Host says audio is playing. If the renderer stopped its performance
      // (lost segment events, backend watchdog, reload mid-speech), restart it
      // from the current envelope stream instead of leaving the mouth shut.
      try {
        if (win.stage.stats().speaking !== true) startFallbackSpeech(win.lastHostEmotion || win.appliedEmotion);
      } catch (e) {
        /* stats is best effort */
      }
    }
    sampleFrameWatchdog('state');
    return;
  }
  if (!win.stage) return;
  if (type === 'visibility') {
    win.stage.setVisible(event.visible !== false);
    return;
  }
  if (type === 'model_changed') {
    if (event.model) createStage(event.model);
    return;
  }
  if (type === 'speak_request') {
    // A new utterance: visuals wait for its first real audio callback.
    resetSpeechPerformance();
    // The whole utterance is announced up front — keep its total length so the
    // first segment can start a performance that lasts for the whole utterance.
    const segments = Array.isArray(event.segments) ? event.segments : [];
    win.plannedSegmentChars = segments.map((segment) => String((segment && segment.content) || '').length);
    win.plannedChars = win.plannedSegmentChars.reduce((total, length) => total + length, 0);
    if (Number.isFinite(event.latencyMs)) win.audioLatencyMs = event.latencyMs;
    return;
  }
  if (type === 'speech_start' || type === 'segment_start') {
    const index = Number.isFinite(event.index) ? event.index : 0;
    const speech = {
      index,
      emotion: event.emotion || event.usedEmotion || '',
      text: event.text || event.content || '',
      intensity: typeof event.intensity === 'number' ? event.intensity : 1,
    };
    // The TTS pipeline announces a segment when generation starts, which can be
    // seconds before its audio is audible. Only the first segment starts the
    // utterance (at playback_start); later ones are recorded and applied on the
    // audio clock.
    if (win.audioStartedAt !== 0) {
      rememberSegment(index, speech);
      advanceSpeechSegments();
    } else {
      rememberSegment(index, speech);
      if (!win.pendingSpeech) {
        win.pendingSpeech = speech;
        win.pendingSpeechId = event.id === undefined ? null : event.id;
      }
    }
    return;
  }
  if (type === 'playback_start') {
    // Emitted by the shim on the first PCM callback: the audible sound begins
    // (plus the reported output latency). This is the sync anchor for the mouth
    // and for the scheduled segment changes.
    const latency = pickLatency(event);
    if (latency !== undefined) win.audioLatencyMs = latency;
    win.playbackStartedAt = Date.now();
    if (win.pendingSpeech) startSpeech(win.pendingSpeech, win.pendingSpeechId);
    else win.audioStartedAt = Date.now();
    advanceSpeechSegments();
    return;
  }
  if (type === 'envelope') {
    // The host stamps every frame with its send time. Anything older than 1.5s
    // is a backlog from before a pause and must not drive the mouth now.
    if (typeof event.sentAt === 'number' && Date.now() - event.sentAt > 1500) {
      win.droppedStaleEvents += 1;
      return;
    }
    const frames = Array.isArray(event.frames) ? event.frames : [];
    const hopMs = typeof event.hopMs === 'number' ? event.hopMs : 20;
    const latency = pickLatency(event);
    // Fallback for a shim that does not send playback_start (or a page that
    // missed the announce events while reconnecting): the first envelope is
    // already audio being played, so start the performance now.
    if (win.pendingSpeech) {
      win.playbackStartedAt = win.playbackStartedAt || Date.now();
      startSpeech(win.pendingSpeech, win.pendingSpeechId);
    } else if (frames.length > 0 && (win.audioStartedAt === 0 || win.performId === null)) {
      startFallbackSpeech(win.lastHostEmotion || win.appliedEmotion, latency);
    }
    const options = latency === undefined ? undefined : { latencyMs: latency };
    if (latency !== undefined) win.audioLatencyMs = latency;
    win.stage.pushEnvelope(frames, hopMs, options);
    advanceSpeechSegments();
    return;
  }
  if (type === 'emotion') {
    if (win.pendingSpeech) return; // applied together with the first audio
    if (!event.name) {
      win.stage.clearEmotion();
      win.appliedEmotion = '';
      return;
    }
    const name = String(event.name);
    const intensity = typeof event.intensity === 'number' ? event.intensity : 1;
    // During speech the segment scheduler applies the mood at its real audio
    // position; this event fires when *synthesis* of the segment starts and must
    // not be applied early.
    if (win.audioStartedAt !== 0) return;
    win.stage.setEmotion(name, intensity);
    win.appliedEmotion = name;
    return;
  }
  if (type === 'segment_end') {
    // Exact per-segment audio duration: enables audio-clock scheduling for the
    // following segments (segment_start leads the sound by the synthesis lead).
    const index = Number.isFinite(event.index) ? event.index : -1;
    const seconds = Number(event.seconds);
    if (index >= 0 && win.segments.has(index) && Number.isFinite(seconds) && seconds > 0) {
      const record = win.segments.get(index);
      record.seconds = seconds;
      if (index + 1 > win.plannedSegmentCount) win.plannedSegmentCount = index + 1;
    }
    advanceSpeechSegments();
    return;
  }
  if (type === 'emotion_clear' || type === 'clear_emotion') {
    win.stage.clearEmotion();
    win.appliedEmotion = '';
    return;
  }
  if (type === 'speech_end' || type === 'speak_done') {
    // Both speak_done and speech_end are broadcast for one utterance.
    if (win.audioStartedAt !== 0 || win.performId !== null) win.stage.speakEnd();
    resetSpeechPerformance();
    return;
  }
  if (type === 'log') {
    console.info(TAG, String(event.text || ''));
  }
}

// ---------------------------------------------------------------------------
// window chrome: resize, drag region, auto-hiding close button
// ---------------------------------------------------------------------------
function onResize() {
  if (!win.stage) return;
  const size = stageSize();
  try {
    win.stage.resize(size.width, size.height);
  } catch (e) {
    /* ignore */
  }
}

if (dom.close) {
  dom.close.addEventListener('click', (event) => {
    event.stopPropagation();
    try {
      if (window.__DSH_LIVE2D_WINDOW_CLOSE__) window.__DSH_LIVE2D_WINDOW_CLOSE__();
      else window.close();
    } catch (e) {
      /* ignore */
    }
  });
}

window.addEventListener('resize', onResize);
window.addEventListener('beforeunload', () => {
  win.disposed = true;
  try {
    if (win.source) win.source.close();
  } catch (e) {
    /* ignore */
  }
  try {
    if (win.stage) win.stage.dispose();
  } catch (e) {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// acceptance / debug handle
// ---------------------------------------------------------------------------
function measurePixels() {
  const canvas = dom.stage && dom.stage.querySelector('canvas');
  if (!canvas) return null;
  const w = canvas.width;
  const h = canvas.height;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  let nonTransparent = 0;
  let sumAlpha = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    sumAlpha += a;
    if (a > 8) nonTransparent++;
  }
  return {
    width: w,
    height: h,
    nonTransparent,
    coverage: nonTransparent / (w * h),
    meanAlpha: sumAlpha / (w * h),
    corners: {
      topLeft: data[3],
      topRight: data[(w - 1) * 4 + 3],
      bottomLeft: data[(h - 1) * w * 4 + 3],
      bottomRight: data[(h * w - 1) * 4 + 3],
    },
    preserveDrawingBuffer: config.debug,
  };
}

// ---------------------------------------------------------------------------
// Self-heal: the host keeps receiving *real audio* but this page gets no TTS
// events (silently dead SSE stream). We only judge on evidence: poll /health and
// require the host's `lastEnvelopeAt` to ADVANCE between two polls. A stale
// `speaking` flag (e.g. TTS aborted without speak_done) must never trigger a
// reconnect — that produced a reconnect/reload loop ("flickering") before.
// No page reload here: reloading a live window is too destructive and was the
// source of the flicker. SSE reconnect + host watchdog cover recovery.
// ---------------------------------------------------------------------------
let lastHealthEnvelopeAt = 0;
let healReconnects = 0;
let healWindowStartedAt = Date.now();

async function checkHostAndHeal() {
  if (win.disposed) return;
  let health = null;
  try {
    const response = await fetch('http://127.0.0.1:' + config.port + '/health', { cache: 'no-store' });
    if (!response.ok) return;
    health = await response.json();
  } catch (e) {
    return; // host unreachable: the normal reconnect/backoff path handles it
  }
  const envelopeAt = typeof health.lastEnvelopeAt === 'number' ? health.lastEnvelopeAt : 0;
  if (envelopeAt <= 0) return;
  const advanced = envelopeAt > lastHealthEnvelopeAt;
  if (advanced) lastHealthEnvelopeAt = envelopeAt;
  if (!advanced) return; // no fresh audio since the previous poll: nothing to judge
  // The host ingested an audio batch (so TTS is really playing), yet this page
  // has not seen a single TTS event for >2.5s -> the stream is stale.
  if (Date.now() - (win.lastTtsEventAt || 0) < 2500) return;
  healReconnects += 1;
  console.warn(TAG, 'host received fresh audio but no TTS SSE event arrived; reconnecting SSE', healReconnects);
  forceReconnect('stale-sse-during-audio');
}

window.setInterval(checkHostAndHeal, 1500);

/** Reconnect proactively when this page was hidden/unfocused and events are old. */
function reconnectIfStale(reason, thresholdMs) {
  if (win.disposed || !win.source) return;
  // Host state heartbeat every 10s keeps the age small while idle; only a real
  // gap (hidden renderer, resumed session, ...) exceeds these thresholds.
  const age = Date.now() - (win.lastEventAt || 0);
  if (age > (thresholdMs || 25000)) forceReconnect(reason);
}

/**
 * Called whenever the page becomes exposed again (focus, visibility, click,
 * minimise restore). Re-arm the render loop immediately and, if the host says
 * it is speaking but this page has not received TTS frames recently, rebuild
 * the SSE stream instead of waiting for the 25s stale threshold.
 */
async function healOnExpose(reason) {
  if (win.disposed) return;
  // Pointer/key/focus events can fire rapidly (focus fighting between the pet
  // and the main window); one recovery per second is enough.
  if ((reason === 'pointerdown' || reason === 'keydown' || reason === 'window-focus') && Date.now() - win.lastResumeAt < 1000) return;
  win.lastResumeAt = Date.now();
  win.resumeCount += 1;
  try {
    win.stage?.resume?.();
  } catch (e) {
    /* resume is best effort */
  }
  sampleFrameWatchdog(reason);
  reconnectIfStale(reason, 25000);
  try {
    const response = await fetch(healthUrl(), { cache: 'no-store' });
    if (!response.ok) return;
    const health = await response.json();
    if (win.disposed) return;
    const age = Date.now() - (win.lastTtsEventAt || 0);
    if (health && health.speaking === true && age > 1500) {
      forceReconnect(reason + ':speaking-without-frames');
    } else if (health && health.windowClients === 0 && win.eventCount > 0) {
      forceReconnect(reason + ':no-window-sse');
    }
  } catch (e) {
    /* host unreachable: the normal SSE reconnect loop handles it */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void healOnExpose('visibilitychange');
});
window.addEventListener('focus', () => void healOnExpose('window-focus'));
window.addEventListener('pageshow', () => void healOnExpose('pageshow'));
window.addEventListener('pointerdown', () => void healOnExpose('pointerdown'), true);
window.addEventListener('keydown', () => void healOnExpose('keydown'), true);

window.__DSH_LIVE2D_WINDOW__ = {
  /** Build marker: bump when the event-sync logic changes (debugging aid). */
  version: 'sync-12',
  config,
  runtime: runtimeStatus(),
  ready: () => win.ready,
  backend: () => (win.stage ? win.stage.backend : 'none'),
  stats: () => (win.stage ? win.stage.stats() : null),
  stage: () => win.stage,
  statuses: () => win.statuses,
  errors: () => win.errors,
  lastEvent: () => win.lastEvent,
  lastSpeechEvent: () => win.lastSpeechEvent || null,
  eventCount: () => win.eventCount || 0,
  lastEventAt: () => win.lastEventAt || 0,
  lastTtsEventAt: () => win.lastTtsEventAt || 0,
  pendingSpeech: () => win.pendingSpeech,
  audioStartedAt: () => win.audioStartedAt || 0,
  performId: () => win.performId,
  appliedEmotion: () => win.appliedEmotion,
  plannedChars: () => win.plannedChars,
  resumeCount: () => win.resumeCount || 0,
  droppedStaleEvents: () => win.droppedStaleEvents || 0,
  fallbackSpeeches: () => win.fallbackSpeeches || 0,
  lastHostSpeaking: () => win.lastHostSpeaking === true,
  resume: () => void healOnExpose('debug-resume'),
  eventSource: () => win.source,
  measurePixels,
  setVisible: (v) => win.stage && win.stage.setVisible(!!v),
  setEmotion: (name, intensity) => win.stage && win.stage.setEmotion(name, intensity),
};

if (!config.visible) setHint('', false);
setHint('等待 DSH host 连接…', true);
connect();






