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
  /**
   * Slow harmonic motion for a *sustained* voice: pitches it drifts between over
   * one loop, spaced evenly and **crossfaded**, never switched.
   *
   * A struck voice can change pitch instantly because its envelope is already at
   * zero between strikes ({@link VoiceSpec.sequenceHz}); a sustained voice can't
   * — a hard switch mid-note clicks. So each pitch is rendered across the whole
   * loop and weighted by an overlapping raised-cosine window, which makes the
   * change a morph. The windows are equal-power (adjacent weights square-sum to
   * 1), so the voice never dips in level as it moves.
   *
   * Keep the pitches inside the key: these voices are the harmonic foundation,
   * and any subset of layers has to stay consonant.
   *
   * **No pitch centre may land on a chorus cancellation node.** The detune
   * copies beat against each other over the loop, and where they cancel the
   * fundamental disappears — put a centre there and the voice renders its octave
   * instead of the note it is supposed to be featuring. Nudge
   * {@link VoiceSpec.driftPhase} rather than widening the chorus: wide spacing
   * moves the nodes off the centres but deepens the comb *between* them, which
   * turns a gentle swell into a throb. `test/synth.test.ts` asserts both.
   *
   * Ignored when `pulses` is set — a voice is either struck or sustained.
   */
  driftHz?: number[];
  /**
   * Slides the drift centres along the loop, in steps (`0.25` = a quarter of the
   * way to the next pitch). Used to keep every centre clear of a chorus node
   * while leaving the chorus itself gentle.
   */
  driftPhase?: number;
}

/**
 * Note frequencies used by {@link DEFAULT_VOICES}. The placeholder set is in
 * **D major**, so every pitch below is a D, F♯, A, C♯ or E — writing them out
 * keeps the voicing legible instead of a wall of decimals.
 */
const D_MAJOR = {
  D2: 73.42,
  A2: 110.0,
  D3: 146.83,
  Fs3: 185.0,
  G3: 196.0,
  A3: 220.0,
  B3: 246.94,
  D4: 293.66,
  E4: 329.63,
  Fs4: 369.99,
  G4: 392.0,
  A4: 440.0,
  B4: 493.88,
  Cs5: 554.37,
  D5: 587.33,
  E5: 659.26,
  Fs5: 739.99,
  A5: 880.0,
  D6: 1174.66,
} as const;

/**
 * Equal-power crossfade weight for drift pitch `index` of `count`, at `turn`
 * through the loop.
 *
 * Centres sit at `(index + phase) / count`; each window reaches zero at
 * ±`1/count`, so exactly two are ever non-zero and their squares sum to 1.
 * Distance wraps, which is what keeps the motion seamless across the loop point.
 *
 * `phase` slides all the centres together. It exists to keep a centre off a
 * chorus cancellation node — see {@link VoiceSpec.driftPhase}.
 */
export function driftWeight(turn: number, index: number, count: number, phase = 0): number {
  let distance = turn - (index + phase) / count;
  if (distance > 0.5) distance -= 1;
  if (distance < -0.5) distance += 1;

  const span = 1 / count;
  if (Math.abs(distance) >= span) return 0;
  return Math.cos((Math.PI * distance) / (2 * span));
}

/**
 * The default seven-layer voicing in **D major**, in the order
 * {@link tierToGains} switches them on: five progressive base layers, then the
 * richness pad, then the high-end model signature.
 *
 * Base layers spell D2 → A3 → F♯4 → C♯5 → E5: a root that grows into an open
 * fifth, then a major triad, then a major-seventh, then an added ninth.
 */
