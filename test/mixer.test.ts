import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer } from '../src/audio/mixer';

/** A constant-value mono buffer — isolates gain behaviour from waveform content. */
const flat = (len: number, value = 1): Float32Array =>
  Float32Array.from({ length: len }, () => value);

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
  const m = new Mixer([flat(4)], { sampleRate: 1000, crossfadeMs: 100, masterGain: 0.8 });
  m.setTargets([1]);
  const block = m.render(200); // 100 frames of fade-in + 100 steady
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
  });
  m.setTargets([1]);
  m.snapToTargets();
  const out = [...m.render(8)].map((x) => Math.round(x * 10) / 10);
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
