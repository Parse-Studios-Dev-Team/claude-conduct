import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer, defaultPanSpecs, type PanSpec } from '../src/audio/mixer';

/** A constant-value mono buffer — isolates gain behaviour from waveform content. */
const flat = (len: number, value = 1): Float32Array =>
  Float32Array.from({ length: len }, () => value);

/**
 * Pin every stem hard-left, so the left channel carries the raw summed mix and
 * gain assertions stay exact regardless of the stereo layer.
 */
const pinnedLeft = (count: number): PanSpec[] =>
  Array.from({ length: count }, () => ({ center: -1, depth: 0, rateHz: 0, phase: 0 }));

/** Pull one channel out of an interleaved stereo block. */
const channel = (block: Float32Array, index: 0 | 1): number[] => {
  const out: number[] = [];
  for (let i = index; i < block.length; i += 2) out.push(block[i]!);
  return out;
};

test('gain ramps smoothly toward its target — every step is bounded by gainStepPerFrame', () => {
  const m = new Mixer([flat(4)], { sampleRate: 1000, crossfadeMs: 100 });
  assert.equal(m.gainStepPerFrame, 0.01); // 1 / (0.1s * 1000Hz)
  m.setTargets([1]);

  let prev = 0;
  for (let i = 0; i < 100; i++) {
    m.render(1);
    const g = m.getGains()[0]!;
    const delta = g - prev;
    assert.ok(delta >= -1e-9 && delta <= 0.01 + 1e-9, `step ${delta} exceeded bound`);
    prev = g;
  }
  assert.ok(Math.abs(prev - 1) < 1e-9, 'reaches the target by the end of the crossfade');
});

test('crossfade duration: ~halfway at half-time, complete at full time', () => {
  const m = new Mixer([flat(4)], { sampleRate: 1000, crossfadeMs: 100 });
  m.setTargets([1]);
  m.render(50);
  assert.ok(Math.abs(m.getGains()[0]! - 0.5) < 1e-9);
  m.render(50);
  assert.ok(Math.abs(m.getGains()[0]! - 1) < 1e-9);
});

test('fade-out ramps down symmetrically', () => {
  const m = new Mixer([flat(4)], { sampleRate: 1000, crossfadeMs: 100 });
  m.setTargets([1]);
  m.snapToTargets();
  assert.equal(m.getGains()[0], 1);
  m.setTargets([0]);
  m.render(100);
  assert.ok(Math.abs(m.getGains()[0]!) < 1e-9);
});

test('no clicks: output never jumps by more than masterGain*step while a stem fades in', () => {
  const m = new Mixer([flat(4)], {
    sampleRate: 1000,
    crossfadeMs: 100,
    masterGain: 0.8,
    pans: pinnedLeft(1),
  });
  m.setTargets([1]);
  const block = channel(m.render(200), 0); // 100 frames of fade-in + 100 steady
  // Bound = masterGain * gainStep, plus a Float32 quantization allowance (the
  // output buffer is 32-bit). A real click would be orders of magnitude larger.
  const bound = 0.8 * 0.01 + 1e-6;
  for (let i = 1; i < block.length; i++) {
    const jump = Math.abs(block[i]! - block[i - 1]!);
    assert.ok(jump <= bound, `sample jump ${jump} would click`);
  }
});

test('seamless loop: the position wraps cleanly at the buffer boundary', () => {
  const m = new Mixer([Float32Array.from([0, 0.1, 0.2, 0.3])], {
    sampleRate: 1000,
    crossfadeMs: 100,
    masterGain: 1,
    pans: pinnedLeft(1),
  });
  m.setTargets([1]);
  m.snapToTargets();
  const out = channel(m.render(8), 0).map((x) => Math.round(x * 10) / 10);
  assert.deepEqual(out, [0, 0.1, 0.2, 0.3, 0, 0.1, 0.2, 0.3]);
});

test('survives a rapid sequence of changes (10 in 5s) without glitching, then converges', () => {
  // 1000Hz makes 5s = 5000 frames; a change every 500 frames = 10 changes in 5s.
  const m = new Mixer([flat(4)], { sampleRate: 1000, crossfadeMs: 1500 });
  const step = m.gainStepPerFrame;
  const pattern = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];

  let prev = m.getGains()[0]!;
  for (const target of pattern) {
    m.setTargets([target]);
    for (let f = 0; f < 500; f++) {
      m.render(1);
      const g = m.getGains()[0]!;
      assert.ok(Number.isFinite(g), 'gain stayed finite');
      assert.ok(Math.abs(g - prev) <= step + 1e-9, 'no discontinuous jump between frames');
      prev = g;
    }
  }

  // Let it settle on the final target.
  m.setTargets([0]);
  m.render(2000);
  assert.ok(Math.abs(m.getGains()[0]!) < 1e-9);
});

test('setTargets clamps to [0,1] and coerces non-finite to 0', () => {
  const m = new Mixer([flat(4), flat(4)]);
  m.setTargets([5, -3]);
  assert.deepEqual(m.getTargets(), [1, 0]);
  m.setTargets([Number.NaN, Number.POSITIVE_INFINITY]);
  assert.deepEqual(m.getTargets(), [0, 0]);
});

