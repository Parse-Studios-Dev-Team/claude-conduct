/**
 * Placeholder stem generator. Until CC-4 delivers real recorded stems, the
 * daemon runs on synthesized voices so it is fully runnable and testable.
 *
 * Every stem is a **seamless** mono loop: each oscillator, each detune voice and
 * each modulator completes a whole number of cycles over the shared loop length,
 * so the wrap point is phase-continuous (no click) and all stems stay
 * phase-locked with each other.
 *
 * The design goal is that *stacking* stems is what creates the music. Rather
 * than octave-doubling one chord, each successive base stem introduces a new
 * degree — root → fifth → third → major seventh → ninth — so turning a layer on
 * changes the *chord quality*, not just the density. Motion comes from per-voice
 * tremolo at mutually prime rates plus slow chorus detuning, and the top layers
 * are plucked rather than sustained, so a busy session gains rhythm as well as
 * harmony.
 */

/**
 * One synthesized layer. Frequencies are quantized to whole cycles-per-loop
 * before rendering, which is what keeps the loop seamless.
 */
export interface VoiceSpec {
  /** Fundamental pitch (Hz), quantized to a whole number of cycles per loop. */
  hz: number;
  /** Relative amplitude of harmonic 1, 2, 3, … A 0 entry omits that partial. */
  partials: number[];
  /**
   * Chorus offsets in *whole cycles per loop*. Each entry is an extra copy of
   * the voice detuned by `offset / loopSeconds` Hz, so the beating it creates is
   * itself loop-periodic. `[0]` means no chorus.
   */
  detune: number[];
  /** Tremolo rate in whole cycles per loop. Ignored when `pulses` is set. */
  lfoCycles: number;
  /** Tremolo depth, `0` (flat) to `1` (full). Ignored when `pulses` is set. */
  lfoDepth: number;
  /** Phase offset of the tremolo, in loops (`0..1`), so voices don't swell together. */
  phase: number;
  /** Peak amplitude after normalization — the layer's weight in the mix. */
  peak: number;
  /**
   * When set, the voice is *plucked* this many times per loop with a percussive
   * decay envelope instead of being sustained. The envelope reaches zero at each
   * segment boundary, so it stays seamless.
   */
  pulses?: number;
  /**
   * Melody for a struck voice: one pitch (Hz) per pulse, cycling if there are
   * more pulses than notes. Requires `pulses`. When present it replaces
   * {@link VoiceSpec.hz} entirely — including any `scaleHz` override — because
   * the voice no longer has a single fundamental.
   */
  sequenceHz?: number[];
}

/**
 * Note frequencies used by {@link DEFAULT_VOICES}. The placeholder set is in
 * **D major**, so every pitch below is a D, F♯, A, C♯ or E — writing them out
 * keeps the voicing legible instead of a wall of decimals.
 */
const D_MAJOR = {
  D2: 73.42,
  D3: 146.83,
  Fs3: 185.0,
  A3: 220.0,
  D4: 293.66,
  Fs4: 369.99,
  A4: 440.0,
  Cs5: 554.37,
  D5: 587.33,
  E5: 659.26,
  Fs5: 739.99,
  A5: 880.0,
  D6: 1174.66,
} as const;

/**
 * The default seven-layer voicing in **D major**, in the order
 * {@link tierToGains} switches them on: five progressive base layers, then the
 * richness pad, then the high-end model signature.
 *
 * Base layers spell D2 → A3 → F♯4 → C♯5 → E5: a root that grows into an open
 * fifth, then a major triad, then a major-seventh, then an added ninth.
 */
