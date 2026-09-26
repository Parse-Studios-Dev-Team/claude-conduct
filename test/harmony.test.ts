import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASS_RANGE,
  DIATONIC,
  KEYS_RANGE,
  MAJOR,
  PROGRESSIONS,
  bassNote,
  buildChord,
  dayPosition,
  noteName,
  notesIn,
  phaseAt,
  voiceLead,
} from '../src/harmony';

/**
 * The radio's harmony. The property that matters: nothing a melody can play
 * over a chord is an avoid note, and nothing in the key sits outside the key
 * unless it's one of the two borrowed chords that unlock at the top.
 */

const F = 5;
const C = 0;

test('chords are the jazz sevenths of the key, named and extended by level', () => {
  assert.equal(buildChord(C, DIATONIC.I, 1).label, 'Cmaj7');
  assert.equal(buildChord(C, DIATONIC.ii, 1).label, 'Dm7');
  assert.equal(buildChord(C, DIATONIC.V, 1).label, 'G7');
  assert.equal(buildChord(C, DIATONIC.I, 3).label, 'Cmaj9');
  assert.equal(buildChord(C, DIATONIC.ii, 3).label, 'Dm9');
  assert.equal(buildChord(C, DIATONIC.V, 3).label, 'G9');
  assert.equal(buildChord(C, DIATONIC.ii, 6).label, 'Dm11');
  assert.equal(buildChord(C, DIATONIC.V, 6).label, 'G13');
  assert.equal(buildChord(F, DIATONIC.IV, 1).label, 'B♭maj7');
});

test('the safe set never holds an avoid note', () => {
  const cases: Array<[keyof typeof DIATONIC, number[]]> = [
    ['I', [5, 1]], // no 4th, no ♭9 over Cmaj7
    ['IV', [0 + 11, 6]], // no ♭9 (F♯? no — E is the 7th); no natural 4th B♭ over Fmaj7
    ['V', [0, 8]], // no C (the 4th) or A♭ (♭9) over G7
  ];
  const cmaj7 = buildChord(C, DIATONIC.I, 8).safe;
  assert.ok(!cmaj7.includes(5), 'F over Cmaj7');
  assert.ok(!cmaj7.includes(1), 'D♭ over Cmaj7');
  const g7 = buildChord(C, DIATONIC.V, 8).safe;
  assert.ok(!g7.includes(0), 'C over G7');
  assert.ok(!g7.includes(8), 'A♭ over G7');
  const fmaj7 = buildChord(C, DIATONIC.IV, 8).safe;
  assert.ok(!fmaj7.includes(10), 'B♭ over Fmaj7');
  void cases;
});

test('every diatonic chord stays inside the key — including its tensions', () => {
  for (const tonic of [C, F, 2, 10]) {
    const key = new Set(MAJOR.map((s) => (tonic + s) % 12));
    for (const [name, spec] of Object.entries(DIATONIC)) {
      for (const level of [1, 3, 6, 8]) {
        const chord = buildChord(tonic, spec, level);
        for (const p of chord.safe) assert.ok(key.has(p), `${name} at level ${level} in ${tonic}: ${p}`);
        for (const p of chord.voicing) assert.ok(chord.safe.includes(p), `${name} voicing ${p} is safe`);
      }
    }
  }
});

test('iii takes its 11th, never the chromatic 9th', () => {
  const em = buildChord(C, DIATONIC.iii, 3);
  assert.ok(!em.safe.includes(6), 'no F♯');
  assert.ok(em.voicing.includes(9), 'the 11th (A) instead');
  assert.equal(em.label, 'Em11');
});

test('borrowed chords only unlock near the top of the ladder', () => {
  const key = new Set(MAJOR.map((s) => s % 12));
  for (const p of PROGRESSIONS) {
    const outside = p.chords.some((c) => !key.has(c.root) || (c.root === 5 && c.quality === 'm7'));
    if (outside) assert.ok(p.minLevel >= 7, `${p.name} unlocks at ${p.minLevel}`);
  }
  assert.ok(PROGRESSIONS.filter((p) => p.minLevel === 1).length >= 3, 'enough loops to start with');
});

test('voice leading is smooth and never leaves a semitone between neighbouring voices', () => {
  let voicing = [57, 60, 64, 67];
  for (let i = 0; i < 400; i++) {
    const progression = PROGRESSIONS[i % PROGRESSIONS.length]!;
    const chord = buildChord(F, progression.chords[i % 4]!, 1 + (i % 8));
    const next = voiceLead(voicing, chord.voicing);
    for (const m of next) assert.ok(m >= KEYS_RANGE[0] && m <= KEYS_RANGE[1], `${m} out of range`);
    for (let j = 1; j < next.length; j++) assert.ok(next[j]! - next[j - 1]! >= 2, `${next} has a semitone`);
    const moved = next.reduce((sum, m, j) => sum + Math.abs(m - voicing[j]!), 0);
    assert.ok(moved <= 14, `moved ${moved} semitones`);
    voicing = next;
  }
});

test('the bass stays where laptop speakers can hear it', () => {
  for (let p = 0; p < 12; p++) {
    const b = bassNote(p, 41);
    assert.ok(b >= BASS_RANGE[0] && b <= BASS_RANGE[1], `${b}`);
    assert.equal(b % 12, p);
  }
});

test('notesIn lists a chord across a range', () => {
  assert.deepEqual(notesIn([0, 4, 7], 60, 72), [60, 64, 67, 72]);
});

test('names follow the key signature', () => {
  assert.equal(noteName(10, F), 'B♭');
  assert.equal(noteName(6, 2), 'F♯');
});

test('context fill still walks the sky from dawn to night', () => {
  assert.equal(phaseAt(dayPosition(5)).name, 'dawn');
  assert.equal(phaseAt(dayPosition(25)).name, 'golden hour');
  assert.equal(phaseAt(dayPosition(75)).name, 'night');
  assert.equal(dayPosition(Number.NaN), 0);
});
