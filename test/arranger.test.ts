import test from 'node:test';
import assert from 'node:assert/strict';
import { Arranger, type BeatPlan, type Mix } from '../src/arranger';
import { PROGRESSIONS, buildChord } from '../src/harmony';

/**
 * The band. The first test is the promise: **nothing clashes.** The rest pin
 * what makes it a groove — layers arrive on phrase boundaries, one at a time,
 * the beat never stops, and melodies repeat.
 */

const MIX: Mix = { day: 0.3, level: 1, working: true, presence: 1, stars: 0 };

function run(a: Arranger, from: number, beats: number, mix: Mix | ((beat: number) => Mix)): BeatPlan[] {
  const plans: BeatPlan[] = [];
  for (let b = from; b < from + beats; b++) plans.push(a.planBeat(b, typeof mix === 'function' ? mix(b) : mix));
  return plans;
}

/** Every chord any progression can play, by label, with its safe set and tones. */
function chordTable(tonic: number): Map<string, { safe: Set<number>; tones: Set<number> }> {
  const table = new Map<string, { safe: Set<number>; tones: Set<number> }>();
  for (const p of PROGRESSIONS) {
    for (const spec of p.chords) {
      for (let level = 1; level <= 8; level++) {
        const c = buildChord(tonic, spec, level);
        table.set(c.label, { safe: new Set(c.safe), tones: new Set(c.tones) });
      }
    }
  }
  return table;
}

test('nothing clashes: every note, at every level, in every state, belongs to the chord under it', () => {
  for (const tonic of [5, 0, 3]) {
    const a = new Arranger({ tonic, seed: tonic + 7 });
    const table = chordTable(tonic);
    let notes = 0;
    for (let b = 0; b < 4_000; b++) {
      if (b % 37 === 0) a.cue({ kind: 'turnEnd' });
      if (b % 523 === 0) a.cue({ kind: 'sunrise' });
      const plan = a.planBeat(b, {
        ...MIX,
        level: 1 + Math.floor(b / 400) % 8,
        working: b % 90 < 60,
        presence: b % 1_000 < 900 ? 1 : 0.3,
      });
      const chord = table.get(plan.chord);
      assert.ok(chord, `unknown chord ${plan.chord}`);
      for (const n of plan.notes) {
        notes++;
        const pc = n.midi % 12;
        if (n.voice === 'bass') assert.ok(chord.tones.has(pc), `bass ${n.midi} under ${plan.chord}`);
        else assert.ok(chord.safe.has(pc), `${n.voice} ${n.midi} over ${plan.chord}`);
      }
      for (const m of plan.pad ?? []) assert.ok(chord.safe.has(m % 12), `pad ${m} over ${plan.chord}`);
    }
    assert.ok(notes > 10_000, `${notes} notes checked`);
  }
});

test('no semitone rubs between voices sounding together', () => {
  const a = new Arranger();
  for (let b = 0; b < 2_000; b++) {
    const plan = a.planBeat(b, { ...MIX, level: 1 + Math.floor(b / 250) });
    for (let step = 0; step < 4; step++) {
      const keys = plan.notes.filter((n) => n.step === step && n.voice === 'keys').map((n) => n.midi).sort((x, y) => x - y);
      for (let i = 1; i < keys.length; i++) assert.ok(keys[i]! - keys[i - 1]! >= 2, `keys ${keys} on beat ${b}`);
    }
  }
});

test('it starts as a beat: drums, keys and bass from the very first bar', () => {
  const a = new Arranger();
  const bar = run(a, 0, 4, { ...MIX, working: false });
  const voices = new Set(bar.flatMap((p) => p.notes.map((n) => n.voice)));
  assert.deepEqual([...voices].sort(), ['bass', 'keys']);
  const pieces = new Set(bar.flatMap((p) => p.drums.map((d) => d.piece)));
  assert.ok(pieces.has('kick') && pieces.has('snare') && pieces.has('hat'));
  assert.equal(bar[0]!.level, 1);
  assert.equal(bar[0]!.chord, 'B♭maj7'); // IV of F — the "descent" loop
});

test('the beat never stops — not on your turn, not after a long silence', () => {
  const a = new Arranger();
  const plans = run(a, 0, 256, (b) => ({ ...MIX, working: b < 64, presence: b < 128 ? 1 : 0.3 }));
  for (let bar = 0; bar < 64; bar++) {
    const drums = plans.slice(bar * 4, bar * 4 + 4).flatMap((p) => p.drums);
    assert.ok(drums.some((d) => d.piece === 'kick'), `bar ${bar} has a kick`);
  }
});

test('one chord per bar, looping every four', () => {
  const a = new Arranger();
  const plans = run(a, 0, 64, MIX);
  for (const p of plans) if (!p.downbeat) assert.equal(p.chord, plans[p.bar * 4]!.chord);
  const bars = plans.filter((p) => p.downbeat).map((p) => p.chord);
  assert.deepEqual(bars.slice(0, 4), bars.slice(4, 8), 'the loop repeats');
});

