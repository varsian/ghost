import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DATA_DIR = process.env.LIVE2D_WINDOW_DATA ? resolve(process.env.LIVE2D_WINDOW_DATA) : join(REPO_ROOT, 'data')
const PID_PATH = join(DATA_DIR, 'live2d-window.pid')
const META_PATH = join(DATA_DIR, 'live2d-window.json')
const LOCK_PATH = join(DATA_DIR, 'live2d-window.lock')
const LOG_PATH = join(DATA_DIR, 'live2d-window.log')
const USER_DATA_DIR = join(DATA_DIR, 'electron-userdata')
const MAIN_JS = join(HERE, 'main.js')
const DEFAULT_URL = 'http://127.0.0.1:34567/window'

function emit(payload, code = 0) {
  process.stdout.write(JSON.stringify(payload) + '\n')
  process.exit(code)
}
function fail(error, extra = {}) {
  emit({ ok: false, error: String(error), ...extra }, 1)
}
function parseArgs(argv) {
  const takesValue = new Set(['url', 'x', 'y', 'width', 'height', 'capture', 'capture-delay', 'timeout'])
  const out = { _: [] }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const equals = token.indexOf('=')
    const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
    if (equals !== -1) { out[key] = token.slice(equals + 1); continue }
    if (takesValue.has(key)) {
      const value = argv[++index]
      out[key] = value !== undefined ? value : true
    } else {
      out[key] = true
    }
  }
  return out
}
function readPid() {
  try {
    const value = Number.parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}
function readMeta() {
  try { return JSON.parse(readFileSync(META_PATH, 'utf8')) } catch { return null }
}
/** Owner pid of the window's exclusive instance lock (the live window). */
function readLockOwner() {
  try {
    const value = Number.parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}
/** A live window whose pid file was lost in a restart race: re-adopt it. */
function adoptLockedWindow() {
  const owner = readLockOwner()
  if (!owner || !isAlive(owner)) return null
  try { writeFileSync(PID_PATH, String(owner) + '\n', 'utf8') } catch { /* best effort */ }
  return owner
}
function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
function clearState() {
  for (const file of [PID_PATH, META_PATH]) {
    try { if (existsSync(file)) unlinkSync(file) } catch { /* best effort */ }
  }
  // A force-killed window cannot run will-quit, so its file lock can be stale.
  try {
    const owner = readLockOwner()
    if (!owner || !isAlive(owner)) unlinkSync(LOCK_PATH)
  } catch { /* best effort */ }
}

/**
 * Report every Live2D window boot recorded in the (rotated) window log.
 * This is deliberately scoped to our own launcher: pids are only ever logged
 * by `main.js`, so a stale unrelated process id can never be treated as a pet.
 */
/**
 * Every Electron main process that is running our window page, independent of
 * the pid/lock files. Old builds (or windows whose data dir was lost) can leave
 * a blank `DSH Live2D` window alive that the log/pid scan cannot see; the
 * command line is the one identity those processes cannot lose.
 */
function scanWindowProcesses() {
  try {
    const main = MAIN_JS.replaceAll("'", "''")
    const userData = USER_DATA_DIR.replaceAll("'", "''")
    const script = [
      `$main = '${main}'`,
      `$userData = '${userData}'`,
      `Get-CimInstance Win32_Process -Filter "name='electron.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($main.ToLower()) -and $_.CommandLine.ToLower().Contains($userData.ToLower()) } | ForEach-Object { $_.ProcessId }`,
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 6000,
      windowsHide: true,
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return []
    return result.stdout
      .split(/\s+/u)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0)
  } catch { return [] }
}

function closeOtherTitledWindows(keeperPid) {
  try {
    const script = join(HERE, 'close-others.ps1')
    if (!existsSync(script)) return { ok: false, closed: [], error: 'close-others.ps1 missing' }
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-KeeperPid', String(keeperPid), '-Title', 'DSH Live2D'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    )
    const line = String(result.stdout || '')
      .split('\n')
      .map((value) => value.trim())
      .find((value) => value.startsWith('{'))
    if (line) {
      try { return JSON.parse(line) } catch { /* fall through */ }
    }
    return { ok: false, closed: [], error: String(result.stderr || 'no JSON output').slice(0, 400) }
  } catch (error) {
    return { ok: false, closed: [], error: String(error) }
  }
}

function readBootPids() {
  const entries = []
  for (const file of [LOG_PATH, LOG_PATH + '.1']) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const re = /"ts":"([^"]+)","pid":(\d+),[^\n]*"message":"main-boot"/g
    let match
    while ((match = re.exec(text)) !== null) {
      const pid = Number.parseInt(match[2], 10)
      if (Number.isFinite(pid) && pid > 0) entries.push({ ts: match[1], pid })
    }
  }
  const byPid = new Map()
  for (const entry of entries) {
    const previous = byPid.get(entry.pid)
    if (!previous || entry.ts > previous) byPid.set(entry.pid, entry.ts)
  }
  return [...byPid.entries()]
    .map(([pid, ts]) => ({ pid, ts }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
}

/**
 * Keep exactly one recorded window alive. Preference: pid file -> lock owner ->
 * newest boot. Used both before launching (so old orphans cannot accumulate)
 * and by the explicit `--dedupe` command.
 */
async function dedupeWindows() {
  const scanned = scanWindowProcesses()
  const alivePids = new Set(scanned)
  for (const pid of [readPid(), readLockOwner()]) {
    if (isAlive(pid)) alivePids.add(pid)
  }
  const alive = [...alivePids].map((pid) => ({ pid }))
  if (alive.length === 0) return { ok: true, kept: null, killed: [], closed: [], titledWindows: [], instances: 0, scanned }
  const pidFilePid = readPid()
  const lockPid = readLockOwner()
  const keeper =
    alive.find((entry) => entry.pid === pidFilePid) ??
    alive.find((entry) => entry.pid === lockPid) ??
    alive[alive.length - 1]
  // Close duplicate windows gracefully FIRST. WM_CLOSE lets Explorer/DWM remove
  // the Alt+Tab entry cleanly; force-killing a transparent Electron window can
  // leave a stale thumbnail ("only title"/black) in the switcher.
  let closed = []
  let titledWindows = []
  if (scanned.includes(keeper.pid)) {
    const result = closeOtherTitledWindows(keeper.pid)
    if (Array.isArray(result.closed)) closed = result.closed
    if (Array.isArray(result.seen)) titledWindows = result.seen
    await sleep(700)
  }
  const killed = []
  for (const entry of alive) {
    if (entry.pid === keeper.pid) continue
    if (!isAlive(entry.pid)) continue
    if (killProcess(entry.pid)) killed.push(entry.pid)
  }
  try { writeFileSync(PID_PATH, String(keeper.pid) + '\n', 'utf8') } catch { /* best effort */ }
  if (killed.length > 0) clearStateIfEmpty()
  return { ok: true, kept: keeper.pid, killed, closed, titledWindows, instances: alive.length, scanned }
}
/** Remove pid/meta only when the kept window is gone; not used after a dedupe. */
function clearStateIfEmpty() {
  const pid = readPid()
  if (!isAlive(pid)) clearState()
}

/** Serialise concurrent launchers (old/new host instances, watchdog retries). */
const LAUNCHER_LOCK_PATH = join(DATA_DIR, 'launch.lock')
async function acquireLauncherLock(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const fd = openSync(LAUNCHER_LOCK_PATH, 'wx')
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      return true
    } catch {
      try {
        const owner = Number.parseInt(readFileSync(LAUNCHER_LOCK_PATH, 'utf8').trim(), 10)
        if (isAlive(owner)) { await sleep(150); continue }
        unlinkSync(LAUNCHER_LOCK_PATH)
      } catch { /* stale/unreadable: retry */ }
      await sleep(150)
    }
  }
  return false
}
function releaseLauncherLock() {
  try {
    const owner = Number.parseInt(readFileSync(LAUNCHER_LOCK_PATH, 'utf8').trim(), 10)
    if (owner === process.pid) unlinkSync(LAUNCHER_LOCK_PATH)
  } catch { /* best effort */ }
}
process.on('exit', releaseLauncherLock)
/** Close every recorded window (used by `--close` and duplicate cleanup). */
function allLiveWindowPids() {
  const pids = new Set()
  for (const pid of scanWindowProcesses()) if (isAlive(pid)) pids.add(pid)
  for (const pid of [readPid(), readLockOwner()]) if (isAlive(pid)) pids.add(pid)
  return [...pids]
}
function electronBinary() {
  const require = createRequire(import.meta.url)
  try {
    const binary = require('electron')
    if (typeof binary === 'string' && existsSync(binary)) return binary
  } catch { /* fall through */ }
  throw new Error('electron is not installed; run `npm install` in tools/live2d-window (slow download: set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/)')
}
function electronVersion() {
  try { return createRequire(import.meta.url)('electron/package.json').version } catch { return null }
}
async function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)) }
async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}
function killProcess(pid) {
  try { process.kill(pid) } catch { /* already gone */ }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  return !isAlive(pid)
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  emit({
    ok: true,
    usage: 'node launch.mjs [--url <url>] [--x N] [--y N] [--width N] [--height N] [--timeout ms] | --status | --close | --dry-run',
    defaultUrl: DEFAULT_URL,
    dataDir: DATA_DIR,
    log: LOG_PATH,
    electronVersion: electronVersion(),
  })
}

