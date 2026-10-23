import type { AudioLevelAnalyzer } from "@soullink-emotion/engine";

/**
 * Audio level analyzer fed by RMS-envelope frames pushed from the TTS bridge.
 *
 * The TTS shim tees the real playback samples and posts fixed-hop RMS frames
 * (0..1, ~20ms hop). The frames arrive in bursts and can be slightly ahead of
 * playback, so they are queued and consumed on the render/delta clock instead
 * of immediately, which keeps the mouth in sync with the audible voice.
 *
 * When the queue is empty the level is released to 0 and `isAvailable()`
 * returns false so the engine falls back to its procedural lip-sync path.
 */
export class EnvelopeAudioLevelAnalyzer implements AudioLevelAnalyzer {
  private pending: number[] = [];
  private hopMs = 20;
  private budgetMs = 0;
  private level = 0;
  private peak = 0;
  private hasFrames = false;
  private speechActive = false;
  private readonly gain: number;
  private readonly releaseSeconds: number;
  /**
   * Real-time playback budget. The TTS envelope arrives in real time (one hop
   * of audio per hop of wall clock), so a queue longer than this can only mean
   * the renderer was paused/starved: replaying it would show the mouth moving
   * to last minute's audio. Drop the oldest frames instead.
   */
  private maxBacklogMs: number;
  private droppedFrames = 0;
  private flushCount = 0;
  private lastFlushAt = 0;

  constructor(options: { gain?: number; releaseSeconds?: number; maxBacklogMs?: number } = {}) {
    this.gain = clamp(options.gain ?? 1, 0, 4);
    this.releaseSeconds = clamp(options.releaseSeconds ?? 0.12, 0.02, 1);
    this.maxBacklogMs = clamp(options.maxBacklogMs ?? 500, 100, 5000);
  }

  /** Change the maximum accepted backlog (real-time ms). */
  setMaxBacklogMs(maxBacklogMs: number): void {
    this.maxBacklogMs = clamp(maxBacklogMs, 100, 5000);
    this.trimBacklog();
  }

  getLevel(): number {
    return this.level;
  }

  getPeak(): number {
    return this.peak;
  }

  isAvailable(): boolean {
    return this.hasFrames;
  }

  available(): boolean {
    return this.hasFrames;
  }

  reset(): void {
    this.pending = [];
    this.budgetMs = 0;
    this.level = 0;
    this.peak = 0;
    this.hasFrames = false;
  }

  /**
   * Drop everything queued and reset the smoothed level. Used when the page was
   * paused/occluded: the next frames that arrive are the current audio, so the
   * mouth must not replay the backlog. Speech stays active.
   */
  flush(): void {
    const hadData = this.pending.length > 0 || this.hasFrames || this.level > 0;
    this.pending = [];
    this.budgetMs = 0;
    this.level = 0;
    this.peak = 0;
    this.hasFrames = false;
    if (hadData) {
      this.flushCount += 1;
      this.lastFlushAt = Date.now();
    }
  }

  /** Called by `speakStart()`; a new utterance must not inherit an old tail. */
  beginSpeech(): void {
    this.pending = [];
    this.budgetMs = 0;
    this.level = 0;
    this.peak = 0;
    this.hasFrames = false;
    this.speechActive = true;
  }

  /** Called by `speakEnd()`; the queue drains and the analyzer releases to 0. */
  endSpeech(): void {
    this.speechActive = false;
  }

  /** Enqueue one burst of frames (0..1 RMS) with the producer hop in ms. */
  push(frames: readonly number[], hopMs = 20): void {
    if (this.pending.length === 0) this.budgetMs = 0;
    this.hopMs = clamp(hopMs, 5, 100);
    for (const frame of frames) {
      if (!Number.isFinite(frame)) continue;
      this.pending.push(clamp(frame, 0, 1));
    }
    this.trimBacklog();
    this.hasFrames = this.pending.length > 0;
  }

