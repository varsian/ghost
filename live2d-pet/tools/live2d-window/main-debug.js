'use strict'

/**
 * Live2D independent window — Electron main process.
 *
 * A transparent, frameless, always-on-top, taskbar-less window that loads the
 * host's standalone window page (default http://127.0.0.1:34567/window).
 * The page itself owns the drag regions (-webkit-app-region: drag) and the
 * renderer; this process only owns the OS window, retries, logging and the
 * self-capture used for acceptance evidence.
 *
 * Arguments (all optional, also accepted as LIVE2D_WINDOW_* env vars):
 *   --url <url>            page to load                 (default host /window)
 *   --width/--height <px>  window size                  (default 360x520)
 *   --x/--y <px>           window position              (default bottom-right)
 *   --capture <png path>   capturePage() this PNG after load
 *   --capture-delay <ms>   delay before capture         (default 1200)
 *   --capture-only         quit right after the capture
 *   --retries <n>          load retries                 (default 30)
 *   --retry-delay <ms>     delay between retries        (default 2000)
 *
 * Data directory: LIVE2D_WINDOW_DATA or <repo>/data. Files:
 *   live2d-window.log   JSON-lines log
 *   live2d-window.pid   this process's pid (for launch.mjs --close)
 */

const fs = require('node:fs')
const path = require('node:path')

// Refuse to run under plain Node: if ELECTRON_RUN_AS_NODE leaked into the
// environment the Electron binary would behave as Node, and every Electron API
// here would be undefined. Fail fast and quietly instead of showing a dialog.
if (!process.versions.electron) {
  try {
    process.stderr.write('live2d-window: start this with the Electron binary (tools/live2d-window/launch.mjs), not node\n')
  } catch { /* no stderr */ }
  process.exit(1)
}

const { app, BrowserWindow, screen } = require('electron')
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: electron required\n')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DATA_DIR = process.env.LIVE2D_WINDOW_DATA
  ? path.resolve(process.env.LIVE2D_WINDOW_DATA)
  : path.join(REPO_ROOT, 'data')
const LOG_PATH = path.join(DATA_DIR, 'live2d-window.log')
const PID_PATH = path.join(DATA_DIR, 'live2d-window.pid')

fs.mkdirSync(DATA_DIR, { recursive: true })
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: data dir ready\n')

/** Append one JSON line to the window log (never throws). */
function log(level, message, extra) {
  const record = { ts: new Date().toISOString(), level, message, ...extra }
  const line = JSON.stringify(record) + '\n'
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 4 * 1024 * 1024) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1')
    }
  } catch { /* rotation is best effort */ }
  try { fs.appendFileSync(LOG_PATH, line) } catch { /* logging must never break the window */ }
  try { console.log(line.trimEnd()) } catch { /* no stdio in some launches */ }
}

// Acceptance/UX rule: a failed window must never leave a blocking native dialog
// on the user's desktop. Suppress Chromium's error dialogs and turn uncaught
// main-process errors into a log line plus a quiet exit.
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: before switches\n');
app.commandLine.appendSwitch('noerrdialogs')
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: switches ok\n')
app.commandLine.appendSwitch('disable-crash-reporter')
app.commandLine.appendSwitch('disable-breakpad')
process.on('uncaughtException', (error) => {
  log('error', 'uncaught-exception', { error: String(error?.stack ?? error) })
  app.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandled-rejection', { reason: String(reason?.stack ?? reason) })
  app.exit(1)
})

/** Parse `--flag value` / `--flag` arguments into a plain object. */
function parseArgs(argv) {
  const values = new Set(['url', 'x', 'y', 'width', 'height', 'capture', 'capture-delay', 'retries', 'retry-delay'])
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (values.has(key)) {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('--')) { out[key] = value; index++ }
    } else {
      out[key] = true
    }
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))
const env = process.env
const url = String(argv.url ?? env.LIVE2D_WINDOW_URL ?? 'http://127.0.0.1:34567/window')
const width = Math.max(80, Math.round(Number(argv.width ?? env.LIVE2D_WINDOW_WIDTH ?? 360)))
const height = Math.max(80, Math.round(Number(argv.height ?? env.LIVE2D_WINDOW_HEIGHT ?? 520)))
const capturePath = argv.capture ?? env.LIVE2D_WINDOW_CAPTURE ?? ''
const captureDelay = Math.max(0, Math.round(Number(argv['capture-delay'] ?? env.LIVE2D_WINDOW_CAPTURE_DELAY ?? 1200)))
const captureOnly = Boolean(argv['capture-only'] ?? env.LIVE2D_WINDOW_CAPTURE_ONLY)
const maxRetries = Math.max(0, Math.round(Number(argv.retries ?? env.LIVE2D_WINDOW_RETRIES ?? 30)))
const retryDelay = Math.max(200, Math.round(Number(argv['retry-delay'] ?? env.LIVE2D_WINDOW_RETRY_DELAY ?? 2000)))

