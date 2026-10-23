/**
 * DSH Live2D plugin — browser half (source entry).
 *
 * Bundled by `build-client.mjs` into `lib/client.js` in the dsh-client-modules
 * factory format. Responsibilities:
 *  - mount and manage the transparent overlay (canvas host + small status chip);
 *  - connect to the Host half's local SSE stream (`GET /events`);
 *  - forward state/model changes, speech emotions/content and the real playback
 *    RMS envelopes to the Live2D renderer;
 *  - clean everything up when the Plugins row is switched off.
 *
 * The renderer module owns the actual Live2D stage; its preferred backend is a
 * vendored build of the Soullink Emotion SDK (`Live2DRenderer` + `SoullinkRuntime`)
 * and it falls back to a direct pixi-live2d-display implementation.
 *
 * No React, no baseline imports: everything (pixi + Live2D runtime) is bundled.
 *
 * @module @local/dsh-live2d/client
 */
import { createLive2DStage } from './renderer/index.js';

/** Client services (none required: the plugin owns its DOM and transport). */
export const inject = [];

const DEFAULT_PORT = 34567;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const Z_INDEX = '2147482000';

/** Resolve the Host half's local HTTP port (config override > URL param > default). */
function resolvePort() {
  try {
    const override = typeof window !== 'undefined' ? window.__DSH_LIVE2D_PORT__ : undefined;
    if (typeof override === 'number' && Number.isFinite(override)) return Math.trunc(override);
    if (typeof override === 'string' && /^\d+$/u.test(override)) return Number(override);
    const fromUrl = new URLSearchParams(window.location.search).get('live2dPort');
    if (fromUrl !== null && /^\d+$/u.test(fromUrl)) return Number(fromUrl);
    const stored = window.localStorage.getItem('dsh-live2d-port');
    if (stored !== null && /^\d+$/u.test(stored)) return Number(stored);
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_PORT;
}

/** Create the overlay DOM. The stage owns the canvas; the plugin owns the chrome. */
function mountOverlay() {
  const root = document.createElement('div');
  root.id = 'dsh-live2d-root';
  root.dataset.state = 'connecting';
  Object.assign(root.style, {
    position: 'fixed',
    zIndex: Z_INDEX,
    pointerEvents: 'none',
    display: 'none',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '4px',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    transition: 'opacity 160ms ease',
    opacity: '0'
  });
  const stageHost = document.createElement('div');
  stageHost.id = 'dsh-live2d-stage';
  Object.assign(stageHost.style, {
    position: 'relative',
    pointerEvents: 'none',
    width: '360px',
    height: '520px',
    background: 'transparent',
    border: 'none',
    overflow: 'visible'
  });
  const chip = document.createElement('div');
  chip.id = 'dsh-live2d-status';
  Object.assign(chip.style, {
    pointerEvents: 'none',
    fontSize: '10px',
    lineHeight: '14px',
    padding: '1px 7px',
    borderRadius: '999px',
    color: 'rgba(255,255,255,0.85)',
    background: 'rgba(18,18,22,0.45)',
    border: '1px solid rgba(255,255,255,0.10)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    opacity: '0.9'
  });
  chip.textContent = '';
  // Stage first, chip after: the chip sits just below the canvas near the screen
  // corner instead of floating at the top of the transparent canvas area.
  root.append(stageHost, chip);
  document.body.appendChild(root);
  return { root, chip, stageHost };
}

/** Position the overlay for an anchor/offset pair (config from the Host). */
function placeOverlay(root, model) {
  const anchor = typeof model?.anchor === 'string' ? model.anchor : 'bottom-right';
  const dx = Number.isFinite(model?.offsetX) ? model.offsetX : 0;
  const dy = Number.isFinite(model?.offsetY) ? model.offsetY : 0;
  const map = {
    'bottom-right': { right: '12px', bottom: '12px' },
    'bottom-left': { left: '12px', bottom: '12px' },
    'top-right': { right: '12px', top: '12px' },
    'top-left': { left: '12px', top: '12px' },
    center: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
  };
  for (const key of ['left', 'right', 'top', 'bottom', 'transform']) root.style[key] = '';
  Object.assign(root.style, map[anchor] ?? map['bottom-right']);
  if (dx !== 0) root.style.marginLeft = `${dx}px`;
  if (dy !== 0) root.style.marginTop = `${dy}px`;
  root.style.alignItems = anchor.endsWith('left') ? 'flex-start' : 'flex-end';
}

/**
 * Mount the plugin for one browser context.
 * @param ctx - Client root context (cordis).
 */
export function apply(ctx) {
  // The overlay lasts for exactly one activation; a re-activation mounts fresh state.
  let disposed = false;
  let root;
  let chip;
  let stageHost;
  let stage;
  let loading;
  let source;
  let retryTimer;
  let retryDelay = RETRY_MIN_MS;
  let currentModel;
  let modelKey = '';
  let visible = false;
  /** Segment announced but not yet audible: perform only once audio actually plays. */
  let pendingSpeech = null;
  /** id of the utterance that pendingSpeech belongs to. */
  let pendingSpeechId = null;
  /** Wall-clock time of the first real audio callback of the current utterance. */
  let audioStartedAt = 0;
  /** Utterance whose performance runs now (one speakStart per utterance). */
  let performId = null;
  /** Emotion already applied to the stage (skip duplicate intent triggers). */
  let appliedEmotion = '';
  /** Total characters of the planned utterance (for the duration estimate). */
  let plannedChars = 0;
  /** Content length of each requested segment (fallback timing). */
  let plannedSegmentChars = [];
  /** Planned segment count (grows as segment_start arrives). */
  let plannedSegmentCount = 0;
  /** index -> { emotion, text, seconds } for the current utterance. */
  let segments = new Map();
  /** Next segment to apply on the audio clock. */
  let nextSegmentIndex = 1;
  /** Wall clock of playback_start (audible beginning). */
  let playbackStartedAt = 0;
  /** Reported output latency for the current utterance. */
  let audioLatencyMs = 0;
  /** Wall clock of the latest SSE frame (used by the exposure recovery path). */
  let lastEventAt = 0;

  const rememberSegment = (index, speech) => {
    if (!Number.isFinite(index) || index < 0) return;
    const previous = segments.get(index) || {};
    segments.set(index, {
      emotion: speech.emotion || previous.emotion || '',
      text: (speech.text !== undefined ? speech.text : previous.text) || '',
      seconds: previous.seconds || 0,
    });
    if (index + 1 > plannedSegmentCount) plannedSegmentCount = index + 1;
  };

  const applySegment = (index, record) => {
    if (!record || stage === undefined) return;
    const durationMs = record.seconds > 0 ? Math.round(record.seconds * 1000) : undefined;
    if (record.emotion) {
      appliedEmotion = record.emotion;
      setChip(`${record.emotion}`);
    }
    if (typeof stage.speakSegment === 'function') {
      stage.speakSegment({
        emotion: record.emotion || undefined,
        text: record.text || '',
        intensity: 1,
        durationMs,
      });
      return;
    }
    if (record.emotion && record.emotion !== appliedEmotion) {
      if (typeof stage.speakEmotion === 'function') stage.speakEmotion(record.emotion, 1);
      else stage.setEmotion?.(record.emotion, 1);
    }
  };

  const exactStartSeconds = (index) => {
    let total = 0;
    for (let k = 0; k < index; k += 1) {
      const record = segments.get(k);
      if (!record || !(record.seconds > 0)) return null;
      total += record.seconds;
    }
    return total;
  };

  const estimatedStartSeconds = (index) => {
    let total = 0;
    for (let k = 0; k < index; k += 1) {
      const record = segments.get(k);
      const chars = record && record.text ? record.text.length : (plannedSegmentChars[k] || 0);
      total += 0.28 + chars * 0.2;
    }
    return total;
  };

  /** Apply announced segments whose real audio start has been reached. */
  const advanceSpeechSegments = () => {
    if (stage === undefined || audioStartedAt === 0 || !playbackStartedAt) return;
    const audioPos = (Date.now() - playbackStartedAt - (audioLatencyMs || 0)) / 1000;
    let guard = 0;
    let dueIndex = -1;
    let dueRecord = null;
    while (nextSegmentIndex < plannedSegmentCount && guard < 8) {
      guard += 1;
      const index = nextSegmentIndex;
      const record = segments.get(index);
      if (!record) break;
      const exact = exactStartSeconds(index);
      const startSeconds = exact !== null ? exact : estimatedStartSeconds(index);
      if (audioPos + 0.06 < startSeconds) break;
      // A pause can make several segments due at once; only jump to the latest
      // position instead of replaying every intermediate emotion.
      dueIndex = index;
      dueRecord = record;
      nextSegmentIndex = index + 1;
    }
    if (dueRecord !== null) applySegment(dueIndex, dueRecord);
  };

  const beginSpeech = (speech, utteranceId) => {
    if (!speech || stage === undefined) return;
    audioStartedAt = Date.now();
    pendingSpeech = null;
    pendingSpeechId = null;
    const id = utteranceId === undefined || utteranceId === null ? null : String(utteranceId);
    const emotion = speech.emotion || '';
    const isNewUtterance = performId === null || id === null || id !== performId;
    if (isNewUtterance) {
      const chars = plannedChars || String(speech.text || speech.content || '').length;
      const durationSeconds = Math.min(120, Math.max(1.6, 1.7 + chars * 0.17 + 1.5));
      const firstRecord = segments.get(0);
      const firstSeconds = firstRecord && firstRecord.seconds > 0 ? firstRecord.seconds : 0;
      const firstText = firstRecord && firstRecord.text ? firstRecord.text : (speech.text || speech.content || '');
      const durationMs = firstSeconds > 0
        ? Math.round(firstSeconds * 1000)
        : Math.max(900, Math.round((0.3 + firstText.length * 0.2) * 1000));
      performId = id;
      appliedEmotion = emotion;
      if (!playbackStartedAt) playbackStartedAt = Date.now();
      setChip(`${emotion || '说话中'}`);
      stage.speakStart?.({ emotion: speech.emotion, text: speech.text ?? speech.content ?? '', durationSeconds, durationMs });
      return;
    }
    /* Same utterance: segment_start is a synthesis event that leads the sound;
       record it and let the audio clock apply it. */
    rememberSegment(Number.isFinite(speech.index) ? speech.index : nextSegmentIndex, speech);
    advanceSpeechSegments();
  };

  const resetSpeech = () => {
    pendingSpeech = null;
    pendingSpeechId = null;
    audioStartedAt = 0;
    performId = null;
    appliedEmotion = '';
    plannedChars = 0;
    plannedSegmentChars = [];
    plannedSegmentCount = 0;
    segments = new Map();
    nextSegmentIndex = 1;
    playbackStartedAt = 0;
    audioLatencyMs = 0;
  };

  /** Remember the whole utterance announced by `speak_request` (total length). */
  const planSpeech = (event) => {
    resetSpeech();
    const requested = Array.isArray(event.segments) ? event.segments : [];
    plannedSegmentChars = requested.map((segment) => String((segment && segment.content) || '').length);
    plannedChars = plannedSegmentChars.reduce((total, length) => total + length, 0);
    if (Number.isFinite(event.latencyMs)) audioLatencyMs = event.latencyMs;
  };

  const setChip = (text) => {
    if (chip !== undefined) chip.textContent = text;
  };

  const syncVisibility = () => {
    if (root === undefined) return;
    root.style.display = visible ? 'flex' : 'none';
    root.style.opacity = visible ? '1' : '0';
    root.dataset.visible = visible ? 'true' : 'false';
    // Stopping the render loop when hidden is the main CPU saving (the renderer
    // owns the loop and pauses on setVisible(false)).
    if (stage !== undefined) stage.setVisible?.(visible);
  };

  const loadStage = (model) => {
    if (model === null || model === undefined || loading !== undefined || disposed) return;
    const key = `${model.id}|${model.modelFile}|${model.baseUrl}`;
    if (key === modelKey && stage !== undefined) return;
    loading = (async () => {
      try {
        if (stage !== undefined) {
          stage.dispose?.();
          stage = undefined;
        }
        setChip('Live2D 加载中…');
        if (Number.isFinite(model.maxWidth)) stageHost.style.width = `${model.maxWidth}px`;
        if (Number.isFinite(model.maxHeight)) stageHost.style.height = `${model.maxHeight}px`;
        const created = await createLive2DStage({
          container: stageHost,
          model,
          onStatus: (status) => {
            if (disposed) return;
            if (status.kind === 'ready') setChip('');
            else if (status.kind === 'error') setChip(`Live2D 加载失败：${status.message}`);
          }
        });
        if (disposed) {
          created?.dispose?.();
          return;
        }
        stage = created;
        modelKey = key;
        stage.setVisible?.(visible);
        if (Number.isFinite(model.scale)) stage.setScale?.(model.scale);
        // Acceptance/debug handle: lets Playwright (and the user console) read the
        // active backend, fps, mouth value, envelope queue and hidden parts without
        // poking into renderer internals. Removed on dispose.
        try {
          window.__DSH_LIVE2D_STATS__ = () => {
            try {
              return stage?.stats?.() ?? null;
            } catch {
              return null;
            }
          };
        } catch {
          /* non-browser or frozen window: diagnostics only */
        }
      } catch (error) {
        setChip(`Live2D 加载失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        loading = undefined;
      }
    })();
  };

  /** Apply a state event: visibility, model selection, position/scale. */
  const applyState = (event) => {
    // `overlayVisible` controls the in-page overlay; in standalone-window mode it is
    // false and this half stays hidden while the pet window does the rendering.
    visible = event.overlayVisible === true || (event.overlayVisible === undefined && event.visible === true);
    if (event.model !== null && typeof event.model === 'object') {
      const next = event.model;
      currentModel = next;
      placeOverlay(root, next);
      if (next.id !== undefined && Number.isFinite(next.maxWidth)) stageHost.style.width = `${next.maxWidth}px`;
      if (next.id !== undefined && Number.isFinite(next.maxHeight)) stageHost.style.height = `${next.maxHeight}px`;
      loadStage(next);
      if (stage !== undefined) {
        if (Number.isFinite(next.scale)) stage.setScale?.(next.scale);
        stage.setPosition?.(next.anchor, next.offsetX, next.offsetY);
      }
    }
    syncVisibility();
    if (!visible) setChip('');
    else if (event.speaking === true) setChip(`${event.emotion || '说话中'}`);
  };

  const handleEvent = (event) => {
    if (disposed || event === null || typeof event !== 'object') return;
    lastEventAt = Date.now();
    if (event.type === 'state') {
      applyState(event);
      return;
    }
    // Speech reactions only run while the avatar is shown; a hidden avatar stays
    // hidden (the user asked for an explicit display switch).
    if (!visible || stage === undefined) return;
    if (event.type === 'speak_request') {
      planSpeech(event);
      return;
    }
    if (event.type === 'segment_start') {
      const index = Number.isFinite(event.index) ? event.index : 0;
      const speech = {
        index,
        emotion: event.emotion,
        text: event.text ?? event.content ?? '',
        content: event.text ?? event.content ?? '',
      };
      if (Number.isFinite(event.latencyMs)) {
        stage.setAudioLatency?.(event.latencyMs);
        audioLatencyMs = event.latencyMs;
      }
      // The TTS pipeline announces a segment when its synthesis starts, which can
      // lead its audio by a second or more. Only the first segment starts the
      // performance (at playback_start); later ones are applied on the audio
      // clock (advanceSpeechSegments) so the expression lines up with the sound.
      rememberSegment(index, speech);
      if (audioStartedAt !== 0) advanceSpeechSegments();
      else if (!pendingSpeech) {
        pendingSpeech = speech;
        pendingSpeechId = event.id === undefined ? null : event.id;
      }
      return;
    }
    if (event.type === 'playback_start') {
      if (Number.isFinite(event.latencyMs)) audioLatencyMs = event.latencyMs;
      playbackStartedAt = Date.now();
      if (pendingSpeech) beginSpeech(pendingSpeech, pendingSpeechId);
      else audioStartedAt = Date.now();
      advanceSpeechSegments();
      return;
    }
    if (event.type === 'envelope') {
      if (typeof event.sentAt === 'number' && Date.now() - event.sentAt > 1500) return;
      if (pendingSpeech) {
        playbackStartedAt = playbackStartedAt || Date.now();
        beginSpeech(pendingSpeech, pendingSpeechId);
      }
      if (Number.isFinite(event.latencyMs)) audioLatencyMs = event.latencyMs;
      stage.pushEnvelope?.(event.frames ?? [], event.hopMs ?? 20, Number.isFinite(event.latencyMs) ? { latencyMs: event.latencyMs } : undefined);
      advanceSpeechSegments();
      return;
    }
    if (event.type === 'emotion') {
      if (pendingSpeech) return; // applied with the first audible frame
      if (!event.name) {
        stage.clearEmotion?.();
        appliedEmotion = '';
        return;
      }
      const name = String(event.name);
      const intensity = typeof event.intensity === 'number' ? event.intensity : 1;
      // During speech the scheduler applies the mood at the segment's real audio
      // position; this event fires at synthesis time and would lead the sound.
      if (audioStartedAt !== 0) return;
      stage.setEmotion?.(name, intensity);
      appliedEmotion = name;
      return;
    }
    if (event.type === 'speak_done' || event.type === 'speech_end') {
      // Both speak_done and speech_end arrive for one utterance: end once.
      if (audioStartedAt !== 0 || performId !== null) stage.speakEnd?.();
      resetSpeech();
      setChip('');
      return;
    }
    if (event.type === 'segment_end') {
      // Exact per-segment audio duration: the scheduler uses the real audio clock
      // instead of the synthesis lead.
      const index = Number.isFinite(event.index) ? event.index : -1;
      const seconds = Number(event.seconds);
      if (index >= 0 && segments.has(index) && Number.isFinite(seconds) && seconds > 0) {
        const record = segments.get(index);
        record.seconds = seconds;
        if (index + 1 > plannedSegmentCount) plannedSegmentCount = index + 1;
      }
      advanceSpeechSegments();
      return;
    }
    if (event.type === 'test') {
      stage.speakStart?.({ emotion: event.emotion, text: '' });
      stage.setEmotion?.(event.emotion, 1);
      stage.pushEnvelope?.(event.frames ?? [0.2, 0.6, 0.9, 0.5, 0.1], 40);
      return;
    }
    if (event.type === 'log') setChip(String(event.text ?? ''));
  };

  const connect = () => {
    if (disposed) return;
    // `client=overlay` lets the host tell overlay clients from the standalone
    // pet window (the host watchdog only heals the standalone window stream).
    const url = `http://127.0.0.1:${resolvePort()}/events?client=overlay`;
    try {
      source = new EventSource(url);
    } catch {
      scheduleRetry();
      return;
    }
    source.onopen = () => {
      retryDelay = RETRY_MIN_MS;
    };
    source.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(message.data));
      } catch {
        /* malformed frame: ignore */
      }
    };
    source.onerror = () => {
      try {
        source?.close();
      } catch {
        /* ignore */
      }
      source = undefined;
      scheduleRetry();
    };
  };

  const scheduleRetry = () => {
    if (disposed || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, retryDelay);
    retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.6));
  };

  ctx.effect(() => {
    if (typeof document === 'undefined' || document.body === null) {
      const onReady = () => apply(ctx);
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
      return () => document.removeEventListener('DOMContentLoaded', onReady);
    }
    ({ root, chip, stageHost } = mountOverlay());
    placeOverlay(root, currentModel);
    connect();
    // Chromium can pause rAF for a background tab/window; when this page is
    // exposed again, re-arm the stage and drop any stale envelope backlog.
    const onExposed = () => {
      if (disposed) return;
      try {
        stage?.resume?.();
      } catch {
        /* best effort */
      }
      // The host sends a state heartbeat every 10s, so the normal retry path
      // covers a dead stream; only ask for a reconnect when it is really old.
      if (Date.now() - (lastEventAt || 0) > 25000) {
        try {
          source?.close();
        } catch {
          /* ignore */
        }
        source = undefined;
        scheduleRetry();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onExposed();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onExposed);
    window.addEventListener('pageshow', onExposed);
    // A cheap health probe gives the user (and the acceptance run) a visible
    // marker even before the first state event arrives.
    void (async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${resolvePort()}/health`);
        const health = await response.json();
        if (disposed) return;
        if (health?.model && currentModel === undefined) {
          // The SSE state frame will follow; nothing to do but keep the port warm.
        }
      } catch {
        /* the SSE retry loop reports the connection state */
      }
    })();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onExposed);
      window.removeEventListener('pageshow', onExposed);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      try {
        source?.close();
      } catch {
        /* ignore */
      }
      try {
        stage?.dispose?.();
      } catch {
        /* ignore */
      }
      stage = undefined;
      try {
        delete window.__DSH_LIVE2D_STATS__;
      } catch {
        /* ignore */
      }
      root?.remove();
    };
  }, 'live2d overlay');
}
