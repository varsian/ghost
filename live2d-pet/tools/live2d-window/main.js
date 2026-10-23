'use strict'

/**
 * Live2D independent window — Electron main process (minimal, GPU-software safe).
 *
 * A transparent, frameless window that loads the plugin host's standalone window
 * page (default http://127.0.0.1:34567/window). It behaves like a normal desktop
 * window: shown in the taskbar, minimisable/restorable from it, normal z-order
 * (NOT always-on-top by default) and resizable/draggable. The page owns the Live2D
 * stage, the transparent background, the drag region and the close button
 * (window.close()); this process owns the OS window only.
 *
 * This file deliberately avoids Electron features that are fragile in this
 * deployment (GPU process, single-instance IPC lock, capturePage under software
 * rendering). Logging + a pid file are enough for launch.mjs to manage it.
 *
 * Args (also accepted as LIVE2D_WINDOW_* env vars):
 *   --url <url> --width <px> --height <px> --x <px> --y <px> --retries <n>
 *   --always-on-top (opt-in topmost; env LIVE2D_WINDOW_TOPMOST=1)
 */

const fs = require('node:fs')
const path = require('node:path')

if (!process.versions.electron) {
  try { process.stderr.write('live2d-window: start with launch.mjs (Electron), not node\n') } catch { /* ignore */ }
  process.exit(1)
}

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.LIVE2D_WINDOW_DATA ? path.resolve(process.env.LIVE2D_WINDOW_DATA) : path.join(REPO_ROOT, 'data')
const LOG_PATH = path.join(DATA_DIR, 'live2d-window.log')
const PID_PATH = path.join(DATA_DIR, 'live2d-window.pid')
const BOUNDS_PATH = path.join(DATA_DIR, 'window-bounds.json')
const CONTROL_PATH = path.join(DATA_DIR, 'window-control.json')
const PRELOAD_PATH = path.join(__dirname, 'preload.js')
// 32x32 tray icon (blue pet head) generated once; nativeImage accepts PNG data URLs.
const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAKASURBVFhH7ZY9aBRBFMdTWlraaSnJLFGwSCMklcFCLAzu7KLxA+RAQraSCAexEA525ryDyIkfnKjgcRDYIGICFiFEEwghYJorU2lKwebKkTfuLTfv7d7NhtvOP/yKuzfz3puZN29nbOy/TqhxL7ww4YvpHvAbjxmpzs4vn3I8ecfxZMvhsut4UqUjIuaJ0uR87TT2cWKBQ8eTxzRYNoyL344bBpA49mctWAXjYhc7z4foTN6sncO+hwomMU8eUYf5gd2AOsExMqVXPqLgPSAJxuV5HIsIzixr2y8vNNXsUlvNBO+JzcYOixpanFA4eCLgP9tUjUOVUGru57L3JVHDMRPFV41UO6ys33mPq+VVK7sBl93xufAMjq0VXzcyyQ2/EufA3caOlZ0iKji2FvPkOh0s9bli58CNyrqVnSI6OLau/EEd7vHakeF8eeOXuni7bm3HkBvh+NUpPAgDWw3bCgWX5nyYvR/G5XUjAfgDDyoUNwzMBDIKsDC4eGIkMMGFSwYVCONyyUzAF9N4UJHAgo0EoDngQYXiV6eMBEBZ34ACOMaxtaAwUgaPHMarb3FsLX0MA5rRqBj4foSvFZ4AzNxfUe36F3XpVo3YMG/CT8pfeE3+/4eIcExDcTGSL+Jec0upz4fq26tNda30IsWx1MlBcBj3JzqgyXLZJS04Tboto6OYe/hSOwXnwI9326pRiRJgd3629xL74iP6KCFXb5B0Y0JJXHnwXK2tbBiJYDofvqdvP+58NoLmpJ/XyBlsbbn8MVk5HEv96aq6FzRTAsturpVjxTXRIo6tEJHVmdsIrg7c37QC7SfesVauZ3he6SKFxys0rh5uGBQatCj9BY2Il54j82IQAAAAAElFTkSuQmCC'

try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }

