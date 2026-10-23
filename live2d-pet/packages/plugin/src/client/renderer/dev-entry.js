/**
 * dev-entry.js — proto/test entry.
 *
 * Bundled by `build-client.mjs --proto` into `proto/dev-bundle.js` as a plain
 * IIFE (no DSH loader wrapper). The proto page loads the vendored UMD runtime
 * with <script> tags first, then this bundle, and drives
 * `window.__Live2DDev.createLive2DStage(...)`.
 */

import {
  createLive2DStage,
  runtimeStatus,
  detectFormat,
  syntheticEnvelope,
  listEmotionNames,
  DEFAULT_EMOTION_MAP,
} from './index.js';
import { EnvelopePlayer } from './envelope.js';
import { resolveEmotion } from './emotions.js';
import { loadModelAssets } from './assets.js';

const api = {
  createLive2DStage,
  runtimeStatus,
  detectFormat,
  syntheticEnvelope,
  listEmotionNames,
  DEFAULT_EMOTION_MAP,
  EnvelopePlayer,
  resolveEmotion,
  loadModelAssets,
  version: '0.1.0',
};

if (typeof globalThis !== 'undefined') globalThis.__Live2DDev = api;
if (typeof window !== 'undefined') window.__Live2DDev = api;

export default api;
