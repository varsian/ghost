# Installing the local `tts` plugin into a DSH release

This directory is a standalone artifact snapshot of `@deepseek-ai/dsh-tool-tts`
(version `0.1.5-rc.2`; upstream **MIT license** — see `package.json` and the
repository `NOTICE`). It carries no `workspace:` specifiers: `lib/` is the built
Node plugin, `python/` is the engine, and `package.json` depends on published
versions of the released family.

> Paths are shown as placeholders — see the repository `docs/INSTALL.md`:
> `<DSH_INSTANCE>` (installed DSH application directory), `<DSH_HOME>`,
> `<DSH_PROFILE>`, `<VOICE_PLUGIN_ROOT>` (this `voice-plugin/` directory),
> `<PYTHON>`, `<VOICES_DIR>`, `<MODELS_DIR>`, `<CACHE_DIR>`.

Keep this artifact at a stable path: the profile install links to the artifact
itself, so moving or deleting it breaks the plugin even though the profile entry
remains.

## Install into an instance

Run the steps in order. Step 2 makes the artifact's own bare imports resolvable,
and step 3 makes the preset row resolvable; a plain copy next to the instance's
other packages achieves neither (see "Why the copy alone is not sufficient").

```powershell
$instance = '<DSH_INSTANCE>'
$artifact = '<VOICE_PLUGIN_ROOT>'
$env:DSH_HOME = '<DSH_HOME>'

# 1. Keep the artifact at a stable path. Copying it into the instance is optional:
#    the profile link in step 3 points at the artifact, so that copy is not what
#    the loader resolves.

# 2. Make the artifact self-sufficient for its bare imports. The plugin's
#    lib/index.js imports @deepseek-ai/schemastery and @deepseek-ai/dsh-tools, and
#    step 3 installs a junction, so Node resolves those imports from the
#    artifact's REAL path, not from the instance tree. Without this, the preset
#    mount fails with:
#      Cannot find package '@deepseek-ai/schemastery' imported from ...\lib\index.js
New-Item -ItemType Directory -Force "$artifact\node_modules\@deepseek-ai" | Out-Null
cmd /c mklink /J "$artifact\node_modules\@deepseek-ai\schemastery" "$instance\node_modules\@deepseek-ai\schemastery"
cmd /c mklink /J "$artifact\node_modules\@deepseek-ai\dsh-tools"   "$instance\node_modules\@deepseek-ai\dsh-tools"
cmd /c mklink /J "$artifact\node_modules\@deepseek-ai\cordis"      "$instance\node_modules\@deepseek-ai\cordis"

#    Proof that the artifact now loads on its own:
node --input-type=module -e "console.log(Object.keys(await import('file:///<VOICE_PLUGIN_ROOT>/lib/index.js')).join(','))"
#    expect: Config,apply,inject,name

# 3. Register the artifact on the profile — this is the resolution path the preset
#    row uses.
node "$instance\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add $artifact
# expect: + @deepseek-ai/dsh-tool-tts link:<VOICE_PLUGIN_ROOT>
#         written into  $env:DSH_HOME\profiles\web\package.json
# expect: a junction  $env:DSH_HOME\profiles\web\node_modules\@deepseek-ai\dsh-tool-tts -> $artifact
# The CLI also warns that the package declares no `dsh.bundle`: expected and harmless
# here, because this plugin is a preset row, not a profile bundle.

# 4. Re-insert the `tool-tts` row into the instance's shipped standard preset
#    (the block below), because a release reinstall overwrites
#    node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml.

# 5. Version / link check.
node "$instance\node_modules\@deepseek-ai\dsh\lib\bin.js" --version   # expect 0.1.5-rc.2
Get-Item "$env:DSH_HOME\profiles\web\node_modules\@deepseek-ai\dsh-tool-tts" |
  Select-Object LinkType, Target                     # expect Junction -> the artifact
Get-Item "$artifact\node_modules\@deepseek-ai\schemastery" |
  Select-Object LinkType, Target                     # expect Junction -> instance package
```

### The `tool-tts` preset row

Insert this row (adjust the paths to your machine) after the tool rows in the
standard preset file:

```yaml
- id: tool-tts
  name: '@deepseek-ai/dsh-tool-tts'
  config:
    pythonPath: '<PYTHON>'
    daemonScript: '<VOICE_PLUGIN_ROOT>\python\tts_daemon.py'
    voicesDir: '<VOICES_DIR>'    # one audio file + its same-stem .txt transcript
    defaultEmotion: 默认
    modelDir: '<MODELS_DIR>'     # VoxCPM 1.5: weights + config + tokenizer
    cacheDir: '<CACHE_DIR>'
    device: 'cuda:0'
    cfgValue: 2.7
    inferenceTimesteps: 10
    preload: false
```

