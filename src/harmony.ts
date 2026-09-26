/**
 * The radio's harmony: one major key, jazz seventh chords, and the rule that
 * keeps everything consonant.
 *
 * **The rule.** Every chord carries a `safe` set — its chord tones plus the
 * tensions that sit well over it (the 9th and 13th on a major seventh, the 9th
 * and 11th on a minor seventh, the 9th and 13th on a dominant). Melody, arpeggio
 * and flourish notes are only ever drawn from the safe set of the chord sounding
 * *when they play*. Avoid notes — the 4th over a major chord, the ♭9 anywhere —
 * are simply not in the vocabulary, so a clash can't be generated. The arranger
 * tests assert this over thousands of beats.
 *
 * Pure and Node-free; the browser and the tests both import it.
 */

export type Quality = 'maj7' | 'm7' | '7';

/** A chord as the progression tables write it: root above the tonic, and quality. */
export interface ChordSpec {
  /** Semitones above the tonic. */
  root: number;
  quality: Quality;
  /**
   * Leave the 9th out. The iii chord's 9th is a semitone outside the key (F♯
   * over Em7 in C) — lovely on its own, but it's the one tension that steps off
   * the scale, so iii gets its 11th instead.
   */
  noNinth?: boolean;
}

export interface Chord {
  /** Root pitch class, `0..11`. */
  root: number;
  quality: Quality;
  /** Root, third, fifth, seventh — pitch classes. */
  tones: number[];
  /** Tensions that sound good over this chord — pitch classes. */
  tensions: number[];
  /** Everything a melody may play over this chord: tones + tensions. */
  safe: number[];
  /** The pitch classes the keys voice at this level, e.g. `[3, 5, 7, 9]`. */
  voicing: number[];
  /** e.g. `Dm9`, `G13`, `Fmaj9`. */
  label: string;
}

/** The major scale, in semitones above the tonic. */
export const MAJOR = [0, 2, 4, 5, 7, 9, 11] as const;

/** Diatonic seventh chords of a major key, by degree. vii (m7♭5) is left out on purpose. */
export const DIATONIC: Record<'I' | 'ii' | 'iii' | 'IV' | 'V' | 'vi', ChordSpec> = {
  I: { root: 0, quality: 'maj7' },
  ii: { root: 2, quality: 'm7' },
  iii: { root: 4, quality: 'm7', noNinth: true },
  IV: { root: 5, quality: 'maj7' },
  V: { root: 7, quality: '7' },
  vi: { root: 9, quality: 'm7' },
};

/** Borrowed from the parallel minor: the two chords that make lo-fi sound like lo-fi. */
export const BORROWED: Record<'iv' | 'bVII', ChordSpec> = {
  iv: { root: 5, quality: 'm7' },
  bVII: { root: 10, quality: '7' },
};

const { I, ii, iii, IV, V, vi } = DIATONIC;
const { iv, bVII } = BORROWED;

/** A four-bar loop, and the level at which it becomes available. */
export interface Progression {
  chords: readonly ChordSpec[];
  minLevel: number;
  name: string;
}

/**
 * The loops. Early levels get the plain, endlessly repeatable ones; later
 * levels unlock turnarounds and, at the top, the borrowed minor iv and ♭VII —
 * the "sad chord" that most lo-fi is built around. Every one of them is smooth
 * to loop: the last chord leads back to the first.
 */
export const PROGRESSIONS: readonly Progression[] = [
  { name: 'descent', chords: [IV, iii, ii, I], minLevel: 1 },
  { name: 'classic', chords: [I, vi, ii, V], minLevel: 1 },
  { name: 'two-five', chords: [ii, V, I, vi], minLevel: 1 },
  { name: 'sixes', chords: [vi, IV, I, V], minLevel: 2 },
  { name: 'royal road', chords: [IV, V, iii, vi], minLevel: 3 },
  { name: 'turnaround', chords: [I, iii, IV, V], minLevel: 5 },
  { name: 'rain', chords: [ii, iii, IV, V], minLevel: 6 },
  { name: 'sad chord', chords: [IV, iv, I, vi], minLevel: 7 },
  { name: 'backdoor', chords: [ii, iv, bVII, I], minLevel: 8 },
];

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const FLAT_KEYS = new Set([5, 10, 3, 8, 1, 6]);

