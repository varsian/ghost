# live2d-window — standalone transparent Live2D window (Electron)

A tiny offline Electron launcher that opens the plugin's standalone window page
(`http://127.0.0.1:34567/window`, served by the DSH Live2D plugin host) in a
transparent, frameless, normal desktop window (taskbar entry, not topmost by
default). The page renders the model and owns its drag regions
(`-webkit-app-region: drag`); this launcher only owns the OS window, logging,
retry and the self-capture used for evidence.

## Install

`node_modules` (Electron ~250 MB on disk) is **not** part of the deliverable.
Recreate it locally:

```powershell
cd live2d-pet/tools/live2d-window
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'   # optional, fast mirror
npm install
```

The local development install used Electron 44.9.0 (~247 MB on disk), but this
snapshot's `package.json` pins **Electron 28.3.3** (the version the original
launcher was developed against). Nothing else is required — the launcher is pure
Node stdlib + the `electron` package; the binary lands at
`node_modules\electron\dist\electron.exe`.

## Usage

All commands print **one line of JSON** on stdout (`{ ok, ... }`), exit 0 on
success (including `already:true`) and 1 on failure.

```powershell
# Start the window (idempotent: an alive window is reported, not duplicated)
node tools/live2d-window/launch.mjs --url "http://127.0.0.1:34567/window"
# -> {"ok":true,"already":false,"pid":1234,"url":"...","exe":"...","log":"...","bounds":{...}}

# Custom geometry / URL
node tools/live2d-window/launch.mjs --url "http://127.0.0.1:34567/window" --width 360 --height 520 --x 1500 --y 600

# Status / close / dedupe
node tools/live2d-window/launch.mjs --status   # -> {"ok":true,"running":true,"pid":1234,"instances":[...],...}
node tools/live2d-window/launch.mjs --close    # -> {"ok":true,"closed":true,"pids":[...]}
node tools/live2d-window/launch.mjs --dedupe   # -> {"ok":true,"kept":1234,"killed":[...],"instances":2}

# Capture the page to a PNG (transparency proof) and exit
node tools/live2d-window/launch.mjs --url "http://127.0.0.1:34567/window" `
  --capture "<data-dir>\window.png" --capture-only

# Validate paths without launching anything (no window, no dialog)
node tools/live2d-window/launch.mjs --dry-run
```

Environment overrides: `LIVE2D_WINDOW_DATA` (data directory), `LIVE2D_WINDOW_URL`,
`LIVE2D_WINDOW_WIDTH/HEIGHT/X/Y`, `LIVE2D_WINDOW_CAPTURE`.

## Window behaviour (`main.js`)

- `BrowserWindow({ transparent: true, frame: false, alwaysOnTop: false,
  skipTaskbar: false, resizable: true, hasShadow: false,
  backgroundColor: '#00000000', webPreferences: { backgroundThrottling: false,
  contextIsolation: true, nodeIntegration: false, sandbox: true } })`
- Normal z-order (opt-in topmost with `--always-on-top`); default position is the
  bottom-right of the primary work area; `showInactive()` so it never steals focus.
- `restore`/`show`/`focus` call `window.__DSH_LIVE2D_WINDOW__.resume()` so a page
  whose rAF was paused while occluded/minimised re-arms immediately.
- Load retries: 30 × 2 s by default (host may start after the window), then a
  JSON log entry `give-up`. Errors never raise native dialogs.
- `webContents.capturePage()` writes the PNG plus `<png>.json` alpha statistics
  (`transparentPixels`, `transparentRatio`, size, bytes) for acceptance.
- `sync-11` singleton stack: Electron `requestSingleInstanceLock` (kernel mutex,
  survives pid/lock-file loss), a data-dir file lock kept for adoption, a launcher
  mutex (`launch.lock`) and a log-based `--dedupe` sweep before every spawn.
  A duplicate launch logs `duplicate-instance` and exits instead of opening a
  second window.

## Files / data directory

Default data directory: `<live2d-pet>/data` (override with `LIVE2D_WINDOW_DATA`):

| File | Meaning |
|---|---|
| `live2d-window.log` | JSON-lines log (`load`, `did-fail-load`, `window-ready`, `capture`, errors) |
| `live2d-window.pid` | running window pid, written by `main.js`, removed on quit |
| `live2d-window.json` | launch metadata (`pid`, `url`, bounds, electron version) |

## Known limitations / notes

- **Windows transparency:** a transparent window needs the page background to be
  transparent; `capturePage()` returns the page with alpha where the page is
  transparent. Some GPU/driver combinations force an opaque compositor; if the
  capture alpha is 0, check `disableHardwareAcceleration` only as a last resort
  (it hurts Live2D WebGL performance).
- **Start this only with the Electron binary.** The DSH host environment exports
  `ELECTRON_RUN_AS_NODE=1`; `launch.mjs` deletes it for the child, and `main.js`
  refuses to run under plain Node. Running `node main.js` directly prints a hint
  and exits instead of showing a dialog.
- **Do not point Electron at a missing app path.** Electron pops a native
  "Unable to find Electron app" dialog for it; `launch.mjs` validates
  `main.js`/electron first and reports JSON `{ok:false,error}` instead.
- **This machine (host sandbox) may crash Electron at startup**, e.g.
  `0xc0000005` right after `app.whenReady()`; see `data/live2d-window.log`.
  If that reproduces, run the launcher from a normal (non-agent) shell or use the
  fallback below. The launcher itself never shows a blocking dialog on failure.
- **Fallback without Electron:** Edge app mode
  `msedge.exe --app=http://127.0.0.1:34567/window --window-size=360,520 — no
  transparency/always-on-top, so it is only a visual fallback.
- The window loads the host page, so the DSH desktop app (or a dev instance) must
  already serve `http://127.0.0.1:34567/window`; the launcher never starts the host.