The exact accepted fields are defined by the plugin's `Config` schema in
`lib/index.js`; `preload`, `idleUnloadSec`, `toolTimeoutMs`, `cacheDir`, `saveDir`,
`optimize`, `normalizeText`, `cfgValue`, `inferenceTimesteps` and the
sentence-splitting fields are also available.

## Alternative: install without junctions

Instead of step 3 you can copy the artifact physically into the profile's own
module directory, where the profile module fallback already provides
`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-tools`, and `@deepseek-ai/cordis`:

```powershell
$profile = "$env:DSH_HOME\profiles\web"
Copy-Item -Recurse -Force '<VOICE_PLUGIN_ROOT>' `
  "$profile\node_modules\@deepseek-ai\dsh-tool-tts"
```

That directory is inside the preset-mount discovery base, so the row resolves
without a `link:` dependency. If a `link:` entry already exists in
`$profile\package.json`, remove it (and its junction) first so the copy is what
resolves. The trade-off is that the copy is a snapshot: re-run the `Copy-Item`
after every artifact rebuild.

## Why the copy alone is not sufficient

Copying the artifact to `<instance>\node_modules\@deepseek-ai\dsh-tool-tts` makes
a direct `import '@deepseek-ai/dsh-tool-tts'` work from the instance root, but the
component that resolves a **preset row** discovers the named plugin by walking up
from the **profile directory** (`$env:DSH_HOME\profiles\web`, the directory
holding `cordis.yml`). Only that directory and its ancestors are on that chain, so
a package that exists only in the instance install tree is invisible to the
lookup, and booting the `standard` preset fails with:

```
row "tool-tts" names a plugin that cannot be resolved: @deepseek-ai/dsh-tool-tts
```

`dsh plugin --profile web add` is the supported fix: it adds the `link:`
dependency to the profile `package.json` and creates the junction under the
profile's `node_modules\@deepseek-ai\`, which is the discovery base itself.

## The reference voice

The engine clones one reference voice, so `<VOICES_DIR>` holds exactly one audio
file — `reference.wav` for example — plus a same-stem `reference.txt` transcript
holding exactly what that recording says:

```
<VOICES_DIR>\
  reference.wav
  reference.txt
```

- One audio file only (`.wav` preferred; `.mp3`, `.flac`, `.m4a`, `.ogg` and `.opus`
  are also accepted). Zero audio files, or more than one, fail cleanly at startup with
  a message naming the folder.
- The transcript must be the same stem as the audio (case-insensitive, Unicode-NFC
  normalized, so `Reference.WAV` + `Reference.TXT` pair up). It is read as UTF-8
  (UTF-8/UTF-16 BOM aware) with a CP936 fallback.
- The transcript is required: an empty/whitespace-only file, one that cannot be
  decoded, or one longer than 2000 characters counts as missing, and the call then
  fails with `GENERATE_FAILED` naming the exact `.txt` path to write. VoxCPM clones by
  continuing the reference clip, so the clip and its exact text are both mandatory.
- Editing the transcript in place, or replacing the audio, is picked up on the next
  `tts` call (a `voices`/`reload` request forces it immediately); no DSH restart is
  needed.

`defaultEmotion` is the default emotion label (`默认`); segments without one use that label,
and a segment's `emotion` is a label forwarded on the events for the Live2D bridge — neither
changes the reference voice.

## Re-apply after reinstalling or upgrading the release

A release reinstall replaces the shipped preset file, and removing the install can
drop the profile link. Both steps are needed again:

1. `node "$instance\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add $artifact`
   (with `DSH_HOME` set). Re-create the step-2 junctions only if the artifact
   itself moved or the instance was reinstalled at a different path.
2. Re-insert the `tool-tts` preset row above.

## Notes on this artifact snapshot

- `lib/` is the built output; the upstream TypeScript sources and the full test
  suite are not included (the engine tests are under `python/tests/`).
- The plugin and engine keep their upstream licenses: the Node plugin artifact is
  **MIT**; the Python engine and the VoxCPM 1.5 model stack carry their own
  upstream licenses. Model weights are not included — download them separately and
  point `modelDir` at the VoxCPM 1.5 directory.
- For the Live2D + TTS coupling, the repository's `tts-bridge/` overrides the
  running daemon with `live2d_tts_shim.py`; see `tts-bridge/docs/TTS-BRIDGE.md`.
