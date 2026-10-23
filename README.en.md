[简体中文](README.md)

# GHOST — Community Edition

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Community Edition](https://img.shields.io/badge/edition-Community-5B8DEF)
![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**A local, realtime Live2D digital human for DeepSeek Harness (DSH) — the lips are driven
by the VoxCPM 1.5 speech you actually hear.**

This is the **Community Edition** of GHOST: a local-first, Apache-2.0 source snapshot. It
runs one reference voice at a time; bring your own licensed Live2D model, the VoxCPM 1.5
weights and one reference voice clip with its transcript.

GHOST is a local-first stack of three cooperating DSH plugins. Everything runs on your own
machine: no cloud TTS, no accounts, no telemetry, no capture hardware. The mouth follows the
RMS envelope of the PCM that was actually handed to the audio device — not text-length
heuristics, not a fixed animation — and emotion labels become expressions, idle motion and
speaking gestures.

> Invited by **Bilibili Live** to test-broadcast in its new **AI Application & Robotics** category — [why that matters](#recognition).

[Highlights](#highlights) · [Recognition](#recognition) · [Features](#features) · [Quick start](#quick-start) · [Documentation](#documentation)

## Highlights

| Highlight | What it gives you |
| --- | --- |
| **Real-PCM lip sync** | The mouth follows the RMS envelope of the audio actually played, aligned with measured output latency — not a text-length guess. |
| **Fully local** | VoxCPM 1.5 TTS and Live2D rendering run on your machine: no cloud TTS, accounts or telemetry. |
| **Emotion-aware Live2D** | Emotion labels drive expression blends, idle motion, breathing and speech gestures. |
| **Modular DSH bundles** | The pet and the TTS bridge switch independently; turning the bridge off restores native TTS. |

## Recognition

![Bilibili Live invitation](https://img.shields.io/badge/Bilibili%20Live-official%20invitation-00A1D6)
![Test broadcast](https://img.shields.io/badge/test%20broadcast-473K%20viewers-00A1D6)
![Net followers](https://img.shields.io/badge/net%20followers-%2B928%20%C2%B7%20top%201%25-ff69b4)

**Invited by Bilibili Live.** In October 2026 the Bilibili Live team invited the
GHOST maintainer to test-broadcast in its newly launched **AI Application & Robotics**
(AI 应用-机器人) live category, as an AI virtual streamer built on this stack.

**First public test broadcast** — Bilibili creator dashboard, 7-day window ending
2026-10-21:

| Metric | Result |
| --- | --- |
| Cumulative viewers, single test broadcast | **473,000+** |
| Net new followers | **+928** |
| New followers vs. same-tier streamers | **Top 1%** — 1,255 new followers, above 99% of peers |
| Streamed in the 7-day window | **14.2 h** |

*Creator-reported platform metrics from one test broadcast; they show real-world
use, not a benchmark or a promise of results. No account, room or contact details
are included.*

## Edition scope

This Community Edition contains exactly three components — the Live2D pet
(`live2d-pet/`), the TTS playback bridge (`tts-bridge/`) and the VoxCPM 1.5 TTS
plugin snapshot (`voice-plugin/`). Nothing else is bundled: no extra plugin packs,
no other TTS engines, no model weights or voice samples.

| # | Directory | Project | What it is |
|---|-----------|---------|------------|
| 1 | [`live2d-pet/`](live2d-pet/) | Live2D desktop pet | A DSH bundle + plugin that renders any Live2D model in a transparent, always-on-top-style desktop window (or as an in-GUI overlay) and drives it from the TTS playback envelope, emotions and text. |
| 2 | [`tts-bridge/`](tts-bridge/) | TTS playback bridge | A separate, independently switchable DSH bundle that points the `tts` tool's `daemonScript` at a mirror shim. The shim **is** the real TTS daemon (executed in-process) and tees the actual playback PCM envelope + emotion timeline to the pet. |
| 3 | [`voice-plugin/`](voice-plugin/) | Voice plugin (VoxCPM 1.5) | The standalone `@deepseek-ai/dsh-tool-tts` plugin artifact (Node plugin + Python VoxCPM 1.5 engine) that the bridge wraps. Included so the stack is reproducible without the upstream monorepo. |

Everything here is a **source snapshot**: no model binaries, no Live2D Cubism Core binaries,
no VoxCPM weights, no reference voice audio, no `node_modules`, no logs or local data.

## 💼 License and commercial use

> **Free for personal use.** For commercial editions or commercial features, contact
> the author for a license. Features that the Community Edition does not include are
> listed below.
>
> **Counterfeit notice:** if you find an identical repackaged product being sold, it is
> pirated — please stop and report it promptly.

| Item | Community Edition (open source) | Commercial Edition |
| --- | --- | --- |
| Personal use | ✅ Free | Per commercial agreement |
| Commercial features | ❌ Not included | ✅ Included |
| Live-stream high-end TTS | ❌ Not included | ✅ Included |
| Additional advanced plugins | ❌ Not included | ✅ Included |
| Commercial licensing | CE code under Apache-2.0 | ✅ Contact the author for a commercial license |
| Support | Community issues / docs | Author support |
| Customization & deployment | Self-service | Negotiable |
| Updates | Follow open-source releases | Commercial release updates |

> Note: the CE source code is licensed under **Apache-2.0**. The "Commercial Edition"
> above refers to the author's separate commercial distribution, advanced features and
> commercial support; it does not add restrictions to the CE source code. Contact the
> author's authorized channel for commercial features or support.

## How the three parts connect

```
 DSH agent calls the `tts` tool
        │
        ▼
 @deepseek-ai/dsh-tool-tts  (voice-plugin/)            ← TTS plugin + Python VoxCPM 1.5 daemon
        │  daemonScript override, inserted by
        │  @local/dsh-live2d-tts-bridge  (tts-bridge/)
        ▼
 live2d_tts_shim.py  (live2d-pet/packages/plugin/python/)
        │  · runs the real tts_daemon.py in the same process (byte-for-byte relay)
        │  · tees the real speaker PCM → ~20 ms RMS envelope
        │  · tees segment emotions / sentence timeline / output latency
        ▼  HTTP POST 127.0.0.1:34567/ingest  (loopback, non-secret token)
 Live2D plugin host half  (live2d-pet/packages/plugin/lib/index.js, Node)
        │  SSE /events
        ▼
 Live2D plugin browser half  (pixi.js + pixi-live2d-display + Soullink adapter)
        │
        ├─ standalone transparent Electron window  (live2d-pet/tools/live2d-window/)
        └─ in-GUI overlay that renders the model on top of the DSH Web GUI
```

The two DSH bundles are independent: switch the pet bundle off and the avatar disappears;
switch the bridge bundle off and TTS returns to its native daemon. The pet alone still does
idle animation, model switching and `/live2d` commands.

## Features

**Live2D** (`live2d-pet/`)

- Renders any properly licensed Live2D Cubism 4 model in a transparent,
  always-on-top-style desktop window or as an in-GUI overlay.
- Lip sync is driven by a ~20 ms RMS envelope of the PCM actually handed to the
  audio device, with measured output latency applied so the mouth matches the
  sound you hear.
- Emotion labels from the TTS stream become expressions (native exp3 + VAD blend),
  plus idle motion, breathing and speech gestures.
- `/live2d` commands cover status, on/off, model switching, window management and
  reload; the loopback-only host guards model asset paths and drops SSE clients
  that stop draining instead of growing an unbounded queue.

**TTS** (`voice-plugin/` + `tts-bridge/`)

- The model-facing `tts` tool speaks through a local VoxCPM 1.5 daemon — no cloud
  calls, no accounts.
- One reference voice per install (a clip plus its transcript); emotion names are
  labels on the event stream, not separate voices.
- Streaming sentence-by-sentence generation and playback; the tool returns before
  playback finishes and reports a frame ledger (`early`, `remainingMs`, frames) so
  the agent can keep working while the audio plays.
- Cancel, unload and daemon caching are supported; the daemon reloads
  configuration on the next call without restarting the app.
- Enabling the bridge bundle makes the shim relay the real daemon byte-for-byte
  and tee envelope/emotion/latency to the Live2D pet; disabling it restores the
  native TTS path.

## Requirements

- **Windows 10/11** with PowerShell 7 (`pwsh`). The installer and window launcher are
  Windows-first; the plugin code itself is portable.
- **Node.js ≥ 20** (provides `npm`/`npx`) and **esbuild** resolvable (install it in a
  `node_modules` above `live2d-pet/packages/plugin`, or set `ESBUILD_MAIN`).
- **Python 3.10+** for the TTS engine; a CUDA-capable GPU is recommended (VoxCPM 1.5 runs on
  CUDA). Voice cloning needs one reference voice clip plus its transcript text file.
- **DeepSeek Harness** desktop app or a dev instance (`DSH_HOME`), because these are DSH
  profile bundles / plugin rows.
- **Your own licensed Live2D Cubism 4 model**, **VoxCPM 1.5 weights** and **a reference voice**
  (one audio clip plus its transcript).
  None of them are shipped here.
- For the standalone window: `npm install` inside `live2d-pet/tools/live2d-window`
  (downloads Electron, ~250 MB, not committed).

## Quick start

```powershell
# 1) Fetch the proprietary runtime once (read the Live2D EULA first).
node scripts/fetch-vendor.mjs --accept-live2d-eula

# 2) Build the browser bundles (they inline the proprietary cores; not committed).
node scripts/build-all.mjs

# 3) Install the pet + bridge into a DSH profile.
./live2d-pet/tools/install.ps1 `
    -ProfileDir '<DSH_PROFILE>' `
    -PythonPath '<PYTHON>' `
    -VoicesDir '<VOICES_DIR>' `
    -ModelDir '<MODELS_DIR>' `
    -CacheDir '<CACHE_DIR>'

# 4) Check the install.
./live2d-pet/tools/verify-install.ps1 -ProfileDir '<DSH_PROFILE>'
# expect: RESULT: OK — both Live2D bundles are installed in this profile.
```

The installer creates `node_modules/@local/...` junctions in the profile, appends the two
bundles to `dsh.profile.bundles`, renders the bridge patch placeholders
(`<PLUGIN_DIR>`, `<PYTHON>`, `<VOICES_DIR>`, `<MODELS_DIR>`, `<CACHE_DIR>`), writes the TTS
shim sidecar config and points the workspace `tts.config.yml` at the shim. A running desktop
profile recomposes via HMR; restart the app only if it does not.

Say something with the `tts` tool and the character's mouth follows the audio.
`/live2d status`, `/live2d on|off`, `/live2d model <id>`, `/live2d window <...>` are
available in the GUI command plane.

If the target DSH release does not already provide `@deepseek-ai/dsh-tool-tts`, install the
bundled snapshot: see [`voice-plugin/INSTALL.md`](voice-plugin/INSTALL.md). Most desktop
installs ship it already (inside the voice bundle), so this step is optional.

## Repository layout

```
README.md  README.en.md  LICENSE  NOTICE  .gitignore  .editorconfig
SUPPORT.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md
.github/                CI workflow + issue/PR templates
docs/
  ARCHITECTURE.md      components, protocols, data flow
  INSTALL.md           prerequisites, build, install, verify, uninstall
  INSTALL.zh-CN.md     same in Chinese (installation mechanism + full flow)
  LICENSING.md         license boundaries for every bundled/unbundled artifact
live2d-pet/            project 1 — Live2D desktop pet
  packages/bundle/     @local/dsh-live2d-bundle (profile bundle layer)
  packages/plugin/     @local/dsh-live2d (host + browser halves, TTS shim, vendor)
  tools/live2d-window/ Electron launcher for the transparent window
  tools/*.ps1          install / uninstall / verify / dev helpers
  tests/               node:test + Python shim tests
  docs/                original project docs (design, install, renderer, incidents)
  models/README.md     how to add your own licensed Live2D model
tts-bridge/            project 2 — TTS playback bridge
  bundle/              @local/dsh-live2d-tts-bridge (tool-tts row override)
  docs/TTS-BRIDGE.md   shim protocol, latency alignment, acceptance notes
voice-plugin/          project 3 — VoxCPM 1.5 TTS plugin snapshot
  package.json  lib/   Node plugin (published-style build output)
  python/              TTS engine (daemon, ttslib, tests, requirements)
  README.md  INSTALL.md
third_party/soullink-emotion-sdk/   Apache-2.0 subset (adapter sources + built dist)
scripts/
  fetch-vendor.mjs     EULA-gated Cubism Core fetch + SHA-256 verification
  build-all.mjs        vendor check + client bundle build helper
```

## What is **not** shipped

- **Live2D model binaries and textures** (`*.moc3`, `*.model3.json`, texture PNGs). Drop a
  properly licensed model into `live2d-pet/models/` (or point `modelsDir` at it). See
  [`live2d-pet/models/README.md`](live2d-pet/models/README.md).
- **Live2D Cubism Core** (`live2dcubismcore.min.js`, legacy `live2d.min.js`). Proprietary;
  fetched by [`scripts/fetch-vendor.mjs`](scripts/fetch-vendor.mjs) after the EULA gate and
  gitignored.
- **VoxCPM 1.5 weights** and the **reference voice**. Model weights and the reference voice
  are user-supplied; point `modelDir` / `voicesDir` at them (the voice folder holds exactly one
  `<name>.wav` plus a same-stem `<name>.txt` transcript). No audio is included.
- **Prebuilt browser bundles** (`lib/client.js`, `lib/window.js`): they inline the
  proprietary cores, so they are build products (step 2 above).
- `node_modules/`, `data/` directories, logs, screenshots, local evidence files and test
  cache; `user-models/`.

## License boundaries (short version)

- **This stack** (root, `live2d-pet/`, `tts-bridge/`, `docs/`, `scripts/`): Apache-2.0 (see
  [LICENSE](LICENSE) and [NOTICE](NOTICE)). `voice-plugin/` keeps its upstream MIT license;
  `third_party/` keeps the upstream Apache-2.0 license.
- **Live2D Cubism Core**: proprietary Live2D Inc. software, *not* part of this repository;
  fetched only after the Live2D Proprietary Software License Agreement. Shipping an
  application that embeds it may also require the Live2D Cubism SDK Release License. See
  [docs/LICENSING.md](docs/LICENSING.md).
- **Live2D models / voice reference audio / VoxCPM weights**: whoever owns them; the
  repository grants no rights to those files and ships none.
- **Soullink Emotion SDK**: Apache-2.0 subset in `third_party/`.
- **pixi.js / pixi-live2d-display**: MIT.
- **voice-plugin/** is a snapshot of the upstream `@deepseek-ai/dsh-tool-tts` plugin artifact
  (0.1.5-rc.2) and **keeps its upstream MIT license**; it is not relicensed to Apache-2.0.
  The VoxCPM 1.5 model code/weights carry their own upstream licenses.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, event protocols, build pipeline.
- [docs/INSTALL.md](docs/INSTALL.md) — build + install into a DSH profile.
- [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) — 中文安装指南：DSH 插件安装机制 + 完整安装/验证/卸载流程.
- [docs/LICENSING.md](docs/LICENSING.md) — per-artifact license boundaries.
- [live2d-pet/docs/README.md](live2d-pet/docs/README.md) — full `/live2d` command and
  configuration reference (Chinese).
- [tts-bridge/docs/TTS-BRIDGE.md](tts-bridge/docs/TTS-BRIDGE.md) — shim design/protocol/acceptance notes (Chinese).
- [voice-plugin/README.md](voice-plugin/README.md) — the VoxCPM 1.5 TTS plugin reference.
- [README.md](README.md) — 中文说明与快速安装指南。
- [SUPPORT.md](SUPPORT.md) — where to ask, what to include, and support scope.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to report bugs, propose changes and open pull requests.
- [SECURITY.md](SECURITY.md) — threat model and private vulnerability reporting.
- [CHANGELOG.md](CHANGELOG.md) — release history.
- [docs/RELEASING.md](docs/RELEASING.md) — the release process.

## Status

Early-stage, single-maintainer **Community Edition** snapshot. Windows is the tested
platform; Linux/macOS are untested. The DSH plugin API and the VoxCPM integration may
evolve. No dates or compatibility promises are made here.