/** Rotate the append-only log so the dedupe scan stays fast after weeks of use. */
function rotateLog() {
  try {
    const maxBytes = 2 * 1024 * 1024
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > maxBytes) {
      fs.rmSync(LOG_PATH + '.1', { force: true })
      fs.renameSync(LOG_PATH, LOG_PATH + '.1')
    }
  } catch { /* logging must never break the window */ }
}
rotateLog()

function log(level, message, extra) {
  const record = { ts: new Date().toISOString(), pid: process.pid, level, message, ...(extra ?? {}) }
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(record) + '\n') } catch { /* never throw from logging */ }
}

process.on('uncaughtException', (error) => { log('error', 'uncaught-exception', { error: String(error && error.stack ? error.stack : error) }); try { app.exit(1) } catch { /* ignore */ } })
process.on('unhandledRejection', (reason) => { log('error', 'unhandled-rejection', { reason: String(reason) }); try { app.exit(1) } catch { /* ignore */ } })

// Electron's own single-instance lock is the primary duplicate guard: it is a
// live kernel-level mutex, so losing the pid/lock files cannot defeat it. The
// file lock below is still kept because launch.mjs uses it to adopt a window
// whose pid file was lost.
try {
  const userData = path.join(DATA_DIR, 'electron-userdata')
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
} catch { /* fall back to the --user-data-dir switch */ }
let hasElectronLock = true
try {
  hasElectronLock = app.requestSingleInstanceLock()
} catch { /* older Electron or a locked profile: keep the file-lock fallback */ }
if (!hasElectronLock) {
  log('warn', 'duplicate-instance', { reason: 'electron-single-instance-lock' })
  process.exit(0)
}
app.on('second-instance', () => {
  log('info', 'second-instance', { pid: process.pid })
  showWindow()
})

function parseArgs(argv) {
  const takesValue = new Set(['url', 'width', 'height', 'x', 'y', 'retries', 'retry-delay'])
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (typeof token !== 'string' || !token.startsWith('--')) continue
    const equals = token.indexOf('=')
    const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
    if (!takesValue.has(key)) { out[key] = true; continue }
    out[key] = equals === -1 ? argv[++index] : token.slice(equals + 1)
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))
const env = process.env
// The launcher passes these through the environment (never through the command
// line) so URLs containing & or unicode survive every shell/host layer.
const url = String(argv.url || env.LIVE2D_WINDOW_URL || 'http://127.0.0.1:34567/window')
const width = Math.max(80, Math.round(Number(argv.width || env.LIVE2D_WINDOW_WIDTH || 360)))
const height = Math.max(80, Math.round(Number(argv.height || env.LIVE2D_WINDOW_HEIGHT || 520)))
const maxRetries = Math.max(0, Math.round(Number(argv.retries || 30)))
// Normal desktop-window behaviour by default: no topmost, taskbar entry present
// (so the char window can be minimised and restored like any other program).
// The old topmost/taskbar-less pet behaviour is still available opt-in.
const alwaysOnTopRequested = argv['always-on-top'] === true || env.LIVE2D_WINDOW_TOPMOST === '1'
const showInTaskbar = argv['taskbar'] !== false && env.LIVE2D_WINDOW_SKIP_TASKBAR !== '1'

/**
 * Single-instance guard: two pet windows must never exist for one data dir.
 * Duplicates appeared when a plugin reload / app restart raced an older window
 * that was still shutting down: the second launcher saw no pid file (the first
 * launcher had already cleared it) and started another window. A pid file alone
 * cannot close that race (both launchers can read "no pid" before either writes
 * it), so take an exclusive lock file first, then double-check the pid file.
 * The host adopts the surviving window through the control file.
 */
const LOCK_PATH = path.join(DATA_DIR, 'live2d-window.lock')

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx')
      try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
      return true
    } catch {
      // Lock exists: either a live instance owns it or it is stale.
      try {
        const owner = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim())
        if (processAlive(owner)) return false
      } catch { /* unreadable: treat as stale */ }
      try { fs.rmSync(LOCK_PATH, { force: true }) } catch { /* ignore */ }
      // Busy-wait briefly instead of async: this guard runs before app.whenReady
      // and only on the (rare) stale-lock path.
      const until = Date.now() + 120
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false
}