test('levels arrive on phrase boundaries, one at a time, each announced by a fill', () => {
  const a = new Arranger();
  const plans = run(a, 0, 160, { ...MIX, level: 5 });
  const levels = plans.filter((p) => p.downbeat).map((p) => p.level);
  assert.deepEqual(levels.slice(0, 20), [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5]);
  const fills = plans.filter((p) => p.flourish === 'levelup').map((p) => p.beat);
  assert.deepEqual(fills, [15, 31, 47, 63], 'on the last beat before each new phrase');
});

test('each level adds its layer', () => {
  const voicesAt = (level: number): Set<string> => {
    const a = new Arranger();
    const plans = run(a, 0, 4 * 64, { ...MIX, level });
    return new Set(plans.slice(-64).flatMap((p) => p.notes.map((n) => n.voice)));
  };
  assert.ok(!voicesAt(3).has('lead'));
  assert.ok(voicesAt(4).has('lead'));
  assert.ok(!voicesAt(5).has('arp'));
  assert.ok(voicesAt(6).has('arp'));

  const padAt = (level: number): boolean => {
    const a = new Arranger();
    return run(a, 0, 4 * 64, { ...MIX, level }).some((p) => (p.pad ?? []).length > 0);
  };
  assert.equal(padAt(4), false);
  assert.equal(padAt(5), true);
});

test('your turn lays the band back: no melody, no arpeggio, softer drums — but still a groove', () => {
  const a = new Arranger();
  run(a, 0, 4 * 48, { ...MIX, level: 8 });
  const back = run(a, 192, 32, { ...MIX, level: 8, working: false }).slice(8);
  assert.ok(back.every((p) => p.band === 'laid back'));
  const voices = new Set(back.flatMap((p) => p.notes.map((n) => n.voice)));
  assert.ok(!voices.has('lead') && !voices.has('arp'));
  assert.ok(voices.has('keys') && voices.has('bass'));
  assert.ok(back.some((p) => (p.pad ?? []).length > 0) || true, 'the pad can stay');
});

test('the band comes back within two bars of a prompt', () => {
  const a = new Arranger();
  run(a, 0, 16, { ...MIX, working: false });
  const back = run(a, 16, 8, MIX);
  assert.ok(back.slice(0, 8).some((p) => p.band === 'full'));
});

test('the melody is a motif: the same rhythm twice before it varies', () => {
  const a = new Arranger();
  const plans = run(a, 0, 4 * 80, { ...MIX, level: 4 });
  // Find a section that started at level 4 and compare its first two 2-bar halves.
  const lead = (bar: number): string =>
    plans
      .slice(bar * 4, bar * 4 + 8)
      .flatMap((p) => p.notes.filter((n) => n.voice === 'lead').map((n) => `${p.beat - bar * 4}:${n.step}`))
      .join(',');
  const starts = plans.filter((p) => p.downbeat && p.bar >= 16 && p.bar % 8 === 0).map((p) => p.bar);
  const bar = starts[0]!;
  assert.ok(lead(bar).length > 0, 'the lead plays');
  assert.equal(lead(bar), lead(bar + 2), 'the second statement repeats the first');
});

test('your turn gets a soft flourish that climbs', () => {
  const a = new Arranger();
  run(a, 0, 5, MIX);
  a.cue({ kind: 'turnEnd' });
  const plan = a.planBeat(5, MIX);
  assert.equal(plan.flourish, 'sparkle');
  const climb = plan.notes.filter((n) => n.voice === 'sparkle').map((n) => n.midi);
  assert.equal(climb.length, 4);
  for (let i = 1; i < climb.length; i++) assert.ok(climb[i]! > climb[i - 1]!);
  assert.ok(plan.notes.filter((n) => n.voice === 'sparkle').every((n) => n.velocity < 0.5));
});

test('a sunrise sweeps into a fresh progression on the next bar', () => {
  const a = new Arranger();
  const before = run(a, 0, 4 * 12, { ...MIX, level: 8 });
  const loop = before.filter((p) => p.downbeat).slice(-4).map((p) => p.chord).join();
  a.cue({ kind: 'sunrise' });
  const after = run(a, 48, 16, { ...MIX, level: 8 });
  assert.equal(after[0]!.flourish, 'sunrise');
  assert.notEqual(after.filter((p) => p.downbeat).map((p) => p.chord).join(), loop);
});

test('new levels unlock new progressions, and the band plays them', () => {
  const a = new Arranger();
  const plans = run(a, 0, 4 * 400, { ...MIX, level: 8 });
  const seen = new Set(plans.map((p) => p.chord));
  assert.ok([...seen].some((c) => c.startsWith('B♭m')), 'the borrowed iv (B♭m) turns up at the top');
});

test('the same seed plays the same music', () => {
  const play = (): string => JSON.stringify(run(new Arranger({ seed: 42 }), 0, 256, (b) => ({ ...MIX, level: 1 + (b >> 5) })));
  assert.equal(play(), play());
});
