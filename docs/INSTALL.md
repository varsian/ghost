# Install

This is the packaged layout of the GHOST **Community Edition** DSH plugin stack. The
installer, launcher and window are Windows/PowerShell first; the plugin code
itself is portable.

## 0. Placeholder convention

Paths in configs, docs and scripts use placeholders instead of the original
developer machine paths. Replace them when installing:

| Placeholder | Meaning |
| --- | --- |
| `<PLUGIN_DIR>` | Absolute path of the **`live2d-pet/`** directory in this repo (rendered automatically by `install.ps1`). |
| `<PYTHON>` | Python interpreter that runs the TTS daemon (e.g. a virtualenv with `voice-plugin/python/requirements.txt`). Pass with `-PythonPath`. |
| `<VOICES_DIR>` | Folder containing the single reference voice: one audio file (`<name>.wav`) plus a same-stem `<name>.txt` transcript. Pass with `-VoicesDir`. |
| `<DSH_PROFILE>` | DSH profile directory that contains `package.json` (desktop app: `%USERPROFILE%\.dsh\profiles\desktop`; dev: `$env:DSH_HOME\profiles\web`). |
| `<DSH_HOME>` | `DSH_HOME` directory for a dev instance. |
| `<DSH_INSTANCE>` | A released/installed DSH application directory (for the voice-plugin install path). |
| `<VOICE_PLUGIN_ROOT>` | Absolute path of this repo's `voice-plugin/` directory. |
| `<MODELS_DIR>` | VoxCPM 1.5 model directory (weights, config and tokenizer files). |
| `<CACHE_DIR>` | Daemon cache directory (transcripts, default WAV output). |

## 1. Prerequisites

- Windows 10/11 with PowerShell 7 (`pwsh`).
- Node.js >= 20 (also provides `npm`/`npx`).
- esbuild resolvable: either install it into a `node_modules` on the path from
  `live2d-pet/packages/plugin` upwards, or set `ESBUILD_MAIN` to
  `.../esbuild/lib/main.js`.
- Python 3.10+ for the TTS engine (a CUDA GPU is recommended but not required for
  non-TTS parts).
- For the standalone window: `npm install` inside `live2d-pet/tools/live2d-window`
  (downloads Electron; not committed).

## 2. Fetch the proprietary runtime (one-time)

Read the Live2D license first and only proceed if it applies to you:

- <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- <https://www.live2d.com/en/download/cubism-sdk/release-license/>

```powershell
# from the repository root
node scripts/fetch-vendor.mjs --accept-live2d-eula
```

The script verifies the committed MIT runtimes (`pixi.min.js`,
`pixi-live2d-display.min.js`) against `live2d-pet/packages/plugin/vendor/vendor.lock.json`
and downloads the proprietary Cubism Core file(s) into the same directory. The
core files are gitignored: never commit them. Without the flag the script refuses
with an explanation and changes nothing.

## 3. Build the browser bundles

The committed `lib/index.js` is the host half. The browser halves are build
outputs and are not committed because they inline the proprietary cores:

```powershell
# from the repository root
node scripts/build-all.mjs
```

This produces `live2d-pet/packages/plugin/lib/client.js` and `lib/window.js`
(+ source maps). Use `node live2d-pet/packages/plugin/build-client.mjs` directly
for a single target.

## 4. Install the Live2D pet into a DSH profile