const pc = (n: number): number => ((n % 12) + 12) % 12;

/** Spell a pitch class the way the key of `tonic` major would. */
export function noteName(pitch: number, tonic: number = 0): string {
  return (FLAT_KEYS.has(pc(tonic)) ? FLAT_NAMES : SHARP_NAMES)[pc(pitch)]!;
}

const STRUCTURE: Record<Quality, { third: number; fifth: number; seventh: number; tensions: number[] }> = {
  // Over a major seventh: the 9th and 13th. Not the 4th — it rubs against the 3rd.
  maj7: { third: 4, fifth: 7, seventh: 11, tensions: [2, 9] },
  // Over a minor seventh: the 9th and 11th. The 11th is what makes m11 so soft.
  m7: { third: 3, fifth: 7, seventh: 10, tensions: [2, 5] },
  // Over a dominant: the 9th and 13th. Never the ♭9 or the 4th.
  '7': { third: 4, fifth: 7, seventh: 10, tensions: [2, 9] },
};

/**
 * Build a chord, voiced for the level the track has reached.
 *
 * - Levels 1–2: root, 3rd, 5th, 7th. Plain and warm.
 * - Level 3+: rootless — 3rd, 5th, 7th, 9th — with the bass holding the root.
 *   This is the jazz-piano voicing that most lo-fi keys use.
 * - Level 6+: the 5th gives way to the 13th on dominants and the 11th on minors.
 */
export function buildChord(tonic: number, spec: ChordSpec, level: number): Chord {
  const root = pc(tonic + spec.root);
  const s = STRUCTURE[spec.quality];
  const at = (interval: number): number => pc(root + interval);
  const tones = [root, at(s.third), at(s.fifth), at(s.seventh)];
  const tensions = s.tensions.filter((t) => !(spec.noNinth && t === 2)).map(at);

  let voicing = tones;
  let suffix: string = spec.quality;
  if (level >= 3) {
    // Rootless: the colour tone goes where the root was.
    const colour = spec.noNinth ? at(5) : at(2);
    voicing = [at(s.third), at(s.fifth), at(s.seventh), colour];
    suffix = spec.noNinth ? 'm11' : spec.quality === 'maj7' ? 'maj9' : spec.quality === 'm7' ? 'm9' : '9';
  }
  if (level >= 6 && spec.quality !== 'maj7' && !spec.noNinth) {
    const colour = spec.quality === 'm7' ? 5 : 9;
    voicing = [at(s.third), at(colour), at(s.seventh), at(2)];
    suffix = spec.quality === 'm7' ? 'm11' : '13';
  }

  return {
    root,
    quality: spec.quality,
    tones,
    tensions,
    safe: [...tones, ...tensions],
    voicing,
    label: noteName(root, tonic) + suffix,
  };
}

/** Nearest MIDI note with pitch class `pitch` to `near`. */
export function nearestWithPc(pitch: number, near: number): number {
  const below = near - pc(near - pitch);
  const above = below + 12;
  return near - below <= above - near ? below : above;
}

/** Fold a note into `[lo, hi]` by octaves. */
export function fold(midi: number, lo: number, hi: number): number {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m < lo ? m + 12 : m;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([item, ...tail]);
  });
  return out;
}

/** Where the keys live: F3 to C5. */
export const KEYS_RANGE: readonly [number, number] = [53, 72];