export const DEFAULT_VOICES: VoiceSpec[] = [
  // 0 — root drone. Carries the low end; slowest swell.
  {
    hz: D_MAJOR.D2,
    partials: [1, 0.5, 0.18, 0.06],
    detune: [0, 1],
    lfoCycles: 1,
    lfoDepth: 0.22,
    phase: 0,
    peak: 0.24,
  },
  // 1 — the fifth. Opens the root into a bare, hollow interval.
  {
    hz: D_MAJOR.A3,
    partials: [1, 0.35, 0.12],
    detune: [0, -1],
    lfoCycles: 2,
    lfoDepth: 0.28,
    phase: 0.2,
    peak: 0.17,
  },
  // 2 — the major third. Completes the triad; the chord finally has a quality.
  {
    hz: D_MAJOR.Fs4,
    partials: [1, 0.28, 0.1, 0.04],
    detune: [0, 1, -1],
    lfoCycles: 3,
    lfoDepth: 0.34,
    phase: 0.45,
    peak: 0.13,
  },
  // 3 — the major seventh. Adds colour and a little tension.
  {
    hz: D_MAJOR.Cs5,
    partials: [1, 0.22, 0.08],
    detune: [0, 2],
    lfoCycles: 5,
    lfoDepth: 0.4,
    phase: 0.65,
    peak: 0.1,
  },
  // 4 — the ninth, plucked. The busiest sessions gain motion, not just weight.
  {
    hz: D_MAJOR.E5,
    partials: [1, 0.3, 0.12, 0.05],
    detune: [0, -2],
    lfoCycles: 7,
    lfoDepth: 0.45,
    phase: 0.8,
    peak: 0.085,
    pulses: 8,
  },
  // 5 — richness pad. A wide, heavily chorused wash sitting under everything.
  {
    hz: D_MAJOR.D3,
    partials: [1, 0.4, 0.2, 0.1, 0.05],
    detune: [0, 1, -1, 2, -2],
    lfoCycles: 1,
    lfoDepth: 0.5,
    phase: 0.5,
    peak: 0.15,
  },
  // 6 — high-end model signature (CC-8): a bell that moves. Eight strikes per
  // loop, one every two seconds, walking a D-major figure across two and a half
  // octaves instead of repeating one pitch. Deliberate wide leaps rather than a
  // scale run, so it reads as a phrase and not an exercise.
  //
  // Every note is a D, F♯ or A — a tone of the triad the drones are already
  // holding — so whichever layers happen to be on, the bell lands consonant.
  // Odd partials only, which is what gives it the hollow, struck-metal quality.
  {
    hz: D_MAJOR.D5, // unused while `sequenceHz` is set; kept as the voice's home note
    partials: [1, 0, 0.4, 0, 0.15],
    detune: [0, 1],
    lfoCycles: 0,
    lfoDepth: 0,
    phase: 0,
    peak: 0.07,
    pulses: 8,
    sequenceHz: [
      D_MAJOR.D5, // mid
      D_MAJOR.A3, // drop low
      D_MAJOR.Fs5, // up high
      D_MAJOR.D4, // back down
      D_MAJOR.A5, // higher still
      D_MAJOR.Fs3, // bottom of the figure
      D_MAJOR.D6, // top of the figure
      D_MAJOR.A4, // settle in the middle
    ],
  },
];

export interface SynthOptions {
  sampleRate?: number;
  /** Loop length in ms (shared by all stems). Default 8000. */
  loopMs?: number;
  /** Override the per-stem fundamentals (Hz); other voice traits are kept. */
  scaleHz?: number[];
  /** Replace the voice table outright. */
  voices?: VoiceSpec[];
}

/** Percussive envelope for one pluck; 0 at both ends so segments join silently. */
function pluckEnvelope(t: number): number {
  return (1 - Math.exp(-t * 220)) * Math.exp(-t * 6);
}

