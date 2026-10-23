// Browser shim used ONLY by the IIFE bundle (`dist/dsh-live2d-adapter.js`).
//
// `pixi-live2d-display.min.js` (UMD, already vendored by the DSH plugin)
// registers its public classes on `window.PIXI.live2d`. The renderer's
// `import("pixi-live2d-display/cubism4")` is aliased to this module so the IIFE
// bundle contains no bare import specifiers and no second copy of the library.
const globalScope = globalThis as unknown as {
  PIXI?: {
    live2d?: {
      Live2DModel?: unknown;
      Cubism4InternalModel?: unknown;
      [key: string]: unknown;
    };
  };
};

const live2d = globalScope.PIXI?.live2d;

if (!live2d) {
  throw new Error(
    "[dsh-live2d-adapter] window.PIXI.live2d is missing. Load pixi-live2d-display.min.js after pixi.min.js."
  );
}

export const Live2DModel = live2d.Live2DModel;
export const Cubism4InternalModel = live2d.Cubism4InternalModel;
export const live2dNamespace = live2d;
export default live2d;
