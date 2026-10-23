// Browser shim used ONLY by the IIFE bundle (`dist/dsh-live2d-adapter.js`).
//
// The DSH client plugin already vendors `pixi.min.js` and
// `pixi-live2d-display.min.js` (both UMD builds, see
// `packages/plugin/vendor/`). The IIFE adapter bundle therefore resolves
// `pixi.js` to the already-loaded `window.PIXI` global instead of bundling a
// second copy of PIXI (~456 KB).
//
// Script order required by the IIFE bundle:
//   1. pixi.min.js            -> window.PIXI
//   2. pixi-live2d-display.min.js -> window.PIXI.live2d
//   3. live2dcubismcore.min.js    -> window.Live2DCubismCore (or loaded lazily by config.coreUrl)
//   4. dsh-live2d-adapter.js  -> window.DSHLive2DAdapter
const globalScope = globalThis as unknown as {
  PIXI?: {
    Application?: unknown;
    Ticker?: unknown;
    utils?: unknown;
    [key: string]: unknown;
  };
};

const PIXI = globalScope.PIXI;

if (!PIXI) {
  throw new Error(
    "[dsh-live2d-adapter] global PIXI is missing. Load pixi.min.js before the adapter IIFE bundle."
  );
}

export const Application = PIXI.Application;
export const Ticker = PIXI.Ticker;
export const utils = PIXI.utils;
export default PIXI;
