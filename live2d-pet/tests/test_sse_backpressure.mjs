/**
 * Host SSE backpressure test: a paused/occluded renderer must be disconnected
 * instead of being fed an ever-growing queue of stale TTS frames.
 *
 * Run with:
 *   node tests/test_sse_backpressure.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createLive2DHost } from '../packages/plugin/lib/index.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('a non-draining SSE client is dropped once its buffer exceeds the limit', async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(os.tmpdir(), 'dsh-live2d-sse-'));
  const host = createLive2DHost(
    { logger: { info() {}, warn() {}, error() {} }, get: () => null },
    {
      port,
      dataDir,
      mode: 'window',
      visible: false,
      sseBackpressureBytes: 16 * 1024,
      sseBackpressureMs: 500,
    }
  );
  let client;
  try {
    await host.listen();

    client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    await new Promise((resolve) => client.once('connect', resolve));
    client.write('GET /events?client=window HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    // Stop reading: emulate a renderer whose main thread is frozen.
    client.pause();

    const registerDeadline = Date.now() + 3000;
    while (host.hub.stats().windowClients === 0 && Date.now() < registerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(host.hub.stats().windowClients, 1, 'SSE client did not register');

    const frames = Array.from({ length: 400 }, () => 0.5);
    for (let i = 0; i < 2000; i += 1) {
      host.ingest({ type: 'envelope', frames, hopMs: 20 });
      if (i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const deadline = Date.now() + 5000;
    while (host.hub.stats().dropped === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stats = host.hub.stats();
    assert.ok(stats.dropped >= 1, `expected a backpressure drop, got ${JSON.stringify(stats)}`);
    assert.equal(stats.windowClients, 0);
  } finally {
    try { client?.destroy(); } catch { /* ignore */ }
    await host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
