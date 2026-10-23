# Models — bring your own (no binaries shipped)

This directory intentionally contains **no model binaries**. The repository ships
no Live2D model: models are separately licensed assets and are not part of this
source snapshot.

## Where to put a model

Create one directory per model:

```
models/
  <model-id>/
    <model-id>.model3.json           # Cubism 4 entry file (or .model.json for Cubism 2)
    <model-id>.moc3                  # Cubism 4 model data
    <model-id>.2048/texture_00.png   # textures
    <model-id>.physics3.json         # optional
    <model-id>.cdi3.json             # optional
    *.exp3.json                      # optional expressions (file name = expression name)
    motions/*.motion3.json           # optional motions
    live2d.manifest.json             # optional: { "hiddenParts": [...], "name": "..." }
    soullink.profile.json            # optional: generated parameter mapping
```

Then pick it with `/live2d model <model-id>` (the catalog rescans on
`/live2d reload`).

## Which directory is scanned

The plugin row config field `modelsDir` decides:

- empty (default) → `<live2d-pet>/packages/plugin/models/` (a placeholder README
  lives there; put the model next to it if you want zero configuration);
- any absolute path → that directory (for example this `live2d-pet/models/`
  directory).

## Licensing requirements

Only place a model here if you have the right to use it. Most Live2D models come
with their own terms (personal use only, no redistribution, credit required,
commercial use restrictions, etc.). Keep the author's license/readme file in the
model directory and:

- do **not** commit the model to this repository (`**/models/*` is gitignored
  except `README.md`, and `*.moc3` / `*.model3.json` / textures are ignored);
- do **not** redistribute the model through the repository or installed builds;
- check the Live2D Cubism SDK Release License if you ship a product that renders
  models with the proprietary Cubism Core.

Textures (`*.png`), motions (`*.motion3.json`), expressions (`*.exp3.json`) and
model data (`*.moc3`) are all covered by the gitignore patterns.

## Transparency / hidden parts

The renderer keeps the canvas fully transparent. If a model contains built-in
desk/background props, list the parts to hide in `live2d.manifest.json`:

```json
{ "name": "My model", "hiddenParts": ["Part109", "Part110"] }
```

The automatic `soullink.profile.json` generator (`profile-generator`) can derive
a parameter profile for arbitrary models; see `live2d-pet/docs/README.md`
(Chinese) for details.
