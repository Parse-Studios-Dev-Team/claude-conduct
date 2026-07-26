/**
 * The crossfade engine — the heart of the daemon.
 *
 * Holds every stem's PCM in memory looping continuously, and each stem has a
 * *current* gain that chases a *target* gain by a bounded step every frame. A
 * tier change just moves the targets; the per-frame ramp guarantees the audible
 * level never jumps, which is precisely what prevents the pops/clicks you'd get
 * from starting or stopping a player per stem.
 *
 * Each stem also has its own slow auto-pan, so layers drift across the stereo
 * field independently and cross over one another instead of sitting in a fixed
 * stack. The starting position of every sweep is seeded (see
 * {@link defaultPanSpecs}), so a session doesn't open with the same spatial
 * arrangement twice.
 *
 * Pure and synchronous — no audio hardware, no clock, no globals — so the
 * "no pops / survives rapid changes" behaviour is fully unit-testable.
 */

/** One stem's stereo movement. A `depth` of 0 pins it to `center`. */
export interface PanSpec {
  /** Position the sweep orbits, `-1` (hard left) to `1` (hard right). */
  center: number;
  /** How far the sweep travels either side of `center`, `0`–`1`. */
  depth: number;
  /** Sweep rate in Hz. Deliberately tiny — a full pass takes tens of seconds. */
  rateHz: number;
  /** Where in the sweep the stem starts, `0`–`1`. Randomized per run by default. */
  phase: number;
}

export interface MixerOptions {
  /** Output sample rate (Hz). Default 44100. */
  sampleRate?: number;
  /** Time for a gain to travel the full 0↔1 range. Default 1500ms (within the ~1–2s spec). */
  crossfadeMs?: number;
  /** Master gain applied to the summed mix before clipping. Default 0.8. */
  masterGain?: number;
  /** Per-stem stereo movement. Defaults to {@link defaultPanSpecs} using `panSeed`. */
  pans?: PanSpec[];
  /**
   * Seed for the default pan layout. Omit for a fresh arrangement each run —
   * which is the point: the stems should not start in the same place twice.
   * Pass a fixed number for reproducible output (tests, rendering previews).
   */
  panSeed?: number;
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Small deterministic PRNG so a seed reproduces an arrangement exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a stereo arrangement for `count` stems.
 *
 * Rates are mutually detuned and slow (18–63s per pass) so layers separate and
 * re-converge without ever settling into a pattern. Stem 0 is treated as the
 * bass and kept near the middle with a shallow sweep — wide-panned low end
 * smears the image and reads as a mistake on speakers.
 */
export function defaultPanSpecs(count: number, seed: number): PanSpec[] {
  const random = mulberry32(seed);
  const specs: PanSpec[] = [];

  for (let i = 0; i < count; i++) {
    const isBass = i === 0;
    specs.push({
      center: isBass ? 0 : (random() * 2 - 1) * 0.35,
      depth: isBass ? 0.12 : 0.35 + random() * 0.35,
      rateHz: 1 / (18 + random() * 45),
      phase: random(), // the "starts somewhere else this time" knob
    });
  }

  return specs;
}

/**
 * How often pan coefficients are recomputed, in frames. Sweeps move over tens
 * of seconds, so holding a value for ~1.5ms is inaudible and saves two trig
 * calls per stem per frame.
 */
const PAN_UPDATE_FRAMES = 64;

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
  private readonly pans: PanSpec[];
  /** Per-stem left/right coefficients, refreshed every {@link PAN_UPDATE_FRAMES}. */
  private readonly panL: number[];
  private readonly panR: number[];
  /** Frames rendered so far — drives the pan sweeps. */
  private elapsedFrames = 0;

  constructor(stems: Float32Array[], options?: MixerOptions) {
    this.sampleRate = options?.sampleRate ?? 44_100;
    this.crossfadeMs = options?.crossfadeMs ?? 1_500;
    this.masterGain = options?.masterGain ?? 0.8;

    this.pcms = stems.slice();
    this.positions = stems.map(() => 0);
    this.gains = stems.map(() => 0);
    this.targets = stems.map(() => 0);

    const seed = options?.panSeed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    const supplied = options?.pans;
    this.pans =
      supplied && supplied.length >= stems.length
        ? supplied.slice(0, stems.length)
        : defaultPanSpecs(stems.length, seed);

    this.panL = stems.map(() => Math.SQRT1_2);
    this.panR = stems.map(() => Math.SQRT1_2);
    this.updatePan();

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

  /** The stereo arrangement in use — snapshot copy. */
  getPans(): PanSpec[] {
    return this.pans.map((pan) => ({ ...pan }));
  }

  /** Current pan position per stem, `-1`..`1` — for introspection and tests. */
  getPanPositions(): number[] {
    const seconds = this.elapsedFrames / this.sampleRate;
    return this.pans.map((pan) => this.positionOf(pan, seconds));
  }

  private positionOf(pan: PanSpec, seconds: number): number {
    return clamp(
      pan.center + pan.depth * Math.sin(2 * Math.PI * (pan.rateHz * seconds + pan.phase)),
      -1,
      1,
    );
  }

  /** Recompute equal-power left/right coefficients from the current sweep positions. */
  private updatePan(): void {
    const seconds = this.elapsedFrames / this.sampleRate;
    for (let i = 0; i < this.pans.length; i++) {
      const position = this.positionOf(this.pans[i]!, seconds);
      // Equal power: constant perceived loudness across the sweep. Centre sits
      // at √½ per channel rather than 1, which is what keeps a stem from getting
      // louder as it approaches either side.
      const angle = ((position + 1) * Math.PI) / 4;
      this.panL[i] = Math.cos(angle);
      this.panR[i] = Math.sin(angle);
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

  /** Snap current gains straight to their targets (no ramp) — e.g. a hard reset. */
  snapToTargets(): void {
    for (let i = 0; i < this.gains.length; i++) {
      this.gains[i] = this.targets[i]!;
    }
  }

  /**
   * Render `frames` of **interleaved stereo** (`[L0, R0, L1, R1, …]`, so the
   * returned array is `frames * 2` long), advancing every stem's loop by one
   * sample per frame, stepping each gain toward its target, and moving each
   * stem's pan along its sweep. Output is master-scaled and hard-clamped.
   */
  render(frames: number): Float32Array {
    const frameCount = Math.max(0, frames | 0);
    const out = new Float32Array(frameCount * 2);
    const n = this.pcms.length;
    const step = this.gainStepPerFrame;
    const master = this.masterGain;

    for (let f = 0; f < frameCount; f++) {
      if (this.elapsedFrames % PAN_UPDATE_FRAMES === 0) this.updatePan();

      let left = 0;
      let right = 0;

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
          const sample = pcm[pos]! * g;
          left += sample * this.panL[i]!;
          right += sample * this.panR[i]!;
          pos += 1;
          this.positions[i] = pos >= len ? 0 : pos; // seamless loop wrap
        }
      }

      out[f * 2] = clamp(left * master, -1, 1);
      out[f * 2 + 1] = clamp(right * master, -1, 1);
      this.elapsedFrames += 1;
    }

    return out;
  }
}
