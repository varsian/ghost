#!/usr/bin/env node
/**
 * build-all.mjs — build the browser halves of the Live2D pet, with preflight.
 *
 * The repository commits the *host* half (`packages/plugin/lib/index.js`) but not
 * the browser halves, because those inline the proprietary Live2D Cubism cores:
 *
 *   live2d-pet/packages/plugin/lib/client.js   (DSH client loader bundle)
 *   live2d-pet/packages/plugin/lib/window.js   (standalone window bundle)
 *
 * Steps:
 *   1. verify the vendor runtime against vendor.lock.json (delegates to
 *      scripts/fetch-vendor.mjs; it refuses while the proprietary core is absent);
 *   2. run packages/plugin/build-client.mjs (default DSH client bundle);
 *   3. run packages/plugin/build-client.mjs --window (standalone window);
 *   4. run static checks over the repository source (JSON parse + node --check).
 *
 * Usage (from the repository root):
 *   node scripts/build-all.mjs              # vendor check + both builds + checks
 *   node scripts/build-all.mjs --check-only # no build; verify + static checks
 *   node scripts/build-all.mjs --no-checks  # skip the static checks
 *   node scripts/build-all.mjs --help
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PLUGIN = join(ROOT, 'live2d-pet', 'packages', 'plugin');
const VENDOR = join(PLUGIN, 'vendor');
const LOCK = join(VENDOR, 'vendor.lock.json');
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);

function log(message) {
  process.stdout.write(`[build-all] ${message}\n`);
}
function fail(message) {
  process.stderr.write(`[build-all] ERROR: ${message}\n`);
  process.exitCode = 1;
}
function rel(path) {
  return relative(ROOT, path).replaceAll('\\', '/');
}

function printUsage() {
  process.stdout.write(`DSH Live2D build helper

Usage (from the repository root):
  node scripts/build-all.mjs               vendor check + client/window builds + static checks
  node scripts/build-all.mjs --check-only  vendor + static checks only (no build)
  node scripts/build-all.mjs --no-checks   skip static checks
  node scripts/build-all.mjs --help

Requires: node >= 20, esbuild resolvable (node_modules or ESBUILD_MAIN), and the
proprietary vendor cores fetched via:
  node scripts/fetch-vendor.mjs --accept-live2d-eula
`);
}

function checkVendor() {
  if (!existsSync(LOCK)) {
    fail(`vendor lock missing: ${rel(LOCK)}`);
    return false;
  }
  const required = ['pixi.min.js', 'pixi-live2d-display.min.js', 'live2dcubismcore.min.js', 'live2d.min.js'];
  const missing = required.filter((name) => !existsSync(join(VENDOR, name)));
  if (missing.length > 0) {
    fail(
      `vendor runtime incomplete (missing: ${missing.join(', ')}).\n` +
        '  The MIT files are committed; the proprietary Live2D Cubism cores must be fetched\n' +
        '  after accepting the EULA:\n' +
        '    node scripts/fetch-vendor.mjs --accept-live2d-eula'
    );
    return false;
  }
  // Verify hashes through fetch-vendor's --verify-only path: running it without
  // the EULA flag is fine because the core is already present.
  const result = spawnSync(process.execPath, [join(HERE, 'fetch-vendor.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`vendor integrity check failed:\n${(result.stderr || result.stdout || '').trim()}`);
    return false;
  }
  log('vendor runtime present and SHA-256 verified against vendor.lock.json');
  return true;
}

function runBuild(extraArgs) {
  const builder = join(PLUGIN, 'build-client.mjs');
  if (!existsSync(builder)) {
    fail(`missing ${rel(builder)}`);
    return false;
  }
  const args = [builder, ...extraArgs];
  log(`running: node ${args.map(rel).join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    fail(`build failed (${extraArgs.join(' ') || 'client'}).\n` +
      '  If the error mentions esbuild: install it (e.g. `npm i -D esbuild`) somewhere on the\n' +
      '  path from live2d-pet/packages/plugin upwards, or set ESBUILD_MAIN to its lib/main.js.');
    return false;
  }
  return true;
}

/** Static checks: JSON parse + `node --check` for tracked plain JS/MJS. */
function staticChecks() {
  let failed = false;

  const walk = (dir, onFile) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__pycache__' || name.startsWith('.')) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path, onFile);
      else onFile(path);
    }
  };

  walk(ROOT, (path) => {
    const ext = extname(path);
    if (ext === '.json') {
      try {
        JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        failed = true;
        fail(`invalid JSON: ${rel(path)} — ${error.message}`);
      }
    }
    if ((ext === '.js' || ext === '.mjs') && !/\.min\.js$/.test(path) && !path.split(/[\\/]/).includes('vendor')) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) {
        failed = true;
        fail(`syntax error: ${rel(path)}\n${(result.stderr || '').trim()}`);
      }
    }
  });

  if (!failed) log('static checks passed (JSON parse + node --check)');
  return !failed;
}

function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }
  if (!checkVendor()) return;

  if (!hasFlag('--check-only')) {
    if (!runBuild([])) return;
    if (!runBuild(['--window'])) return;
    log(`built ${rel(join(PLUGIN, 'lib', 'client.js'))} and ${rel(join(PLUGIN, 'lib', 'window.js'))}`);
  }

  if (!hasFlag('--no-checks')) {
    if (!staticChecks()) return;
  }
  log('done');
}

main();
