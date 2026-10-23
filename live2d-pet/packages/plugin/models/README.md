# models/ — default model root (currently empty)

No Live2D model is shipped with this repository. This directory is the plugin's
default `modelsDir` (empty config value), so an empty directory is expected.

Add one directory per model here — see
[`../../../models/README.md`](../../../models/README.md) for the required layout,
the scanner rules and the licensing requirements (the short version: only models
you are allowed to use, and never commit model binaries to this repo; the
`.gitignore` excludes them).

Example:

```
live2d-pet/packages/plugin/models/<model-id>/
  <model-id>.model3.json
  <model-id>.moc3
  <model-id>.2048/texture_00.png
```

Then run `/live2d reload` and `/live2d model <model-id>` (or set `defaultModel`
in the bundle patch).