/** Render a single voice into a seamless mono loop of `loopLength` samples. */
function renderVoice(spec: VoiceSpec, loopLength: number, loopSeconds: number): Float32Array {
  const buffer = new Float32Array(loopLength);

  // Quantize to whole cycles per loop — the seamlessness invariant.
  const baseCycles = Math.max(1, Math.round(spec.hz * loopSeconds));
  const detunes = spec.detune.length > 0 ? spec.detune : [0];
  const pulses = spec.pulses && spec.pulses > 0 ? Math.round(spec.pulses) : 0;
  const segment = pulses > 0 ? loopLength / pulses : 0;
  const segmentSeconds = pulses > 0 ? loopSeconds / pulses : 0;
  const sequence = pulses > 0 && spec.sequenceHz && spec.sequenceHz.length > 0 ? spec.sequenceHz : null;

  for (let n = 0; n < loopLength; n++) {
    let sample = 0;
    let envelope: number;

    if (sequence) {
      // A struck voice with a melody: each pulse is its own little loop, with its
      // own pitch quantized to whole cycles *within the segment*. The envelope is
      // zero at both ends of a segment, so changing pitch between strikes joins
      // silently — which is the whole reason a moving bell can stay seamless.
      const pulseIndex = Math.floor(n / segment);
      const local = (n - pulseIndex * segment) / segment; // 0..1 within the strike
      const hz = sequence[pulseIndex % sequence.length]!;
      const cyclesInSegment = Math.max(1, Math.round(hz * segmentSeconds));

      for (const offset of detunes) {
        const cycles = Math.max(1, cyclesInSegment + Math.round(offset));
        for (let h = 0; h < spec.partials.length; h++) {
          const amp = spec.partials[h]!;
          if (amp === 0) continue;
          sample += amp * Math.sin(2 * Math.PI * cycles * (h + 1) * local);
        }
      }
      envelope = pluckEnvelope(local);
    } else {
      const turn = n / loopLength; // position through the loop, 0..1

      for (const offset of detunes) {
        const cycles = Math.max(1, baseCycles + Math.round(offset));
        for (let h = 0; h < spec.partials.length; h++) {
          const amp = spec.partials[h]!;
          if (amp === 0) continue;
          sample += amp * Math.sin(2 * Math.PI * cycles * (h + 1) * turn);
        }
      }

      if (pulses > 0) {
        envelope = pluckEnvelope((n % segment) / segment);
      } else {
        // Unipolar tremolo: never inverts phase, just breathes.
        const lfo = Math.sin(2 * Math.PI * (spec.lfoCycles * turn + spec.phase));
        envelope = 1 - spec.lfoDepth + spec.lfoDepth * 0.5 * (1 + lfo);
      }
    }

    buffer[n] = sample * envelope;
  }

  // Normalize to the voice's intended weight so the mix budget is predictable.
  let max = 0;
  for (let n = 0; n < loopLength; n++) {
    const abs = Math.abs(buffer[n]!);
    if (abs > max) max = abs;
  }
  if (max > 0) {
    const scale = spec.peak / max;
    for (let n = 0; n < loopLength; n++) buffer[n]! *= scale;
  }

  return buffer;
}

/**
 * Generate `count` seamless placeholder stems as mono `Float32Array` loops, all
 * the same length. Stems beyond the voice table wrap around it.
 */
export function synthesizeStems(count: number, options?: SynthOptions): Float32Array[] {
  const sampleRate = options?.sampleRate ?? 44_100;
  const loopMs = options?.loopMs ?? 8_000;
  const table = options?.voices && options.voices.length > 0 ? options.voices : DEFAULT_VOICES;

  const loopLength = Math.max(1, Math.round((loopMs / 1000) * sampleRate));
  const loopSeconds = loopLength / sampleRate;
  const stems: Float32Array[] = [];

  for (let i = 0; i < count; i++) {
    const base = table[i % table.length]!;
    const override = options?.scaleHz?.[i % (options.scaleHz.length || 1)];
    const spec = typeof override === 'number' && override > 0 ? { ...base, hz: override } : base;
    stems.push(renderVoice(spec, loopLength, loopSeconds));
  }

  return stems;
}
