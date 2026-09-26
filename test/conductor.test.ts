import test from 'node:test';
import assert from 'node:assert/strict';
import { Conductor, LEVELS } from '../src/conductor';
import { DEMO_LEVEL_SCALE, demoScript } from '../src/demo';
import type { RadioEvent } from '../src/types';

/**
 * The conductor keeps score. The rule it holds to: usage only ever makes the
 * music richer.
 */

const T = 1_800_000_000_000;
const at = (s: number): number => T + s * 1000;

const ev = (s: number, e: Record<string, unknown>, session = 'a'): RadioEvent =>
  ({ session, at: at(s), ...e }) as RadioEvent;

const usage = (out: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'usage',
  model: 'claude-opus-5-5',
  effort: 'xhigh',
  out,
  fresh: 2_000,
  cached: 98_000,
  contextPct: 10,
  ...extra,
});

test('the ladder climbs with output tokens, and only ever climbs', () => {
  const c = new Conductor();
  assert.equal(c.mix(at(0)).level, 1);
  assert.deepEqual(c.handle(ev(1, usage(1_000)), at(1)), []);
  assert.deepEqual(c.handle(ev(2, usage(600)), at(2)), [{ kind: 'levelUp', level: 2 }]);
  assert.equal(c.mix(at(2)).level, 2);
  // A big turn can earn several levels at once; each is announced.
  assert.deepEqual(c.handle(ev(3, usage(12_000)), at(3)), [
    { kind: 'levelUp', level: 3 },
    { kind: 'levelUp', level: 4 },
  ]);
  c.handle(ev(4, { type: 'end' }), at(4));
  c.handle(ev(5, { type: 'compact', preTokens: 800_000 }), at(5));
  assert.equal(c.mix(at(600)).level, 4, 'nothing takes a level away');
});

test('every session counts, and so do subagents', () => {
  const c = new Conductor();
  c.handle(ev(1, usage(800), 'a'), at(1));
  c.handle(
    { session: 'a', at: at(2), sub: true, type: 'usage', model: null, effort: null, out: 400, fresh: 0, cached: 0, contextPct: 0 },
    at(2),
  );
  const cues = c.handle(ev(3, usage(400), 'b'), at(3));
  assert.deepEqual(cues, [{ kind: 'levelUp', level: 2 }]);
});

test("tokens spent before tuning in don't count — the track builds from here", () => {
  const c = new Conductor();
  c.seed(
    [
      {
        session: 'a',
        project: 'app',
        title: 't',
        model: 'claude-opus-5-5',
        effort: 'xhigh',
        contextPct: 40,
        outTotal: 500_000,
        activity: 'idle',
        tool: null,
        lastAt: at(0),
        compactions: 0,
      },
    ],
    at(1),
  );
  assert.equal(c.mix(at(1)).level, 1);
  assert.equal(c.view(at(1)).sessions[0]!.outTotal, 500_000, 'the card still shows the session total');
});

test('build speed scales every threshold', () => {
  const fast = new Conductor({ buildSpeed: 'fast' });
  const slow = new Conductor({ buildSpeed: 'slow' });
  fast.handle(ev(1, usage(6_000)), at(1));
  slow.handle(ev(1, usage(6_000)), at(1));
  assert.equal(fast.mix(at(1)).level, 4);
  assert.equal(slow.mix(at(1)).level, 2);
});

test('progress reports the way to the next level', () => {
  const c = new Conductor();
  c.handle(ev(1, usage(3_250)), at(1));
  const p = c.progress();
  assert.equal(p.level, 2);
  assert.equal(p.name, 'Groove');
  assert.equal(p.next?.name, 'Warmth');
  assert.equal(p.toNext, 1_750);
  assert.equal(p.fraction, 0.5);
  const top = new Conductor();
  top.handle(ev(1, usage(1_000_000)), at(1));
  assert.equal(top.progress().next, null);
  assert.equal(top.progress().level, LEVELS.length);
});

