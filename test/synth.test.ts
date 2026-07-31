import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeStems,
  DEFAULT_VOICES,
  driftWeight,
  type VoiceSpec,
} from '../src/audio/synth';

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

// --- Drifting sustained voices (driftHz) ------------------------------------

test('drift windows are equal-power: squares sum to 1, at most two open at once', () => {
  for (const count of [2, 3, 4, 5]) {
    for (let step = 0; step < 200; step++) {
      const turn = step / 200;
      const weights = Array.from({ length: count }, (_, i) => driftWeight(turn, i, count));

      const power = weights.reduce((sum, w) => sum + w * w, 0);
      assert.ok(
        Math.abs(power - 1) < 1e-9,
        `count ${count} at turn ${turn.toFixed(3)}: power ${power}`,
      );

      const open = weights.filter((w) => w > 0).length;
      assert.ok(open <= 2, `count ${count} at turn ${turn.toFixed(3)}: ${open} windows open`);
    }
  }
});

test('drift weight is 1 at a pitch centre and 0 at its neighbours', () => {
  // Three pitches: centres at 0, 1/3, 2/3.
  assert.ok(Math.abs(driftWeight(0, 0, 3) - 1) < 1e-9);
  assert.equal(driftWeight(1 / 3, 0, 3), 0);
  assert.equal(driftWeight(2 / 3, 0, 3), 0);
  // Wrapping: just before the loop end is just before centre 0, not far from it.
  assert.ok(driftWeight(0.999, 0, 3) > 0.99, 'distance must wrap across the loop point');
});

test('every drifting voice actually changes pitch across the loop', () => {
  const stems = synthesizeStems(DEFAULT_VOICES.length, {
    sampleRate: SAMPLE_RATE,
    loopMs: LOOP_MS,
  });

  DEFAULT_VOICES.forEach((voice, vi) => {
    if (!voice.driftHz) return;
    assertDriftPitches(stems[vi]!, voice.driftHz, vi, voice.driftPhase ?? 0);
  });
});

function assertDriftPitches(
  stem: Float32Array,
  pitches: number[],
  vi: number,
  phase: number,
): void {

  // One-bin DFT over a short window centred on each drift centre. Robust to the
  // tremolo and chorus, both of which a zero-crossing count would trip over.
  const energyAt = (centre: number, hz: number): number => {
    const mid = Math.round(centre * stem.length);
    const span = Math.round(SAMPLE_RATE * 0.4);
    const from = Math.max(0, mid - span / 2);
    const to = Math.min(stem.length, from + span);
    let re = 0;
    let im = 0;
    for (let n = from; n < to; n++) {
      const angle = (2 * Math.PI * hz * (n - from)) / SAMPLE_RATE;
      re += stem[n]! * Math.cos(angle);
      im += stem[n]! * Math.sin(angle);
    }
    return re * re + im * im;
  };

  pitches.forEach((target, i) => {
    // Centres are phase-shifted off the chorus nodes, so probe where the pitch
    // actually is, not where an unphased layout would put it.
    const centre = ((i + phase) / pitches.length) % 1;
    let best = pitches[0]!;
    let bestEnergy = -1;
    for (const candidate of pitches) {
      const energy = energyAt(centre, candidate);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        best = candidate;
      }
    }
    assert.equal(
      best,
      target,
      `voice ${vi} at centre ${centre.toFixed(2)}: heard ${best}Hz, wanted ${target}Hz`,
    );
  });
}

test('every drift pitch stays in D major, so any layer subset stays consonant', () => {
  // D major scale as pitch classes measured in log space from D.
  const D = 73.42;
  const scale = [
    1, // D
    9 / 8, // E
    5 / 4 * 1.0079, // F# (equal temperament)
    4 / 3, // G
    3 / 2, // A
    27 / 16, // B
    15 / 8 * 1.0000, // C#
  ].map((ratio) => Math.log2(ratio) % 1);

  for (const voice of DEFAULT_VOICES) {
    for (const hz of voice.driftHz ?? []) {
      const cls = ((Math.log2(hz / D) % 1) + 1) % 1;
      const near = scale.some((s) => {
        const d = Math.abs(cls - ((s % 1) + 1) % 1);
        return Math.min(d, 1 - d) < 0.012; // ~a fifth of a semitone
      });
      assert.ok(near, `${hz}Hz is outside D major (pitch class ${cls.toFixed(4)})`);
    }
  }
});