if (!acquireInstanceLock()) {
  log('warn', 'duplicate-instance', { reason: 'instance-lock-held' })
  process.exit(0)
}

function otherLiveWindowPid() {
  try {
    const raw = fs.readFileSync(PID_PATH, 'utf8').trim()
    const pid = Number(raw)
    if (!processAlive(pid)) return null
    return pid
  } catch {
    return null
  }
}

const existingWindowPid = otherLiveWindowPid()
if (existingWindowPid !== null) {
  log('warn', 'duplicate-instance', { existingPid: existingWindowPid })
  // We acquired the file lock only because the live window had lost it (a
  // previous duplicate used to delete it). Heal it with the live window's pid
  // instead of deleting it: the surviving window then owns the lock again and
  // future launches exit here too.
  try { fs.writeFileSync(LOCK_PATH, String(existingWindowPid) + '\n', 'utf8') } catch { /* best effort */ }
  process.exit(0)
}

log('info', 'main-boot', { electron: process.versions.electron, url, width, height, dataDir: DATA_DIR })
try { fs.writeFileSync(PID_PATH, String(process.pid) + '\n', 'utf8') } catch (error) { log('warn', 'pid-write-failed', { error: String(error) }) }

/** Saved window geometry from the previous run (relative to the current screen). */
function savedBounds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BOUNDS_PATH, 'utf8'))
    const pick = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null)
    return {
      x: pick(parsed.x, -10000, 10000),
      y: pick(parsed.y, -10000, 10000),
      width: pick(parsed.width, 120, 2000),
      height: pick(parsed.height, 120, 2000),
    }
  } catch {
    return null
  }
}

