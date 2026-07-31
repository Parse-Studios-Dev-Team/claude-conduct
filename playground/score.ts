import { driftWeight, type VoiceSpec } from '../src/audio/synth';

/**
 * Reads the *composition* out of the running engine: which voices are sounding
 * right now, what pitch each one is on, and what chord they add up to.
 *
 * Everything here is derived, not stored. The synth renders a drifting voice by
 * crossfading several pitches with {@link driftWeight}, and a struck voice by
 * stepping through `sequenceHz` — so given the voice table, the per-stem gains
 * and the position through the loop, the sounding pitch of every layer is a pure
 * function. That means this module can be unit-tested without an AudioContext,
 * and it can never drift out of sync with what you're hearing: it reads the same
 * `DEFAULT_VOICES` the daemon plays.
 */

/** Layer names, in the order `tierToGains` switches them on. */
export const LAYER_ROLES = ['root', 'fifth', 'third', 'maj7', 'ninth', 'pad', 'bell'] as const;

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Below this a layer is inaudible — treat it as off rather than let it colour the chord. */
export const AUDIBLE = 0.02;

/**
 * Name a frequency in 12-TET with A4 = 440. The voice table is written in exact
 * Hz, so this rounds to the nearest semitone rather than assuming a lookup hit.
 */
export function noteName(hz: number): string {
  if (!(hz > 0)) return '—';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]!;
  return `${name}${Math.floor(midi / 12) - 1}`;
}

/** Pitch class `0..11` (C = 0) for a frequency. */
export function pitchClass(hz: number): number {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return ((midi % 12) + 12) % 12;
}

export interface VoiceReadout {
  index: number;
  role: string;
  /** Current mixer gain for this layer, `0..1`. */
  gain: number;
  audible: boolean;
  kind: 'sustained' | 'struck';
  /** The pitch carrying most of this voice's energy right now. */
  hz: number;
  note: string;
  /** For a drifting voice mid-morph: the pitch it is moving toward. */
  toward?: { hz: number; note: string; blend: number };
  /** For a struck voice: where we are in its figure. */
  strike?: { index: number; count: number; figure: string[] };
}

/**
 * What a single voice is doing at `turn` (position through the loop, `0..1`).
 *
 * A sustained voice with `driftHz` has exactly two non-zero drift windows at any
 * moment (the windows are equal-power and overlap by one), so the readout is
 * "this note, morphing `blend` of the way to that one". A struck voice jumps
 * cleanly between pitches, so it just reports which strike is sounding.
 */
export function readVoice(voice: VoiceSpec, index: number, gain: number, turn: number): VoiceReadout {
  const role = LAYER_ROLES[index] ?? `stem ${index}`;
  const base = { index, role, gain, audible: gain > AUDIBLE };

  if (voice.pulses && voice.pulses > 0) {
    const figure = voice.sequenceHz && voice.sequenceHz.length > 0 ? voice.sequenceHz : [voice.hz];
    const strikeIndex = Math.floor(turn * voice.pulses) % voice.pulses;
    const hz = figure[strikeIndex % figure.length]!;
    return {
      ...base,
      kind: 'struck',
      hz,
      note: noteName(hz),
      strike: { index: strikeIndex, count: voice.pulses, figure: figure.map(noteName) },
    };
  }

  const drift = voice.driftHz && voice.driftHz.length > 0 ? voice.driftHz : null;
  if (!drift) {
    return { ...base, kind: 'sustained', hz: voice.hz, note: noteName(voice.hz) };
  }

  const weights = drift.map((_, i) => driftWeight(turn, i, drift.length, voice.driftPhase ?? 0));
  let lead = 0;
  let second = -1;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i]! > weights[lead]!) lead = i;
  }
  for (let i = 0; i < weights.length; i++) {
    if (i !== lead && weights[i]! > 0 && (second < 0 || weights[i]! > weights[second]!)) second = i;
  }

  const readout: VoiceReadout = {
    ...base,
    kind: 'sustained',
    hz: drift[lead]!,
    note: noteName(drift[lead]!),
  };
  if (second >= 0) {
    // Ratio of the two live windows, so it reads 0 at a centre and →1 as the
    // voice arrives at the next pitch.
    const blend = weights[second]! / (weights[lead]! + weights[second]!);
    readout.toward = { hz: drift[second]!, note: noteName(drift[second]!), blend };
  }
  return readout;
}

interface ChordTemplate {
  intervals: number[];
  suffix: string;
}

/**
 * Chord shapes the D-major voicing can actually produce. Ordered longest-first
 * so a five-note match wins before its own triad subset does.
 */