function defaultPosition(bounds) {
  const area = screen.getPrimaryDisplay().workArea
  const x = Number(argv.x ?? env.LIVE2D_WINDOW_X)
  const y = Number(argv.y ?? env.LIVE2D_WINDOW_Y)
  return {
    x: Number.isFinite(x) ? Math.round(x) : area.x + area.width - bounds.width - 12,
    y: Number.isFinite(y) ? Math.round(y) : area.y + area.height - bounds.height - 12,
  }
}

/** Write our own pid so launch.mjs/close can find this window even on early failures. */
function writePidFile() {
  try { fs.writeFileSync(PID_PATH, String(process.pid) + '\n', 'utf8') } catch { /* non-fatal */ }
}

// One window per machine: a duplicate launch exits before creating another and
// must not overwrite the running window's pid file.
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: before lock\n');
const hasLock = app.requestSingleInstanceLock()
require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: lock ' + hasLock + '\n')
if (!hasLock) {
  log('warn', 'single-instance-lock-failed', { pid: process.pid })
  app.quit()
} else {
  writePidFile()
}

app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  try {
    const stored = fs.existsSync(PID_PATH) ? fs.readFileSync(PID_PATH, 'utf8').trim() : ''
    if (stored === String(process.pid)) fs.unlinkSync(PID_PATH)
  } catch { /* best effort */ }
})

let win
let attempts = 0
let retryTimer
let capturing = false

function scheduleRetry(reason) {
  if (retryTimer !== undefined) return
  if (attempts > maxRetries) {
    log('error', 'give-up', { url, attempts, reason })
    if (captureOnly) app.exit(2)
    return
  }
  retryTimer = setTimeout(() => { retryTimer = undefined; load() }, retryDelay)
}

function load() {
  if (!win || win.isDestroyed()) return
  attempts += 1
  log('info', 'load', { url, attempt: attempts })
  win.loadURL(url).catch((error) => scheduleRetry(String(error)))
}

/** Capture the page into a PNG plus alpha statistics for transparent-window acceptance. */
async function capture() {
  if (capturing) return
  capturing = true
  try {
    const image = await win.webContents.capturePage()
    const size = image.getSize()
    fs.mkdirSync(path.dirname(capturePath), { recursive: true })
    fs.writeFileSync(capturePath, image.toPNG())
    const bitmap = image.toBitmap() // BGRA
    let transparent = 0
    const pixels = size.width * size.height
    for (let offset = 3; offset < bitmap.length; offset += 4) {
      if (bitmap[offset] === 0) transparent += 1
    }
    const stats = {
      ok: true,
      path: path.resolve(capturePath),
      width: size.width,
      height: size.height,
      bytes: fs.statSync(capturePath).size,
      transparentPixels: transparent,
      totalPixels: pixels,
      transparentRatio: pixels === 0 ? 0 : Math.round((transparent / pixels) * 10000) / 10000,
    }
    fs.writeFileSync(capturePath + '.json', JSON.stringify(stats, null, 2) + '\n', 'utf8')
    log('info', 'capture', stats)
  } catch (error) {
    log('error', 'capture-failed', { error: String(error), capturePath })
  }
  if (captureOnly) setTimeout(() => app.quit(), 250)
}

require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: before ready\n');
app.whenReady().then(() => {
  require('fs').appendFileSync(process.env.TRIM_LOG, 'stage: ready\n')
  const bounds = { width, height }
  const position = defaultPosition(bounds)
  log('info', 'create-window', { url, width, height, ...position, pid: process.pid })

  win = new BrowserWindow({
    ...bounds,
    ...position,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)

  const showWindow = () => {
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.showInactive()
    log('info', 'window-ready', {
      pid: process.pid,
      bounds: win.getBounds(),
      isAlwaysOnTop: win.isAlwaysOnTop(),
      resizable: win.isResizable(),
      visible: win.isVisible(),
      transparent: true,
      frame: false,
    })
    if (capturePath) setTimeout(() => capture(), captureDelay)
  }

  win.once('ready-to-show', showWindow)
  // A transparent window can skip ready-to-show on some GPUs; bound the wait.
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) showWindow() }, 5000)

  win.webContents.on('did-finish-load', () => {
    attempts = 0
    log('info', 'did-finish-load', { url })
    showWindow()
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    log('warn', 'did-fail-load', { code, description, validatedURL })
    scheduleRetry(`did-fail-load ${code} ${description}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'render-process-gone', details)
  })

  load()
}).catch((error) => {
  log('error', 'when-ready-failed', { error: String(error) })
  app.exit(1)
})

app.on('second-instance', () => {
  if (!win) return
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  log('info', 'second-instance-focused', { pid: process.pid })
})