if (args['dry-run'] || args.check) {
  let exe = null
  let problem = null
  try { exe = electronBinary() } catch (error) { problem = String(error) }
  emit({
    ok: problem === null,
    dryRun: true,
    main: MAIN_JS,
    mainExists: existsSync(MAIN_JS),
    url: String(args.url ?? process.env.LIVE2D_WINDOW_URL ?? DEFAULT_URL),
    electron: exe,
    electronExists: exe !== null && existsSync(exe),
    electronVersion: electronVersion(),
    dataDir: DATA_DIR,
    log: LOG_PATH,
    ...(problem === null ? {} : { error: problem }),
  })
}

if (args.status) {
  const pid = readPid()
  const running = isAlive(pid)
  if (!running && pid) clearState()
  emit({
    ok: true,
    running,
    pid: running ? pid : null,
    instances: allLiveWindowPids(),
    lockPid: readLockOwner(),
    meta: running ? readMeta() : null,
    log: LOG_PATH,
    dataDir: DATA_DIR
  })
}

if (args.dedupe) {
  if (!(await acquireLauncherLock())) fail('another launcher is running; cannot dedupe')
  const result = await dedupeWindows()
  emit({ ...result, lockPid: readLockOwner(), pid: readPid(), log: LOG_PATH, dataDir: DATA_DIR })
}