const TEMPLATES: ChordTemplate[] = [
  { intervals: [0, 2, 4, 7, 11], suffix: 'maj9' },
  { intervals: [0, 2, 3, 7, 10], suffix: 'm9' },
  { intervals: [0, 4, 7, 11], suffix: 'maj7' },
  { intervals: [0, 3, 7, 10], suffix: 'm7' },
  { intervals: [0, 4, 7, 10], suffix: '7' },
  { intervals: [0, 2, 4, 7], suffix: 'add9' },
  { intervals: [0, 2, 3, 7], suffix: 'm(add9)' },
  { intervals: [0, 4, 7], suffix: '' },
  { intervals: [0, 3, 7], suffix: 'm' },
  { intervals: [0, 2, 7], suffix: 'sus2' },
  { intervals: [0, 5, 7], suffix: 'sus4' },
  { intervals: [0, 7], suffix: '5' },
];

const sameSet = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Best chord name for a set of sounding pitch classes, or `null` when the stack
 * isn't a shape we name.
 *
 * `bassPc` breaks ties: the same pitch classes can match several roots (D6 and
 * Bm7 are the same four notes), and the lowest sounding voice is what the ear
 * actually hears as the root. Returning `null` rather than guessing is
 * deliberate — mid-drift the layers genuinely do pass through stacks that aren't
 * a named chord, and the UI shows the raw notes for those instead of inventing a
 * label.
 */
export function chordName(pitchClasses: number[], bassPc?: number): string | null {
  const unique = [...new Set(pitchClasses)].sort((a, b) => a - b);
  if (unique.length === 0) return null;
  if (unique.length === 1) return NOTE_NAMES[unique[0]!]!;

  const roots = bassPc === undefined ? [] : [bassPc];
  for (let pc = 0; pc < 12; pc++) if (pc !== bassPc) roots.push(pc);

  for (const root of roots) {
    const intervals = unique.map((pc) => ((pc - root) % 12 + 12) % 12).sort((a, b) => a - b);
    for (const template of TEMPLATES) {
      if (sameSet(intervals, [...template.intervals].sort((a, b) => a - b))) {
        return `${NOTE_NAMES[root]!}${template.suffix}`;
      }
    }
  }
  return null;
}

/** Pitch classes of the D-major scale — the key the whole voicing is written in. */
const D_MAJOR_SCALE = new Set([2, 4, 6, 7, 9, 11, 1]);

/** True when every sounding pitch belongs to D major, which the voicing guarantees by design. */
export function inKey(pitchClasses: number[]): boolean {
  return pitchClasses.length > 0 && pitchClasses.every((pc) => D_MAJOR_SCALE.has(pc));
}

export interface ScoreReadout {
  voices: VoiceReadout[];
  /**
   * Named chord from the *sustained* layers, or `null` mid-drift.
   *
   * Struck voices are excluded on purpose: the bell and the plucked ninth are
   * melody over the harmony, not part of it — the bell's whole design is that
   * every note is a triad tone so it stays consonant against whatever the drones
   * hold. Folding it into the chord turned ordinary voicings into unnameable
   * seven-note stacks.
   */
  chord: string | null;
  /** Headline label: the chord when there is one, else the key it's drifting inside. */
  label: string;
  /** True when `label` is the key fallback rather than a real chord name. */
  drifting: boolean;
  /** Every sounding note, low to high. */
  notes: string[];
  /** Just the struck voices — the melodic layer. */
  melody: string[];
  turn: number;
}

/** The full picture: every voice, the harmony they spell, and the melody over it. */
export function readScore(voices: VoiceSpec[], gains: number[], turn: number): ScoreReadout {
  const readouts = voices.map((voice, i) => readVoice(voice, i, gains[i] ?? 0, turn));
  const sounding = readouts.filter((v) => v.audible).sort((a, b) => a.hz - b.hz);
  const harmony = sounding.filter((v) => v.kind === 'sustained');

  const chord = chordName(
    harmony.map((v) => pitchClass(v.hz)),
    harmony.length > 0 ? pitchClass(harmony[0]!.hz) : undefined,
  );

  // The drones move continuously, so a lot of the loop is genuinely between
  // chords. Falling back to the key is honest about that and still says
  // something true, where a dash would just read as broken.
  const pcs = sounding.map((v) => pitchClass(v.hz));
  const fallback = inKey(pcs) ? 'D major' : '—';

  return {
    voices: readouts,
    chord,
    label: chord ?? fallback,
    drifting: chord === null,
    notes: sounding.map((v) => v.note),
    melody: sounding.filter((v) => v.kind === 'struck').map((v) => v.note),
    turn,
  };
}
