// Build the DSH Live2D adapter IIFE without npm-installing the SDK workspace.
//
// The vendored bundle in live2d-pet/packages/plugin/vendor/soullink is produced
// from this package, so changes to src/stage.ts must be rebuilt here and copied
// over.
//
// Usage (from this directory):
//   node scripts/build-iife-dsh.mjs [--out <file>]
//
// esbuild is resolved from ESBUILD_MAIN, a local/ancestor node_modules pnpm
// store (no extra install); pixi.js / pixi-live2d-display are aliased to the
// local shims, exactly like scripts/build.mjs does for the published bundle.
//
// NOTE: this snapshot ships the adapter sources, the built dist and this script,
// but not the full Soullink workspace node_modules. Rebuilding therefore needs
// `@soullink-emotion/*` to be resolvable (e.g. by installing the dependencies of
// third_party/soullink-emotion-sdk in a workspace), otherwise esbuild fails on
// the imports with a clear "could not resolve" error.
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "src", "index.ts");
const shimDir = path.join(root, "src", "vendor");
const outArgIndex = process.argv.indexOf("--out");
const outfile = outArgIndex > -1
  ? path.resolve(process.argv[outArgIndex + 1])
  : path.join(root, "dist", "dsh-live2d-adapter.js");

function findEsbuild() {
  const candidates = [];
  if (process.env.ESBUILD_MAIN) candidates.push(process.env.ESBUILD_MAIN);
  const pnpmDirs = [];
  // Walk up from the adapter package looking for a pnpm store (workspace install).
  let dir = root;
  for (let i = 0; i < 7; i++) {
    pnpmDirs.push(path.join(dir, "node_modules", ".pnpm"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const dir of pnpmDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith("esbuild@")) candidates.push(path.join(dir, name, "node_modules", "esbuild", "lib", "main.js"));
      }
    } catch { /* ignore */ }
  }
  for (const candidate of candidates.reverse()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`esbuild not found (tried ${candidates.length} candidates); set ESBUILD_MAIN`);
}

const esbuildMain = findEsbuild();
const mod = await import(pathToFileURL(esbuildMain).href);
const esbuild = mod.build ? mod : mod.default;

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  target: ["es2020"],
  charset: "utf8",
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
  format: "iife",
  globalName: "DSHLive2DAdapter",
  minify: true,
  alias: {
    "pixi.js": path.join(shimDir, "pixi-shim.ts"),
    "pixi-live2d-display/cubism4": path.join(shimDir, "live2d-shim.ts"),
    "pixi-live2d-display": path.join(shimDir, "live2d-shim.ts")
  }
});

const bytes = fs.readFileSync(outfile);
const sha = createHash("sha256").update(bytes).digest("hex");
const warn = result.warnings ?? [];
console.log(`[adapter:iife] wrote ${outfile}`);
console.log(`[adapter:iife] ${bytes.length} bytes, sha256 ${sha}`);
if (warn.length) console.log(`[adapter:iife] ${warn.length} warning(s)`);
