import test from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE, SkyClock } from '../src/skyclock';

/**
 * The sky's clock. What matters on screen: it moves a little every frame and
 * never jumps, it never overshoots and drifts back, and a compaction's new day
 * comes up from the east instead of the old one running backwards.
 */

const FRAME = 1 / 60;

/**
 * Run the clock at 60fps, with `want(t)` sampled four times a second — the way
 * the page hands it the day, in steps.
 */
function run(clock: SkyClock, seconds: number, want: (t: number) => number): number[] {
  const positions: number[] = [];
  let given = want(0);
  for (let frame = 0; frame * FRAME < seconds; frame++) {
    const t = frame * FRAME;
    if (frame % 15 === 0) given = want(t);
    clock.advance(given, FRAME);
    positions.push(clock.position);
  }
  return positions;
}

/** Frame-to-frame moves, forward being positive, counting midnight as one step. */
function moves(positions: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < positions.length; i++) {
    let d = positions[i]! - positions[i - 1]!;
    if (d < -CYCLE / 2) d += CYCLE;
    if (d > CYCLE / 2) d -= CYCLE;
    out.push(d);
  }
  return out;
}

test('a compaction at night: on through the night, and up into a new morning', () => {
  const clock = new SkyClock();
  clock.snap(0.907); // 85% context
  // Context falls to nothing, and a second later the summary puts it at 4%.
  const positions = run(clock, 12, (t) => (t < 1 ? 0 : 0.145));
  const steps = moves(positions);

  assert.ok(steps.every((d) => d >= -1e-9), 'never runs backwards');
  assert.ok(Math.max(...steps) < 0.006, `no jumps (largest step ${Math.max(...steps).toFixed(4)})`);
  assert.ok(positions.some((c) => c > 1.05), 'passes through the hour before dawn');
  assert.ok(Math.abs(clock.day - 0.145) < 0.004, `arrives at the morning (day ${clock.day.toFixed(3)})`);
  assert.equal(clock.dawning, false);
});

test('a new day takes seconds, not a drift', () => {
  const clock = new SkyClock();
  clock.snap(0.9);
  const positions = run(clock, 6, () => 0.15);
  // Five seconds in, it's morning, give or take.
  const at5 = positions[Math.round(5 / FRAME)]!;
  assert.ok(at5 < 1 && Math.abs(at5 - 0.15) < 0.05, `morning by five seconds (at ${at5.toFixed(3)})`);
});

test('a smaller fall in the morning eases back, without overshooting', () => {
  const clock = new SkyClock();
  clock.snap(0.4);
  const positions = run(clock, 20, () => 0.1);
  assert.ok(positions.every((c) => c <= 1), 'no trip through the night');
  assert.ok(moves(positions).every((d) => d <= 1e-9), 'only ever back');
  assert.ok(Math.min(...positions) >= 0.1 - 1e-6, 'never below where it was going');
  assert.ok(Math.abs(clock.day - 0.1) < 0.003);
});

test('context growing in steps: the sky follows without a hitch or an overshoot', () => {
  const clock = new SkyClock();
  clock.snap(0.2);
  const positions = run(clock, 25, (t) => 0.2 + Math.min(10, Math.floor(t / 0.5)) * 0.01);
  const steps = moves(positions);
  assert.ok(steps.every((d) => d >= -1e-9), 'never back');
  assert.ok(Math.max(...positions) <= 0.3 + 1e-6, 'never past where it was going');
  assert.ok(Math.abs(clock.day - 0.3) < 0.002);
});

test('back to the older session mid-way: no new day after all', () => {
  const clock = new SkyClock();
  clock.snap(0.9);
  const positions = run(clock, 15, (t) => (t < 0.6 ? 0.1 : 0.85));
  assert.ok(Math.abs(clock.day - 0.85) < 0.003, `back at night (day ${clock.day.toFixed(3)})`);
  assert.equal(clock.dawning, false);
  assert.ok(Math.max(...moves(positions).map(Math.abs)) < 0.006, 'smoothly');
});

test('a snap is immediate, and clamps', () => {
  const clock = new SkyClock();
  clock.snap(0.62);
  assert.equal(clock.day, 0.62);
  clock.snap(7);
  assert.equal(clock.day, 1);
  clock.snap(Number.NaN);
  assert.equal(clock.day, 0);
});

test('a long frame (a tab coming back) moves further, but stays on course', () => {
  const clock = new SkyClock();
  clock.snap(0.3);
  clock.advance(0.5, 0.1);
  assert.ok(clock.day > 0.3 && clock.day < 0.5);
});