test('drift is ignored on a struck voice — a voice is either struck or sustained', () => {
  const struck: VoiceSpec = {
    ...DEFAULT_VOICES[0]!,
    pulses: 4,
    driftHz: [100, 200],
    sequenceHz: [440, 660, 880, 1100],
  };
  const [withBoth] = synthesizeStems(1, { sampleRate: SAMPLE_RATE, loopMs: LOOP_MS, voices: [struck] });

  const sequenceOnly: VoiceSpec = { ...struck };
  delete sequenceOnly.driftHz;
  const [withoutDrift] = synthesizeStems(1, {
    sampleRate: SAMPLE_RATE,
    loopMs: LOOP_MS,
    voices: [sequenceOnly],
  });

  assert.deepEqual([...withBoth!.slice(0, 5000)], [...withoutDrift!.slice(0, 5000)]);
});

test('the sustained layers now drift, and the drone is no longer one held pitch', () => {
  // The complaint that drove this: the low voices held a single note forever.
  const sustained = DEFAULT_VOICES.filter((v) => !v.pulses);
  assert.ok(sustained.length >= 4);
  for (const voice of sustained) {
    assert.ok(voice.driftHz && voice.driftHz.length > 1, `a sustained voice should move`);
  }

  // Mixed step counts, so the combined harmony doesn't snap between two chords.
  const counts = new Set(sustained.map((v) => v.driftHz!.length));
  assert.ok(counts.size > 1, 'voices must drift at different rates');
});

test('no drift centre sits on a chorus cancellation node', () => {
  // The invariant that keeps a drifting voice from losing its fundamental. The
  // detune copies beat over the loop; where they cancel, the fundamental is gone,
  // and a pitch centre placed there renders as its octave instead of the note.
  //
  // This shipped twice while building drift: the root's ±1 chorus cancels at turn
  // 0.5 where its second pitch sat, and the third's symmetric ±1 triple cancels
  // at 1/3 and 2/3 where all three of its pitches sat. `driftPhase` slides the
  // centres clear.
  //
  // The bar is deliberately "not a node", not "maximal". Chasing maximal by
  // widening the chorus deepens the comb *between* centres, which trades a gentle
  // swell for a throb — measurably worse.
  for (const [index, voice] of DEFAULT_VOICES.entries()) {
    const drift = voice.driftHz;
    if (!drift) continue;
    const phase = voice.driftPhase ?? 0;

    drift.forEach((_, i) => {
      const turn = ((i + phase) / drift.length) % 1;
      let re = 0;
      let im = 0;
      for (const offset of voice.detune) {
        re += Math.cos(2 * Math.PI * offset * turn);
        im += Math.sin(2 * Math.PI * offset * turn);
      }
      const envelope = Math.hypot(re, im) / voice.detune.length;
      assert.ok(
        envelope > 0.15,
        `voice ${index} at centre ${turn.toFixed(3)}: chorus envelope ${envelope.toFixed(3)} — on a node`,
      );
    });
  }
});

test('driftPhase slides the centres and is what keeps them off the nodes', () => {
  // Unphased, a 2-step drift centres on 0 and 0.5; a ±1 chorus cancels at 0.5.
  const unphased = driftWeight(0.5, 1, 2, 0);
  assert.ok(Math.abs(unphased - 1) < 1e-9, 'centre 1 of 2 sits at turn 0.5 unphased');

  // A half-step phase moves them to 0.25 and 0.75.
  assert.ok(Math.abs(driftWeight(0.25, 0, 2, 0.5) - 1) < 1e-9);
  assert.ok(Math.abs(driftWeight(0.75, 1, 2, 0.5) - 1) < 1e-9);

  // Equal-power still holds with a phase applied.
  for (let step = 0; step < 100; step++) {
    const turn = step / 100;
    const power = [0, 1, 2].reduce((sum, i) => sum + driftWeight(turn, i, 3, 0.5) ** 2, 0);
    assert.ok(Math.abs(power - 1) < 1e-9, `phased power ${power} at turn ${turn}`);
  }
});