/**
 * Move each voice to a tone of the new chord by the shortest total path, so
 * chord changes glide instead of jumping. Scores every assignment of tones to
 * voices, in every octave that fits, and keeps the cheapest — with anything
 * that would sound rough (a semitone between neighbours, a unison) ruled out,
 * and low clusters discouraged.
 *
 * Returns pitches sorted low to high.
 */
export function voiceLead(
  previous: readonly number[],
  targetPcs: readonly number[],
  range: readonly [number, number] = KEYS_RANGE,
): number[] {
  const [lo, hi] = range;
  let best: number[] = [];
  let bestCost = Infinity;

  // Each voice may take its nearest note or the one an octave either side —
  // spreading a voicing out is sometimes the only way to avoid a rub.
  const shifts = [0, -12, 12];
  const options: number[][] = [];
  for (const perm of permutations(targetPcs)) {
    const nearest = perm.map((p, i) => nearestWithPc(p, previous[i] ?? 62));
    const walk = (i: number, acc: number[]): void => {
      if (i === nearest.length) {
        options.push(acc);
        return;
      }
      for (const shift of shifts) {
        const m = nearest[i]! + shift;
        if (m >= lo && m <= hi) walk(i + 1, [...acc, m]);
      }
      if (!shifts.some((shift) => nearest[i]! + shift >= lo && nearest[i]! + shift <= hi)) {
        walk(i + 1, [...acc, fold(nearest[i]!, lo, hi)]);
      }
    };
    walk(0, []);
  }

  for (const candidate of options) {
    let cost = candidate.reduce((sum, m, i) => sum + Math.abs(m - (previous[i] ?? m)), 0);
    const sorted = [...candidate].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!;
      // A semitone between neighbouring voices is the one sound the keys must
      // never make — a rub, not a colour — so it's all but forbidden, not just
      // discouraged. (Dm11's E and F go a seventh apart instead.)
      if (gap <= 1) cost += 1_000;
      else if (gap < 3 && sorted[i - 1]! < 57) cost += 8;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = sorted;
    }
  }
  return best;
}

/** Where the bass lives: C2 to D3, audible on laptop speakers. */
export const BASS_RANGE: readonly [number, number] = [36, 50];

/** A bass note of pitch class `pitch`, as close as possible to the last one. */
export function bassNote(pitch: number, previous: number): number {
  return fold(nearestWithPc(pitch, previous), BASS_RANGE[0], BASS_RANGE[1]);
}

/** Every note of `pcs` inside `[lo, hi]`, ascending. */
export function notesIn(pcs: readonly number[], lo: number, hi: number): number[] {
  const set = new Set(pcs.map(pc));
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (set.has(pc(m))) out.push(m);
  return out;
}

/** Equal-tempered frequency of a MIDI note. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ── the sky ────────────────────────────────────────────────────────────────

/** A time of day, for the sky: where it starts on the `0..1` day. */
export interface Phase {
  name: 'dawn' | 'morning' | 'golden hour' | 'dusk' | 'night';
  from: number;
}

export const PHASES: readonly Phase[] = [
  { name: 'dawn', from: 0 },
  { name: 'morning', from: 0.2 },
  { name: 'golden hour', from: 0.4 },
  { name: 'dusk', from: 0.6 },
  { name: 'night', from: 0.8 },
];

/**
 * How context fill bends onto the day. On a 1M window real sessions run 5% →
 * 68%, so a power curve under 1 spreads that across the whole day: 6% is dawn,
 * 22% golden hour, 69% night.
 */
export const DAY_CURVE = 0.6;

/** Context-window occupancy (`0..100`) → position through the day (`0..1`). */
export function dayPosition(contextPct: number, curve: number = DAY_CURVE): number {
  if (!Number.isFinite(contextPct) || contextPct <= 0) return 0;
  return Math.min(1, Math.pow(Math.min(100, contextPct) / 100, curve));
}

export function phaseAt(position: number): Phase {
  let found = PHASES[0]!;
  for (const phase of PHASES) if (position >= phase.from) found = phase;
  return found;
}
