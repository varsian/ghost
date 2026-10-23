/**
 * envelope.js — RMS envelope playback for lip sync.
 *
 * The host relays `envelope` events produced by the TTS bridge: arrays of RMS
 * values (0..1) sampled at a fixed hop (default 20 ms) from the *actually
 * played* PCM. Frames arrive in chunks while speech is playing, i.e. in
 * roughly real time but with network jitter. To keep the mouth from stuttering
 * we play them against the device clock with a small jitter buffer and smooth
 * them with asymmetric attack/release envelopes.
 *
 * Public API (used by the stage):
 *   begin(now, {latencyMs?, startDelayMs?}) — speech started, reset the timeline
 *   push(frames, hopMs)    — append frames (numbers, 0..1)
 *   setLatency(ms, now)    — shift playback while audio output latency changes
 *   end(now)               — speech ended, release to zero
 *   value(now)             — smoothed mouth openness 0..1
 *   reset()                — hard reset
 *
 * Latency model: the shim reports when a PCM chunk was handed to the audio
 * device (`latencyMs` = output/device latency). The envelope from that chunk
 * therefore describes sound the listener hears `latencyMs` later, so playback
 * of frames is delayed by `bufferMs (jitter) + startDelayMs + audioLatencyMs`.
 */

export class EnvelopePlayer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.hopMs=20]        envelope hop in ms
   * @param {number} [opts.bufferMs=40]     jitter buffer (playback delay)
   * @param {number} [opts.attackTau=0.03]  attack time constant (s)
   * @param {number} [opts.releaseTau=0.07] release time constant (s)
   * @param {number} [opts.underrunGraceMs=220] hold last value for this long
   * @param {number} [opts.startDelayMs=0]  extra constant delay before playback
   * @param {number} [opts.audioLatencyMs=0] output latency reported by the host
   * @param {number} [opts.gain=1]
   */
  constructor(opts = {}) {
    this.hopMs = opts.hopMs || 20;
    this.bufferMs = opts.bufferMs === undefined ? 40 : opts.bufferMs;
    this.attackTau = opts.attackTau === undefined ? 0.03 : opts.attackTau;
    this.releaseTau = opts.releaseTau === undefined ? 0.07 : opts.releaseTau;
    this.underrunGraceMs = opts.underrunGraceMs === undefined ? 220 : opts.underrunGraceMs;
    this.startDelayMs = opts.startDelayMs === undefined ? 0 : opts.startDelayMs;
    /** Host-reported audio *output* latency (frame → audible speaker). */
    this.audioLatencyMs = opts.audioLatencyMs === undefined ? 0 : opts.audioLatencyMs;
    this.gain = opts.gain === undefined ? 1 : opts.gain;
    this.reset();
  }

  /** Total delay applied before the first frame is consumed (ms). */
  get delayMs() {
    return this.bufferMs + this.startDelayMs + this.audioLatencyMs;
  }

  reset() {
    /** @type {number[]} */
    this.frames = [];
    /** index of the first sample still relevant (avoids array shifts) */
    this.head = 0;
    /** wall-clock (performance.now) when playback of frames[0] starts */
    this.startedAt = 0;
    this.active = false;
    this.endedAt = 0;
    /** last raw target value (for underrun hold) */
    this.lastTarget = 0;
    this.lastAvailableAt = 0;
    /** smoothed output */
    this.smoothed = 0;
    this._lastNow = 0;
    this.totalFrames = 0;
  }

  /**
   * Reset the timeline and mark speech as active.
   * @param {number} now
   * @param {{latencyMs?:number, startDelayMs?:number}} [opts] per-speech overrides
   */
  begin(now, opts) {
    const o = opts || {};
    const latency =
      typeof o.latencyMs === 'number' && Number.isFinite(o.latencyMs)
        ? Math.max(0, o.latencyMs)
        : this.audioLatencyMs;
    if (typeof o.startDelayMs === 'number' && Number.isFinite(o.startDelayMs)) {
      this.startDelayMs = Math.max(0, o.startDelayMs);
    }
    this.audioLatencyMs = latency;
    this.reset();
    this.active = true;
    this.startedAt = now + this.delayMs;
    this._lastNow = now;
    return this;
  }

  /**
   * Change the audio output latency while speech is playing (the host may only
   * know it after speech_start). Shifts the playback clock by the delta so the
   * mouth stays aligned with what the listener actually hears.
   * @param {number} latencyMs
   */
  setLatency(latencyMs) {
    const next = Math.max(0, Number(latencyMs) || 0);
    const delta = next - this.audioLatencyMs;
    this.audioLatencyMs = next;
    if (this.active && delta !== 0) this.startedAt += delta;
    return this;
  }

  /** Extra constant delay (ms) added on top of buffer+latency for the next begin(). */
  setStartDelay(delayMs) {
    this.startDelayMs = Math.max(0, Number(delayMs) || 0);
    return this;
  }

  /** Mark speech as finished; playback releases smoothly to zero. */
  end(now) {
    this.active = false;
    this.endedAt = typeof now === 'number' ? now : this._lastNow;
  }

  /**
   * Append envelope frames.
   * @param {number[]|Float32Array|ArrayLike<number>} frames RMS values 0..1
   * @param {number} [hopMs] hop of *this* chunk (must match the timeline hop)
   */
  push(frames, hopMs) {
    if (!frames) return this;
    const arr = frames;
    if (hopMs && Math.abs(hopMs - this.hopMs) > 0.01) {
      // Different hop: re-sampling would be over-engineering; adopt the hop if
      // this is the first chunk, otherwise ignore the hint.
      if (this.totalFrames === 0) this.hopMs = hopMs;
    }
    for (let i = 0; i < arr.length; i++) {
      let v = Number(arr[i]);
      if (!Number.isFinite(v)) v = 0;
      if (v < 0) v = 0;
      else if (v > 1) v = 1;
      this.frames.push(v);
    }
    this.totalFrames += arr.length;
    // A queue longer than 1.5s of audio means the page was paused/starved; the
    // wall-clock playback position would skip anyway. Drop the stale backlog so
    // memory does not grow and the next audible frames start at the current time.
    const maxQueued = Math.max(1, Math.round(1500 / Math.max(5, this.hopMs)));
    if (this.frames.length - this.head > maxQueued) {
      this.frames = [];
      this.head = 0;
      this.startedAt = this._lastNow;
    }
    if (this.totalFrames > 0) this.lastAvailableAt = this._lastNow;
    return this;
  }

  /** Number of queued (unplayed, unconsumed) frames. */
  get queued() {
    return Math.max(0, this.frames.length - this.head);
  }

  /**
   * Smoothed mouth value at `now` (performance.now()).
   * @param {number} now
   * @returns {number} 0..1
   */
  value(now) {
    const t = typeof now === 'number' ? now : 0;
    const dt = this._lastNow ? Math.max(0, Math.min(0.25, (t - this._lastNow) / 1000)) : 0;
    this._lastNow = t;

    let target = 0;
    let i0 = 0;
    if (this.active || this.queued > 0) {
      const elapsed = t - this.startedAt;
      if (elapsed >= 0) {
        const pos = elapsed / this.hopMs;
        i0 = Math.floor(pos);
        const frac = pos - i0;
        const abs = this.head + i0;
        if (abs + 1 < this.frames.length) {
          target = this.frames[abs] * (1 - frac) + this.frames[abs + 1] * frac;
          this.lastTarget = target;
          this.lastAvailableAt = t;
        } else if (abs < this.frames.length) {
          target = this.frames[abs];
          this.lastTarget = target;
          this.lastAvailableAt = t;
        } else {
          // underrun: hold, then decay after the grace period
          const stale = t - this.lastAvailableAt;
          target = stale <= this.underrunGraceMs ? this.lastTarget : 0;
        }
      } else {
        target = 0; // jitter-buffer delay (playback has not started yet)
      }

      // Consume played samples in batches to keep the array small.
      if (i0 > 256) {
        this.head += i0;
        this.startedAt += i0 * this.hopMs;
      }
      if (this.head > 512 && this.head * 2 > this.frames.length) {
        this.frames = this.frames.slice(this.head);
        this.head = 0;
      }
    } else {
      target = 0;
      if (this.frames.length) {
        this.frames = [];
        this.head = 0;
      }
    }

    const tau = target > this.smoothed ? this.attackTau : this.releaseTau;
    const coef = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
    this.smoothed += (target - this.smoothed) * coef;
    if (this.smoothed < 0.0005) this.smoothed = 0;
    return Math.min(1, Math.max(0, this.smoothed * this.gain));
  }
}

