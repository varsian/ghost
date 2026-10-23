/**
 * Unit tests for the adapter's envelope analyzer (occlusion/backlog resync).
 *
 * Run with:
 *   node --experimental-strip-types --test tests/test_envelope.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvelopeAudioLevelAnalyzer } from '../../third_party/soullink-emotion-sdk/packages/dsh-live2d-adapter/src/envelope.ts';

test('beginSpeech clears a previous utterance tail', () => {
  const analyzer = new EnvelopeAudioLevelAnalyzer({ maxBacklogMs: 500 });
  analyzer.beginSpeech();
  analyzer.push([0.2, 0.3, 0.4], 20);
  assert.equal(analyzer.stats().pendingFrames, 3);
  analyzer.beginSpeech();
  const stats = analyzer.stats();
  assert.equal(stats.pendingFrames, 0);
  assert.equal(stats.level, 0);
  assert.equal(stats.speechActive, true);
});

test('push drops the oldest frames when the backlog exceeds the real-time budget', () => {
  const analyzer = new EnvelopeAudioLevelAnalyzer({ maxBacklogMs: 100 });
  analyzer.beginSpeech();
  analyzer.push(Array.from({ length: 20 }, () => 0.5), 20);
  const stats = analyzer.stats();
  assert.equal(stats.pendingFrames, 5);
  assert.equal(stats.droppedFrames, 15);
  assert.equal(stats.active, true);
});

test('a long frame gap flushes stale frames instead of replaying them', () => {
  const analyzer = new EnvelopeAudioLevelAnalyzer({ maxBacklogMs: 500 });
  analyzer.beginSpeech();
  analyzer.push(Array.from({ length: 10 }, () => 0.8), 20);
  analyzer.advance(0.5); // renderer was paused for 500ms
  const stats = analyzer.stats();
  assert.equal(stats.pendingFrames, 0);
  assert.ok(stats.flushCount >= 1);
  assert.equal(stats.level, 0);
});

test('flush keeps speechActive so the next frames still drive the mouth', () => {
  const analyzer = new EnvelopeAudioLevelAnalyzer({ maxBacklogMs: 500 });
  analyzer.beginSpeech();
  analyzer.push([0.9, 0.9], 20);
  analyzer.flush();
  assert.equal(analyzer.stats().speechActive, true);
  analyzer.push([0.2, 0.6], 20);
  analyzer.advance(0.04);
  assert.ok(analyzer.stats().level > 0);
});
