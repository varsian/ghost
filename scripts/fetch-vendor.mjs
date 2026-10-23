#!/usr/bin/env node
/**
 * fetch-vendor.mjs — fetch/verify the runtime vendor bundle for the Live2D pet.
 *
 * The renderer needs four browser artifacts. Two are committed to this
 * repository (MIT), and two are proprietary and therefore NEVER committed:
 *
 *   live2d-pet/packages/plugin/vendor/
 *     pixi.min.js                        pixi.js 7.4.3 (MIT, npm)        committed
 *     pixi-live2d-display.min.js         pixi-live2d-display 0.5.0-beta  committed
 *                                        (dist/index.min.js, all-in-one)
 *     live2dcubismcore.min.js            Live2D Cubism 4 Core (PROPRIETARY) fetched
 *     live2d.min.js                      Live2D Cubism 2 Core (PROPRIETARY) fetched
 *                                        (legacy models only; build-client inlines it)
 *     vendor.lock.json                   COMMITTED SHA-256 pin
 *     manifest.json                      generated provenance (gitignored)
 *
 * Supply-chain integrity: vendor.lock.json pins the exact SHA-256 of every
 * artifact. An existing file is only accepted when it matches the lock, a fresh
 * download is rejected when it does not, and packages/plugin/build-client.mjs is
 * expected to inline only files that match. Update the lock deliberately (after
 * reviewing the upstream change) with `--update-lock`.
 *
 * EULA gate:
 *   The Live2D Cubism cores (4 and the legacy 2 core used for Cubism 2 models) are
 *   only downloaded when you explicitly pass `--accept-live2d-eula` (or set
 *   DSH_LIVE2D_ACCEPT_EULA=1). Without it the script verifies the committed MIT
 *   files and refuses to fetch the cores. Read the license first:
 *     https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
 *     https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html
 *     https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html
 *   Shipping an application that embeds the Cubism SDK may additionally require
 *   the Cubism SDK Release License:
 *     https://www.live2d.com/en/download/cubism-sdk/release-license/
 *
 * Usage (from the repository root):
 *   node scripts/fetch-vendor.mjs                      # verify MIT files; refuse cores
 *   node scripts/fetch-vendor.mjs --accept-live2d-eula # verify + fetch cores
 *   node scripts/fetch-vendor.mjs --accept-live2d-eula --force        # re-download all
 *   node scripts/fetch-vendor.mjs --accept-live2d-eula --update-lock  # maintainers only
 *   node scripts/fetch-vendor.mjs --help
 *
 * Offline machines: the committed MIT files still verify; the proprietary cores
 * cannot be obtained offline (there is intentionally no copy in this repo).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VENDOR = join(ROOT, 'live2d-pet', 'packages', 'plugin', 'vendor');
const LOCK_PATH = join(VENDOR, 'vendor.lock.json');
const MANIFEST_PATH = join(VENDOR, 'manifest.json');

const PIXI_NAME = 'pixi.js';
const PIXI_VERSION = '7.4.3';
const DISPLAY_NAME = 'pixi-live2d-display';
const DISPLAY_VERSION = '0.5.0-beta';
const DISPLAY_DIST_FILE = 'package/dist/index.min.js';
const CORE4_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
const CORE2_URL = 'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js';

const EULA_LINKS = [
  'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html',
  'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html',
  'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html',
];
const SDK_RELEASE_LINK = 'https://www.live2d.com/en/download/cubism-sdk/release-license/';

/** Files build-client.mjs inlines, in load order. `committed` = part of this repo. */
const VENDOR_FILES = {
  pixi: { path: join(VENDOR, 'pixi.min.js'), committed: true },
  display: { path: join(VENDOR, 'pixi-live2d-display.min.js'), committed: true },
  core: { path: join(VENDOR, 'live2dcubismcore.min.js'), committed: false },
  core2: { path: join(VENDOR, 'live2d.min.js'), committed: false },
};

