# Licensing

This repository is the **GHOST Community Edition** source snapshot. The root
license is Apache-2.0 (see [`../LICENSE`](../LICENSE)). That license covers the original code
and documentation in this snapshot, but it does **not** override the licenses of
third-party components, and it cannot grant rights to Live2D's proprietary
runtime or to user-supplied models and voices.

## 1. Root license — Apache-2.0

- `LICENSE` — Apache License 2.0, full text.
- `NOTICE` — attribution summary for the bundled third-party components.
- Every `package.json` of this repository's own code declares
  `"license": "Apache-2.0"`, with one deliberate exception: `voice-plugin/` is a
  snapshot of the upstream `@deepseek-ai/dsh-tool-tts` artifact and **keeps its
  upstream MIT license** (`voice-plugin/package.json` declares `"license": "MIT"`).
  It is not relicensed here.
- The repository consolidates three previously local plugin projects; keep the
  Apache-2.0 header/NOTICE when redistributing derived work (and the MIT notice
  for the voice-plugin snapshot).

## 2. Live2D Cubism Core — proprietary, NOT redistributed

The Live2D Cubism Core (`live2dcubismcore.min.js`, Cubism 4; and the legacy
Cubism 2 `live2d.min.js`) is **not** part of this repository:

- the files are in `.gitignore`;
- they are downloaded only by `scripts/fetch-vendor.mjs` after the explicit
  `--accept-live2d-eula` flag;
- the expected SHA-256 of each artifact is pinned in
  `live2d-pet/packages/plugin/vendor/vendor.lock.json` (an integrity pin, not a
  redistribution);
- the browser bundles (`lib/client.js`, `lib/window.js`) that inline the cores are
  build outputs and are also gitignored.

Live2D license documents (read before accepting):

- Live2D Proprietary Software License Agreement:
  <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
  (also available in Japanese and Chinese on the same site)
- Cubism SDK Release License (needed for shipping an application that embeds the
  SDK, depending on your revenue/scale):
  <https://www.live2d.com/en/download/cubism-sdk/release-license/>
- Live2D Open Software License (for the open parts of the Cubism SDK):
  <https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html>

The plugin's original `vendor/README.md` (updated in this snapshot) keeps the
download sources and license links next to the files.

**If you are not entitled to use the Cubism SDK, do not run the fetch step and do
not distribute the built bundles.** The host half and the Python bridge code still
work conceptually, but there is no renderer runtime without the core.

## 3. Models and textures

No Live2D model files are shipped (`*.moc3`, `*.model3.json`, textures, motions,
expressions). Models are separately licensed by their authors; some are free for
personal use only, some forbid redistribution. Place only models you have the
right to use in `live2d-pet/models/` (gitignored) and keep the author's license
file next to the model. The original project docs referenced a test model that is
**not** included here for that reason.

## 4. Voice reference audio and cloned voices

No voice/audio files are shipped. The TTS engine clones a voice from a reference
recording supplied via `voicesDir`. You are responsible for having consent and the
necessary rights to use any voice/reference audio you supply; do not commit
recordings of other people to this repository (`*.wav`/`*.mp3` are gitignored by
default).

## 5. Third-party components included in the snapshot

| Component | License | Where | Notes |
| --- | --- | --- | --- |
| Soullink Emotion SDK (subset) | Apache-2.0 | `third_party/soullink-emotion-sdk/`, `live2d-pet/packages/plugin/vendor/soullink/` | Adapter sources + built IIFE used by the renderer; LICENSE included. |
| pixi.js 7.4.3 | MIT | `live2d-pet/packages/plugin/vendor/pixi.min.js` | `LICENSE-pixi.js.txt`. |
| pixi-live2d-display 0.5.0-beta | MIT | `live2d-pet/packages/plugin/vendor/pixi-live2d-display.min.js` | all-in-one UMD build; `LICENSE-pixi-live2d-display.txt`. |
| Electron (dependency) | MIT | `live2d-pet/tools/live2d-window/package.json` | Not committed; `npm install` fetches it. Chromium is covered by Electron's bundled notices. |
| VoxCPM 1.5 model code | upstream licenses | referenced by `voice-plugin/python/` | Model **weights** are not shipped; check the model card before downloading/using. |
| `@deepseek-ai/dsh-tool-tts` snapshot (`voice-plugin/`) | MIT (upstream; NOT relicensed) | `voice-plugin/` | Plugin artifact snapshot; keeps its upstream MIT license and notice. |
| Python runtime dependencies | upstream licenses | `voice-plugin/python/requirements.txt` | Installed locally, not vendored. |

`NOTICE` contains the per-component attribution lines; the license texts for the
bundled artifacts are kept next to the files (and mirrored in
`third_party/soullink-emotion-sdk/licenses/`).

## 6. What this snapshot deliberately excludes

To keep the repository cleanly licensed and small, the snapshot contains **no**:

- Live2D Cubism Core files (proprietary; fetched separately);
- prebuilt browser bundles that inline the cores (build products);
- Live2D model binaries/textures, user `user-models/`, reference voices/audio;
- `node_modules`, Python caches, logs, runtime `data/`, test artifacts;
- acceptance screenshots/videos or other local evidence;
- local absolute paths, secrets, tokens or personal information.

See `.gitignore` for the enforced patterns.

## 7. About the GHOST name

This repository **is** the open-source GHOST stack: local Live2D × VoxCPM
digital-human plugins for DeepSeek Harness. It is not the earlier standalone
GHOST engine project; that engine remains a separate, local-only project and is
not included here.
