## Summary

<!-- What does this pull request change, and why? Link the issue it fixes. -->

Fixes #

## Type of change

- [ ] Bug fix
- [ ] New feature or enhancement
- [ ] Documentation / translation
- [ ] Build, tooling or CI
- [ ] Refactor (no behaviour change)
- [ ] Other (describe below)

## Scope

- Affected component(s): `live2d-pet/` / `tts-bridge/` / `voice-plugin/` / `docs/` / `scripts/` / `.github/`
- Compatibility notes (DSH plugin contract, config or model format changes):

## Testing

<!-- List the exact commands you ran and their results. State anything you could not run. -->

```text
node --test live2d-pet/tests/test_sse_backpressure.mjs live2d-pet/tests/test_window_singleton.mjs
python -m compileall -q voice-plugin/python live2d-pet/packages/plugin/python
```

## Checklist

- [ ] I have read `CONTRIBUTING.md` and agree to the `CODE_OF_CONDUCT.md`.
- [ ] Every commit is signed off (`git commit -s`, DCO).
- [ ] No generated or proprietary artifacts are included: Live2D models/textures,
      Live2D Cubism Core, VoxCPM weights, reference voices/audio, `lib/client.js`,
      `lib/window.js`, `node_modules/`, `data/`, logs or screenshots.
- [ ] No secrets, tokens, local absolute paths or personal information are included.
- [ ] Documentation was updated where behaviour changed (including the Chinese docs
      where they exist), and `CHANGELOG.md` `[Unreleased]` mentions user-visible changes.
- [ ] New third-party code/assets have their license and `NOTICE` attribution added.
- [ ] The change keeps the local-first design: no telemetry, no accounts, no cloud TTS,
      loopback-only services, no runtime CDN/network fetches.
- [ ] CI (offline syntax checks, `node:test` suites, Python byte-compilation) is expected
      to pass on this branch.
