import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteName, pitchClass, chordName, readVoice, readScore, LAYER_ROLES } from '../playground/score';
import { DEFAULT_VOICES } from '../src/audio/synth';
import { tierToGains } from '../src/audio/tierGains';

// The score panel claims to show what the engine is playing. That claim is only
// worth anything if it is derived from the same voice table the daemon renders,
// so these assert against DEFAULT_VOICES rather than a fixture.

test('noteName reads the D-major voicing back as note names', () => {
  assert.equal(noteName(73.42), 'D2');
  assert.equal(noteName(110.0), 'A2');
  assert.equal(noteName(369.99), 'F♯4');
  assert.equal(noteName(554.37), 'C♯5');
  assert.equal(noteName(1174.66), 'D6');
  assert.equal(noteName(440), 'A4');
  assert.equal(noteName(0), '—');
});

test('pitchClass is octave-invariant', () => {
  assert.equal(pitchClass(73.42), pitchClass(146.83), 'D2 and D3');
  assert.equal(pitchClass(220), pitchClass(880), 'A3 and A5');
});

test('chordName names the stack each ensemble level builds', () => {
  const D = pitchClass(73.42);
  const A = pitchClass(220);
  const Fs = pitchClass(369.99);
  const Cs = pitchClass(554.37);
  const E = pitchClass(659.26);

  assert.equal(chordName([D], D), 'D');
  assert.equal(chordName([D, A], D), 'D5', 'root + fifth is a bare fifth');
  assert.equal(chordName([D, A, Fs], D), 'D', 'the triad finally has a quality');
  assert.equal(chordName([D, A, Fs, Cs], D), 'Dmaj7');
  assert.equal(chordName([D, A, Fs, Cs, E], D), 'Dmaj9', 'the full ensemble');
});

test('chordName uses the bass to pick between enharmonic readings', () => {
  // B D F♯ A is Bm7 over B and D6 over D — the lowest voice decides.
  const B = pitchClass(246.94);
  const D = pitchClass(146.83);
  const Fs = pitchClass(369.99);
  const A = pitchClass(220);
  assert.equal(chordName([B, D, Fs, A], B), 'Bm7');
  assert.equal(chordName([D, Fs, A], D), 'D');
});

test('chordName returns null rather than inventing a name for a passing stack', () => {
  // G A B — what the drifting voices genuinely pass through mid-morph.
  assert.equal(chordName([pitchClass(196), pitchClass(220), pitchClass(246.94)]), null);
  assert.equal(chordName([]), null);
});

test('readVoice tracks a drifting voice between its centres', () => {
  const root = DEFAULT_VOICES[0]!; // D2 ↔ A2
  const atStart = readVoice(root, 0, 1, 0);
  assert.equal(atStart.kind, 'sustained');
  assert.equal(atStart.note, 'D2', 'sits on its first centre at turn 0');
  assert.equal(atStart.role, 'root');

  const halfway = readVoice(root, 0, 1, 0.5);
  assert.equal(halfway.note, 'A2', 'and on the second at the opposite centre');

  const between = readVoice(root, 0, 1, 0.25);
  assert.ok(between.toward, 'mid-morph it reports where it is heading');
  assert.ok(between.toward!.blend > 0.3, `should be well into the morph, got ${between.toward!.blend}`);
});

test('readVoice walks the bell through its figure', () => {
  const bell = DEFAULT_VOICES[6]!;
  const figure = bell.sequenceHz!;
  assert.equal(figure.length, 8);

  for (let strike = 0; strike < 8; strike++) {
    // Sample the middle of each strike's window.
    const turn = (strike + 0.5) / 8;
    const readout = readVoice(bell, 6, 1, turn);
    assert.equal(readout.kind, 'struck');
    assert.equal(readout.strike?.index, strike);
    assert.equal(readout.note, noteName(figure[strike]!), `strike ${strike + 1}`);
  }
});