if (args.close) {
  if (!(await acquireLauncherLock())) fail('another launcher is running; cannot close')
  // Ask every visible window to close itself first (WM_CLOSE). This is the
  // graceful path: Explorer removes the Alt+Tab/taskbar entry immediately, and
  // Electron runs its normal will-quit cleanup. Force-kill below is only a
  // fallback for a hung process.
  const graceful = closeOtherTitledWindows(0)
  await sleep(1500)
  const pids = allLiveWindowPids()
  const pid = readPid()
  if (pids.length === 0) {
    await sleep(300)
    clearState()
    emit({ ok: true, closed: Array.isArray(graceful.closed) && graceful.closed.length > 0, reason: 'not-running', closedWindows: Array.isArray(graceful.closed) ? graceful.closed : [], lockPid: readLockOwner() })
  }
  for (const target of pids) killProcess(target)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && allLiveWindowPids().length > 0) await sleep(200)
  const remaining = allLiveWindowPids()
  if (remaining.length > 0) {
    emit({ ok: false, error: 'window did not exit', pids: remaining }, 1)
  }
  const titled = closeOtherTitledWindows(0)
  await sleep(300)
  clearState()
  emit({ ok: true, closed: true, pids, pid, closedWindows: Array.isArray(graceful.closed) ? graceful.closed : (Array.isArray(titled.closed) ? titled.closed : []) })
}

// ---------------------------------------------------------------- launch mode --
const url = String(args.url ?? process.env.LIVE2D_WINDOW_URL ?? DEFAULT_URL)
const width = Math.max(80, Math.round(Number(args.width ?? 360)))
const height = Math.max(80, Math.round(Number(args.height ?? 520)))
const timeoutMs = Math.max(3000, Math.round(Number(args.timeout ?? 20000)))

if (!(await acquireLauncherLock())) fail('another launcher is running; window start skipped')

// Never spawn while a recorded window is still alive. This also cleans up
// orphans left by a crashed/duplicate launcher from an older build.
const dedupeResult = await dedupeWindows()
if (dedupeResult.kept !== null && isAlive(dedupeResult.kept)) {
  const meta = readMeta()
  emit({
    ok: true,
    already: true,
    adopted: true,
    pid: dedupeResult.kept,
    url: meta?.url ?? null,
    dedupe: dedupeResult,
    log: LOG_PATH,
    dataDir: DATA_DIR,
  })
}

const existingPid = readPid()
if (existingPid && isAlive(existingPid)) {
  const meta = readMeta()
  emit({ ok: true, already: true, pid: existingPid, url: meta?.url ?? null, log: LOG_PATH, dataDir: DATA_DIR })
}
if (existingPid) clearState()
const adoptedPid = adoptLockedWindow()
if (adoptedPid !== null) {
  // The previous launcher cleared the pid file while its window was still
  // shutting down (or a launcher race lost the pid file). The window's lock is
  // authoritative: adopt the running window instead of spawning a duplicate.
  const meta = readMeta()
  emit({ ok: true, already: true, adopted: true, pid: adoptedPid, url: meta?.url ?? null, log: LOG_PATH, dataDir: DATA_DIR })
}

