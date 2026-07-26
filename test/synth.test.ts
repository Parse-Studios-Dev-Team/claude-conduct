import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeStems, DEFAULT_VOICES } from '../src/audio/synth';

const SAMPLE_RATE = 44_100;
const LOOP_MS = 8_000;

const peakOf = (buffer: Float32Array): number => {
  let max = 0;
  for (const sample of buffer) {
    const abs = Math.abs(sample);
    if (abs > max) max = abs;
  }
  return max;
};

/** Largest jump between adjacent samples inside the loop. */
const maxInternalStep = (buffer: Float32Array): number => {
  let max = 0;
  for (let n = 1; n < buffer.length; n++) {
    const step = Math.abs(buffer[n]! - buffer[n - 1]!);
    if (step > max) max = step;
  }
  return max;
};

test('produces the requested number of equal-length stems', () => {
  const stems = synthesizeStems(7, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });
  assert.equal(stems.length, 7);
  const expected = (LOOP_MS / 1000) * SAMPLE_RATE;
  for (const stem of stems) assert.equal(stem.length, expected);
});

test('every stem loops seamlessly: the wrap is no bigger than an internal step', () => {
  const stems = synthesizeStems(DEFAULT_VOICES.length, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });

  stems.forEach((stem, i) => {
    const wrap = Math.abs(stem[0]! - stem[stem.length - 1]!);
    const internal = maxInternalStep(stem);
    // A click at the loop point shows up as a wrap discontinuity far larger
    // than any step the waveform takes mid-loop.
    assert.ok(
      wrap <= internal * 1.5,
      `stem ${i}: wrap ${wrap} exceeds 1.5× max internal step ${internal}`,
    );
  });
});

test('each stem is normalized to its voice peak, leaving mix headroom', () => {
  const stems = synthesizeStems(DEFAULT_VOICES.length, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });

  stems.forEach((stem, i) => {
    assert.ok(Math.abs(peakOf(stem) - DEFAULT_VOICES[i]!.peak) < 1e-6, `stem ${i} peak`);
  });

  // Worst case (every stem at full gain) must still leave room before clipping.
  const sum = DEFAULT_VOICES.reduce((total, voice) => total + voice.peak, 0);
  assert.ok(sum < 1, `summed peaks ${sum} would clip`);
});

test('stacking base layers builds a chord of distinct pitches, not octave copies', () => {
  const pitches = DEFAULT_VOICES.slice(0, 5).map((voice) => voice.hz);
  const pitchClasses = pitches.map((hz) => {
    // Fold to a single octave; distinct values mean distinct scale degrees.
    let folded = hz;
    while (folded >= 130.81 * 2) folded /= 2;
    while (folded < 130.81) folded *= 2;
    return Math.round(folded);
  });
  assert.equal(new Set(pitchClasses).size, pitches.length);
});

test('plucked voices start silent so each strike joins cleanly', () => {
  const plucked = DEFAULT_VOICES.map((voice, i) => ({ voice, i })).filter(
    ({ voice }) => voice.pulses,
  );
  assert.ok(plucked.length > 0, 'expected at least one plucked voice');

  const stems = synthesizeStems(DEFAULT_VOICES.length, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });
  for (const { i } of plucked) {
    assert.ok(Math.abs(stems[i]![0]!) < 1e-6, `stem ${i} should start at silence`);
  }
});

test('scaleHz overrides fundamentals without discarding the voice design', () => {
  const [stem] = synthesizeStems(1, {
    sampleRate: SAMPLE_RATE,
    loopMs: LOOP_MS,
    scaleHz: [220],
  });
  assert.ok(Math.abs(peakOf(stem!) - DEFAULT_VOICES[0]!.peak) < 1e-6);
});

// --- The moving bell (sequenceHz) -------------------------------------------

test('the signature bell walks a sequence: each strike has a different dominant pitch', () => {
  const bellIndex = DEFAULT_VOICES.length - 1;
  const bell = DEFAULT_VOICES[bellIndex]!;
  assert.ok(bell.sequenceHz && bell.sequenceHz.length > 1, 'bell must carry a melody');
  assert.equal(bell.pulses, bell.sequenceHz!.length, 'one strike per note');

  const stems = synthesizeStems(DEFAULT_VOICES.length, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });
  const stem = stems[bellIndex]!;
  const segment = stem.length / bell.pulses!;

  // Project each strike onto every note of the melody (a one-bin DFT per
  // candidate). The strike's own note must carry the most energy — this is
  // robust to the bell's strong odd harmonics, which fool zero-crossing counts.
  const energyAt = (from: number, to: number, hz: number): number => {
    let re = 0;
    let im = 0;
    for (let n = from; n < to; n++) {
      const angle = (2 * Math.PI * hz * (n - from)) / SAMPLE_RATE;
      re += stem[n]! * Math.cos(angle);
      im += stem[n]! * Math.sin(angle);
    }
    return re * re + im * im;
  };

  const notes = [...new Set(bell.sequenceHz!)];
  bell.sequenceHz!.forEach((target, i) => {
    const from = Math.floor(i * segment);
    const to = Math.floor(i * segment + segment * 0.5);
    let best = notes[0]!;
    let bestEnergy = -1;
    for (const note of notes) {
      const energy = energyAt(from, to, note);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        best = note;
      }
    }
    assert.equal(best, target, `strike ${i}: dominant note ${best}Hz, wanted ${target}Hz`);
  });
});

test('every bell note is a D-major triad tone, so it lands consonant on any layer subset', () => {
  const bell = DEFAULT_VOICES[DEFAULT_VOICES.length - 1]!;
  // Compare pitch classes in log space: distance from D as a fraction of an
  // octave. Immune to the rounding traps of dividing frequencies down by 2.
  const D = 73.42;
  const classes = [0, Math.log2(92.5 / D), Math.log2(110.0 / D)]; // D, F#, A
  for (const hz of bell.sequenceHz!) {
    const cls = ((Math.log2(hz / D) % 1) + 1) % 1;
    const near = classes.some((c) => {
      const d = Math.abs(cls - c);
      return Math.min(d, 1 - d) < 0.005; // within half a semitone's neighborhood
    });
    assert.ok(near, `${hz}Hz is not a D/F#/A triad tone (pitch class ${cls.toFixed(4)})`);
  }
});

test('a sequenced strike still joins silently at every segment boundary', () => {
  const bellIndex = DEFAULT_VOICES.length - 1;
  const bell = DEFAULT_VOICES[bellIndex]!;
  const stems = synthesizeStems(DEFAULT_VOICES.length, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS });
  const stem = stems[bellIndex]!;
  const segment = stem.length / bell.pulses!;

  for (let i = 0; i < bell.pulses!; i++) {
    const boundary = Math.round(i * segment);
    assert.ok(
      Math.abs(stem[boundary]!) < 1e-3,
      `pitch change at strike ${i} would click (sample ${stem[boundary]})`,
    );
  }
});
