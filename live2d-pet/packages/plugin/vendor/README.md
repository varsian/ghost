# vendor/ — third-party runtime (offline, no CDN at runtime)

The renderer needs a small set of browser runtimes, loaded in a strict order by
`build-client.mjs` (inlined inside the generated `lib/client.js` /
`lib/window.js`). Files marked *fetched* are proprietary Live2D software and are
**never committed**.

| File | Version | License | Source | Committed? |
| --- | --- | --- | --- | --- |
| `pixi.min.js` | pixi.js **7.4.3** (WebGL global build) | MIT | npm `pixi.js@7.4.3` → `dist/pixi.min.js` | yes |
| `pixi-live2d-display.min.js` | pixi-live2d-display **0.5.0-beta** (all-in-one UMD: Cubism 2 + 4) | MIT | npm `pixi-live2d-display@0.5.0-beta` → `dist/index.min.js` | yes |
| `live2dcubismcore.min.js` | Live2D **Cubism 4 Core** | Live2D Proprietary Software License Agreement | official `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` | **no — fetched** |
| `live2d.min.js` | Live2D **Cubism 2 Core** (legacy `*.model.json` models; inlined by `build-client.mjs`) | Live2D Proprietary Software License Agreement | community mirror `dylanNew/live2d` via jsDelivr (documented in the original project) | **no — fetched** |
| `soullink/dsh-live2d-adapter.js` | Soullink Emotion SDK DSH adapter, IIFE (patched, see below) | Apache-2.0 | built from `third_party/soullink-emotion-sdk/` | yes |
| `soullink/patch-adapter.mjs` | applies the two minimal DSH patches to the adapter | — | maintained here | yes |
| `soullink/LICENSE-soullink-sdk.txt` | Apache-2.0 text for the adapter | — | — | yes |
| `LICENSE-pixi.js.txt`, `LICENSE-pixi-live2d-display.txt`, `LICENSE-live2d-core.txt` | license texts/notes | — | — | yes |
| `vendor.lock.json` | committed SHA-256 pin for the fetched/committed runtime artifacts | — | generated/maintained by `scripts/fetch-vendor.mjs` | yes |
| `manifest.json` | generated provenance of the last fetch | — | `scripts/fetch-vendor.mjs` | no (gitignored) |

## Fetching the proprietary cores (EULA gate)

Both Cubism cores are **not** part of the repository and must not be committed.
From the repository root:

```bash
node scripts/fetch-vendor.mjs --accept-live2d-eula
```

The script:

1. verifies the committed MIT files against `vendor.lock.json`;
2. downloads the official Cubism 4 Core and the legacy Cubism 2 Core (only with
   `--accept-live2d-eula` or `DSH_LIVE2D_ACCEPT_EULA=1`);
3. verifies their pinned SHA-256 values and writes a generated `manifest.json`;
4. refuses and changes nothing without the EULA flag.

`build-client.mjs` inlines both cores, which keeps Cubism 2 model support. Cubism 4
(`.model3.json` / `.moc3`) models do not load the Cubism 2 core at runtime, but the
bundle contains it; if you want a Cubism-4-only build, remove the
`live2d.min.js`/`live2dcubismcore` steps from `build-client.mjs` (see
`docs/LICENSING.md` first — both files are proprietary either way).

Read the license first:

- <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
- <https://www.live2d.com/en/download/cubism-sdk/release-license/>

## Load order (hard requirement)

```
pixi.min.js                    -> window.PIXI
live2d.min.js                  -> window.Live2D            (Cubism 2, legacy models only)
live2dcubismcore.min.js        -> window.Live2DCubismCore  (Cubism 4)
pixi-live2d-display.min.js     -> PIXI.live2d
soullink/dsh-live2d-adapter.js -> window.DSHLive2DAdapter
```

`build-client.mjs` inlines these in exactly this order; the window page loads the
resulting self-contained bundle.

## Soullink adapter

The adapter is a build of `third_party/soullink-emotion-sdk/packages/dsh-live2d-adapter`
produced by `scripts/build-iife-dsh.mjs`. The committed copy carries two patches
applied by `soullink/patch-adapter.mjs` (idempotent; the original SHA-256 is
recorded in the file header):

1. `antialias:!0` → `antialias:!1` — DSH renders a small transparent canvas; MSAA
   is not wanted by default.
2. fixed RAF fps → `window.__DSH_LIVE2D_FPS__ || config.fps` — lets the wrapper
   throttle idle/recovering rendering for CPU savings.

Rebuild flow (after editing adapter sources):

```bash
cd third_party/soullink-emotion-sdk/packages/dsh-live2d-adapter
node scripts/build-iife-dsh.mjs                       # -> dist/dsh-live2d-adapter.js
cp dist/dsh-live2d-adapter.js ../../../../live2d-pet/packages/plugin/vendor/soullink/dsh-live2d-adapter.js
cd ../../../../live2d-pet/packages/plugin
node vendor/soullink/patch-adapter.mjs                # re-apply DSH patches
node build-client.mjs && node build-client.mjs --window
```