const MIN_BYTES = {
  pixi: 400 * 1024,
  display: 120 * 1024,
  core: 150 * 1024,
  core2: 100 * 1024,
};

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const eulaAccepted =
  hasFlag('--accept-live2d-eula') || process.env.DSH_LIVE2D_ACCEPT_EULA === '1';

function log(message) {
  process.stdout.write(`[fetch-vendor] ${message}\n`);
}
function fail(message) {
  process.stderr.write(`[fetch-vendor] ERROR: ${message}\n`);
  process.exitCode = 1;
}
function printUsage() {
  process.stdout.write(`DSH Live2D vendor fetcher

Usage (from the repository root):
  node scripts/fetch-vendor.mjs                       verify committed MIT files; refuse cores
  node scripts/fetch-vendor.mjs --accept-live2d-eula  verify + fetch the Live2D Cubism Core
  node scripts/fetch-vendor.mjs --accept-live2d-eula --force        re-download everything
  node scripts/fetch-vendor.mjs --accept-live2d-eula --update-lock  rewrite vendor.lock.json
  node scripts/fetch-vendor.mjs --help

Options:
  --accept-live2d-eula   Acknowledge the Live2D Proprietary Software License
                         Agreement (REQUIRED to download the Cubism Core).
  --force                Re-download every artifact, even if already present.
  --update-lock          After a successful fetch, rewrite the committed SHA-256
                         pin (live2d-pet/packages/plugin/vendor/vendor.lock.json).
                         Maintainers only, after reviewing the upstream change.
  --help                 Show this help.

Environment:
  DSH_LIVE2D_ACCEPT_EULA=1   Same as --accept-live2d-eula.
  npm_config_registry        npm registry override (default registry.npmjs.org).

Integrity: every artifact is checked against the committed vendor.lock.json. A
mismatch is a hard error (tampered/corrupted download), except with --update-lock.

Proprietary Live2D Cubism 4 Core source:
  ${CORE4_URL}
`);
}
function printEulaRefusal() {
  process.stderr.write(
    [
      '',
      '[fetch-vendor] REFUSED: the Live2D Cubism Core is proprietary software.',
      '',
      '  The renderer needs the Cubism 4 Core (and the legacy Cubism 2 Core for',
      '  Cubism 2 models) at runtime, but they are NOT open source and are NOT',
      '  committed to this repository. By downloading them you accept the Live2D',
      '  Proprietary Software License Agreement:',
      '',
      ...EULA_LINKS.map((link) => `    ${link}`),
      '',
      '  Shipping an application that embeds the Cubism SDK may also require the',
      `  Cubism SDK Release License: ${SDK_RELEASE_LINK}`,
      '',
      '  If you accept the EULA and have the right to use the Cubism SDK, re-run:',
      '',
      '    node scripts/fetch-vendor.mjs --accept-live2d-eula',
      '',
      '  (CI/integration: set DSH_LIVE2D_ACCEPT_EULA=1)',
      '',
    ].join('\n')
  );
  process.exitCode = 1;
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
function humanBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
function isJavaScript(buffer) {
  const head = buffer.subarray(0, 200).toString('utf8').trimStart();
  return !head.startsWith('<') && !/^\s*<!doctype/i.test(head);
}
function hasEveryMarker(buffer, markers, label) {
  const text = buffer.toString('utf8');
  const missing = markers.filter((marker) => !text.includes(marker));
  if (missing.length > 0) {
    throw new Error(`${label} does not look like the expected file (missing markers: ${missing.join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

function npmRegistry() {
  return (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

async function downloadBuffer(url, label, attempt = 1) {
  const maxAttempts = 3;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(180_000),
      headers: { 'user-agent': 'dsh-live2d-fetch-vendor (+local)' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('empty response');
    return bytes;
  } catch (error) {
    if (attempt >= maxAttempts) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)} (${url})`);
    }
    log(`${label} failed (${error.message}); retry ${attempt}/${maxAttempts - 1}...`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200 * attempt));
    return downloadBuffer(url, label, attempt + 1);
  }
}