function persistBounds() {
  if (win === undefined || win.isDestroyed()) return
  try {
    const bounds = win.getBounds()
    fs.writeFileSync(BOUNDS_PATH, JSON.stringify({ ...bounds, savedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  } catch { /* best effort */ }
}

/** Clamp a frameless window size to something usable and visible. */
function clampSize(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback
}

/** If the window was dragged/resized (almost) completely off-screen, pull it back. */
function ensureOnScreen() {
  if (win === undefined || win.isDestroyed()) return
  try {
    const bounds = win.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    const inside = centerX >= area.x && centerX <= area.x + area.width && centerY >= area.y && centerY <= area.y + area.height
    if (inside) return
    win.setBounds(clampToWorkArea(bounds))
    log('info', 'bounds-pulled-back', { from: bounds })
  } catch { /* ignore */ }
}

/** Resize the pet window (renderer grip, host command, or launcher). */
function applyResize(requestedWidth, requestedHeight) {
  if (win === undefined || win.isDestroyed()) return null
  const current = win.getBounds()
  const nextWidth = clampSize(requestedWidth, current.width, 160, 1600)
  const nextHeight = clampSize(requestedHeight, current.height, 200, 1600)
  try {
    win.setSize(nextWidth, nextHeight, false)
    log('info', 'resize', { width: nextWidth, height: nextHeight })
    schedulePersistBounds()
    return win.getBounds()
  } catch (error) {
    log('warn', 'resize-failed', { error: String(error) })
    return null
  }
}

/** Move the pet window to absolute screen coordinates. */
function applyMove(x, y) {
  if (win === undefined || win.isDestroyed()) return null
  const targetX = Number.isFinite(Number(x)) ? Math.round(Number(x)) : null
  const targetY = Number.isFinite(Number(y)) ? Math.round(Number(y)) : null
  if (targetX === null || targetY === null) return null
  try {
    win.setPosition(targetX, targetY, false)
    log('info', 'move', { x: targetX, y: targetY })
    schedulePersistBounds()
    return win.getBounds()
  } catch (error) {
    log('warn', 'move-failed', { error: String(error) })
    return null
  }
}

// Host -> window control channel: a tiny JSON file the host plugin writes for
// resize/move/close (the host cannot talk IPC to this process directly).
let controlTimer
let lastControlAt = ''
function pollControl() {
  try {
    if (!fs.existsSync(CONTROL_PATH)) return
    const parsed = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'))
    const stamp = String(parsed.at ?? '')
    if (stamp === '' || stamp === lastControlAt) return
    lastControlAt = stamp
    log('info', 'control-command', { command: parsed })
    if (parsed.resize !== undefined && parsed.resize !== null) applyResize(parsed.resize.width, parsed.resize.height)
    if (parsed.move !== undefined && parsed.move !== null) applyMove(parsed.move.x, parsed.move.y)
    if (parsed.show === true) showWindow()
    if (parsed.hide === true && win !== undefined && !win.isDestroyed()) win.hide()
    if (parsed.top === true) applyAlwaysOnTop(true)
    if (parsed.top === false) applyAlwaysOnTop(false)
    if (parsed.minimize === true && win !== undefined && !win.isDestroyed()) win.minimize()
    if (parsed.reload === true) reloadWindow()
    if (parsed.report === true && win !== undefined && !win.isDestroyed()) {
      win.webContents.executeJavaScript(`(() => {
        let stats = null
        try { stats = typeof globalThis.__DSH_LIVE2D_STATS__ === 'function' ? globalThis.__DSH_LIVE2D_STATS__() : null } catch (error) { stats = { error: String(error) } }
        let handle = null
        try {
          const h = globalThis.__DSH_LIVE2D_WINDOW__
          const source = (() => { try { return h && typeof h.eventSource === 'function' ? h.eventSource() : null } catch (error) { return null } })()
          handle = h ? {
            version: h.version || null,
            backend: typeof h.backend === 'function' ? h.backend() : null,
            eventCount: typeof h.eventCount === 'function' ? h.eventCount() : null,
            lastSpeechEvent: typeof h.lastSpeechEvent === 'function' ? h.lastSpeechEvent() : null,
            lastEvent: typeof h.lastEvent === 'function' ? h.lastEvent() : null,
            pendingSpeech: typeof h.pendingSpeech === 'function' ? h.pendingSpeech() : null,
            audioStartedAt: typeof h.audioStartedAt === 'function' ? h.audioStartedAt() : null,
            resumeCount: typeof h.resumeCount === 'function' ? h.resumeCount() : null,
            droppedStaleEvents: typeof h.droppedStaleEvents === 'function' ? h.droppedStaleEvents() : null,
            fallbackSpeeches: typeof h.fallbackSpeeches === 'function' ? h.fallbackSpeeches() : null,
            lastHostSpeaking: typeof h.lastHostSpeaking === 'function' ? h.lastHostSpeaking() : null,
            lastEventAgeMs: typeof h.eventCount === 'function' && typeof h.lastEventAt === 'function' ? Math.max(0, Date.now() - (h.lastEventAt() || 0)) : null,
            sse: source ? { readyState: source.readyState, url: source.url } : null,
          } : null
        } catch (error) { handle = { error: String(error) } }
        return { stats, handle, page: { visibility: document.visibilityState, focus: document.hasFocus(), hidden: document.hidden } }
      })()`).then((report) => {
        const stats = report ? report.stats : null
        log('info', 'window-stats', { stats, handle: report ? report.handle : null, page: report ? report.page : null })
        try {
          // Atomic write: diagnostics pollers read this file concurrently; a
          // non-atomic write used to surface as transient JSON parse errors.
          const target = path.join(DATA_DIR, 'window-stats.json')
          const temp = target + '.tmp'
          fs.writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), stats, handle: report ? report.handle : null, page: report ? report.page : null }, null, 2) + '\n', 'utf8')
          fs.renameSync(temp, target)
        } catch { /* ignore */ }
      }).catch((error) => log('warn', 'window-stats-failed', { error: String(error) }))
    }
    if (parsed.close === true && win !== undefined) win.close()
    // Consume the command so a restart never replays a stale resize/move.
    try { fs.unlinkSync(CONTROL_PATH) } catch { /* best effort */ }
  } catch (error) {
    log('warn', 'control-poll-failed', { error: String(error) })
  }
}
function startControlPolling() {
  if (controlTimer !== undefined) return
  controlTimer = setInterval(pollControl, 350)
}