export const DEFAULT_VOICES: VoiceSpec[] = [
  // 0 — root drone. Carries the low end; slowest swell. Drifts tonic → dominant,
  // the one piece of motion you feel rather than hear.
  {
    hz: D_MAJOR.D2,
    partials: [1, 0.5, 0.18, 0.06],
    detune: [0, 2], // nodes at 0.25/0.75, clear of the centres at 0/0.5

    lfoCycles: 1,
    lfoDepth: 0.22,
    phase: 0,
    peak: 0.24,
    driftHz: [D_MAJOR.D2, D_MAJOR.A2],
  },
  // 1 — the fifth. Opens the root into a bare, hollow interval. Moving it to the
  // 6th and the 4th is what makes the stack read as Bm and G without any voice
  // leaving the key.
  {
    hz: D_MAJOR.A3,
    partials: [1, 0.35, 0.12],
    detune: [0, -1],
    lfoCycles: 2,
    lfoDepth: 0.28,
    phase: 0.2,
    peak: 0.17,
    driftHz: [D_MAJOR.A3, D_MAJOR.B3, D_MAJOR.G3],
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
    driftHz: [D_MAJOR.Fs4, D_MAJOR.G4, D_MAJOR.E4],
    driftPhase: 0.5, // a symmetric ±1 triple cancels at 1/3 and 2/3 — the centres
  },
  // 3 — the major seventh. Adds colour and a little tension; drifting to the 6th
  // releases it.
  {
    hz: D_MAJOR.Cs5,
    partials: [1, 0.22, 0.08],
    detune: [0, 2],
    lfoCycles: 5,
    lfoDepth: 0.4,
    phase: 0.65,
    peak: 0.1,
    driftHz: [D_MAJOR.Cs5, D_MAJOR.B4],
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
  // 5 — richness pad. A wide, heavily chorused wash sitting under everything,
  // breathing between the root and the fifth.
  {
    hz: D_MAJOR.D3,
    // 2nd partial held below the fundamental's worst-case chorus envelope (⅓): a
    // symmetric ±1 chorus cancels odd harmonics at turn 0.5 and reinforces even
    // ones, so at 0.4 the octave came through louder than the note itself.
    partials: [1, 0.25, 0.2, 0.1, 0.05],
    // Three copies, not five: a five-copy comb suppresses the fundamental to a
    // fifth of its level everywhere except turn 0, and at one drift centre that
    // was enough for the octave to come through louder than the note.
    detune: [0, 1, -1],
    lfoCycles: 1,
    lfoDepth: 0.5,
    phase: 0.5,
    peak: 0.15,
    driftHz: [D_MAJOR.D3, D_MAJOR.A3, D_MAJOR.G3],
    driftPhase: 0.5, // ±1 triple cancels at 1/3 and 2/3 — where the centres would sit
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

/**
 * One period of a sine, sampled at the loop length.
 *
 * Every sustained oscillator here is `sin(2π · cycles · n / loopLength)` with an
 * *integer* `cycles` — that is precisely a stride through a single-period table,
 * so the table is exact rather than an approximation. Sustained voices with drift
 * evaluate up to 75 oscillators per sample; calling `Math.sin` for each cost
 * about a second per rebuild, which the playground rebuilds on every slider drag.
 */
function sineTable(length: number): Float32Array {
  const table = new Float32Array(length);
  for (let n = 0; n < length; n++) table[n] = Math.sin((2 * Math.PI * n) / length);
  return table;
}

/**
 * Accumulate one oscillator (integer `cycles` per loop) into `into`, scaled by
 * `amp`.
 *
 * The index walks the sine table by a constant stride and wraps by subtraction.
 * The obvious formulation — `sine[(cycles * h * n) % length]` — is what this
 * replaces: that product exceeds int32, so it lands in floating point and the
 * modulo becomes an fmod, which cost more than the `Math.sin` calls it was meant
 * to avoid.
 */
function addOscillator(
  into: Float32Array,
  sine: Float32Array,
  cycles: number,
  amp: number,
): void {
  const length = sine.length;
  let index = 0;
  for (let n = 0; n < length; n++) {
    into[n]! += amp * sine[index]!;
    index += cycles;
    if (index >= length) index -= length;
  }
}

/** Render a single voice into a seamless mono loop of `loopLength` samples. */
function renderVoice(
  spec: VoiceSpec,
  loopLength: number,
  loopSeconds: number,
  sine: Float32Array,
): Float32Array {
  const buffer = new Float32Array(loopLength);

  // Quantize to whole cycles per loop — the seamlessness invariant.
  const baseCycles = Math.max(1, Math.round(spec.hz * loopSeconds));
  const detunes = spec.detune.length > 0 ? spec.detune : [0];
  const pulses = spec.pulses && spec.pulses > 0 ? Math.round(spec.pulses) : 0;
  const segment = pulses > 0 ? loopLength / pulses : 0;
  const segmentSeconds = pulses > 0 ? loopSeconds / pulses : 0;
  const sequence =
    pulses > 0 && spec.sequenceHz && spec.sequenceHz.length > 0 ? spec.sequenceHz : null;
  // Drift is for sustained voices only — a struck voice moves via `sequenceHz`.
  const drift = pulses === 0 && spec.driftHz && spec.driftHz.length > 1 ? spec.driftHz : null;

  if (sequence) {
    // A struck voice with a melody: each pulse is its own little loop, with its
    // own pitch quantized to whole cycles *within the segment*. The envelope is
    // zero at both ends of a segment, so changing pitch between strikes joins
    // silently — the whole reason a moving bell can stay seamless.
    //
    // Sample-at-a-time here rather than the accumulate pass used below: pitch
    // changes every segment, and only one is ever sounding, so there is nothing
    // to hoist.
    for (let n = 0; n < loopLength; n++) {
      const pulseIndex = Math.floor(n / segment);
      const local = (n - pulseIndex * segment) / segment; // 0..1 within the strike
      const hz = sequence[pulseIndex % sequence.length]!;
      const cyclesInSegment = Math.max(1, Math.round(hz * segmentSeconds));

      let sample = 0;
      for (const offset of detunes) {
        const cycles = Math.max(1, cyclesInSegment + Math.round(offset));
        for (let h = 0; h < spec.partials.length; h++) {
          const amp = spec.partials[h]!;
          if (amp === 0) continue;
          sample += amp * Math.sin(2 * Math.PI * cycles * (h + 1) * local);
        }
      }
      buffer[n] = sample * pluckEnvelope(local);
    }
  } else if (drift) {
    // Sustained voice with harmonic motion. One accumulate pass per pitch, then
    // that pitch's crossfade window is applied once — rather than per oscillator.
    const scratch = new Float32Array(loopLength);

    for (let d = 0; d < drift.length; d++) {
      scratch.fill(0);
      const pitchCycles = Math.max(1, Math.round(drift[d]! * loopSeconds));

      for (const offset of detunes) {
        const cycles = Math.max(1, pitchCycles + Math.round(offset));
        for (let h = 0; h < spec.partials.length; h++) {
          const amp = spec.partials[h]!;
          if (amp === 0) continue;
          addOscillator(scratch, sine, cycles * (h + 1), amp);
        }
      }

      for (let n = 0; n < loopLength; n++) {
        const weight = driftWeight(n / loopLength, d, drift.length, spec.driftPhase ?? 0);
        if (weight !== 0) buffer[n]! += scratch[n]! * weight;
      }
    }

    applySustainEnvelope(buffer, spec, loopLength);
  } else {
    for (const offset of detunes) {
      const cycles = Math.max(1, baseCycles + Math.round(offset));
      for (let h = 0; h < spec.partials.length; h++) {
        const amp = spec.partials[h]!;
        if (amp === 0) continue;
        addOscillator(buffer, sine, cycles * (h + 1), amp);
      }
    }

    if (pulses > 0) {
      for (let n = 0; n < loopLength; n++) buffer[n]! *= pluckEnvelope((n % segment) / segment);
    } else {
      applySustainEnvelope(buffer, spec, loopLength);
    }
  }

  normalize(buffer, spec.peak);
  return buffer;
}

/** Unipolar tremolo: never inverts phase, just breathes. */
function applySustainEnvelope(buffer: Float32Array, spec: VoiceSpec, loopLength: number): void {
  for (let n = 0; n < loopLength; n++) {
    const lfo = Math.sin(2 * Math.PI * (spec.lfoCycles * (n / loopLength) + spec.phase));
    buffer[n]! *= 1 - spec.lfoDepth + spec.lfoDepth * 0.5 * (1 + lfo);
  }
}

/** Scale to an exact peak so the mix budget stays predictable. */
function normalize(buffer: Float32Array, peak: number): void {
  let max = 0;
  for (let n = 0; n < buffer.length; n++) {
    const abs = Math.abs(buffer[n]!);
    if (abs > max) max = abs;
  }
  if (max === 0) return;
  const scale = peak / max;
  for (let n = 0; n < buffer.length; n++) buffer[n]! *= scale;
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
  const sine = sineTable(loopLength);
  const stems: Float32Array[] = [];

  for (let i = 0; i < count; i++) {
    const base = table[i % table.length]!;
    const override = options?.scaleHz?.[i % (options.scaleHz.length || 1)];
    const spec = typeof override === 'number' && override > 0 ? { ...base, hz: override } : base;
    stems.push(renderVoice(spec, loopLength, loopSeconds, sine));
  }

  return stems;
}
