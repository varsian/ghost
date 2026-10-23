# Architecture

This GHOST Community Edition repository packages three cooperating projects. Each keeps
its original internal package structure; this document describes how they fit together.

## 1. Components

### Project 1 — `live2d-pet/` (Live2D desktop pet)

| Path | Role |
| --- | --- |
| `packages/bundle/` | `@local/dsh-live2d-bundle`: a DSH profile bundle layer. Its `cordis.patch.yml` inserts the `live2d` plugin row and carries the row configuration (port, token, model dir, presentation mode, performance tuning). |
| `packages/plugin/lib/index.js` | Host half (hand-written ESM). Owns the loopback HTTP + SSE server (`127.0.0.1:34567` by default), model catalog/asset serving, `/live2d` command registration, the window launcher and the ingest endpoint used by the bridge. |
| `packages/plugin/src/client/` | Browser half sources: overlay glue + renderer core (pixi.js v7 + pixi-live2d-display; the Soullink Emotion SDK adapter is the primary performance backend with a direct renderer fallback). |
| `packages/plugin/lib/client.js` | Build output of `src/client/` for the DSH client loader. **Not committed** — it inlines the proprietary Cubism cores. |
| `packages/plugin/lib/window.js` | Build output for the standalone window page. **Not committed**, same reason. |
| `packages/plugin/python/live2d_tts_shim.py` | The mirror shim used as the TTS `daemonScript` (project 2). |
| `packages/plugin/vendor/` | Committed MIT runtimes (`pixi.min.js`, `pixi-live2d-display.min.js`) and the built Soullink adapter; the proprietary Live2D Cubism cores are **fetched** here by `scripts/fetch-vendor.mjs`. |
| `tools/live2d-window/` | Standalone transparent Electron window launcher (`launch.mjs` + `main.js`); Electron itself is installed locally with `npm install` and is not committed. |
| `tools/*.ps1` | Windows install / uninstall / verify / dev helpers. |
| `tests/` | `node:test` and Python tests for the protocol, envelope, backpressure and window singleton behaviour. |

Presentation modes: `window` (default, separate transparent Electron window),
`overlay` (inside the DSH Web GUI), `both`, `none`. The renderer and the shim do
not care which one is active; they share the same SSE event stream.

### Project 2 — `tts-bridge/` (TTS playback bridge)

`@local/dsh-live2d-tts-bridge` is deliberately a *separate* bundle from the pet
bundle. It overrides the `tool-tts` row inserted by the voice bundle (a profile
bundle `config` block is a whole-row replacement, so the complete TTS config is
restated) and points `daemonScript` at `live2d_tts_shim.py`.

The shim:

1. reads a sidecar JSON (`packages/plugin/python/live2d_tts_shim.json`, generated
   at install time, gitignored) to find the real `tts_daemon.py`;
2. executes the real daemon in the same process with `runpy` — stdin/stdout/stderr,
   exit codes and signal behaviour are unchanged;
3. tees `os.read(stdin)` request lines, `EventWriter.emit` protocol frames and the
   `SoundDevicePlayer` PCM callback;
4. turns the actual playback PCM into ~20 ms RMS envelope batches and POSTs them,
   together with segment emotions, sentence timings and measured output latency,
   to `http://127.0.0.1:34567/ingest` with the loopback-only `X-Live2D-Token`
   header.

If the sidecar/config is missing, the ingest endpoint is down, or numpy is not
installed, the bridge degrades to "zero events" and TTS keeps working unchanged.
Turning the bridge bundle off removes the row override and TTS returns to the
native daemon with no manual rollback.

### Project 3 — `voice-plugin/` (local voice/TTS plugin snapshot)

A standalone build of `@deepseek-ai/dsh-tool-tts`: a Node plugin (`lib/`) that
registers the model-facing `tts` tool and owns the daemon process, plus the Python
engine (`python/`: `tts_daemon.py`, `ttslib/`, voice library, tests). The bridge
runs this engine, and the shim hooks its `SoundDevicePlayer` callback. This
snapshot is included so the stack can be reproduced without the upstream
monorepo; it is not a second TTS implementation.

## 2. Event flow

```
tts tool call
  └─ tool-tts host spawns <pythonPath> <shim> --voices-dir <VOICES_DIR> --model-dir <MODELS_DIR> ... (bridge override)
       └─ shim: runpy(real tts_daemon.py)
            ├─ protocol frames on stdout (ready / speak_start / segment_* / speak_done)
            └─ playback PCM callback ──► RMS envelope (20 ms frames, 4-frame batches)
                                          + segment emotion / sentence timeline
                                          + latencyMs (device output latency)
                     HTTP POST /ingest (loopback, token)
  └─ live2d host: validates token, queues events, forwards over SSE /events
       └─ browser/window renderer:
            · lip sync  = envelope, delayed by latencyMs to match audible sound
            · emotion   = segment emotion → native exp3 + VAD blend
            · motion    = Soullink speech-performance planner / idle engine
            · display   = transparent canvas (Electron window or in-GUI overlay)
```

Host endpoints (default port `34567`): `GET /health`, `GET /events` (SSE),
`GET /models`, `GET /model`, `GET /assets/<path>` (path-traversal guarded),
`POST /ingest` (bridge only, token), `POST /command` (browser UI commands),
`GET /window` + `GET /lib/window.js` (standalone window page).

## 3. Build pipeline

1. `node scripts/fetch-vendor.mjs --accept-live2d-eula`
   - verifies the committed `pixi.min.js` / `pixi-live2d-display.min.js` against
     `vendor.lock.json`;
   - downloads both Live2D Cubism cores (Cubism 4 official URL + legacy Cubism 2
     core mirror) to the vendor directory;
   - verifies every artifact by SHA-256; nothing proprietary is written unless the
     EULA flag is present.
2. `node scripts/build-all.mjs` (needs esbuild resolvable from `node_modules` or
   `ESBUILD_MAIN`) runs `packages/plugin/build-client.mjs` twice, producing
   `lib/client.js` and `lib/window.js` with the vendor runtime inlined.
3. `live2d-pet/tools/install.ps1` links the plugin/bundle packages into a DSH
   profile (`node_modules/@local/*` junctions + `link:` dependencies + ordered
   `dsh.profile.bundles`), writes the TTS shim sidecar and renders the
   `<PLUGIN_DIR>` / `<PYTHON>` / `<VOICES_DIR>` placeholders in the bridge patch.

`third_party/soullink-emotion-sdk/` holds the adapter sources and the prebuilt
adapter IIFE used by `packages/plugin/vendor/soullink/dsh-live2d-adapter.js`;
`patch-adapter.mjs` applies the two documented DSH rendering patches.

## 4. Design notes worth keeping

- The TTS row's `config` in a bundle patch is a whole-row replacement, so the
  bridge restates the full TTS configuration. Read `tts-bridge/docs/TTS-BRIDGE.md`
  before editing it.
- A workspace-level `tts.config.yml` outranks the plugin row config; the installer
  rewrites its `daemonScript` to the shim and keeps a `*.lead-backup` for
  `uninstall.ps1`.
- The ingest token is a fixed loopback value (`dsh-live2d-local`), a guard against
  accidental cross-process injection, not a credential. The server binds
  loopback only.
- The renderer is CPU-budgeted: bounded frame rate, DPR cap, no filters, no CDN,
  no runtime network fetches (model assets are served from the local host).