test('readScore only counts layers the tier has actually faded in', () => {
  const voices = DEFAULT_VOICES;

  const solo = readScore(voices, tierToGains({ ensembleSize: 1, richness: 0, timbre: 0 }), 0);
  assert.deepEqual(solo.notes, ['D2'], 'one layer on');
  assert.equal(solo.chord, 'D');

  // Turn 0.0625 rather than 0: the third's `driftPhase` of 0.5 offsets its
  // centres, so at turn 0 it sits exactly between F♯4 and E4 and the stack has
  // no name. The voicing only spells its textbook chord once the drones settle.
  const full = readScore(voices, tierToGains({ ensembleSize: 5, richness: 0, timbre: 0 }), 0.0625);
  assert.equal(full.notes.length, 5);
  assert.equal(full.chord, 'Dmaj7', 'the plucked ninth is melody, so it does not make this a maj9');

  const silent = readScore(voices, tierToGains({ ensembleSize: 0, richness: 0, timbre: 0 }), 0);
  assert.deepEqual(silent.notes, []);
  assert.equal(silent.chord, null);
  assert.equal(silent.label, '—');
});

test('struck voices are melody, not harmony', () => {
  const gains = tierToGains({ ensembleSize: 5, richness: 0, timbre: 1 });
  const score = readScore(DEFAULT_VOICES, gains, 0.0625);

  // At this turn the bell is on the first strike of its figure (D5) and the
  // plucked ninth sounds E5 — both above the drones, both excluded from harmony.
  assert.deepEqual(score.melody, ['D5', 'E5'], 'the bell and the plucked ninth, low to high');
  assert.ok(score.notes.length > score.melody.length, 'melody is a subset of everything sounding');
  assert.equal(score.chord, 'Dmaj7', 'the melody notes do not rename the chord');
});

test('the label falls back to the key while the drones are mid-drift', () => {
  const gains = tierToGains({ ensembleSize: 5, richness: 2, timbre: 1 });
  const drifting = readScore(DEFAULT_VOICES, gains, 0.5);

  assert.equal(drifting.chord, null, 'genuinely between chords here');
  assert.equal(drifting.drifting, true);
  assert.equal(drifting.label, 'D major', 'says something true rather than showing a dash');
});

test('every pitch the voicing can sound stays in D major', () => {
  // The bell's contract — "any triad tone lands consonant" — only holds if no
  // layer ever leaves the key, including mid-drift. Sweep the whole loop.
  const gains = tierToGains({ ensembleSize: 5, richness: 2, timbre: 1 });
  for (let i = 0; i < 64; i++) {
    const score = readScore(DEFAULT_VOICES, gains, i / 64);
    assert.equal(score.label !== '—', true, `turn ${(i / 64).toFixed(3)} left the key: ${score.notes.join(' ')}`);
  }
});

test('readScore reports every layer, audible or not, in engine order', () => {
  const score = readScore(DEFAULT_VOICES, tierToGains({ ensembleSize: 2, richness: 0, timbre: 0 }), 0);
  assert.equal(score.voices.length, DEFAULT_VOICES.length);
  assert.deepEqual(
    score.voices.map((v) => v.role),
    [...LAYER_ROLES],
    'roles line up with the order tierToGains switches stems on',
  );
  assert.deepEqual(
    score.voices.map((v) => v.audible),
    [true, true, false, false, false, false, false],
  );
});

test('the timbre signature shows up as the bell being audible', () => {
  const withBell = readScore(DEFAULT_VOICES, tierToGains({ ensembleSize: 3, richness: 0, timbre: 1 }), 0);
  assert.equal(withBell.voices.at(-1)!.audible, true, '✦ lights the bell');

  const without = readScore(DEFAULT_VOICES, tierToGains({ ensembleSize: 3, richness: 0, timbre: 0 }), 0);
  assert.equal(without.voices.at(-1)!.audible, false);
});
