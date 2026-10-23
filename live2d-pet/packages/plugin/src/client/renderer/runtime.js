/**
 * runtime.js — access to the vendored Live2D/PIXI runtime.
 *
 * The renderer intentionally does NOT `import` pixi.js / pixi-live2d-display:
 * both are shipped as classic UMD/global builds in `vendor/`, inline-injected
 * into the client bundle (`build-client.mjs`) or loaded with <script> in the
 * proto. This keeps the esbuild pipeline trivial (no npm resolution at build
 * time, no runtime CDN) and makes the proto and the shipped bundle use the
 * exact same vendor files.
 *
 * Expected globals (installed by vendor/pixi.min.js and
 * vendor/pixi-live2d-display.min.js):
 *   globalThis.PIXI            — pixi.js 7 global build (contains all exports)
 *   globalThis.PIXI.live2d     — pixi-live2d-display UMD global branch
 *   globalThis.Live2DCubismCore — Cubism 4 core (vendor/live2dcubismcore.min.js)
 *   globalThis.live2d          — Cubism 2 core (vendor/live2d.min.js, optional)
 */

function scope() {
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof window !== 'undefined') return window;
  if (typeof self !== 'undefined') return self;
  return {};
}

/** Returns the PIXI namespace object or undefined (never throws). */
export function getPIXI() {
  const g = scope();
  return g.PIXI;
}

/** Returns the pixi-live2d-display namespace (PIXI.live2d) or undefined. */
export function getLive2D() {
  const g = scope();
  return g.PIXI && g.PIXI.live2d;
}

/**
 * Throws a descriptive error when the vendor runtime is missing.
 * @returns {{PIXI:object, Live2D:object}}
 */
export function getRuntime() {
  const g = scope();
  const PIXI = g.PIXI;
  const Live2D = PIXI && PIXI.live2d;
  if (!PIXI) {
    throw new Error(
      '[live2d] PIXI runtime missing: load vendor/pixi.min.js before creating the stage'
    );
  }
  if (!Live2D) {
    throw new Error(
      '[live2d] pixi-live2d-display missing: load vendor/pixi-live2d-display.min.js after pixi.min.js'
    );
  }
  return { PIXI, Live2D };
}

/** Cubism 4 core namespace (Live2DCubismCore) or null. */
export function getCubism4Core() {
  return scope().Live2DCubismCore || null;
}

/** Cubism 2 core (window.live2d, installed by vendor/live2d.min.js) or null. */
export function getCubism2Core() {
  const g = scope();
  return g.live2d || g.Live2D || null;
}

/**
 * Status of the runtime, useful for logs/README/acceptance.
 * @returns {{pixi:boolean, live2d:boolean, cubism4Core:boolean, cubism2Core:boolean,
 *            pixiVersion:(string|null), live2dVersion:(string|null)}}
 */
export function runtimeStatus() {
  const g = scope();
  const PIXI = g.PIXI;
  const Live2D = PIXI && PIXI.live2d;
  return {
    pixi: !!PIXI,
    live2d: !!Live2D,
    cubism4Core: !!g.Live2DCubismCore,
    cubism2Core: !!(g.live2d || g.Live2D),
    pixiVersion: (PIXI && PIXI.VERSION) || null,
    live2dVersion: (Live2D && Live2D.version) || null,
  };
}

/**
 * Makes sure the core required by `format` is available *before* loading a
 * model, so we can fail with a clear message instead of pixi-live2d-display's
 * generic "Failed to start up Cubism 4 framework".
 * @param {'cubism2'|'cubism4'} format
 */
export function ensureCore(format) {
  if (format === 'cubism4') {
    if (!getCubism4Core()) {
      throw new Error(
        '[live2d] Cubism 4 core missing: load vendor/live2dcubismcore.min.js before Cubism 4 models'
      );
    }
    return 'cubism4';
  }
  if (format === 'cubism2') {
    if (!getCubism2Core()) {
      throw new Error(
        '[live2d] Cubism 2 core missing: load vendor/live2d.min.js before Cubism 2 models'
      );
    }
    return 'cubism2';
  }
  return format;
}

/** True when running inside a real DOM (browser / Electron renderer). */
export function hasDOM() {
  return typeof document !== 'undefined' && typeof window !== 'undefined';
}
