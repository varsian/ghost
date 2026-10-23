/**
 * DSH Live2D plugin — Host half.
 *
 * Owns one local HTTP server on 127.0.0.1:<port> that carries the browser half's
 * event stream (`GET /events`, SSE), the TTS daemon shim's ingest (`POST /ingest`),
 * the model catalog and model assets (`GET /models`, `GET /model`, `GET /assets/*`),
 * and lightweight browser→host commands (`POST /command`). Also registers the
 * `/live2d` command family on the Host command plane (never reaches the model).
 *
 * No third-party runtime dependencies: single file, node builtins only.
 * The browser half (`lib/client.js`) is served by dsh-client-modules from
 * this package's `dsh.client` declaration.
 *
 * @module @local/dsh-live2d
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Host subscription: the command plane; everything else is optional at runtime. */
export const inject = ['commands'];
/** Loader identity used in logs and the Plugins page. */
export const name = 'live2d';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Repository root of the deliverable (`live2d-pet/`); `tools/` lives there. */
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const VERSION = '0.2.0';

/** MIME types the model loader needs; everything else is served as octet-stream. */
const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.moc': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.motion3.json': 'application/json; charset=utf-8',
  '.exp3.json': 'application/json; charset=utf-8',
  '.physics3.json': 'application/json; charset=utf-8',
  '.pose3.json': 'application/json; charset=utf-8',
  '.cdi3.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
};

const DEFAULT_CONFIG = {
  port: 34567,
  modelsDir: '',
  defaultModel: '',
  /** Presentation: `window` = standalone always-on-top pet window, `overlay` = in-page overlay, `both`/`none`. */
  mode: 'overlay',
  visible: false,
  scale: 1,
  anchor: 'bottom-right',
  offsetX: 0,
  offsetY: 0,
  opacity: 1,
  fps: 30,
  idleFps: 24,
  maxWidth: 360,
  maxHeight: 520,
  devicePixelRatioCap: 1,
  idleMotion: true,
  blink: true,
  breathe: true,
  gazeFollow: true,
  lipSync: true,
  lipSyncGain: 1,
  lipSyncSmoothing: 0.55,
  /** Empty (default) = natural idle sway only; a non-empty list re-enables random idle moods. */
  idleMoods: [],
  expressionMap: {},
  dataDir: '',
  ingestToken: '',
  /** Standalone window (Electron launcher in <repo>/tools/live2d-window). */
  windowWidth: 360,
  windowHeight: 520,
  windowX: null,
  windowY: null,
  windowAlwaysOnTop: false,
  windowLauncher: '',
  /** Close duplicate pet windows found in the launcher log on startup. */
  windowDedupe: true,
  /** Drop an SSE client whose socket buffers more than this while paused. */
  sseBackpressureBytes: 64 * 1024,
  sseBackpressureMs: 5000
};

/** Framework-free logger adapter: `ctx.logger` may be a function or an object. */
function makeLog(ctx) {
  const logger = ctx?.logger;
  const emit = (level, text) => {
    try {
      if (typeof logger === 'function') logger(`[live2d] ${text}`);
      else if (logger && typeof logger[level] === 'function') logger[level](`[live2d] ${text}`);
      else console[level === 'warn' || level === 'error' ? level : 'log'](`[live2d] ${text}`);
    } catch {
      /* logging must never break the plugin */
    }
  };
  return {
    info: (text) => emit('info', text),
    warn: (text) => emit('warn', text),
    error: (text) => emit('error', text)
  };
}

/** Read one finite number from config, falling back to a default. */
function numberOr(value, fallback, min = -Infinity, max = Infinity) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Normalize the row config into the exact shape the plugin uses. */
function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  config.port = Math.trunc(numberOr(config.port, DEFAULT_CONFIG.port, 1, 65535));
  config.scale = numberOr(config.scale, 1, 0.1, 8);
  config.offsetX = numberOr(config.offsetX, 0, -10000, 10000);
  config.offsetY = numberOr(config.offsetY, 0, -10000, 10000);
  config.opacity = numberOr(config.opacity, 1, 0, 1);
  config.fps = Math.trunc(numberOr(config.fps, 30, 1, 60));
  config.idleFps = Math.trunc(numberOr(config.idleFps, 24, 1, 60));
  config.maxWidth = Math.trunc(numberOr(config.maxWidth, 360, 80, 2000));
  config.maxHeight = Math.trunc(numberOr(config.maxHeight, 520, 80, 3000));
  config.windowWidth = Math.trunc(numberOr(config.windowWidth, 360, 120, 2000));
  config.windowHeight = Math.trunc(numberOr(config.windowHeight, 520, 120, 3000));
  config.windowX = Number.isFinite(config.windowX) ? Math.trunc(config.windowX) : null;
  config.windowY = Number.isFinite(config.windowY) ? Math.trunc(config.windowY) : null;
  config.devicePixelRatioCap = numberOr(config.devicePixelRatioCap, 1, 0.5, 3);
  config.lipSyncGain = numberOr(config.lipSyncGain, 1, 0.1, 8);
  config.lipSyncSmoothing = numberOr(config.lipSyncSmoothing, 0.55, 0, 0.98);
  config.idleMoods = Array.isArray(config.idleMoods)
    ? config.idleMoods.filter((name) => typeof name === 'string' && name.trim() !== '').slice(0, 32)
    : [];
  for (const key of ['visible', 'idleMotion', 'blink', 'breathe', 'gazeFollow', 'lipSync', 'windowAlwaysOnTop', 'windowDedupe']) {
    config[key] = config[key] !== false;
  }
  config.sseBackpressureBytes = Math.trunc(numberOr(config.sseBackpressureBytes, 64 * 1024, 16 * 1024, 16 * 1024 * 1024));
  config.sseBackpressureMs = Math.trunc(numberOr(config.sseBackpressureMs, 5000, 500, 60000));
  if (!['window', 'overlay', 'both', 'none'].includes(config.mode)) config.mode = 'overlay';
  const anchors = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'];
  if (!anchors.includes(config.anchor)) config.anchor = 'bottom-right';
  config.modelsDir = typeof config.modelsDir === 'string' && config.modelsDir.trim() !== ''
    ? resolve(config.modelsDir)
    : join(PACKAGE_ROOT, 'models');
  config.dataDir = typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
    ? resolve(config.dataDir)
    : join(PACKAGE_ROOT, 'data');
  return config;
}

/** Generate or reuse the random ingest token the TTS shim presents. */
function loadIngestToken(config, log) {
  if (typeof config.ingestToken === 'string' && config.ingestToken.trim() !== '') return config.ingestToken.trim();
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const path = join(config.dataDir, 'ingest-token.txt');
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
    const token = randomBytes(24).toString('hex');
    writeFileSync(path, `${token}\n`, 'utf8');
    return token;
  } catch (error) {
    log.warn(`cannot persist the ingest token (${error instanceof Error ? error.message : String(error)}); using a per-run token`);
    return randomBytes(24).toString('hex');
  }
}

/** Every file below `dir`, as POSIX-ish paths relative to it (bounded depth, symlink-safe). */
function listFilesRelative(dir, depth = 3) {
  const out = [];
  if (depth < 0) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      for (const nested of listFilesRelative(join(dir, entry.name), depth - 1)) out.push(`${entry.name}/${nested}`);
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out;
}