test('working is the full band; the end of a turn is a flourish, once, and never on an interrupt', () => {
  const c = new Conductor();
  c.handle(ev(0, { type: 'prompt' }), at(0));
  assert.equal(c.mix(at(1)).working, true);
  assert.deepEqual(c.handle(ev(10, { type: 'end' }), at(10)), [{ kind: 'turnEnd' }]);
  assert.deepEqual(c.handle(ev(11, { type: 'end' }), at(11)), []);
  assert.equal(c.mix(at(12)).working, false);
  assert.equal(c.mix(at(12)).presence, 1, 'the band stays in the room');

  c.handle(ev(20, { type: 'prompt' }), at(20));
  assert.deepEqual(c.handle(ev(22, { type: 'end', interrupted: true }), at(22)), []);
});

test('failures, tool kinds and cache misses change nothing — there is nothing to be told off for', () => {
  const c = new Conductor();
  c.handle(ev(0, { type: 'prompt' }), at(0));
  assert.deepEqual(c.handle(ev(1, { type: 'tool', family: 'exec', name: 'Bash', tokens: 30 }), at(1)), []);
  assert.deepEqual(c.handle(ev(2, { type: 'result', error: true, size: 10 }), at(2)), []);
  assert.deepEqual(c.handle(ev(3, usage(10, { fresh: 90_000, cached: 10_000 })), at(3)), []);
});

test('compaction is a sunrise, and the sky comes up in seconds', () => {
  const c = new Conductor();
  c.handle(ev(0, usage(10, { contextPct: 70 })), at(0));
  c.mix(at(60));
  assert.equal(c.view(at(60)).phase.name, 'night');
  assert.deepEqual(c.handle(ev(61, { type: 'compact', preTokens: 700_000 }), at(61)), [{ kind: 'sunrise' }]);
  for (let t = 61; t <= 69; t += 0.25) c.mix(at(t));
  assert.equal(c.view(at(69)).phase.name, 'dawn');
});

test('the sky follows the session you last prompted', () => {
  const c = new Conductor();
  c.handle(ev(0, usage(10, { contextPct: 5 }), 'a'), at(0));
  c.handle(ev(0, usage(10, { contextPct: 70 }), 'b'), at(0));
  c.handle(ev(1, { type: 'prompt' }, 'a'), at(1));
  for (let i = 2; i < 60; i++) {
    c.handle(ev(i, { type: 'tool', family: 'exec', name: 'Bash', tokens: 30 }, i % 2 ? 'a' : 'b'), at(i));
  }
  assert.equal(c.view(at(60)).phase.name, 'dawn');
  assert.equal(c.view(at(60)).focus, 'a');
});

test('concurrent sessions get their own lanterns', () => {
  const c = new Conductor();
  c.handle(ev(0, { type: 'prompt' }, 'a'), at(0));
  c.handle(ev(1, { type: 'prompt' }, 'b'), at(1));
  assert.deepEqual(c.view(at(2)).sessions.map((s) => s.seat), [0, 1]);
});

test('after a long silence the band leaves, but never all the way', () => {
  const c = new Conductor({ idleMs: 60_000, fadeMs: 60_000, floor: 0.3 });
  c.handle(ev(0, { type: 'prompt' }), at(0));
  c.handle(ev(1, { type: 'end' }), at(1));
  assert.equal(c.mix(at(30)).presence, 1);
  const leaving = c.mix(at(91)).presence;
  assert.ok(leaving < 1 && leaving > 0.3);
  assert.equal(c.mix(at(1_000)).presence, 0.3);
});

test('a session that goes quiet without ending stops counting as working', () => {
  const c = new Conductor({ staleMs: 60_000 });
  c.handle(ev(0, { type: 'prompt' }), at(0));
  assert.equal(c.mix(at(30)).working, true);
  assert.equal(c.mix(at(90)).working, false);
});

test('the demo climbs the whole ladder, turns end, a second session joins, and the sun comes back up', () => {
  const c = new Conductor({ levelScale: DEMO_LEVEL_SCALE });
  const kinds = new Set<string>();
  const phases = new Set<string>();
  for (const e of demoScript()) {
    for (const cue of c.handle(e, T + e.at)) kinds.add(cue.kind);
    c.mix(T + e.at);
    phases.add(c.view(T + e.at).phase.name);
  }
  assert.equal(c.progress().level, LEVELS.length, 'reaches flow state');
  for (const kind of ['levelUp', 'turnEnd', 'sunrise']) assert.ok(kinds.has(kind), kind);
  assert.equal(c.view(T).sessions.length, 2);
  for (const phase of ['dawn', 'morning', 'golden hour', 'dusk', 'night']) assert.ok(phases.has(phase), phase);
});