let electronExe
try { electronExe = electronBinary() } catch (error) {
  fail(error, { hint: 'cd tools/live2d-window && $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install electron', dataDir: DATA_DIR })
}
if (!existsSync(MAIN_JS)) fail('window main.js is missing; nothing was launched', { main: MAIN_JS, dataDir: DATA_DIR })

mkdirSync(DATA_DIR, { recursive: true })

// Launch through a generated .cmd wrapper: in this DSH deployment a direct
// child_process.spawn of Electron can die before its main script runs, while the
// same command line started by cmd.exe is reliable. All variable values (URL
// with &, geometry) travel through the environment, never through the command
// line, so no shell quoting can break them.
const useSoftware = process.env.LIVE2D_WINDOW_GPU !== '1'
const userDataDir = join(DATA_DIR, 'electron-userdata')
const batchPath = join(DATA_DIR, 'launch-window.cmd')
const electronArgs = [
  `--user-data-dir="${userDataDir}"`,
  ...(useSoftware ? ['--no-sandbox', '--disable-gpu', '--in-process-gpu'] : []),
  // The pet is almost never the focused window. Chromium otherwise throttles
  // background timers / occluded renderers, which shows up as stutter while the
  // user works in another app; keep rAF and the compositor running normally.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--noerrdialogs',
  '--disable-crash-reporter',
  '--disable-breakpad',
  `"${MAIN_JS}"`,
].join(' ')
const batch = ['@echo off', 'set ELECTRON_RUN_AS_NODE=', `"${electronExe}" ${electronArgs}`, ''].join('\r\n')
writeFileSync(batchPath, batch, 'utf8')

const childEnv = { ...process.env, LIVE2D_WINDOW_DATA: DATA_DIR }
childEnv.LIVE2D_WINDOW_URL = url
childEnv.LIVE2D_WINDOW_WIDTH = String(width)
childEnv.LIVE2D_WINDOW_HEIGHT = String(height)
if (args.x !== undefined) childEnv.LIVE2D_WINDOW_X = String(Number(args.x))
if (args.y !== undefined) childEnv.LIVE2D_WINDOW_Y = String(Number(args.y))
// Normal desktop-window behaviour is the default (taskbar entry + normal
// z-order). The host passes --always-on-top only when the plugin config asks for
// the legacy topmost pet; --no-taskbar keeps the old taskbar-less variant.
if (args['always-on-top'] !== undefined) childEnv.LIVE2D_WINDOW_TOPMOST = '1'
if (args['no-taskbar'] !== undefined) childEnv.LIVE2D_WINDOW_SKIP_TASKBAR = '1'
if (process.env.LIVE2D_WINDOW_GPU === '1') childEnv.LIVE2D_WINDOW_GPU = '1'
delete childEnv.ELECTRON_RUN_AS_NODE
delete childEnv.ELECTRON_RUN_AS_NODE_BACKUP

const child = spawn('cmd.exe', ['/c', batchPath], { cwd: REPO_ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: childEnv })
child.unref()

const pid = await waitFor(() => {
  const recorded = readPid()
  return recorded !== null && isAlive(recorded) ? recorded : null
}, timeoutMs)
if (!pid) {
  // The spawned window exited (single-instance guard) or is slow: if a live
  // locked window exists, adopt it instead of reporting a failure (the host
  // would otherwise retry and spawn more launchers).
  const adopted = adoptLockedWindow()
  if (adopted !== null) {
    const meta = readMeta()
    emit({ ok: true, already: true, adopted: true, pid: adopted, url: meta?.url ?? null, log: LOG_PATH, dataDir: DATA_DIR })
  }
  clearState()
  fail('window did not report its pid in time', {
    log: LOG_PATH,
    hint: 'inspect data/live2d-window.log; the host page may be unreachable (the window retries)',
  })
}

const meta = {
  pid,
  url,
  width,
  height,
  x: args.x !== undefined ? Number(args.x) : null,
  y: args.y !== undefined ? Number(args.y) : null,
  startedAt: new Date().toISOString(),
  electron: electronExe,
  electronVersion: electronVersion(),
  softwareRendering: useSoftware,
  log: LOG_PATH,
  dataDir: DATA_DIR,
}
writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n', 'utf8')
emit({ ok: true, already: false, pid, url, exe: electronExe, electronVersion: meta.electronVersion, softwareRendering: useSoftware, log: LOG_PATH, dataDir: DATA_DIR, bounds: { width, height, x: meta.x, y: meta.y } })
