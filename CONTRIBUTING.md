# Contributing to GHOST Community Edition

Thanks for your interest in **GHOST Community Edition** — a local-first Live2D
digital-human stack for DeepSeek Harness (DSH). This document explains how to report
problems, propose changes, and what to expect from the review process.

GHOST Community Edition is an early-stage, maintainer-led project. Contributions of
any size are welcome: bug reports, documentation fixes, translations and focused
pull requests.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report
unacceptable behaviour to the maintainers via the contact listed there.

## Reporting bugs and requesting features

- **Bugs and feature requests**: open an issue with the matching template —
  [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or
  [feature request](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Security issues**: do **not** open a public issue. Follow
  [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting.
- Before filing, search existing issues and read the docs:
  [docs/INSTALL.md](docs/INSTALL.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/LICENSING.md](docs/LICENSING.md), and the component docs listed in
  [README.en.md](README.en.md#documentation).

A good bug report includes:

- the component (`live2d-pet/`, `tts-bridge/`, `voice-plugin/`, `docs/` or `scripts/`);
- OS version, DSH version, Node.js version and Python version;
- what you expected, what happened, and the smallest steps that reproduce it;
- relevant logs with **local paths, tokens and personal data redacted**.

**Never attach proprietary Live2D model files, voice/reference audio, VoxCPM
weights, or API keys/secrets to an issue.** See
[docs/LICENSING.md](docs/LICENSING.md) for why those assets are not part of this
repository.

## Development setup

Windows 10/11 is the tested platform; the plugin code itself is portable, but the
installer, window launcher and helper scripts are PowerShell/Windows-first.
Linux and macOS are currently untested.

Prerequisites:

- Windows 10/11 with PowerShell 7 (`pwsh`).
- Node.js >= 20 (provides `npm`/`npx`), plus esbuild resolvable when building the
  browser halves.
- Python 3.10+ for the TTS engine (a CUDA-capable GPU is recommended for
  VoxCPM 1.5).
- Your own licensed Live2D Cubism 4 model, VoxCPM 1.5 weights and reference voices —
  none of them are shipped here.

Steps:

1. Fork the repository and clone your fork to a short local path.
2. Read [docs/INSTALL.md](docs/INSTALL.md) end to end first.
3. Fetch the proprietary runtime **only after reading the Live2D EULA**:
   `node scripts/fetch-vendor.mjs --accept-live2d-eula`.
4. Build the browser halves: `node scripts/build-all.mjs` (writes
   `live2d-pet/packages/plugin/lib/client.js` and `lib/window.js`; build outputs,
   never commit them).
5. For the standalone transparent window: `npm install` inside
   `live2d-pet/tools/live2d-window` (downloads Electron, ~250 MB, not committed).
6. Install into a DSH profile with `live2d-pet/tools/install.ps1`, then check the
   result with `live2d-pet/tools/verify-install.ps1`. Prefer a disposable dev
   instance (`DSH_HOME` + `live2d-pet/tools/dev-start.ps1`) over your desktop
   profile while developing.

## Checks to run before opening a pull request

These are the same offline checks CI runs; no network access is needed:

```powershell
# 1) Syntax-check every hand-written JS/ESM file (vendor *.min.js excluded).
Get-ChildItem -Recurse -File -Include *.js, *.mjs |
    Where-Object { $_.Name -notlike '*.min.js' -and $_.FullName -notmatch '\\node_modules\\' } |
    ForEach-Object { node --check $_.FullName }

# 2) Offline node:test suites (SSE backpressure + window singleton behaviour).
node --test live2d-pet/tests/test_sse_backpressure.mjs live2d-pet/tests/test_window_singleton.mjs

# 3) Byte-compile the Python engine and the bridge shim.
python -m compileall -q voice-plugin/python live2d-pet/packages/plugin/python
```

Some tests need extra setup and are **not** part of CI yet:
`live2d-pet/tests/test_envelope.mjs`, `live2d-pet/tests/test_shim_bridge.mjs`,
`live2d-pet/tests/test_shim.py` and the `voice-plugin/python/tests/` suite (they
need a built client bundle, a Python environment with the engine dependencies, or
platform-specific pieces). Run them when your change touches those areas and say in
the pull request what you ran and what passed.

If you changed documentation, check that the relative Markdown links you touched
still resolve.

## Coding style

- Match the surrounding code. `.editorconfig` is authoritative: 2-space indent for
  JS/JSON/YAML, 4-space for Python and PowerShell, UTF-8, LF line endings (CRLF for
  `.ps1`/`.bat`/`.cmd`), final newline.
- Use modern plain JavaScript (ESM, `node:` builtins). Do not add runtime
  dependencies unless the need was discussed in an issue first; this project
  deliberately stays dependency-light.
- Keep the local-first contract: no telemetry, no cloud calls in shipped runtime
  paths, loopback-only services, no CDN or runtime network fetches, no accounts.
- Do not commit generated or proprietary files: `node_modules/`, `data/`, logs,
  screenshots, Live2D models/textures, voice or reference audio, VoxCPM weights,
  Live2D Cubism Core files, or the `lib/client.js` / `lib/window.js` build outputs.
- Use placeholders such as `<DSH_PROFILE>`, `<PYTHON>`, `<VOICES_DIR>`,
  `<MODELS_DIR>` instead of machine-local absolute paths in docs, configs and code.
- Docs are kept in English and Chinese where they already exist; when you change a
  documented behaviour, update the doc that owns it ([docs/INSTALL.md](docs/INSTALL.md),
  [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md), or the component doc).
- Keep comments honest and useful; do not invent benchmarks or compatibility
  promises.

## Commit and pull-request conventions

- Commit subjects: `type(scope): summary`, imperative, lowercase summary, no
  trailing period, <= 72 characters. Types: `feat`, `fix`, `docs`, `ci`, `test`,
  `build`, `chore`, `refactor`. Scope is the component (`live2d-pet`,
  `tts-bridge`, `voice-plugin`, `docs`, `ci`) or omitted for repo-wide changes.
  Use the commit body to explain *why*.
- One logical change per pull request. Keep diffs reviewable; do not reformat
  unrelated code.
- Update [CHANGELOG.md](CHANGELOG.md) under `[Unreleased]` for user-visible changes.
- Fill in the pull-request template (summary, testing, scope). Link issues with
  `Fixes #<number>` where applicable.
- Never include generated artifacts, local absolute paths, personal information or
  secrets in a commit. CI and reviewers will flag them.
- Review is best-effort by the maintainers. Changes to the DSH plugin contract, new
  dependencies, or new third-party assets need a design discussion in an issue
  before a large pull request.

### Sign-off (DCO)

This project uses the Developer Certificate of Origin (DCO), not a CLA. Every
commit must be signed off:

```text
git commit -s -m "fix(live2d-pet): handle an empty model catalog"
```

`git commit -s` appends a `Signed-off-by: Your Name <your-email>` trailer. By
signing off you certify that you have the right to submit the contribution under
the file's license (Apache-2.0 for the project code, MIT for `voice-plugin/`).
Pseudonymous sign-off is fine as long as it identifies you; use a GitHub noreply
address if you prefer not to publish a private email. Pull requests without
sign-off will be asked to amend.

## What is out of scope

- **Bundling assets we cannot redistribute**: Live2D model binaries/textures,
  Live2D Cubism Core, VoxCPM 1.5 weights, reference voices/audio. See
  [docs/LICENSING.md](docs/LICENSING.md).
- Telemetry, accounts, cloud TTS, or always-on network calls. This is a local-first
  stack.
- Prebuilt application installers or packaged binaries — this repository is a
  source snapshot; artifacts are built locally by the user.
- A second TTS engine implementation inside `voice-plugin/`: that directory is a
  snapshot of the upstream `@deepseek-ai/dsh-tool-tts` artifact (MIT) and is kept
  as close to upstream as practical.
- Support for DSH internals beyond the plugin/build surfaces this stack already
  uses — report those upstream instead.

## Licensing of contributions

By contributing you agree that your contribution is licensed under the Apache
License 2.0 for the repository's own code and documentation (see [LICENSE](LICENSE)
and [NOTICE](NOTICE)), and under the upstream MIT license for changes inside
`voice-plugin/`. If you bring in new third-party code, add its attribution to
`NOTICE` and include the license text next to the component. See
[docs/LICENSING.md](docs/LICENSING.md) for the per-artifact boundaries.
