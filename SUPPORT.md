# Support

Thanks for using **GHOST Community Edition**. This is a community, single-maintainer
project — support is best-effort, without a guaranteed response time.

## Before opening an issue

1. Read the docs:
   - [README.en.md](README.en.md) — what the three components are and how to start (English).
   - [README.md](README.md) — 中文说明与快速安装指南。
   - [docs/INSTALL.md](docs/INSTALL.md) / [docs/INSTALL.zh-CN.md](docs/INSTALL.zh-CN.md) — build, install, verify, uninstall, troubleshooting pointers.
   - [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, protocols, trust boundaries.
   - [voice-plugin/README.md](voice-plugin/README.md), [tts-bridge/docs/TTS-BRIDGE.md](tts-bridge/docs/TTS-BRIDGE.md), [live2d-pet/docs/README.md](live2d-pet/docs/README.md) — per-component references.
2. Check the [CHANGELOG](CHANGELOG.md) for recent changes.
3. Search existing issues to avoid duplicates.

## Where to ask

| Kind | Where |
| --- | --- |
| Bug report | Open a GitHub issue using the **Bug report** form. Include OS version, DSH version, Node/Python versions, the failing command and sanitized logs. |
| Feature request | Open a GitHub issue using the **Feature request** form. Explain the use case and the expected behavior. |
| Setup / usage question | Open a GitHub issue with the **question** label; include what you already tried. |
| Security vulnerability | **Do not open a public issue.** Follow [SECURITY.md](SECURITY.md) and use GitHub private vulnerability reporting. |

## What to include

- What you expected vs. what happened.
- Exact commands and their output (remove tokens, usernames, local paths and room IDs).
- Where it fails: install step, `/live2d` command, `tts` call, bridge, or renderer/window.
- Never attach: Live2D models, VoxCPM weights, reference voice audio, a `tts.config.yml` containing credentials, model files or personal data.

## Scope

Support covers the three components in this repository. User-supplied assets
(Live2D models, VoxCPM 1.5 weights, reference voices) and DSH itself are outside
this project's support scope; licensing questions about those assets are for their
owners.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go to
[SECURITY.md](SECURITY.md) instead of public issues.
