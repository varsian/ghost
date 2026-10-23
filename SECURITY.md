# Security Policy

GHOST Community Edition is a local-first Live2D digital-human stack for DeepSeek
Harness (DSH). This policy covers the source in this repository: the Live2D pet
(`live2d-pet/`), the TTS playback bridge (`tts-bridge/`), and the voice-plugin
snapshot (`voice-plugin/`).

## Supported versions

This is a 0.x preview project; only the current Community Edition release line is
supported with security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x (current) | Yes |
| < 0.1 | No — upgrade to a current 0.1.x release |
| Forks and modified copies | No — report to the fork maintainer |

There is no long-term-support branch. Fixes land on `main` and in the next release;
see [docs/RELEASING.md](docs/RELEASING.md).

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security
problem.**

- Preferred: use **GitHub private vulnerability reporting** on this repository
  (*Security* tab → *Report a vulnerability*). This opens a private advisory visible
  only to the maintainers.
- If private reporting is not available in your environment, contact the maintainers
  at **`<maintainer-contact>`** with the same information.

Please include:

- the affected component and version/commit;
- your OS, Node.js and Python versions;
- a minimal reproduction or proof of concept, and the impact you believe it has;
- whether the issue is already public elsewhere.

Do not include live secrets, other people's data, proprietary Live2D model files,
voice recordings or VoxCPM weights in the report; a description or redacted log is
enough. We will work with you on a minimal test case if one is needed.

## What to expect

This is a single-maintainer, best-effort project. We aim to acknowledge a private
report within **7 days**, confirm or reject it, and agree on a disclosure timeline.
We ask for **up to 90 days** before public disclosure so a fix and release can be
prepared; shorter timelines are possible for issues that are already public or being
exploited. We will credit reporters in the advisory/release notes unless you ask to
stay anonymous.

Please give us a reasonable chance to fix the issue before publishing details. We
will not take legal action against good-faith research that respects this policy,
other users' privacy and the availability of their systems.

## Threat model and security properties

GHOST is designed to run entirely on the user's machine. The security-relevant
properties, and the limits of each, are:

### 1. Loopback-only HTTP + SSE service

- The Live2D host half serves the renderer and receives TTS events on
  `127.0.0.1:34567` by default. It is not designed to be reachable from a network,
  and there is no authentication layer beyond a loopback guard.
- `POST /ingest` requires the fixed `X-Live2D-Token` value (`dsh-live2d-local`). That
  token is a **loopback anti-confusion guard, not a credential**: it keeps unrelated
  local processes from injecting fake speech events, but any local process running as
  the same user can read it or the plugin configuration.
- Do not bind the service to `0.0.0.0`, forward the port, or tunnel it. If you change
  `port` in `live2d-pet/packages/bundle/cordis.patch.yml`, keep the loopback bind.
- The model asset endpoint serves files from the configured model root only and is
  guarded against path traversal; keep models in a directory you control and never
  point `modelsDir` at a world-writable share.
- The renderer issues no runtime network fetches: model assets come from the local
  host, and there is no CDN use.

### 2. Untrusted Live2D models

Anyone can supply a Live2D model directory (`*.moc3`, `*.model3.json`, textures,
motions, expressions). The renderer parses it with the bundled MIT runtimes
(pixi.js, pixi-live2d-display) and the proprietary Live2D Cubism Core; model files
are data, not a sandboxed plugin format. A malformed or malicious model can crash or
freeze the renderer and can consume significant memory/GPU. **Only load models you
have obtained from a source you trust and are licensed to use.** Do not load models
from untrusted downloads on a machine where that matters.

### 3. Local Python daemon in the TTS bridge

- The bridge points the `tts` tool's `daemonScript` at
  `live2d-pet/packages/plugin/python/live2d_tts_shim.py`, which executes the real
  `tts_daemon.py` in the same process and tees the actual playback PCM envelope and
  emotion timeline to the plugin.
- That daemon runs with **your user permissions** and can read the files that user
  can read, including reference voices and model weights.