ipcMain.on('dsh-live2d:resize', (_event, payload) => { applyResize(payload?.width, payload?.height) })
ipcMain.on('dsh-live2d:move', (_event, payload) => { applyMove(payload?.x, payload?.y) })
ipcMain.on('dsh-live2d:minimize', () => { if (win !== undefined && !win.isDestroyed()) win.minimize() })
ipcMain.on('dsh-live2d:close', () => { if (win !== undefined && !win.isDestroyed()) win.close() })
ipcMain.handle('dsh-live2d:bounds', () => (win !== undefined && !win.isDestroyed() ? win.getBounds() : null))

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  persistBounds()
  if (controlTimer !== undefined) clearInterval(controlTimer)
  if (tray !== undefined) {
    try { tray.destroy() } catch { /* ignore */ }
    tray = undefined
  }
  try {
    const stored = fs.existsSync(PID_PATH) ? fs.readFileSync(PID_PATH, 'utf8').trim() : ''
    if (stored === String(process.pid)) fs.unlinkSync(PID_PATH)
  } catch { /* best effort */ }
  try {
    const lockOwner = fs.existsSync(LOCK_PATH) ? fs.readFileSync(LOCK_PATH, 'utf8').trim() : ''
    if (lockOwner === String(process.pid)) fs.rmSync(LOCK_PATH, { force: true })
  } catch { /* best effort */ }
})

let tray
/**
 * The char window now lives in the taskbar like a normal application window, so
 * minimise/restore works naturally. The tray icon remains as an always-available
 * show/hide/reload/close entry.
 */
function setupTray() {
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
    tray = new Tray(icon)
    tray.setToolTip('Live2D 桌面宠物')
    const menu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => showWindow(),
      },
      {
        label: '隐藏窗口',
        click: () => { if (win !== undefined && !win.isDestroyed()) win.hide() },
      },
      { type: 'separator' },
      {
        label: '重新加载模型页',
        click: () => { if (win !== undefined && !win.isDestroyed()) win.webContents.reload() },
      },
      {
        label: '关闭窗口',
        click: () => { if (win !== undefined && !win.isDestroyed()) win.close() },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
    tray.setContextMenu(menu)
    tray.on('double-click', () => showWindow())
    log('info', 'tray-ready')
  } catch (error) {
    log('warn', 'tray-failed', { error: String(error) })
  }
}

/** Bring the window back from hidden/minimized state (IPC, control file, tray). */
function showWindow() {
  if (win === undefined || win.isDestroyed()) return false
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    resumePage('show')
    return true
  } catch (error) {
    log('warn', 'show-failed', { error: String(error) })
    return false
  }
}

/**
 * Tell the page to re-arm its rAF loop and drop stale TTS frames. Called on
 * restore/show/focus: Chromium can pause the loop while the transparent window
 * is occluded or minimised, and a paused rAF never restarts by itself.
 */
let lastResumePageAt = 0
function resumePage(reason) {
  if (win === undefined || win.isDestroyed()) return
  // Focus/blur and restore/show can fire several times for one exposure; a
  // resume flushes the envelope queue, so do not run it more than once per
  // second while the page is healthy.
  const now = Date.now()
  if (now - lastResumePageAt < 900) return
  lastResumePageAt = now
  try {
    void win.webContents.executeJavaScript(
      "window.__DSH_LIVE2D_WINDOW__ && window.__DSH_LIVE2D_WINDOW__.resume && window.__DSH_LIVE2D_WINDOW__.resume()"
    ).catch((error) => log('warn', 'resume-page-failed', { reason, error: String(error) }))
    log('info', 'resume-page', { reason })
  } catch (error) {
    log('warn', 'resume-page-failed', { reason, error: String(error) })
  }
}

/**
 * Reload the window page. Used by the host's window watchdog when the page's SSE
 * stream silently died: a reload reconnects it and restores TTS reactions
 * without the user having to run `/live2d off` + `/live2d on`.
 */
function reloadWindow() {
  if (win === undefined || win.isDestroyed()) return false
  log('info', 'window-reload', { reason: 'host-request' })
  try {
    win.webContents.reload()
    return true
  } catch (error) {
    log('warn', 'window-reload-failed', { error: String(error) })
    return false
  }
}

let win
let attempts = 0
let retryTimer
let persistTimer

