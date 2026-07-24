/**
 * The crossfade engine — the heart of the daemon.
 *
 * Holds every stem's PCM in memory looping continuously, and each stem has a
 * *current* gain that chases a *target* gain by a bounded step every frame. A
 * tier change just moves the targets; the per-frame ramp guarantees the audible
 * level never jumps, which is precisely what prevents the pops/clicks you'd get
 * from starting or stopping a player per stem.
 *
 * Pure and synchronous — no audio hardware, no clock, no globals — so the
 * "no pops / survives rapid changes" behaviour is fully unit-testable.
 */

export interface MixerOptions {
  /** Output sample rate (Hz). Default 44100. */
  sampleRate?: number;
  /** Time for a gain to travel the full 0↔1 range. Default 1500ms (within the ~1–2s spec). */
  crossfadeMs?: number;
  /** Master gain applied to the summed mix before clipping. Default 0.8. */
  masterGain?: number;
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

export class Mixer {
  readonly sampleRate: number;
  readonly crossfadeMs: number;
  /** Max gain change per frame; a full crossfade takes `crossfadeMs`. */
  readonly gainStepPerFrame: number;

  private masterGain: number;
  private readonly pcms: Float32Array[];
  private readonly positions: number[];
  private readonly gains: number[];
  private readonly targets: number[];

  constructor(stems: Float32Array[], options?: MixerOptions) {
    this.sampleRate = options?.sampleRate ?? 44_100;
    this.crossfadeMs = options?.crossfadeMs ?? 1_500;
    this.masterGain = options?.masterGain ?? 0.8;

    this.pcms = stems.slice();
    this.positions = stems.map(() => 0);
    this.gains = stems.map(() => 0);
    this.targets = stems.map(() => 0);

    const crossfadeSamples = Math.max(1, Math.round((this.crossfadeMs / 1000) * this.sampleRate));
    this.gainStepPerFrame = 1 / crossfadeSamples;
  }

  get stemCount(): number {
    return this.pcms.length;
  }

  /** Current (audible) gains — snapshot copy. */
  getGains(): number[] {
    return this.gains.slice();
  }

  /** Target gains the mix is ramping toward — snapshot copy. */
  getTargets(): number[] {
    return this.targets.slice();
  }

  /**
   * Set the target gain per stem (each clamped to `[0,1]`). The mix crossfades
   * toward these over ~`crossfadeMs`. Extra targets are ignored; missing ones
   * leave that stem's target unchanged. Non-finite values become 0.
   */
  setTargets(targets: readonly number[]): void {
    const count = Math.min(this.targets.length, targets.length);
    for (let i = 0; i < count; i++) {
      const value = targets[i];
      this.targets[i] = clamp(typeof value === 'number' && Number.isFinite(value) ? value : 0, 0, 1);
    }
  }

  /** Master output gain currently applied to the mix. */
  getMasterGain(): number {
    return this.masterGain;
  }

  /** Set the master output gain, clamped to `[0, 1]` (used for live volume / mute). */
  setMasterGain(gain: number): void {
    this.masterGain = clamp(typeof gain === 'number' && Number.isFinite(gain) ? gain : 0, 0, 1);
  }

  /** Snap current gains straight to their targets (no ramp) — e.g. a hard reset. */
  snapToTargets(): void {
    for (let i = 0; i < this.gains.length; i++) {
      this.gains[i] = this.targets[i]!;
    }
  }

  /**
   * Render `frames` mono samples into a fresh `Float32Array`, advancing every
   * stem's loop by one sample per frame and stepping each gain toward its target.
   * Output is master-scaled and hard-clamped to `[-1, 1]`.
   */
  render(frames: number): Float32Array {
    const out = new Float32Array(Math.max(0, frames | 0));
    const n = this.pcms.length;
    const step = this.gainStepPerFrame;
    const master = this.masterGain;

    for (let f = 0; f < out.length; f++) {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        // Ramp this stem's gain toward its target by at most `step`.
        let g = this.gains[i]!;
        const target = this.targets[i]!;
        if (g < target) g = Math.min(target, g + step);
        else if (g > target) g = Math.max(target, g - step);
        this.gains[i] = g;

        const pcm = this.pcms[i]!;
        const len = pcm.length;
        if (len > 0) {
          let pos = this.positions[i]!;
          acc += pcm[pos]! * g;
          pos += 1;
          this.positions[i] = pos >= len ? 0 : pos; // seamless loop wrap
        }
      }
      out[f] = clamp(acc * master, -1, 1);
    }
    return out;
  }
}
