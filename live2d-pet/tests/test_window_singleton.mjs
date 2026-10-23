/**
 * Launcher duplicate-cleanup tests.
 *
 * 1. `--dedupe` never kills a pid just because it appeared in the (historical)
 *    window log; only verified window main processes are touched.
 * 2. `close-others.ps1` closes visible duplicate titled windows via WM_CLOSE,
 *    without killing the owning process tree and without touching the keeper.
 *
 * Run with:
 *   node --test tests/test_window_singleton.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../tools/live2d-window/launch.mjs', import.meta.url));
const CLOSER = fileURLToPath(new URL('../tools/live2d-window/close-others.ps1', import.meta.url));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

test('--dedupe does not kill pids that only appear in the historical log', () => {
  const dataDir = mkdtempSync(join(os.tmpdir(), 'dsh-live2d-dedupe-'));
  const keeper = sleeper();
  const logOnly = sleeper();
  try {
    const line = (pid) =>
      `{"ts":"2026-10-20T00:00:00.000Z","pid":${pid},"level":"info","message":"main-boot"}\n`;
    writeFileSync(join(dataDir, 'live2d-window.log'), line(keeper.pid) + line(logOnly.pid), 'utf8');
    writeFileSync(join(dataDir, 'live2d-window.pid'), `${keeper.pid}\n`, 'utf8');
    writeFileSync(join(dataDir, 'live2d-window.lock'), `${keeper.pid}\n`, 'utf8');

    const result = spawnSync(process.execPath, [LAUNCHER, '--dedupe'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, LIVE2D_WINDOW_DATA: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split('\n').find((value) => value.startsWith('{')) || '{}');
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.kept, keeper.pid);
    assert.deepEqual(parsed.killed, []);
    assert.equal(parsed.instances, 1);
    assert.equal(isAlive(logOnly.pid), true, 'log-only pid must not be killed');
  } finally {
    for (const child of [keeper, logOnly]) {
      try { child.kill(); } catch { /* ignore */ }
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('close-others closes a visible duplicate titled window via WM_CLOSE', async () => {
  if (process.platform !== 'win32') return;
  const marker = `DSH Live2D TEST ${process.pid}`;
  const tempDir = mkdtempSync(join(os.tmpdir(), 'dsh-live2d-window-'));
  const formScript = join(tempDir, 'form.ps1');
  writeFileSync(
    formScript,
    [
      'param([string]$Title)',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$form = New-Object System.Windows.Forms.Form',
      '$form.Text = $Title',
      '$form.Width = 320',
      '$form.Height = 240',
      '[System.Windows.Forms.Application]::Run($form)',
    ].join('\n'),
    'utf8'
  );
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', formScript, '-Title', marker], {
    stdio: 'ignore',
    windowsHide: false,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLOSER, '-KeeperPid', '0', '-Title', marker],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout.trim().split('\n').find((value) => value.startsWith('{')) || '{}');
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.ok(parsed.seen.some((value) => value.startsWith(`${child.pid}:`)), JSON.stringify(parsed));
    assert.ok(parsed.closed.includes(String(child.pid)), JSON.stringify(parsed));
    const deadline = Date.now() + 5000;
    while (isAlive(child.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(isAlive(child.pid), false, 'test window did not close');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    rmSync(tempDir, { recursive: true, force: true });
  }
});