1. Check the bridge patch placeholders:
   `tts-bridge/bundle/cordis.patch.yml` contains `<PYTHON>`, `<VOICES_DIR>`,
   `<MODELS_DIR>` and `<CACHE_DIR>`. Pass all four to the installer (it renders
   them, plus `<PLUGIN_DIR>`, in place):

   ```powershell
   ./live2d-pet/tools/install.ps1 `
       -ProfileDir '<DSH_PROFILE>' `
       -PythonPath '<PYTHON>' `
       -VoicesDir '<VOICES_DIR>' `
       -ModelDir '<MODELS_DIR>' `
       -CacheDir '<CACHE_DIR>'
   ```

2. The installer:
   - creates junctions `node_modules/@local/dsh-live2d[-bundle|-tts-bridge]`
     in the profile pointing at `live2d-pet/packages/{bundle,plugin,bundle-tts-bridge}`;
   - adds the corresponding `link:` dependencies to the profile `package.json`
     and appends both bundles to `dsh.profile.bundles` (backup:
     `package.json.lead-backup`);
   - writes `live2d-pet/packages/plugin/python/live2d_tts_shim.json` with the
     resolved real daemon path, ingest URL/token, enabled-file path and lip-sync
     tuning;
   - rewrites `daemonScript` in the workspace `tts.config.yml` (if present) to
     the shim and keeps a `*.lead-backup` for uninstall.

3. A running DSH profile with HMR recomposes when the ordered bundle list
   changes; the Plugins page then shows two independent entries
   (**Live2D 桌宠** and **Live2D × TTS 联动桥**). Restart the desktop app only if
   HMR does not recompose.

4. If the window was not opened automatically, `/live2d on` opens it.
   To use the in-GUI overlay instead: `/live2d overlay on` (or set `mode` in
   `live2d-pet/packages/bundle/cordis.patch.yml`).

## 5. Voice plugin (optional)

Only needed if the target DSH installation does not already provide
`@deepseek-ai/dsh-tool-tts`. The snapshot is an artifact install (not a profile
bundle): follow the packaged instructions in
[`voice-plugin/INSTALL.md`](../voice-plugin/INSTALL.md), which mirror the upstream
install path with `<DSH_INSTANCE>` / `<DSH_HOME>` / `<VOICE_PLUGIN_ROOT>`
placeholders. Then set `pythonPath`, `voicesDir`, `modelDir` and `cacheDir` in the
`tool-tts` row (or in the workspace `tts.config.yml`).

The Python engine needs its dependencies:

```powershell
<PYTHON> -m pip install -r voice-plugin/python/requirements.txt
```

Models are not shipped; download the VoxCPM 1.5 weights separately (the
`OpenSound/VoxCPM1.5` checkpoint or a local mirror) and point `modelDir` at the
directory that contains its weights, config and tokenizer files.

## 6. Verify

```powershell
# static checks (from repository root)
node --check live2d-pet/packages/plugin/lib/index.js
node --check live2d-pet/packages/plugin/build-client.mjs
python -m py_compile live2d-pet/packages/plugin/python/live2d_tts_shim.py
python -m py_compile voice-plugin/python/tts_daemon.py

# install sanity (read-only)
./live2d-pet/tools/verify-install.ps1 -ProfileDir '<DSH_PROFILE>'

# live status after the app is running
Invoke-RestMethod http://127.0.0.1:34567/health
```

Expected: `RESULT: OK — both Live2D bundles are installed in this profile.` and a
`/health` payload with `plugin: "live2d"`. Then speak with the `tts` tool and
check that `/live2d status` reports bridge traffic and the pet's mouth follows the
audio.

## 7. Uninstall / rollback

```powershell
./live2d-pet/tools/uninstall.ps1 -ProfileDir '<DSH_PROFILE>'
```

Removes both bundles from the profile list and the `@local/*` junctions; by
default dependency entries stay (inert). `-RemoveDependencies` / `-RestoreBackup`
are available. The workspace `tts.config.yml` is restored from `*.lead-backup`.
Turning off only the bridge bundle restores native TTS while keeping the pet.

## Troubleshooting pointers

- Pet window missing: `/live2d window status`; launcher log under the plugin
  `data/` dir; `LIVE2D_WINDOW_GPU=1` if software WebGL misbehaves.
- Lips not moving but TTS audible: the daemon may still be the stock one. Check
  that the running python command line contains `live2d_tts_shim.py`, and that
  the workspace `tts.config.yml` `daemonScript` points at the shim.
- Port conflict: change `port` in `live2d-pet/packages/bundle/cordis.patch.yml`
  and re-install/recompose.
- More detail: `live2d-pet/docs/README.md` (commands/config) and
  `tts-bridge/docs/TTS-BRIDGE.md` (shim protocol/limits), both in Chinese.