/**
 * Acquire an npm package tarball. Preference order:
 *   1. plain HTTPS download of the registry tarball (no npm CLI needed);
 *   2. `npm pack <spec>` fallback (works through the user's npm proxy/cache).
 */
async function fetchNpmTarball(name, version, tmpDir) {
  const fileBase = `${name}-${version}.tgz`;
  const url = `${npmRegistry()}/${name}/-/${fileBase}`;
  const tarballPath = join(tmpDir, fileBase);
  try {
    log(`downloading ${name}@${version} from ${url}`);
    writeFileSync(tarballPath, await downloadBuffer(url, `${name}@${version}`));
    return tarballPath;
  } catch (primaryError) {
    log(`direct download failed (${primaryError.message}); trying "npm pack ${name}@${version}"...`);
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = spawnSync(npmCommand, ['pack', `${name}@${version}`, '--pack-destination', tmpDir, '--silent'], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_loglevel: 'error' },
    });
    if (result.status !== 0 || !existsSync(tarballPath)) {
      throw new Error(
        `could not download ${name}@${version}.\n` +
          `  direct: ${primaryError.message}\n` +
          `  npm pack: ${String(result.stderr || result.stdout || result.error || '').trim().slice(0, 400)}\n` +
          '  If this machine is offline, vendor these files manually from a machine with network access.'
      );
    }
    return tarballPath;
  }
}

// ---------------------------------------------------------------------------
// minimal tar reader (no external `tar` dependency, works on any OS)
// ---------------------------------------------------------------------------

function readTarString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function parsePaxPath(data) {
  let path = null;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** Returns a Map<entryPath, Buffer> for a .tgz archive (ustar + pax). */
function readTarballEntries(gzipBuffer) {
  let buffer;
  try {
    buffer = gunzipSync(gzipBuffer);
  } catch {
    throw new Error('downloaded tarball is not valid gzip data (network/proxy corruption?)');
  }
  const entries = new Map();
  let offset = 0;
  let paxPath = null;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const parsed = parsePaxPath(data);
      if (parsed) paxPath = parsed;
      offset = next;
      continue;
    }
    if (type === 'L') {
      longName = readTarString(data, 0, data.length);
      offset = next;
      continue;
    }
    if (type === '0' || type === '\u0000') {
      entries.set(paxPath || longName || (prefix ? `${prefix}/${name}` : name), Buffer.from(data));
      paxPath = null;
      longName = null;
    }
    offset = next;
  }
  return entries;
}