  /** Advance the playback clock; must be called once per rendered frame. */
  advance(deltaSeconds: number): void {
    // A frame gap this large means rAF was paused (window occluded/minimised).
    // Do not replay the whole phrase the user did not see; resync to the
    // current audio and let the next pushed frames drive the mouth.
    if (deltaSeconds * 1000 > 250) this.flush();
    if (this.pending.length === 0) {
      this.release(deltaSeconds);
      return;
    }

    this.budgetMs += Math.max(0, deltaSeconds) * 1000;
    // Cap the catch-up burst so a long frame gap does not eat a whole phrase.
    let budget = 0;
    while (budget < 6 && this.pending.length > 0 && this.budgetMs >= this.hopMs) {
      const frame = this.pending.shift() as number;
      this.budgetMs -= this.hopMs;
      const level = clamp(frame * this.gain, 0, 1);
      this.level = level;
      this.peak = Math.max(this.peak * 0.82, level);
      budget++;
    }
    this.hasFrames = this.pending.length > 0;
    if (!this.hasFrames) this.release(deltaSeconds);
  }

  stats(): {
    pendingFrames: number;
    hopMs: number;
    level: number;
    peak: number;
    active: boolean;
    speechActive: boolean;
    droppedFrames: number;
    flushCount: number;
    lastFlushAt: number;
  } {
    return {
      pendingFrames: this.pending.length,
      hopMs: this.hopMs,
      level: round(this.level),
      peak: round(this.peak),
      active: this.hasFrames,
      speechActive: this.speechActive,
      droppedFrames: this.droppedFrames,
      flushCount: this.flushCount,
      lastFlushAt: this.lastFlushAt
    };
  }

  /** Keep at most `maxBacklogMs` worth of frames; count the discarded ones. */
  private trimBacklog(): void {
    const maxFrames = Math.max(1, Math.round(this.maxBacklogMs / Math.max(5, this.hopMs)));
    if (this.pending.length <= maxFrames) return;
    const drop = this.pending.length - maxFrames;
    this.pending.splice(0, drop);
    this.droppedFrames += drop;
    this.budgetMs = 0;
  }

  private release(deltaSeconds: number): void {
    if (this.level <= 0.0005) {
      this.level = 0;
      this.peak = 0;
      this.hasFrames = false;
      return;
    }
    const decay = Math.exp(-Math.max(0, deltaSeconds) / this.releaseSeconds);
    this.level = clamp(this.level * decay, 0, 1);
    this.peak = clamp(this.peak * decay, 0, 1);
    this.hasFrames = false;
  }
}

/** Build a speech-shaped RMS envelope for tests / demos. */
export function buildMockEnvelope(options: {
  durationSeconds?: number;
  hopMs?: number;
  seed?: number;
  level?: number;
} = {}): { frames: number[]; hopMs: number; durationSeconds: number } {
  const hopMs = options.hopMs ?? 20;
  const durationSeconds = options.durationSeconds ?? 2.6;
  const count = Math.max(1, Math.round((durationSeconds * 1000) / hopMs));
  const seed = options.seed ?? 7;
  let random = seed >>> 0;
  const rand = () => {
    random = (random * 1664525 + 1013904223) >>> 0;
    return random / 0xffffffff;
  };
  const frames: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i * hopMs) / 1000;
    // Syllable-ish pulses with an attack/decay phrase envelope.
    const phrase = Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5) * (1 - Math.min(0.35, t / durationSeconds) * 0.35);
    const syllable = Math.max(0, Math.sin(t * 13.7) * 0.6 + Math.sin(t * 29.3 + 0.7) * 0.4);
    const noise = rand() * 0.18;
    const gate = t > durationSeconds - 0.22 ? Math.max(0, (durationSeconds - t) / 0.22) : 1;
    frames.push(clamp((syllable * 0.72 + noise) * phrase * gate * (options.level ?? 1), 0, 1));
  }
  return { frames, hopMs, durationSeconds };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