test('output is hard-clamped to [-1,1] when layers sum past unity', () => {
  const m = new Mixer([flat(4), flat(4), flat(4)], { masterGain: 1 });
  m.setTargets([1, 1, 1]);
  m.snapToTargets();
  for (const s of m.render(4)) {
    assert.ok(s <= 1 && s >= -1);
  }
});

test('render(0) and negative frame counts yield an empty block', () => {
  const m = new Mixer([flat(4)]);
  assert.equal(m.render(0).length, 0);
  assert.equal(m.render(-10).length, 0);
});

test('setMasterGain scales output and clamps to [0,1]', () => {
  const m = new Mixer([flat(4)], { masterGain: 1, pans: pinnedLeft(1) });
  m.setTargets([1]);
  m.snapToTargets();
  assert.equal(m.render(1)[0], 1);
  m.setMasterGain(0.5);
  assert.ok(Math.abs(m.render(1)[0]! - 0.5) < 1e-6);
  m.setMasterGain(5);
  assert.equal(m.getMasterGain(), 1);
  m.setMasterGain(-1);
  assert.equal(m.getMasterGain(), 0);
});

// --- Stereo movement --------------------------------------------------------

test('render returns interleaved stereo: two samples per frame', () => {
  const m = new Mixer([flat(4)]);
  assert.equal(m.render(32).length, 64);
  assert.equal(m.render(0).length, 0);
});

test('a centred stem is equal-power: both channels at √½, not unity', () => {
  const centred: PanSpec[] = [{ center: 0, depth: 0, rateHz: 0, phase: 0 }];
  const m = new Mixer([flat(4)], { masterGain: 1, pans: centred });
  m.setTargets([1]);
  m.snapToTargets();

  const block = m.render(1);
  assert.ok(Math.abs(block[0]! - Math.SQRT1_2) < 1e-6, 'left');
  assert.ok(Math.abs(block[1]! - Math.SQRT1_2) < 1e-6, 'right');
});

test('a swept stem actually moves across the field over time', () => {
  // A 1Hz sweep at 1000Hz makes a quarter turn every 250 frames.
  const swept: PanSpec[] = [{ center: 0, depth: 1, rateHz: 1, phase: 0 }];
  const m = new Mixer([flat(4)], { sampleRate: 1000, masterGain: 1, pans: swept });
  m.setTargets([1]);
  m.snapToTargets();

  const start = m.getPanPositions()[0]!;
  m.render(250);
  const quarter = m.getPanPositions()[0]!;
  m.render(500);
  const threeQuarters = m.getPanPositions()[0]!;

  assert.ok(Math.abs(start) < 1e-6, 'starts centred at phase 0');
  assert.ok(quarter > 0.9, `should have swung right, got ${quarter}`);
  assert.ok(threeQuarters < -0.9, `should have swung left, got ${threeQuarters}`);
});

test('the sweep is audible in the channel balance, not just the reported position', () => {
  const swept: PanSpec[] = [{ center: 0, depth: 1, rateHz: 1, phase: 0 }];
  const m = new Mixer([flat(4)], { sampleRate: 1000, masterGain: 1, pans: swept });
  m.setTargets([1]);
  m.snapToTargets();

  m.render(250); // now hard right
  const right = m.render(1);
  assert.ok(right[1]! > right[0]! + 0.9, 'right channel should dominate');

  m.render(499); // continue round to hard left
  const left = m.render(1);
  assert.ok(left[0]! > left[1]! + 0.9, 'left channel should dominate');
});

test('stems start in a different place each run, but a seed reproduces one exactly', () => {
  const a = defaultPanSpecs(7, 1234);
  const b = defaultPanSpecs(7, 1234);
  const c = defaultPanSpecs(7, 9876);

  assert.deepEqual(a, b, 'same seed → same arrangement');
  assert.notDeepEqual(
    a.map((pan) => pan.phase),
    c.map((pan) => pan.phase),
    'different seed → different starting positions',
  );
});

test('every stem sweeps at its own rate, so layers cross rather than move as a block', () => {
  const specs = defaultPanSpecs(7, 42);
  const rates = specs.map((pan) => pan.rateHz);
  assert.equal(new Set(rates).size, rates.length, 'rates must not coincide');
  for (const rate of rates) {
    assert.ok(rate > 0 && rate < 0.1, `sweep ${rate}Hz should take tens of seconds`);
  }
});

test('the bass stem stays near the middle; the rest are free to roam', () => {
  const specs = defaultPanSpecs(7, 7);
  assert.equal(specs[0]!.center, 0);
  assert.ok(specs[0]!.depth < 0.2, 'wide low end smears the stereo image');
  assert.ok(
    specs.slice(1).some((pan) => pan.depth > 0.3),
    'upper layers should travel',
  );
});

test('pan positions stay in range even when center + depth would overshoot', () => {
  const extreme: PanSpec[] = [{ center: 0.9, depth: 0.9, rateHz: 1, phase: 0.25 }];
  const m = new Mixer([flat(4)], { sampleRate: 1000, pans: extreme });
  for (let i = 0; i < 20; i++) {
    m.render(50);
    const position = m.getPanPositions()[0]!;
    assert.ok(position >= -1 && position <= 1, `position ${position} out of range`);
  }
});