function extractFile(tarballPath, entryPath) {
  const entries = readTarballEntries(readFileSync(tarballPath));
  const found = entries.get(entryPath);
  if (!found) {
    const names = [...entries.keys()].join('\n  ');
    throw new Error(`archive ${tarballPath} does not contain ${entryPath}; entries:\n  ${names}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// vendor lock
// ---------------------------------------------------------------------------

function lockLabel() {
  return relative(ROOT, LOCK_PATH).replaceAll('\\', '/');
}

/**
 * Read the committed SHA-256 pin. The lock is part of the repository: without it
 * the fetcher cannot distinguish a genuine upstream artifact from a tampered
 * one, so a missing/invalid lock is a hard error (never a warning).
 */
function readLock() {
  const label = lockLabel();
  if (!existsSync(LOCK_PATH)) {
    throw new Error(
      `vendor integrity lock is missing: ${label}. It is committed to the repository; restore it from version control.`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`vendor integrity lock ${label} is not valid JSON: ${error.message}`);
  }
  const files = parsed !== null && typeof parsed === 'object' ? parsed.files : null;
  if (files === null || typeof files !== 'object') throw new Error(`vendor integrity lock ${label} has no "files" object`);
  const expected = {};
  for (const key of Object.keys(VENDOR_FILES)) {
    const entry = files[key];
    const sha = entry !== null && typeof entry === 'object' ? String(entry.sha256 || '').toLowerCase() : '';
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !/^[0-9a-f]{64}$/u.test(sha) ||
      !Number.isInteger(entry.bytes)
    ) {
      throw new Error(`vendor integrity lock ${label} has no valid sha256/bytes for "${key}"`);
    }
    expected[key] = { sha256: sha, bytes: entry.bytes };
  }
  return expected;
}

/** One existing artifact vs the lock: `null` when it matches, else a problem line. */
function lockProblem(key, path, entry) {
  let buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    return `${key}: cannot be read for integrity check (${error.message})`;
  }
  const actual = sha256(buffer);
  if (actual !== entry.sha256) {
    return (
      `${key}: SHA-256 mismatch against ${lockLabel()} ` +
      `(pinned ${entry.sha256.slice(0, 16)}…, found ${actual.slice(0, 16)}…) — ` +
      'refusing a tampered/corrupted file. Re-download with: ' +
      'node scripts/fetch-vendor.mjs --accept-live2d-eula --force'
    );
  }
  return null;
}

function validateExisting() {
  const lock = readLock();
  const problems = [];
  for (const [key, info] of Object.entries(VENDOR_FILES)) {
    if (!existsSync(info.path)) {
      problems.push(`${key}: missing ${relative(ROOT, info.path).replaceAll('\\', '/')}`);
      continue;
    }
    const size = statSync(info.path).size;
    if (size < MIN_BYTES[key]) problems.push(`${key}: suspiciously small (${size} bytes)`);
    const mismatch = lockProblem(key, info.path, lock[key]);
    if (mismatch !== null) problems.push(mismatch);
  }
  return problems;
}

/** Fatal gate: a file that does not match the lock is never used or documented. */
function enforceLock() {
  const lock = readLock();
  const problems = Object.keys(VENDOR_FILES)
    .filter((key) => existsSync(VENDOR_FILES[key].path))
    .map((key) => lockProblem(key, VENDOR_FILES[key].path, lock[key]))
    .filter((problem) => problem !== null);
  if (problems.length > 0) {
    throw new Error(`vendor files do not match ${lockLabel()}:\n  ${problems.join('\n  ')}`);
  }
}

function writeLock(files) {
  const lock = {
    version: 1,
    comment:
      'SHA-256 pin for the runtime vendor artifacts (supply-chain integrity, not provenance). ' +
      'scripts/fetch-vendor.mjs refuses to use or re-download a file that does not match this lock. ' +
      'pixi/display are committed (MIT); the Live2D Cubism Core is NOT committed, it is fetched only ' +
      'after the Live2D EULA is accepted.',
    generator: 'scripts/fetch-vendor.mjs',
    update: 'Review the upstream change first, then run: node scripts/fetch-vendor.mjs --accept-live2d-eula --update-lock',
    files: Object.fromEntries(
      Object.entries(files).map(([key, info]) => [
        key,
        {
          file: relative(ROOT, info.path).replaceAll('\\', '/'),
          bytes: info.bytes,
          sha256: info.sha256,
          source: info.source,
          license: info.license,
          committed: info.committed,
        },
      ])
    ),
  };
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

function fileInfo(path, source, license, committed) {
  const buffer = readFileSync(path);
  return { path, bytes: buffer.length, sha256: sha256(buffer), source, license, committed };
}

function writeManifest(files) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/fetch-vendor.mjs',
    note:
      'Generated provenance for the runtime vendor artifacts. The committed SHA-256 pin is vendor.lock.json. ' +
      'The Live2D Cubism Core files are proprietary and gitignored: do not commit them.',
    packages: {
      'pixi.js': PIXI_VERSION,
      'pixi-live2d-display': `${DISPLAY_VERSION} (dist/index.min.js, all-in-one)`,
      'Live2D Cubism Core': '4 (official live2dcubismcore.min.js)',
      'Live2D Cubism 2 Core': 'legacy live2d.min.js (community mirror, only if fetched)',
    },
    files: Object.fromEntries(
      Object.entries(files).map(([key, info]) => [
        key,
        {
          file: relative(ROOT, info.path).replaceAll('\\', '/'),
          bytes: info.bytes,
          sha256: info.sha256,
          source: info.source,
          license: info.license,
          committed: info.committed,
        },
      ])
    ),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`wrote generated ${relative(ROOT, MANIFEST_PATH).replaceAll('\\', '/')} (gitignored)`);
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

async function fetchMit(tmpDir, lock) {
  mkdirSync(VENDOR, { recursive: true });

  for (const key of ['pixi', 'display']) {
    const info = VENDOR_FILES[key];
    if (existsSync(info.path) && !hasFlag('--force')) {
      const problem = lockProblem(key, info.path, lock[key]);
      if (problem === null) continue;
      log(problem);
    }
    if (key === 'pixi') {
      const tarball = await fetchNpmTarball(PIXI_NAME, PIXI_VERSION, tmpDir);
      const bytes = extractFile(tarball, 'package/dist/pixi.min.js');
      hasEveryMarker(bytes, ['pixi.js - v' + PIXI_VERSION, 'PIXI'], 'pixi.min.js');
      if (bytes.length < MIN_BYTES.pixi) throw new Error('downloaded pixi.min.js is suspiciously small');
      writeFileSync(info.path, bytes);
      log(`wrote pixi.min.js (${humanBytes(bytes.length)})`);
    } else {
      const tarball = await fetchNpmTarball(DISPLAY_NAME, DISPLAY_VERSION, tmpDir);
      const bytes = extractFile(tarball, DISPLAY_DIST_FILE);
      hasEveryMarker(bytes, ['Live2DModel', 'Cubism4InternalModel'], 'pixi-live2d-display all-in-one build');
      if (bytes.length < MIN_BYTES.display) throw new Error('downloaded pixi-live2d-display.min.js is suspiciously small');
      writeFileSync(info.path, bytes);
      log(`wrote pixi-live2d-display.min.js (${humanBytes(bytes.length)}, dist/index.min.js all-in-one)`);
    }
  }
}

async function fetchCores(lock) {
  if (!existsSync(VENDOR_FILES.core.path) || hasFlag('--force')) {
    if (existsSync(VENDOR_FILES.core.path) && !hasFlag('--force')) {
      const problem = lockProblem('core', VENDOR_FILES.core.path, lock.core);
      if (problem !== null) log(problem);
    }
    log(`downloading the Live2D Cubism 4 Core from ${CORE4_URL}`);
    const bytes = await downloadBuffer(CORE4_URL, 'Live2D Cubism 4 Core');
    hasEveryMarker(bytes, ['Live2D Cubism Core', 'Live2DCubismCore'], 'live2dcubismcore.min.js');
    if (!isJavaScript(bytes)) throw new Error('the Cubism Core download returned an HTML/error page, not JavaScript');
    writeFileSync(VENDOR_FILES.core.path, bytes);
    log(`wrote live2dcubismcore.min.js (${humanBytes(bytes.length)}, proprietary — do not commit)`);
  } else {
    const problem = lockProblem('core', VENDOR_FILES.core.path, lock.core);
    if (problem !== null) {
      log(problem);
      throw new Error('existing live2dcubismcore.min.js does not match the lock; re-run with --force');
    }
  }

  // The all-in-one pixi-live2d-display build and build-client.mjs include the
  // Cubism 2 Core for legacy `*.model.json` models, so it is fetched too.
  if (!existsSync(VENDOR_FILES.core2.path) || hasFlag('--force')) {
    if (existsSync(VENDOR_FILES.core2.path) && !hasFlag('--force')) {
      const problem = lockProblem('core2', VENDOR_FILES.core2.path, lock.core2);
      if (problem !== null) log(problem);
    }
    log(`downloading the legacy Live2D Cubism 2 Core from ${CORE2_URL}`);
    const c2 = await downloadBuffer(CORE2_URL, 'Live2D Cubism 2 Core');
    hasEveryMarker(c2, ['Live2D'], 'live2d.min.js');
    if (!isJavaScript(c2)) throw new Error('the Cubism 2 Core download returned an HTML/error page, not JavaScript');
    writeFileSync(VENDOR_FILES.core2.path, c2);
    log(`wrote live2d.min.js (${humanBytes(c2.length)}, proprietary — do not commit)`);
  } else {
    const problem = lockProblem('core2', VENDOR_FILES.core2.path, lock.core2);
    if (problem !== null) {
      log(problem);
      throw new Error('existing live2d.min.js does not match the lock; re-run with --force');
    }
  }
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printUsage();
    return;
  }

  const lock = readLock();
  const problems = validateExisting();
  const complete = problems.length === 0;
  const coresNeeded = problems.some((problem) => problem.startsWith('core:') || problem.startsWith('core2:'));

  if (complete && !hasFlag('--force')) {
    log('vendor bundle already present and matches vendor.lock.json — skipping download (use --force to re-download)');
  } else if (coresNeeded && !eulaAccepted) {
    log(`vendor bundle incomplete/mismatched: ${problems.join('; ')}`);
    printEulaRefusal();
    return;
  } else {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-live2d-vendor-'));
    try {
      log('verifying/downloading committed MIT artifacts (pixi.js, pixi-live2d-display)...');
      await fetchMit(tmpDir, lock);
      if (eulaAccepted) {
        await fetchCores(lock);
      } else {
        log('cores are present but --accept-live2d-eula was not passed: not re-downloading the proprietary cores');
      }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // The Cubism cores are required at runtime/bundle time; without them nothing works.
  if (!existsSync(VENDOR_FILES.core.path) || !existsSync(VENDOR_FILES.core2.path)) {
    printEulaRefusal();
    return;
  }

  const files = {
    pixi: fileInfo(
      VENDOR_FILES.pixi.path,
      `npm ${PIXI_NAME}@${PIXI_VERSION} dist/pixi.min.js`,
      'MIT',
      true
    ),
    display: fileInfo(
      VENDOR_FILES.display.path,
      `npm ${DISPLAY_NAME}@${DISPLAY_VERSION} dist/index.min.js (all-in-one)`,
      'MIT',
      true
    ),
    core: fileInfo(
      VENDOR_FILES.core.path,
      CORE4_URL,
      'Live2D Proprietary Software License Agreement',
      false
    ),
    core2: fileInfo(
      VENDOR_FILES.core2.path,
      CORE2_URL,
      'Live2D Proprietary Software License Agreement',
      false
    ),
  };

  if (hasFlag('--update-lock')) {
    const tooSmall = Object.entries(VENDOR_FILES).filter(
      ([key, info]) => !existsSync(info.path) || statSync(info.path).size < MIN_BYTES[key]
    );
    if (tooSmall.length > 0) {
      fail(`cannot --update-lock: incomplete vendor bundle (${tooSmall.map(([key]) => key).join(', ')})`);
      return;
    }
    writeLock(files);
    log(`rewrote the vendor integrity lock: ${lockLabel()}`);
  } else {
    enforceLock();
  }

  // `--update-lock` just changed the pin; re-validate with it.
  const remaining = validateExisting();
  if (remaining.length > 0) {
    fail(`vendor bundle incomplete after fetch:\n  ${remaining.join('\n  ')}`);
    return;
  }

  writeManifest(files);
  log('vendor bundle ready (SHA-256 verified against vendor.lock.json):');
  for (const [key, info] of Object.entries(files)) {
    log(
      `  ${key.padEnd(8)} ${humanBytes(info.bytes).padStart(9)}  sha256:${info.sha256.slice(0, 12)}…  ${relative(
        VENDOR,
        info.path
      ).replaceAll('\\', '/')}`
    );
  }
  log('next: node scripts/build-all.mjs');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