/**
 * Build a speech-like envelope for demos/tests: word bursts separated by short
 * pauses, with a decaying plosive at each burst start and a sine carrier.
 * @param {object} [opts]
 * @param {number} [opts.durationMs=3000]
 * @param {number} [opts.hopMs=20]
 * @param {number} [opts.seed=7]
 * @returns {number[]}
 */
export function syntheticEnvelope(opts = {}) {
  const durationMs = opts.durationMs || 3000;
  const hopMs = opts.hopMs || 20;
  const seed0 = opts.seed === undefined ? 7 : opts.seed;
  const n = Math.max(1, Math.round(durationMs / hopMs));
  let seed = seed0 % 2147483647;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out = new Array(n);
  let t = 0;
  while (t < n) {
    const burst = Math.max(3, Math.round((120 + rnd() * 220) / hopMs)); // 120..340ms
    const gap = Math.max(2, Math.round((60 + rnd() * 160) / hopMs)); // 60..220ms
    const amp = 0.45 + rnd() * 0.5;
    for (let i = 0; i < burst && t < n; i++, t++) {
      const p = i / burst;
      const attack = Math.min(1, p / 0.18);
      const release = Math.min(1, (1 - p) / 0.3);
      const wobble = 0.72 + 0.28 * Math.sin(i * 1.7 + seed0);
      out[t] = Math.min(1, amp * attack * release * wobble);
    }
    for (let i = 0; i < gap && t < n; i++, t++) out[t] = 0;
  }
  return out;
}
