# Changelog

All notable changes to **GHOST Community Edition** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The project is 0.x: while the version is `0.x`, minor releases may contain breaking
changes; see [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

## [0.1.0] - 2026-10-22

First release of the community edition: a local-first, Windows-first Live2D
digital-human stack for DeepSeek Harness, published as a three-component source
snapshot under Apache-2.0.

### Added

- **Three cooperating components**: `live2d-pet/` (DSH bundle + plugin + standalone
  transparent Electron window), `tts-bridge/` (DSH bundle + Python mirror shim),
  and `voice-plugin/` (snapshot of the upstream `@deepseek-ai/dsh-tool-tts`
  0.1.5-rc.2 plugin with the VoxCPM 1.5 Python engine, kept under its upstream MIT
  license).
- **One reference voice per install**: `voicesDir` is a folder holding exactly one reference clip plus its same-stem transcript; emotion names are labels carried on the protocol events for expressions, not separate voices.
- **Real-playback lip sync**: the mouth follows a ~20 ms RMS envelope computed from
  the PCM actually handed to the audio device, not from text length or a fixed
  animation; segment emotions become Live2D expressions, and emotion blends, idle
  motion, speech sway and loudness-peak gestures are driven from the same event
  stream.
- **Playback-latency alignment**: the shim reports the measured output latency and
  the renderer delays the envelope so lip movement matches the audible sound.
- **Local loopback host** (default `127.0.0.1:34567`) with `GET /health`,
  `GET /events` (SSE), `GET /models`, `GET /model`, `GET /assets/<path>`,
  `POST /ingest`, `POST /command`, `GET /window` and `GET /lib/window.js`.
  Model assets are path-traversal guarded, SSE backpressure drops a renderer that
  stops draining instead of growing an unbounded queue, and `/ingest` requires the
  documented loopback token.
- **Independent bundle switching**: the pet bundle and the TTS bridge bundle can be
  enabled or disabled separately from the DSH Plugins page; turning the bridge off
  returns TTS to its native daemon without manual rollback.
- **Presentation modes** `window` (default), `overlay`, `both` and `none`; the
  standalone Electron window launcher has single-instance locking, stale-state
  recovery and duplicate-window cleanup (`/live2d window dedupe`).
- **Windows-first installer tooling** under `live2d-pet/tools/`: `install.ps1`,
  `uninstall.ps1`, `verify-install.ps1`, `dev-start.ps1` and
  `bridge-daemon-wrapper.ps1`, rendering `<PLUGIN_DIR>`, `<PYTHON>`, `<VOICES_DIR>`,
  `<MODELS_DIR>` and `<CACHE_DIR>` placeholders so no machine-local path is hard-coded.
- **Build and runtime-fetch scripts**: `scripts/fetch-vendor.mjs` (EULA-gated
  download of the proprietary Live2D Cubism Core, SHA-256 verification against
  `live2d-pet/packages/plugin/vendor/vendor.lock.json`) and `scripts/build-all.mjs`
  (builds the browser halves with esbuild).
- **Documentation**: README, `docs/ARCHITECTURE.md`, `docs/INSTALL.md` (English),
  `docs/INSTALL.zh-CN.md` (Chinese), `docs/LICENSING.md`, component docs under
  `live2d-pet/docs/`, `tts-bridge/docs/TTS-BRIDGE.md`, `voice-plugin/README.md`,
  `voice-plugin/INSTALL.md` and `live2d-pet/models/README.md`.
- **Tests**: `node:test` suites for envelope alignment, shim protocol, SSE
  backpressure and window singleton/dedupe behaviour, plus Python tests for the shim
  and the TTS engine; a minimal offline CI workflow runs the JS syntax checks, the
  SSE-backpressure and window-singleton suites, and Python byte-compilation.
- **Community-edition packaging**: Apache-2.0 `LICENSE` with a third-party `NOTICE`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/RELEASING.md`,
  issue forms, a pull-request template, `.editorconfig` and `.gitignore`.

### Security

- The stack has no telemetry, no accounts and no cloud TTS; all services are bound
  to loopback and the renderer makes no runtime network fetches.
- The source snapshot contains no local absolute paths, secrets or personal
  information; `.gitignore` excludes runtime data, logs, model binaries, Cubism Core
  files, voices and VoxCPM weights.
- The proprietary Live2D Cubism Core is not redistributed: it is fetched only after
  the Live2D EULA is accepted and every fetched runtime artifact is verified against
  a committed SHA-256 pin. See [docs/LICENSING.md](docs/LICENSING.md).
- `voice-plugin/` keeps its upstream MIT license and attribution; bundled MIT and
  Apache-2.0 components are attributed in `NOTICE`.

### Notes

- Supported and tested on Windows 10/11 with PowerShell 7. Linux and macOS are
  untested. No dates or compatibility promises are made.
- Live2D models and textures, Live2D Cubism Core, VoxCPM 1.5 weights, reference
  voices/audio, Electron and `node_modules` are not shipped; see
  [README.en.md](README.en.md#what-is-not-shipped).