/** Remember the user's dragged/resized geometry (debounced). */
function schedulePersistBounds() {
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => { persistTimer = undefined; persistBounds() }, 400)
}

function defaultPosition(bounds) {
  try {
    const area = screen.getPrimaryDisplay().workArea
    const x = Number(argv.x || process.env.LIVE2D_WINDOW_X)
    const y = Number(argv.y || process.env.LIVE2D_WINDOW_Y)
    if (Number.isFinite(x) && Number.isFinite(y)) return clampToWorkArea({ x: Math.round(x), y: Math.round(y), width: bounds.width, height: bounds.height })
    const saved = savedBounds()
    if (saved !== null && saved.x !== null && saved.y !== null) {
      // Keep the window on the current desktop when monitors changed.
      const onScreen = saved.x >= area.x - 40 && saved.y >= area.y - 40 && saved.x <= area.x + area.width - 80 && saved.y <= area.y + area.height - 80
      if (onScreen) return clampToWorkArea({ x: saved.x, y: saved.y, width: bounds.width, height: bounds.height })
    }
    return clampToWorkArea({ x: area.x + area.width - bounds.width - 12, y: area.y + area.height - bounds.height - 12, width: bounds.width, height: bounds.height })
  } catch {
    return { x: 40, y: 40 }
  }
}

/**
 * Keep a frameless window fully inside the display work area. Fractional DPI
 * scaling and monitor changes used to leave the saved geometry partially
 * off-screen (e.g. x + width beyond the right edge), which made the character
 * sit half outside the desktop.
 */
function clampToWorkArea(bounds) {
  try {
    const area = screen.getDisplayMatching(bounds).workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  } catch {
    return bounds
  }
}

/** Switch normal z-order / always-on-top at runtime (control file or command). */
function applyAlwaysOnTop(enabled) {
  if (win === undefined || win.isDestroyed()) return false
  try {
    win.setAlwaysOnTop(!!enabled, enabled ? 'screen-saver' : 'normal')
    log('info', 'always-on-top', { enabled: !!enabled })
    return true
  } catch (error) {
    log('warn', 'always-on-top-failed', { error: String(error) })
    return false
  }
}

function scheduleRetry() {
  if (retryTimer !== undefined) return
  if (attempts > maxRetries) { log('error', 'give-up', { attempts }); return }
  retryTimer = setTimeout(() => { retryTimer = undefined; load() }, 2000)
}

function load() {
  if (win === undefined || win.isDestroyed()) return
  attempts += 1
  log('info', 'load', { url, attempt: attempts })
  win.loadURL(url).catch((error) => {
    log('warn', 'load-failed', { error: String(error) })
    scheduleRetry()
  })
}