- The shim reads a sidecar JSON written by the installer to find the real daemon
  path. That sidecar, the workspace `tts.config.yml`, and the plugin's `data/`
  directory are trusted local configuration: anyone who can write them can make the
  TTS tool run a different Python script. Protect them accordingly (normal user
  profile permissions are sufficient; do not place them in a world-writable
  directory).
- The installer modifies your DSH profile `package.json` and the workspace
  `tts.config.yml` (keeping `*.lead-backup` copies). Review the diff if you run the
  installer against a profile that contains other customizations.

### 4. Voice cloning, recordings and third-party assets

No Live2D models, voices, reference audio or VoxCPM weights are distributed with
this repository. You are responsible for having the consent and rights to use any
reference voice you supply, and for the license of any model or weights you load.
Reference audio and cloned-voice data stay on your machine; the project sends
nothing to a cloud service.

### 5. No telemetry, no accounts, no cloud TTS

The shipped stack does not collect telemetry, does not create accounts, and does not
call a cloud TTS service. Network access happens only when **you** initiate it:
fetching the EULA-gated runtime with `scripts/fetch-vendor.mjs`, installing npm
dependencies, installing Python requirements, or downloading your own models and
weights.

### 6. Proprietary Live2D Cubism Core is not redistributed

`live2dcubismcore.min.js` and the legacy `live2d.min.js` are proprietary Live2D Inc.
software. They are not part of this repository:

- the files are gitignored and are downloaded only after the user passes
  `--accept-live2d-eula` to `scripts/fetch-vendor.mjs`;
- every downloaded artifact is checked against a committed SHA-256 pin in
  `live2d-pet/packages/plugin/vendor/vendor.lock.json`;
- shipping an application that embeds the core may require the Live2D Cubism SDK
  Release License. See [docs/LICENSING.md](docs/LICENSING.md).

If you are not entitled to use the Cubism SDK, do not fetch the cores and do not
distribute the built browser bundles (`lib/client.js`, `lib/window.js`), which
inline them.

### 7. Supply chain

- The committed MIT vendor runtimes (`pixi.min.js`, `pixi-live2d-display.min.js`) are
  integrity-pinned in `live2d-pet/packages/plugin/vendor/vendor.lock.json` and
  verified by `scripts/fetch-vendor.mjs`; the built Soullink adapter is committed
  next to its Apache-2.0 license under `vendor/soullink/`.
- `voice-plugin/` is a snapshot of the upstream `@deepseek-ai/dsh-tool-tts` artifact
  (MIT); its Python dependencies are installed from upstream package indexes and are
  not vendored here.
- The standalone window's Electron dependency is installed locally with `npm install`
  and is not committed.
- CI runs with `permissions: contents: read` and uses no repository secrets; it does
  not download EULA-gated files or model weights.

## Out of scope

The following are generally not handled as vulnerabilities in this repository:

- License/compliance questions about Live2D or model/voice assets — see
  [docs/LICENSING.md](docs/LICENSING.md) instead.
- Vulnerabilities in third-party components (Electron, Live2D Cubism Core, pixi.js,
  VoxCPM) that are not caused by how this project integrates them — report those
  upstream; tell us if this repository ships a vulnerable version or unsafe
  integration.
- Attacks that require an already-compromised local account, administrator rights, or
  the ability to write files the user owns.
- Vulnerabilities in DeepSeek Harness itself — report those to the DSH project.

## Security-related configuration checklist

- Keep the HTTP service bound to `127.0.0.1`; never expose port 34567 (or a
  reconfigured port) to a network.
- If you change `ingestToken`, change it in both the plugin config and the bridge
  sidecar/patch consistently; understand it is not a credential.
- Run DSH, the plugins and the Python engine with a normal user account, not
  administrator/root.
- Load only licensed Live2D models and only reference voices you have consent to use.
- Keep Node.js, Python, Electron and the Python packages up to date; use a virtual
  environment or dedicated Python installation for the TTS engine.
- Only run the installer against a DSH profile you control and inspect the
  `*.lead-backup` files if you need to roll back.
