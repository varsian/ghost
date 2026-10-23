#!/usr/bin/env node
/**
 * patch-adapter.mjs — apply the two *minimal, documented* patches to the
 * vendored Soullink DSH adapter IIFE (`dsh-live2d-adapter.js`).
 *
 * The adapter is built from
 * `third_party/soullink-emotion-sdk/packages/dsh-live2d-adapter`; the committed
 * copy is shipped with the patches below already applied.
 *
 * The two DSH-specific rendering knobs patched here:
 *
 *   1. `antialias:!0` -> `antialias:!1`
 *      MSAA is hardcoded on in Live2DRenderer's PIXI Application; the renderer
 *      must run without antialias by default (small canvas, CPU/GPU budget).
 *
 *   2. `let y=1e3/i;` -> `let y=1e3/(window.__DSH_LIVE2D_FPS__||i);`
 *      The adapter's own RAF loop uses a fixed fps; this lets the DSH wrapper
 *      lower it to ~12 fps when the character is idle/recovering (CPU saving)
 *      by setting `window.__DSH_LIVE2D_FPS__` (undefined/full fps when talking).
 *
 * The script is idempotent (re-running is a no-op) and records the original
 * SHA-256 in the file header. All occurrences are asserted to be unique.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'dsh-live2d-adapter.js');
const MARKER = '__DSH_LIVE2D_FPS__';

const PATCHES = [
  { from: 'antialias:!0', to: 'antialias:!1', label: 'antialias off by default' },
  {
    from: 'let y=1e3/i;',
    to: 'let y=1e3/(window.__DSH_LIVE2D_FPS__||i);',
    label: 'dynamic fps override (idle fps)',
  },
];

const source = readFileSync(FILE, 'utf8');
const hasFpsOverride = source.includes(MARKER);
const hasAntialiasOff = source.includes('antialias:!1');
if (hasFpsOverride && hasAntialiasOff) {
  console.log('[patch-adapter] already patched, nothing to do');
  process.exit(0);
}
// Newer adapter sources already implement the __DSH_LIVE2D_FPS__ override in
// stage.ts; only the antialias knob still needs the post-build patch then.
const applicable = PATCHES.filter((patch) => {
  if (patch.from === 'antialias:!0') return !hasAntialiasOff;
  return !hasFpsOverride;
});
const originalHash = createHash('sha256').update(source).digest('hex');
let patched = source;
for (const patch of applicable) {
  const count = patched.split(patch.from).length - 1;
  if (count !== 1) {
    console.error(
      `[patch-adapter] FAILED: expected exactly 1 occurrence of ${JSON.stringify(patch.from)}, found ${count}`
    );
    process.exit(1);
  }
  patched = patched.replace(patch.from, patch.to);
  console.log(`[patch-adapter] ${patch.label}`);
}
const header = `/* PATCHED by live2d-pet/packages/plugin/vendor/soullink/patch-adapter.mjs
 *   original sha256: ${originalHash}
 *   patches: antialias:!0 -> :!1 ; RAF loop fps = window.__DSH_LIVE2D_FPS__ || config.fps
 * Rebuild-from-source: third_party/soullink-emotion-sdk/packages/dsh-live2d-adapter (do not re-patch twice)
 */\n`;
writeFileSync(FILE, header + patched);
console.log(`[patch-adapter] patched ${FILE}`);
console.log(`[patch-adapter] original sha256 ${originalHash}`);