app.whenReady().then(() => {
  const saved = savedBounds()
  const bounds = {
    width: saved !== null && saved.width !== null ? saved.width : width,
    height: saved !== null && saved.height !== null ? saved.height : height,
  }
  const position = defaultPosition(bounds)
  log('info', 'create-window', { ...bounds, ...position, transparent: true, frame: false, alwaysOnTop: alwaysOnTopRequested, taskbar: showInTaskbar })

  win = new BrowserWindow({
    ...bounds,
    ...position,
    transparent: true,
    frame: false,
    alwaysOnTop: alwaysOnTopRequested,
    skipTaskbar: !showInTaskbar,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
      preload: PRELOAD_PATH,
    },
  })

  if (alwaysOnTopRequested) {
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch { /* ignore */ }
  }
  try { win.setMenuBarVisibility(false) } catch { /* ignore */ }
  // Keep timers/rAF alive when another app has focus (the normal case for a pet).
  try { win.webContents.setBackgroundThrottling(false) } catch { /* ignore */ }
  win.on('focus', () => { log('info', 'window-focus'); resumePage('focus') })
  win.on('blur', () => log('info', 'window-blur'))
  // Like a normal application window: minimise to the taskbar, restore from it.
  try { win.setMinimizable(true) } catch { /* ignore */ }
  try { win.setMaximizable(false) } catch { /* ignore */ }
  win.on('minimize', () => log('info', 'minimized'))
  win.on('restore', () => { log('info', 'restored'); schedulePersistBounds(); resumePage('restore') })
  win.on('show', () => resumePage('show-event'))
  win.on('hide', () => log('info', 'window-hidden'))
  try { win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })) } catch { /* ignore */ }
  win.on('moved', () => { schedulePersistBounds(); ensureOnScreen() })
  win.on('resized', () => { schedulePersistBounds(); ensureOnScreen() })
  win.on('closed', () => { persistBounds(); win = undefined; app.quit() })
  startControlPolling()
  setupTray()

  win.once('ready-to-show', () => {
    if (win === undefined || win.isDestroyed()) return
    try {
      const clamped = clampToWorkArea(win.getBounds())
      const current = win.getBounds()
      if (clamped.x !== current.x || clamped.y !== current.y || clamped.width !== current.width || clamped.height !== current.height) {
        win.setBounds(clamped)
        log('info', 'bounds-clamped', { from: current, to: clamped })
      }
    } catch { /* ignore */ }
    win.showInactive()
    // Normal z-order window: a freshly launched window can be born behind the
    // already-maximised DSH window and look "missing". Raise it once without
    // stealing focus or becoming topmost, then it stacks normally.
    try { win.moveTop() } catch { /* ignore */ }
    persistBounds()
    log('info', 'window-ready', { bounds: win.getBounds(), visible: win.isVisible(), alwaysOnTop: win.isAlwaysOnTop() })
    resumePage('ready')
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Page-side diagnostics (WebGL errors, SSE failures, renderer exceptions).
    if (level >= 2 || /error|fail|webgl/i.test(String(message))) {
      log('info', 'page-console', { level, line, source: String(sourceId).split('/').slice(-1)[0], message: String(message).slice(0, 500) })
    }
  })
  win.webContents.on('did-finish-load', async () => {
    attempts = 0
    log('info', 'did-finish-load', { url })
    resumePage('did-finish-load')
    try {
      const info = await win.webContents.executeJavaScript(`(() => {
        const canvas = document.querySelector('#stage canvas') || document.querySelector('canvas')
        let stats = null
        try { stats = typeof globalThis.__DSH_LIVE2D_STATS__ === 'function' ? globalThis.__DSH_LIVE2D_STATS__() : null } catch (error) { stats = String(error) }
        return {
          inner: [window.innerWidth, window.innerHeight],
          canvases: document.querySelectorAll('canvas').length,
          canvas: canvas ? { width: canvas.width, height: canvas.height, style: canvas.style.cssText } : null,
          stats,
          bridge: typeof globalThis.dshLive2DWindow,
          grip: Boolean(document.getElementById('resize-grip')),
          close: Boolean(document.getElementById('close-btn')),
          hint: document.getElementById('hint')?.textContent ?? null,
        }
      })()`)
      log('info', 'page-diagnostics', { info })
      // Optional acceptance probe: prove the renderer's preload bridge can resize
      // this frameless window (equivalent to dragging the bottom-right grip).
      const probeResize = process.env.LIVE2D_WINDOW_PROBE_RESIZE
      if (probeResize !== undefined && /^\d{2,4}x\d{2,4}$/u.test(probeResize)) {
        const [probeWidth, probeHeight] = probeResize.split('x').map(Number)
        win.webContents.executeJavaScript(`window.dshLive2DWindow && window.dshLive2DWindow.resizeTo(${probeWidth}, ${probeHeight})`).catch(() => undefined)
        setTimeout(() => log('info', 'probe-resize-result', { requested: probeResize, bounds: win !== undefined && !win.isDestroyed() ? win.getBounds() : null }), 900)
      }
    } catch (error) {
      log('warn', 'page-diagnostics-failed', { error: String(error) })
    }
  })
  win.webContents.on('did-fail-load', (_event, code, description) => {
    log('warn', 'did-fail-load', { code, description })
    scheduleRetry()
  })
  win.webContents.on('render-process-gone', (_event, details) => log('error', 'render-process-gone', { details: String(details && details.reason) }))
  log('info', 'loading-page')
  load()
}).catch((error) => {
  log('error', 'when-ready-failed', { error: String(error && error.stack ? error.stack : error) })
  app.exit(1)
})