/** Read the optional `live2d.manifest.json` a model directory may ship. */
function readModelManifest(dir) {
  try {
    const path = join(dir, 'live2d.manifest.json');
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Find available model candidates under one directory: `<name>/<file>.model3.json` or `.model.json`. */
function scanModels(modelsDir, port = 0) {
  const models = [];
  if (!existsSync(modelsDir)) return models;
  let entries = [];
  try {
    entries = readdirSync(modelsDir, { withFileTypes: true });
  } catch {
    return models;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(modelsDir, entry.name);
    let files = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    const candidates = files
      .filter((file) => file.toLowerCase().endsWith('.model3.json') || file.toLowerCase().endsWith('.model.json'))
      .sort((a, b) => b.endsWith('.model3.json') - a.endsWith('.model3.json') || a.localeCompare(b));
    if (candidates.length === 0) continue;
    const modelFile = candidates[0];
    const format = modelFile.toLowerCase().endsWith('.model3.json') ? 'cubism4' : 'cubism2';
    const manifest = readModelManifest(dir);
    const allFiles = listFilesRelative(dir);
    const expressions = allFiles
      .filter((file) => file.toLowerCase().endsWith('.exp3.json'))
      .map((file) => ({ name: file.slice(file.lastIndexOf('/') + 1).replace(/\.exp3\.json$/iu, ''), file }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const motions = allFiles
      .filter((file) => file.toLowerCase().endsWith('.motion3.json'))
      .map((file) => ({ name: file.slice(file.lastIndexOf('/') + 1).replace(/\.motion3\.json$/iu, ''), file, group: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : 'motions' }));
    const hiddenParts = Array.isArray(manifest?.hiddenParts) ? manifest.hiddenParts.filter((value) => typeof value === 'string') : [];
    const baseUrl = `http://127.0.0.1:${port}/assets/${encodeURIComponent(entry.name)}/`;
    const profileFile = allFiles.find((file) => file.toLowerCase().endsWith('soullink.profile.json'));
    models.push({
      id: entry.name,
      name: typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : entry.name,
      dir,
      modelFile,
      format,
      baseUrl,
      expressions,
      motions,
      hiddenParts,
      profileUrl: profileFile === undefined ? undefined : `${baseUrl}${profileFile.split('/').map((part) => encodeURIComponent(part)).join('/')}`,
      profileFile,
      hiddenPartsSource: hiddenParts.length > 0 ? 'manifest' : 'none'
    });
  }
  return models;
}

/** A tiny SSE hub: broadcast JSON events to every open browser stream. */
class EventHub {
  constructor(log, options = {}) {
    this.log = log;
    this.clients = new Set();
    /** SSE client role by response: 'window' (standalone pet) / 'overlay' / 'unknown'. */
    this.roles = new Map();
    /** Wall clock when a client's socket first refused a write (0 = flowing). */
    this.blockedSince = new Map();
    this.maxBufferedBytes = Math.max(16 * 1024, Number(options.maxBufferedBytes) || 64 * 1024);
    this.blockedTimeoutMs = Math.max(1000, Number(options.blockedTimeoutMs) || 5000);
    this.dropped = 0;
    this.lastDropAt = 0;
    this.seq = 0;
  }

  /**
   * Register one open SSE stream.
   * @param res - HTTP response of the stream.
   * @param role - 'window' | 'overlay' | 'unknown', from the `client` query parameter.
   */
  add(res, role = 'unknown') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    this.roles.set(res, role);
    this.blockedSince.set(res, 0);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* the close handler cleans up */
      }
    }, 15000);
    const drop = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
      this.roles.delete(res);
      this.blockedSince.delete(res);
    };
    res.on('close', drop);
    res.on('error', drop);
    return () => drop();
  }

  /** Number of SSE clients for one role (the host uses 'window' for a liveness check). */
  countRole(role) {
    let count = 0;
    for (const value of this.roles.values()) if (value === role) count += 1;
    return count;
  }

  /** Drop a client whose socket is no longer draining (paused/occluded renderer). */
  dropClient(res, reason) {
    const role = this.roles.get(res) || 'unknown';
    this.clients.delete(res);
    this.roles.delete(res);
    this.blockedSince.delete(res);
    this.dropped += 1;
    this.lastDropAt = Date.now();
    this.log.warn(`sse client dropped (${role}): ${reason}`);
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  }

  stats() {
    let bufferedBytes = 0;
    for (const res of this.clients) {
      const length = typeof res.writableLength === 'number' ? res.writableLength : 0;
      if (length > bufferedBytes) bufferedBytes = length;
    }
    return {
      clients: this.clients.size,
      windowClients: this.countRole('window'),
      overlayClients: this.countRole('overlay'),
      bufferedBytes,
      dropped: this.dropped,
      lastDropAt: this.lastDropAt
    };
  }

  broadcast(event) {
    this.seq += 1;
    // `sentAt` lets a renderer discard frames that were buffered while its main
    // thread was paused instead of playing them late.
    const line = `data: ${JSON.stringify({ ...event, seq: this.seq, sentAt: Date.now() })}\n\n`;
    const now = Date.now();
    for (const res of [...this.clients]) {
      try {
        if (res.destroyed || res.writableEnded) {
          this.dropClient(res, 'closed');
          continue;
        }
        const ok = res.write(line);
        if (ok) {
          this.blockedSince.set(res, 0);
        } else if (!this.blockedSince.get(res)) {
          this.blockedSince.set(res, now);
        }
        const buffered = typeof res.writableLength === 'number' ? res.writableLength : 0;
        const blockedFor = this.blockedSince.get(res) ? now - this.blockedSince.get(res) : 0;
        if (buffered > this.maxBufferedBytes || blockedFor > this.blockedTimeoutMs) {
          this.dropClient(res, `backpressure buffered=${buffered}B blocked=${blockedFor}ms`);
        }
      } catch (error) {
        this.dropClient(res, `write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  closeAll() {
    for (const res of [...this.clients]) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.roles.clear();
    this.blockedSince.clear();
  }
}

/** Answer an HTTP request with JSON and CORS headers. */
function sendJson(res, code, value) {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/** Read a request body with a hard byte cap. */
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolve one asset request below a model directory, refusing traversal and absolute paths. */
function resolveAssetPath(modelDir, relativePath) {
  const root = resolve(modelDir);
  const decoded = decodeURIComponent(relativePath).replace(/\\/gu, '/');
  if (decoded.includes('\u0000')) return undefined;
  const target = resolve(root, normalize(decoded));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) return undefined;
  return target;
}

/**
 * Build the plugin instance: state, model catalog, event hub and HTTP server.
 * Exposed for tests; `apply` uses it directly.
 */
export function createLive2DHost(ctx, rawConfig) {
  const log = makeLog(ctx);
  const config = normalizeConfig(rawConfig);
  const token = loadIngestToken(config, log);
  const hub = new EventHub(log, {
    maxBufferedBytes: config.sseBackpressureBytes,
    blockedTimeoutMs: config.sseBackpressureMs
  });
  const state = {
    visible: config.visible,
    mode: config.mode,
    /** In-page overlay visibility (independent from the standalone window). */
    overlayVisible: config.mode === 'overlay' || config.mode === 'both' ? config.visible : false,
    /** Standalone Electron window state owned by this host instance. */
    windowOpen: false,
    windowPid: null,
    /** Whether the standalone window should be shown (user intent, survives close→open). */
    windowIntent: config.visible && (config.mode === 'window' || config.mode === 'both'),
    modelId: config.defaultModel || '',
    scale: config.scale,
    anchor: config.anchor,
    offsetX: config.offsetX,
    offsetY: config.offsetY,
    opacity: config.opacity,
    speaking: false,
    emotion: '',
    content: '',
    /** Playback/output latency reported by the TTS shim (ms), forwarded to renderers. */
    latencyMs: 0,
    /** Most recent real-audio envelope received from the TTS shim. */
    lastEnvelopeAt: null,
    lastEnvelopeLevel: 0,
    /** Wall clock of the latest periodic `state` broadcast (window liveness clock). */
    lastStateTickAt: 0
  };
  let models = scanModels(config.modelsDir, config.port);
  const currentModel = () => models.find((model) => model.id === state.modelId) ?? (state.modelId === '' ? models[0] : undefined);
  const modelPayload = () => {
    const model = currentModel();
    if (model === undefined) return null;
    return {
      id: model.id,
      name: model.name,
      format: model.format,
      modelFile: model.modelFile,
      baseUrl: model.baseUrl,
      modelUrl: `${model.baseUrl}${encodeURIComponent(model.modelFile)}`,
      expressions: model.expressions,
      motions: model.motions,
      hiddenParts: model.hiddenParts,
      ...(model.profileUrl === undefined ? {} : { profileUrl: model.profileUrl }),
      scale: state.scale,
      opacity: state.opacity,
      anchor: state.anchor,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
      fps: config.fps,
      idleFps: config.idleFps,
      mode: config.mode,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      windowWidth: config.windowWidth,
      windowHeight: config.windowHeight,
      devicePixelRatioCap: config.devicePixelRatioCap,
      idleMotion: config.idleMotion,
      blink: config.blink,
      breathe: config.breathe,
      gazeFollow: config.gazeFollow,
      lipSync: config.lipSync,
      lipSyncGain: config.lipSyncGain,
      lipSyncSmoothing: config.lipSyncSmoothing,
      idleMoods: config.idleMoods,
      expressionMap: config.expressionMap
    };
  };
  const statePayload = () => ({
    type: 'state',
    visible: state.visible,
    overlayVisible: state.overlayVisible,
    mode: state.mode,
    windowOpen: state.windowOpen,
    windowPid: state.windowPid,
    speaking: state.speaking,
    emotion: state.emotion,
    content: state.content,
    latencyMs: state.latencyMs,
    lastEnvelopeAt: state.lastEnvelopeAt,
    model: modelPayload()
  });

  /** Choose the initial model when the configured one does not exist. */
  if (currentModel() !== undefined && state.modelId === '') state.modelId = currentModel().id;
  const broadcastState = () => hub.broadcast(statePayload());
  const setVisible = (visible, reason = 'command') => {
    state.visible = visible;
    state.windowIntent = visible;
    if (state.mode === 'overlay') state.overlayVisible = visible;
    log.info(`display ${visible ? 'on' : 'off'} (${reason})`);
    broadcastState();
    return state.visible;
  };
  const setOverlayVisible = (visible, reason = 'command') => {
    state.overlayVisible = visible;
    log.info(`overlay ${visible ? 'on' : 'off'} (${reason})`);
    broadcastState();
    return state.overlayVisible;
  };

  /** Standalone transparent pet window handled by <repo>/tools/live2d-window. */
  const windowScript = (name = 'launch.mjs') => {
    if (typeof config.windowLauncher === 'string' && config.windowLauncher.trim() !== '' && name === 'launch.mjs') return resolve(config.windowLauncher);
    return join(REPO_ROOT, 'tools', 'live2d-window', name);
  };
  /** Run the launcher once and parse its single-line JSON result (best effort). */
  const executeLauncher = (args, timeoutMs = 20000) => new Promise((resolvePromise) => {
    const script = windowScript('launch.mjs');
    if (!existsSync(script)) {
      resolvePromise({ ok: false, error: `window launcher not found: ${script}` });
      return;
    }
    const launcherEnv = { ...process.env, LIVE2D_WINDOW_DATA: config.dataDir };
    delete launcherEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(nodeBinary(), [script, ...args], { cwd: REPO_ROOT, windowsHide: true, env: launcherEnv });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          settle(JSON.parse(trimmed));
          return;
        } catch {
          /* keep buffering */
        }
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => settle({ ok: false, error: error.message }));
    child.on('exit', (code) => {
      if (!settled) settle({ ok: false, error: `launcher exited with code ${String(code)}: ${stderr.trim().slice(0, 600)}` });
    });
    setTimeout(() => settle({ ok: false, error: 'launcher timed out' }), timeoutMs);
  });
  const windowUrl = () => `http://127.0.0.1:${config.port}/window?port=${config.port}&scale=${state.scale}&anchor=${state.anchor}&fps=${config.fps}&idleFps=${config.idleFps}&client=window`;
  const nodeBinary = () => process.env.DSH_NODE_PATH || 'node';
  const windowControlPath = () => join(config.dataDir, 'window-control.json');
  const windowBoundsPath = () => join(config.dataDir, 'window-bounds.json');

  /** Ask the running window to resize/move/close through its control file. */
  const controlWindow = (payload) => {
    try {
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(windowControlPath(), `${JSON.stringify({ at: String(Date.now()), ...payload })}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  /** Last geometry the window reported (saved on resize/move/close). */
  const readWindowBounds = () => {
    try {
      const parsed = JSON.parse(readFileSync(windowBoundsPath(), 'utf8'));
      return Number.isFinite(parsed?.width) && Number.isFinite(parsed?.height) ? parsed : null;
    } catch {
      return null;
    }
  };
  const parseWindowSize = (tokens) => {
    const raw = tokens.slice(2).join(' ').trim();
    const match = /^(\d{2,4})\s*[xX*×,\s]\s*(\d{2,4})$/u.exec(raw);
    if (match !== null) return { width: Number(match[1]), height: Number(match[2]) };
    const single = /^(\d{2,4})$/u.exec(raw);
    if (single !== null) return { width: Number(single[1]), height: Number(single[1]) };
    return null;
  };

  /** True when a process exists (EPERM still means alive). */
  const pidAlive = (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  };
  /**
   * Live window pid from the launcher's pid file, falling back to the window's
   * exclusive instance lock. The lock is authoritative when a close/restart
   * race lost the pid file; adopting it here prevents launching a duplicate.
   */
  const liveWindowPid = () => {
    const pidPath = join(config.dataDir, 'live2d-window.pid');
    const lockPath = join(config.dataDir, 'live2d-window.lock');
    const readPid = (path) => {
      try {
        const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch {
        return null;
      }
    };
    const pidFilePid = readPid(pidPath);
    if (pidAlive(pidFilePid)) return pidFilePid;
    const lockPid = readPid(lockPath);
    if (pidAlive(lockPid)) {
      // The pid file was lost but the window still owns its lock: re-adopt it.
      try {
        writeFileSync(pidPath, `${lockPid}\n`, 'utf8');
      } catch {
        /* best effort */
      }
      return lockPid;
    }
    return null;
  };
  const syncWindowState = () => {
    const pid = liveWindowPid();
    state.windowOpen = pid !== null;
    if (pid !== null) state.windowPid = pid;
    else state.windowPid = null;
    return pid;
  };

  /** Launch (or no-op when already open) the standalone window; resolves with launcher JSON. */
  const launchWindowNow = async (attempt = 1) => {
    syncWindowState();
    if (state.windowOpen) {
      if (config.windowDedupe) {
        const dedupe = await executeLauncher(['--dedupe']);
        if (dedupe?.ok === true && dedupe.killed?.length) {
          log.info(`standalone window dedupe removed ${dedupe.killed.length} duplicate window(s)`);
          syncWindowState();
        }
      }
      // A window that is shutting down still owns the pid for a moment; let it
      // finish so the caller falls through to a real launch instead of reporting
      // a window that is about to disappear.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      if (liveWindowPid() === null) {
        state.windowOpen = false;
        state.windowPid = null;
      } else {
        controlWindow({ show: true });
        return { ok: true, already: true, pid: state.windowPid };
      }
    }
    const script = windowScript('launch.mjs');
    if (!existsSync(script)) {
      return { ok: false, error: `window launcher not found: ${script} (npm install in tools/live2d-window first)` };
    }
    const args = [script, '--url', windowUrl(), '--width', String(config.windowWidth), '--height', String(config.windowHeight)];
    if (state.scale !== 1) args.push('--scale', String(state.scale));
    if (Number.isFinite(config.windowX)) args.push('--x', String(config.windowX));
    if (Number.isFinite(config.windowY)) args.push('--y', String(config.windowY));
    if (config.windowAlwaysOnTop) args.push('--always-on-top');
    const result = await new Promise((resolvePromise) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolvePromise(value);
      };
      const launcherEnv = { ...process.env, LIVE2D_WINDOW_DATA: config.dataDir };
      // Delete, never set to undefined: child_process stringifies env values.
      delete launcherEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(nodeBinary(), args, {
        cwd: REPO_ROOT,
        windowsHide: true,
        env: launcherEnv
      });
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('\n')) {
          for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
              settle(JSON.parse(trimmed));
              break;
            } catch {
              /* keep buffering until a complete JSON line arrives */
            }
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', (error) => settle({ ok: false, error: error.message }));
      child.on('exit', (code) => {
        if (!settled) settle({ ok: false, error: `launcher exited with code ${String(code)}: ${stderr.trim().slice(0, 800)}` });
      });
      setTimeout(() => settle({ ok: true, started: true, slowStart: true }), 20000);
    });
    if (result?.ok) {
      state.windowOpen = true;
      state.windowPid = Number.isFinite(result.pid) ? result.pid : liveWindowPid();
      syncWindowState();
      // Opening the window means the avatar should be shown again; otherwise a
      // close→open cycle would leave state.visible=false and the page would keep
      // the stage hidden (blank transparent window).
      state.visible = true;
      state.windowIntent = true;
      if (state.mode === 'window') state.overlayVisible = false;
      if (state.mode === 'both') state.overlayVisible = true;
      // A close/open race can make the launcher adopt a window that is already
      // exiting (the Electron single-instance mutex is still held briefly after
      // the pid file/lock are gone). Confirm the window is still alive before
      // reporting success; retry once the dying instance has released its lock.
      let confirmed = null;
      for (let probe = 0; probe < 3 && confirmed === null; probe += 1) {
        if (probe > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
        confirmed = liveWindowPid();
      }
      if (confirmed === null) {
        state.windowOpen = false;
        state.windowPid = null;
        if (attempt < 3) {
          log.warn(`standalone window disappeared right after launch (attempt ${attempt}); retrying`);
          return launchWindowNow(attempt + 1);
        }
        log.warn('standalone window disappeared right after launch; giving up');
        broadcastState();
        return { ok: false, error: 'window exited right after launch' };
      }
      state.windowOpen = true;
      state.windowPid = confirmed;
      log.info(`standalone window ${result.already === true ? 'already open' : 'launched'} (pid ${confirmed})`);
      broadcastState();
    } else {
      log.warn(`standalone window failed: ${String(result?.error ?? 'unknown error')}`);
    }
    return result;
  };

  /**
   * Single-flight wrapper: the auto-launcher retries, the window watchdog and
   * `/live2d on` can all ask for a window at the same time. Without this guard
   * each caller spawned its own launcher, which produced two pet windows (the
   * slow first launcher reports after the second window already exists).
   */
  let launchInFlight = null;
  const launchWindow = () => {
    if (launchInFlight !== null) return launchInFlight;
    launchInFlight = launchWindowNow().finally(() => {
      launchInFlight = null;
    });
    return launchInFlight;
  };

  /** Close the standalone window (launcher `--close`, pid fallback). */
  const closeWindow = async () => {
    syncWindowState();
    const targetPid = state.windowPid;
    const script = windowScript('launch.mjs');
    if (existsSync(script)) {
      await new Promise((resolvePromise) => {
        const launcherEnv = { ...process.env, LIVE2D_WINDOW_DATA: config.dataDir };
        delete launcherEnv.ELECTRON_RUN_AS_NODE;
        const child = spawn(nodeBinary(), [script, '--close'], {
          cwd: REPO_ROOT,
          windowsHide: true,
          env: launcherEnv
        });
        let stderr = '';
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', () => resolvePromise(undefined));
        child.on('exit', () => resolvePromise(undefined));
        setTimeout(() => resolvePromise(undefined), 8000);
      });
    }
    if (targetPid !== null && pidAlive(targetPid)) {
      try {
        process.kill(targetPid);
      } catch {
        /* already gone */
      }
    }
    // Do not clear the state until the process and its lock are really gone:
    // losing the pid file while the old window is still alive is exactly the
    // race that used to produce two windows.
    const deadline = Date.now() + 6000;
    while (pidAlive(liveWindowPid()) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
    const remaining = liveWindowPid();
    if (pidAlive(remaining)) {
      state.windowOpen = true;
      state.windowPid = remaining;
      log.warn(`standalone window did not exit (pid ${remaining}); keeping state`);
      broadcastState();
      return { ok: false, error: `window did not exit (pid ${remaining})` };
    }
    // The Electron single-instance mutex can outlive the pid file by a few
    // hundred ms after a force kill; give it a moment before the next launch.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    state.windowOpen = false;
    state.windowPid = null;
    // Keep `state.visible` (the user's display intent): closing the window is not
    // `/live2d off`, so reopening it shows the avatar again instead of a blank stage.
    broadcastState();
    return { ok: true };
  };

  /** Apply one `POST /ingest` batch from the TTS shim. */
  const ingest = (payload) => {
    const events = Array.isArray(payload) ? payload : [payload];
    let requestedSegments = [];
    for (const event of events) {
      if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue;
      if (event.type === 'speak_request') {
        requestedSegments = Array.isArray(event.segments) ? event.segments : [];
        state.speaking = false;
        state.emotion = requestedSegments.length > 0 ? String(requestedSegments[0].emotion ?? '') : '';
        state.content = requestedSegments.map((segment) => String(segment.content ?? '')).join(' ');
        if (Number.isFinite(event.latencyMs)) state.latencyMs = Math.trunc(event.latencyMs);
        hub.broadcast({ type: 'speak_request', id: event.id, segments: requestedSegments, latencyMs: state.latencyMs });
        hub.broadcast({ type: 'speak_start', id: event.id, latencyMs: state.latencyMs });
      } else if (event.type === 'playback_start') {
        // First real PCM callback from the playback device: audio is audible from
        // now (plus the reported output latency). Renderers use this as their
        // sync anchor instead of the much earlier segment announcement.
        state.speaking = true;
        if (Number.isFinite(event.latencyMs)) state.latencyMs = Math.trunc(event.latencyMs);
        hub.broadcast({ type: 'playback_start', id: event.id, ts: numberOr(event.ts, Date.now()), latencyMs: state.latencyMs });
      } else if (event.type === 'segment_start') {
        state.speaking = true;
        state.emotion = String(event.usedEmotion ?? '');
        if (Number.isFinite(event.latencyMs)) state.latencyMs = Math.trunc(event.latencyMs);
        const index = Number.isFinite(event.index) ? event.index : 0;
        // The shim forwards the TTS daemon's per-segment text; fall back to the
        // requested segment list / whole utterance for older shims.
        const segmentText = typeof event.text === 'string' && event.text !== ''
          ? event.text
          : requestedSegments[index] !== undefined
            ? String(requestedSegments[index].content ?? '')
            : state.content;
        hub.broadcast({
          type: 'segment_start',
          id: event.id,
          index,
          emotion: state.emotion,
          requestedEmotion: event.requestedEmotion ?? '',
          content: segmentText,
          text: segmentText,
          fallback: event.fallback === true,
          latencyMs: state.latencyMs,
        });
        hub.broadcast({ type: 'emotion', name: state.emotion, intensity: 1 });
      } else if (event.type === 'sentence_end') {
        // `audioSec` is the synthesized duration of that sentence: the renderer
        // uses these to schedule segment-level expression changes on the audio
        // clock (segment_start is a *synthesis* event and leads the sound).
        hub.broadcast({
          type: 'sentence_end',
          id: event.id,
          index: event.index,
          sentenceIndex: event.sentenceIndex,
          emotion: String(event.usedEmotion ?? ''),
          language: event.language ?? '',
          text: typeof event.text === 'string' ? event.text : '',
          chars: numberOr(event.chars, 0),
          audioSec: numberOr(event.audioSec, 0),
        });
      } else if (event.type === 'segment_end') {
        hub.broadcast({
          type: 'segment_end',
          id: event.id,
          index: event.index,
          emotion: String(event.usedEmotion ?? ''),
          seconds: numberOr(event.seconds, 0),
        });
      } else if (event.type === 'speak_done') {
        state.speaking = false;
        hub.broadcast({ type: 'speak_done', id: event.id, ok: event.ok !== false, totalSeconds: numberOr(event.totalSeconds, 0), cancelled: event.cancelled === true, latencyMs: state.latencyMs });
        hub.broadcast({ type: 'speech_end' });
      } else if (event.type === 'speech_end') {
        // Some shims/daemons report only the end-of-speech marker; never leave the
        // host in a sticky "speaking" state when that happens.
        state.speaking = false;
        hub.broadcast({ type: 'speech_end' });
      } else if (event.type === 'envelope') {
        if (Number.isFinite(event.latencyMs)) state.latencyMs = Math.trunc(event.latencyMs);
        const frames = Array.isArray(event.frames) ? event.frames : [];
        state.lastEnvelopeAt = Date.now();
        state.lastEnvelopeLevel = frames.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0);
        hub.broadcast({ type: 'envelope', id: event.id, frames, hopMs: numberOr(event.hopMs, 20), ts: numberOr(event.ts, Date.now()), latencyMs: state.latencyMs });
      } else if (event.type === 'log') {
        hub.broadcast({ type: 'log', text: String(event.text ?? '') });
      }
    }
    return events.length;
  };

  /** Handle one browser command (`POST /command`). */
  const command = (payload) => {
    const type = typeof payload?.type === 'string' ? payload.type : '';
    if (type === 'set_size') {
      state.scale = numberOr(payload.scale, state.scale, 0.1, 8);
      broadcastState();
      return { ok: true, state: statePayload() };
    }
    if (type === 'set_position') {
      if (typeof payload.anchor === 'string' && ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'].includes(payload.anchor)) state.anchor = payload.anchor;
      state.offsetX = numberOr(payload.offsetX, state.offsetX, -10000, 10000);
      state.offsetY = numberOr(payload.offsetY, state.offsetY, -10000, 10000);
      broadcastState();
      return { ok: true, state: statePayload() };
    }
    if (type === 'set_visible') {
      setVisible(payload.visible !== false, 'browser');
      return { ok: true, visible: state.visible };
    }
    if (type === 'set_overlay') {
      setOverlayVisible(payload.visible !== false, 'browser');
      return { ok: true, overlayVisible: state.overlayVisible };
    }
    if (type === 'open_window') {
      void launchWindow();
      return { ok: true, pending: true };
    }
    if (type === 'close_window') {
      void closeWindow();
      return { ok: true, pending: true };
    }
    if (type === 'window_report') {
      return controlWindow({ report: true });
    }
    if (type === 'set_emotion') {
      hub.broadcast({ type: 'emotion', name: String(payload.name ?? ''), intensity: numberOr(payload.intensity, 1, 0, 1) });
      return { ok: true };
    }
    if (type === 'test') {
      hub.broadcast({ type: 'test', emotion: typeof payload.emotion === 'string' ? payload.emotion : '默认', frames: Array.isArray(payload.frames) ? payload.frames : [] });
      return { ok: true };
    }
    return { ok: false, error: `unknown command ${JSON.stringify(type)}` };
  };

  /** Switch the current model (or rescan the directory when `id` is omitted). */
  const selectModel = (id) => {
    models = scanModels(config.modelsDir, config.port);
    if (typeof id === 'string' && id.trim() !== '') {
      const wanted = id.trim();
      const model = models.find((candidate) => candidate.id === wanted || candidate.name === wanted) ?? models.find((candidate) => candidate.id.toLowerCase() === wanted.toLowerCase());
      if (model === undefined) return { ok: false, error: `model not found: ${wanted}`, models: models.map((candidate) => candidate.id) };
      state.modelId = model.id;
    } else if (models.length > 0 && !models.some((candidate) => candidate.id === state.modelId)) {
      state.modelId = models[0].id;
    }
    broadcastState();
    return { ok: true, model: modelPayload(), models: models.map((candidate) => candidate.id) };
  };

  /** The `/live2d` command family (Host command plane: never reaches the model). */
  const commandText = async (rawInput) => {
    const tokens = typeof rawInput === 'string' ? rawInput.trim().split(/\s+/u).filter(Boolean) : [];
    const verb = tokens[0] ?? 'status';
    models = scanModels(config.modelsDir, config.port);
    syncWindowState();
    if (verb === 'status') {
      const model = currentModel();
      const presentation = state.mode === 'window'
        ? `独立窗口 ${state.windowOpen ? `已打开${state.windowPid === null ? '' : `（pid ${state.windowPid}）`}` : '已关闭'}`
        : state.mode === 'overlay'
          ? `页面覆盖层 ${state.overlayVisible ? '显示' : '隐藏'}`
          : `窗口 ${state.windowOpen ? '开' : '关'} / 覆盖层 ${state.overlayVisible ? '开' : '关'}`;
      const bounds = readWindowBounds();
      return [
        `Live2D 插件 v${VERSION} · ${state.visible ? '显示中' : '已隐藏'} · ${presentation} · 端口 ${config.port}`,
        `模型：${model?.id ?? '无'}（${model?.format ?? '-'}）· 缩放 ${state.scale} · 帧率上限 ${config.fps}（idle ${config.idleFps}）`,
        ...(bounds === null ? [] : [`窗口几何：${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})（拖动/` + '`/live2d window size <w> [h]` 可调）']),
        `模型目录：${config.modelsDir}（${models.length} 个可用：${models.length === 0 ? '无' : models.map((candidate) => candidate.id).join(', ')}）`,
        `TTS 桥接：${state.speaking ? '说话中' : '空闲'}${state.emotion === '' ? '' : ` · 情绪 ${state.emotion}`}${state.latencyMs > 0 ? ` · 输出延迟 ${state.latencyMs}ms` : ''}`
      ].join('\n');
    }
    if (verb === 'window') {
      const action = tokens[1] ?? 'open';
      if (action === 'close' || action === 'off') {
        // Explicit close: do NOT auto-reopen on a later plugin reload/watchdog.
        state.windowIntent = false;
        const closed = await closeWindow();
        return closed?.ok === true ? '独立窗口已关闭' : `独立窗口关闭失败：${String(closed?.error ?? 'unknown')}`;
      }
      if (action === 'size' || action === 'resize') {
        const size = parseWindowSize(tokens);
        if (size === null) return '用法：/live2d window size <宽> <高>（或 /live2d window size 420x620）';
        const applied = controlWindow({ resize: size });
        return applied.ok ? `已请求窗口大小 ${size.width}×${size.height}` : `调整失败：${applied.error}`;
      }
      if (action === 'move') {
        const x = Number(tokens[2]);
        const y = Number(tokens[3]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return '用法：/live2d window move <x> <y>';
        const applied = controlWindow({ move: { x: Math.round(x), y: Math.round(y) } });
        return applied.ok ? `已请求窗口移动到 (${Math.round(x)}, ${Math.round(y)})` : `移动失败：${applied.error}`;
      }
      if (action === 'dedupe' || action === 'cleanup') {
        const result = await executeLauncher(['--dedupe']);
        if (result?.ok !== true) return `清理重复窗口失败：${String(result?.error ?? 'unknown')}`;
        const kept = result.kept == null ? '无' : String(result.kept);
        const killed = Array.isArray(result.killed) && result.killed.length > 0 ? result.killed.join(', ') : '无';
        const closed = Array.isArray(result.closed) && result.closed.length > 0 ? result.closed.join(', ') : '无';
        const seen = Array.isArray(result.titledWindows) ? result.titledWindows.length : null;
        syncWindowState();
        return `重复窗口清理完成：检测到 ${seen === null ? '未知' : seen} 个 DSH Live2D 窗口，保留 pid ${kept}，结束多余进程 ${killed}，关闭重复窗口 ${closed}`;
      }
      if (action === 'status') {
        const bounds = readWindowBounds();
        let lockPid = null;
        try {
          const parsed = Number.parseInt(readFileSync(join(config.dataDir, 'live2d-window.lock'), 'utf8').trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) lockPid = parsed;
        } catch {
          /* no lock */
        }
        return `独立窗口：${state.windowOpen ? '打开' : '关闭'}${state.windowPid === null ? '' : ` pid=${state.windowPid}`}${lockPid === null ? '' : ` lock=${lockPid}`}${bounds === null ? '' : ` · ${bounds.width}×${bounds.height} @ (${bounds.x}, ${bounds.y})`}`;
      }
      if (action === 'show' || action === 'restore') {
        if (!state.windowOpen) {
          const launched = await launchWindow();
          return launched?.ok === true ? '独立窗口已打开' : `独立窗口启动失败：${String(launched?.error ?? 'unknown')}`;
        }
        controlWindow({ show: true });
        setVisible(true, 'window-show');
        return '已恢复显示独立窗口';
      }
      if (action === 'hide') {
        controlWindow({ hide: true });
        return '已隐藏独立窗口（用 /live2d window show 恢复）';
      }
      if (action === 'top' || action === 'alwaysontop' || action === 'topmost') {
        const value = tokens[2];
        if (value !== 'on' && value !== 'off') return '用法：/live2d window top on|off（默认 off，像普通窗口一样可被其它窗口盖住）';
        const enabled = value === 'on';
        const applied = controlWindow({ top: enabled });
        return applied.ok ? `独立窗口置顶已${enabled ? '开启' : '关闭'}` : `设置失败：${applied.error}`;
      }
      if (action === 'minimize' || action === 'min') {
        const applied = controlWindow({ minimize: true });
        return applied.ok ? '已最小化独立窗口（任务栏点击可恢复）' : `最小化失败：${applied.error}`;
      }
      const result = await launchWindow();
      if (result?.ok !== true) {
        return `独立窗口启动失败：${String(result?.error ?? 'unknown')}\n可用回退：浏览器打开 http://127.0.0.1:${config.port}/window`;
      }
      return `独立窗口已${result.already === true ? '存在' : '打开'}${state.windowPid === null ? '' : `（pid ${state.windowPid}）`}\n拖动任意位置移动窗口 · 右下角拖动调整大小 · 右上角悬停出现关闭按钮`;
    }
    if (verb === 'overlay') {
      if (tokens[1] === 'on' || tokens[1] === 'show') {
        setOverlayVisible(true, 'command');
        return '页面覆盖层已显示';
      }
      if (tokens[1] === 'off' || tokens[1] === 'hide') {
        setOverlayVisible(false, 'command');
        return '页面覆盖层已隐藏';
      }
      return `页面覆盖层当前：${state.overlayVisible ? '显示' : '隐藏'}。用法：/live2d overlay on|off`;
    }
    if (verb === 'on' || verb === 'show') {
      setVisible(true, 'command');
      if (state.mode === 'window' || state.mode === 'both') {
        const result = await launchWindow();
        if (result?.ok === true) return `Live2D 已显示（独立窗口${state.windowPid === null ? '' : ` pid ${state.windowPid}`}，模型 ${currentModel()?.id ?? '无'}）`;
      }
      if (state.mode === 'overlay' || state.mode === 'both') setOverlayVisible(true, 'command');
      return `Live2D 已显示（模型 ${currentModel()?.id ?? '无'}）`;
    }
    if (verb === 'off' || verb === 'hide') {
      setVisible(false, 'command');
      if (state.windowOpen) await closeWindow();
      if (state.overlayVisible) setOverlayVisible(false, 'command');
      return 'Live2D 已隐藏';
    }
    if (verb === 'list' || verb === 'models') {
      models = scanModels(config.modelsDir, config.port);
      if (models.length === 0) return `模型目录为空：${config.modelsDir}\n请在目录下按 <模型名>/<模型名>.model3.json 放置模型。`;
      return [`模型目录：${config.modelsDir}`, ...models.map((model, index) => `${model.id === state.modelId ? '▶' : ' '} ${index + 1}. ${model.id} · ${model.format} · ${model.modelFile}`)].join('\n');
    }
    if (verb === 'model') {
      const target = tokens[1] ?? '';
      const result = selectModel(target);
      if (!result.ok) return `切换失败：${result.error}\n可用：${result.models.join(', ')}`;
      return `已切换模型：${result.model?.id ?? '无'}（${result.model?.format ?? '-'}）`;
    }
    if (verb === 'size' || verb === 'scale') {
      if (tokens[1] === undefined) return `当前缩放：${state.scale}\n用法：/live2d size <0.1-8>`;
      const value = Number(tokens[1]);
      if (!Number.isFinite(value) || value < 0.1 || value > 8) return `无效缩放：${tokens[1]}（0.1-8）`;
      state.scale = value;
      broadcastState();
      return `缩放已设为 ${state.scale}`;
    }
    if (verb === 'position') {
      const anchor = tokens[1];
      const anchors = ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'];
      if (anchor === undefined) return `当前位置：${state.anchor}（offset ${state.offsetX}, ${state.offsetY}）\n用法：/live2d position <${anchors.join('|')}> [offsetX offsetY]`;
      if (!anchors.includes(anchor)) return `无效位置：${anchor}；可用：${anchors.join(', ')}`;
      state.anchor = anchor;
      if (tokens[2] !== undefined && Number.isFinite(Number(tokens[2]))) state.offsetX = Number(tokens[2]);
      if (tokens[3] !== undefined && Number.isFinite(Number(tokens[3]))) state.offsetY = Number(tokens[3]);
      broadcastState();
      return `位置已设为 ${state.anchor}（offset ${state.offsetX}, ${state.offsetY}）`;
    }
    if (verb === 'reload') {
      models = scanModels(config.modelsDir, config.port);
      if (models.length > 0 && !models.some((model) => model.id === state.modelId)) state.modelId = models[0].id;
      broadcastState();
      return `已重载：${models.length} 个模型，当前 ${currentModel()?.id ?? '无'}`;
    }
    if (verb === 'test') {
      const emotion = tokens[1] ?? '默认';
      hub.broadcast({ type: 'test', emotion });
      return `已发送测试情绪：${emotion}（查看模型）`;
    }
    return '未知子命令。用法：/live2d status|on|off|window [open|close|dedupe|status]|overlay on|off|list|model <id|空>|size <n>|position <anchor> [dx dy]|reload|test [emotion]';
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, x-live2d-token',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        syncWindowState();
        sendJson(res, 200, {
          ok: true,
          plugin: 'live2d',
          version: VERSION,
          port: config.port,
          visible: state.visible,
          mode: state.mode,
          overlayVisible: state.overlayVisible,
          windowOpen: state.windowOpen,
          windowPid: state.windowPid,
          windowLockPid: (() => {
            try {
              const value = Number.parseInt(readFileSync(join(config.dataDir, 'live2d-window.lock'), 'utf8').trim(), 10);
              return Number.isFinite(value) && value > 0 ? value : null;
            } catch {
              return null;
            }
          })(),
          windowDedupe: config.windowDedupe,
          latencyMs: state.latencyMs,
          lastEnvelopeAt: state.lastEnvelopeAt ?? null,
          lastEnvelopeLevel: state.lastEnvelopeLevel ?? 0,
          models: models.map((model) => model.id),
          model: currentModel()?.id ?? null,
          speaking: state.speaking,
          clients: hub.clients.size,
          windowClients: hub.countRole('window'),
          overlayClients: hub.countRole('overlay'),
          sse: hub.stats(),
          lastStateTickAt: state.lastStateTickAt || null
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        // The role lets the host notice a pet window whose SSE stream silently died
        // while its process stays alive (see the window watchdog in `listen`).
        hub.add(res, url.searchParams.get('client') || 'unknown');
        res.write(`data: ${JSON.stringify(statePayload())}\n\n`);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        if (req.headers['x-live2d-token'] !== token) {
          sendJson(res, 403, { ok: false, error: 'bad ingest token' });
          return;
        }
        const body = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          const lines = body.split('\n').filter((line) => line.trim() !== '');
          if (lines.length === 0) {
            sendJson(res, 400, { ok: false, error: 'empty body' });
            return;
          }
          try {
            payload = lines.map((line) => JSON.parse(line));
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid json' });
            return;
          }
        }
        const count = ingest(payload);
        sendJson(res, 202, { ok: true, accepted: count });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/model') {
        sendJson(res, 200, { ok: true, state: statePayload(), models: models.map((model) => ({ id: model.id, format: model.format, modelFile: model.modelFile })) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        sendJson(res, 200, { ok: true, modelsDir: config.modelsDir, models: models.map((model) => ({ id: model.id, format: model.format, modelFile: model.modelFile, baseUrl: model.baseUrl })) });
        return;
      }
      // Standalone pet-window page (loaded by the Electron launcher) and its bundle.
      if (req.method === 'GET' && (url.pathname === '/window' || url.pathname === '/window/' || url.pathname === '/window/index.html')) {
        const pagePath = join(PACKAGE_ROOT, 'window', 'index.html');
        if (!existsSync(pagePath)) {
          sendJson(res, 503, { ok: false, error: 'window page not built: packages/plugin/window/index.html is missing' });
          return;
        }
        const body = readFileSync(pagePath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/window.js' || url.pathname === '/window/window.js' || url.pathname === '/lib/window.js')) {
        const bundlePath = join(PACKAGE_ROOT, 'lib', 'window.js');
        if (!existsSync(bundlePath)) {
          sendJson(res, 503, { ok: false, error: 'window bundle not built: run node build-client.mjs --window' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': String(statSync(bundlePath).size),
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        createReadStream(bundlePath).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/window/status') {
        syncWindowState();
        let lockPid = null;
        try {
          const parsed = Number.parseInt(readFileSync(join(config.dataDir, 'live2d-window.lock'), 'utf8').trim(), 10);
          if (Number.isFinite(parsed) && parsed > 0) lockPid = parsed;
        } catch {
          /* no lock */
        }
        sendJson(res, 200, { ok: true, windowOpen: state.windowOpen, pid: state.windowPid, lockPid, bounds: readWindowBounds(), mode: state.mode, url: windowUrl(), dedupe: config.windowDedupe });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/command') {
        const parsed = JSON.parse(await readBody(req, 64 * 1024));
        // `{type:"run", rawInput:"status"}` executes the same handler the /live2d
        // command plane uses; handy for acceptance scripts and diagnostics.
        if (parsed !== null && typeof parsed === 'object' && parsed.type === 'run') {
          try {
            sendJson(res, 200, { ok: true, text: await commandText(typeof parsed.rawInput === 'string' ? parsed.rawInput : '') });
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        sendJson(res, 200, command(parsed));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const rest = url.pathname.slice('/assets/'.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) {
          sendJson(res, 400, { ok: false, error: 'expected /assets/<model>/<path>' });
          return;
        }
        const modelId = decodeURIComponent(rest.slice(0, slash));
        const relativePath = rest.slice(slash + 1);
        const model = models.find((candidate) => candidate.id === modelId);
        if (model === undefined) {
          sendJson(res, 404, { ok: false, error: `unknown model ${modelId}` });
          return;
        }
        const filePath = resolveAssetPath(model.dir, relativePath);
        if (filePath === undefined) {
          sendJson(res, 400, { ok: false, error: 'invalid asset path' });
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          sendJson(res, 404, { ok: false, error: `asset not found: ${relativePath}` });
          return;
        }
        const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': String(statSync(filePath).size),
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        createReadStream(filePath).pipe(res);
        return;
      }
      sendJson(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
    } catch (error) {
      log.warn(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Intervals owned by the server lifetime (cleared by `dispose`). */
  const timers = [];
  const hostStartedAt = Date.now();
  const listen = () => new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', onError);
      // Periodic state heartbeat: every client gets a liveness clock, so the
      // standalone window can tell "host reachable but my SSE stream is dead"
      // apart from "host is not running". Without this the window can sit on a
      // silently dead stream until the user restarts it (`/live2d off/on`).
      timers.push(setInterval(() => {
        state.lastStateTickAt = Date.now();
        broadcastState();
      }, 10000));
      // Lightweight liveness tick: a renderer whose rAF was paused while the
      // window was occluded gets a message as soon as it can run again and can
      // re-arm its render loop without waiting for the 10s state heartbeat.
      timers.push(setInterval(() => {
        hub.broadcast({ type: 'tick', at: Date.now() });
      }, 2000));
      // Speech watchdog: `speaking` is set by synthesis-time events; if the TTS
      // daemon dies / the session is aborted the final `speak_done` may never
      // arrive and the flag would stay true forever. The window's self-heal used
      // to trust that flag and reconnected/reloaded in a loop ("flickering"), so
      // clear it as soon as no real audio arrived for a while.
      timers.push(setInterval(() => {
        if (!state.speaking) return;
        const last = state.lastEnvelopeAt ?? 0;
        if (last > 0 && Date.now() - last < 12000) return;
        state.speaking = false;
        log.warn('speech watchdog: cleared a stale speaking flag (no real audio for over 12s)');
        broadcastState();
      }, 5000));
      // Periodic duplicate sweep: old builds (or windows whose pid/lock/log
      // records were lost) can leave a blank `DSH Live2D` window alive without
      // ever connecting as a second SSE client. The launcher's command-line
      // scan sees those processes and removes all but the recorded one.
      timers.push(setInterval(() => {
        if (!config.windowDedupe || !state.windowOpen || dedupeInFlight) return;
        dedupeInFlight = true;
        void executeLauncher(['--dedupe']).finally(() => {
          dedupeInFlight = false;
          syncWindowState();
        });
      }, 60000));
      // Window liveness watchdog: the pet window process is alive but its SSE
      // stream is gone (silent half-open connection, missed reload, ...). Ask
      // the window's main process to reload the page — that reconnects SSE and
      // restores TTS reactions without the user touching /live2d.
      let missingTicks = 0;
      let dedupeInFlight = false;
      timers.push(setInterval(() => {
        syncWindowState();
        const windowClients = hub.countRole('window');
        if (windowClients > 1 && config.windowDedupe && !dedupeInFlight) {
          // Two live window pages connect as client=window. That is a duplicate
          // even if one of them renders a blank page; the launcher's command-line
          // scan can see old windows whose pid/lock/log records were lost.
          dedupeInFlight = true;
          log.warn(`${windowClients} standalone window SSE clients connected; running duplicate cleanup`);
          void executeLauncher(['--dedupe']).finally(() => {
            dedupeInFlight = false;
            syncWindowState();
          });
        }
        if (!state.windowOpen) {
          missingTicks = 0;
          // The window vanished right after this host instance started: a plugin
          // reload race with the previous instance's cleanup. Relaunch it only
          // during a short post-start grace period, so an intentional tray close
          // later on is respected.
          if (
            state.windowIntent &&
            state.visible &&
            (config.mode === 'window' || config.mode === 'both') &&
            state.windowPid === null &&
            Date.now() - hostStartedAt < 60000
          ) {
            log.warn('standalone window is missing shortly after startup; relaunching');
            void launchWindow();
          }
          return;
        }
        if (windowClients > 0) {
          missingTicks = 0;
          return;
        }
        missingTicks += 1;
        if (missingTicks < 3) return;
        missingTicks = 0;
        // Do not reload the page: a reload is destructive and used to produce a
        // visible flicker loop. The page reconnects its EventSource on its own,
        // and a page that is truly dead can be recovered with
        // `/live2d window close` + `/live2d on`.
        log.warn('standalone window is running but has no SSE client; waiting for its reconnect');
      }, 10000));
      resolvePromise({ port: config.port, url: `http://127.0.0.1:${config.port}` });
    });
  });

  const dispose = () => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    hub.closeAll();
    return new Promise((resolvePromise) => {
      try {
        server.close(() => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
  };

  return {
    config,
    token,
    state,
    hub,
    commandText,
    command,
    ingest,
    selectModel,
    setVisible,
    setOverlayVisible,
    launchWindow,
    closeWindow,
    controlWindow,
    modelPayload,
    statePayload,
    getModel: currentModel,
    listModels: () => models,
    rescanModels: () => {
      models = scanModels(config.modelsDir, config.port);
      return models;
    },
    listen,
    dispose
  };
}

/**
 * Plugin entry: build the host, start its local server, expose `/live2d` on the
 * command plane, and stop everything when the plugin is disabled or reloaded.
 *
 * IMPORTANT: `apply` stays synchronous. Cordis effects must be created while the
 * plugin is activating; an effect created after an `await` in an async apply is
 * rejected ("Invalid effect"). The server start is therefore a background promise
 * whose failure is logged instead of thrown.
 * @param ctx - Host registrant context (command plane provider expected).
 * @param config - Row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const log = makeLog(ctx);
  const host = createLive2DHost(ctx, config);

  // The TTS daemon shim only forwards events while this marker file exists, so a
  // disabled/absent Live2D row costs the TTS daemon one `stat` per second at most.
  const bridgeMarker = join(host.config.dataDir, 'tts-bridge.enabled');
  try {
    mkdirSync(host.config.dataDir, { recursive: true });
    writeFileSync(bridgeMarker, `${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    log.warn(`cannot write the TTS bridge marker (${error instanceof Error ? error.message : String(error)})`);
  }

  ctx.effect(() => () => {
    log.info('stopping');
    try {
      rmSync(bridgeMarker, { force: true });
    } catch {
      /* best effort */
    }
    // The standalone window is an independent Electron process. Its close is
    // asynchronous (launcher spawn + process exit). This teardown MUST be
    // awaited: the previous `void host.closeWindow()` let the next host start
    // and spawn a new window while the old one was still alive. That race is
    // what accumulated many (eventually blank) DSH Live2D windows across
    // plugin reloads/recompositions. Cordis awaits async effect disposers.
    return (async () => {
      try {
        await host.closeWindow();
      } catch (error) {
        log.warn(`window close during teardown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await host.dispose();
    })();
  }, 'live2d http server');

  const started = host.listen().then((url) => {
    log.info(`listening on ${url.url} (models: ${host.listModels().length}, dir: ${host.config.modelsDir})`);
    // Standalone presentation: open the pet window as soon as the server is up.
    // `launchWindow` can race the previous host instance's asynchronous
    // `closeWindow` (plugin reload): the launcher then reports "already open"
    // for a window that is about to die, or fails while the old pid is exiting.
    // Retry a few times and only fall back to the in-page overlay after that.
    const ensureWindow = async (attempt) => {
      const result = await host.launchWindow();
      if (result?.ok === true) {
        if (result.already === true) {
          // A window from the previous host instance is still alive: its SSE
          // stream belonged to the old server and can be silently dead. Reload
          // the page so it reconnects immediately instead of waiting for the
          // window watchdog / a manual /live2d off+on.
          log.info('standalone window survived the previous host instance; reloading its page');
          host.controlWindow({ reload: true, show: true });
        }
        return;
      }
      if (attempt < 3) {
        log.warn(`standalone window not ready yet (attempt ${attempt}): ${String(result?.error ?? '')}; retrying`);
        setTimeout(() => {
          void ensureWindow(attempt + 1);
        }, 2500);
        return;
      }
      log.warn(`standalone window unavailable, keeping the in-page overlay: ${String(result?.error ?? '')}`);
      host.setOverlayVisible(true, 'window-fallback');
    };
    if (host.config.visible && (host.config.mode === 'window' || host.config.mode === 'both')) {
      void ensureWindow(1);
      // A reload can also have its freshly launched window killed by the old
      // instance's late cleanup; check once more shortly after start.
      setTimeout(() => {
        if (host.state.windowIntent && !host.state.windowOpen) {
          log.warn('standalone window is missing after reload; launching it again');
          void host.launchWindow();
        }
      }, 9000);
    }
    return url;
  }).catch((error) => {
    log.error(`cannot start the local server on 127.0.0.1:${host.config.port}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });

  const commands = ctx?.get?.('commands') ?? ctx?.commands ?? null;
  if (commands !== null) {
    try {
      commands.register({
        name: 'live2d',
        description: '控制 Live2D 形象：显示/隐藏、独立窗口、覆盖层、切换模型、缩放、位置、刷新、测试情绪（/live2d status|on|off|window [open|close|dedupe]|overlay on|off|list|model <id>|size <n>|position <anchor>|reload|test [emotion]）',
        input: { hint: 'status | on | off | window [open|close|dedupe] | overlay on|off | list | model <id> | size <n> | position <anchor> [dx dy] | reload | test [emotion]' },
        handler: async (invocation) => {
          const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
          try {
            const text = await host.commandText(rawInput);
            // The command plane requires a CommandResult: `{ kind, text }`.
            // Returning undefined made every `/live2d` call fail with
            // 'gateway/internal: command "live2d" handler must return a CommandResult'.
            return { kind: 'success', text: typeof text === 'string' ? text : String(text ?? '') };
          } catch (error) {
            return { kind: 'error', text: `live2d 命令失败：${error instanceof Error ? error.message : String(error)}` };
          }
        }
      });
    } catch (error) {
      log.warn(`commands.register failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log.warn('commands service unavailable: /live2d is not registered');
  }

  return { started, host };
}

// reload-trigger: normal-window defaults + window top/minimize commands
