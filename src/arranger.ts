import { PROGRESSIONS, bassNote, buildChord, notesIn, voiceLead, type Chord, type Progression } from './harmony';
import { hashString, mulberry32, pick, type Rng } from './rng';

/**
 * The band. Turns *how far the session has come* into a lo-fi arrangement, one
 * beat at a time.
 *
 * It's a loop-based arrangement, not a sonification: a four-bar progression,
 * one chord per bar, played by keys, bass and drums from the first beat. What
 * the session earns is **layers** — a bass line, richer chords, a melody,
 * strings, an arpeggio, ghost notes — and each one enters on a phrase boundary,
 * announced by a small drum fill, the way a producer would bring it in.
 *
 * Nothing here reacts note-for-note to events. Repetition is what makes a
 * groove, so melodies are motifs that repeat; events only decide how much of
 * the band is playing.
 *
 * Every pitched note comes from the safe set of the chord sounding when it
 * plays (see `harmony.ts`). Pure and seeded — the tests hold it to that.
 */

export type Voice = 'keys' | 'bass' | 'lead' | 'arp' | 'sparkle';
export type DrumPiece = 'kick' | 'snare' | 'hat' | 'openhat' | 'shaker';

/** Moments the conductor wants marked. */
export type Cue =
  /** Claude handed back — a soft flourish, and the band lays back. */
  | { kind: 'turnEnd' }
  /** The context was compacted — a filter sweep into a fresh progression. */
  | { kind: 'sunrise' }
  /** The session earned a level. The band plays it in at the next phrase. */
  | { kind: 'levelUp'; level: number };

/** The continuous state the conductor reports every beat. */
export interface Mix {
  /** Position through the day, `0..1` — the sky, and a warmer tone at night. */
  day: number;
  /** Level earned so far, `1..8`. */
  level: number;
  /** Any session is mid-turn. */
  working: boolean;
  /** `0..1` — falls off after a long silence. */
  presence: number;
  /** Output tokens across every session, in thousands. */
  stars: number;
}

export interface PlannedNote {
  /** Sixteenth within the beat, `0..3`. */
  step: number;
  midi: number;
  voice: Voice;
  velocity: number;
  /** Length in beats. */
  beats: number;
  /** Position within a strummed chord — the engine staggers each by a few ms. */
  strum: number;
  pan: number;
}

export interface PlannedHit {
  step: number;
  piece: DrumPiece;
  velocity: number;
}

export interface BeatPlan {
  beat: number;
  bar: number;
  downbeat: boolean;
  /** The chord sounding, e.g. `Dm9`. */
  chord: string;
  /** The level the band is playing at. */
  level: number;
  band: 'full' | 'laid back';
  /** New pad voicing, when it changes. Empty means the pad releases. */
  pad?: number[];
  notes: PlannedNote[];
  drums: PlannedHit[];
  flourish?: 'levelup' | 'sunrise' | 'sparkle';
}

export interface ArrangerOptions {
  seed?: number;
  /** Tonic pitch class, `0..11`. Default F. */
  tonic?: number;
}

export const DEFAULT_ARRANGER: Required<ArrangerOptions> = { seed: 0x10f1, tonic: 5 };

/** What each level adds. The conductor decides when a level is earned; this is what it sounds like. */
export const LEVEL_LAYERS: readonly string[] = [
  '',
  'drums, keys and bass',
  'a moving bass line',
  'richer chords and a busier comp',
  'a melody',
  'strings and a shaker',
  'an arpeggio and new progressions',
  'ghost notes, fills and a walking bass',
  'a harmonized melody and borrowed chords',
];

/**
 * Drum patterns, one string per piece, one character per sixteenth
 * (`x` accent, `o` normal, `-` ghost, `.` rest). Written as text because a
 * pattern is a picture of a bar.
 */
type Kit = Partial<Record<DrumPiece, string>>;

const KITS: Record<'laid back' | 1 | 2 | 5 | 7, Kit> = {
  // Your turn: the beat keeps going, softer — half the kick, a whisper of hat.
  'laid back': {
    kick: 'x.........-.....',
    snare: '....-.......-...',
    hat: 'o...-...o...-...',
  },
  // Boom-bap at its simplest: kick on one and the and-of-three, snare on two and four.
  1: {
    kick: 'x.........x.....',
    snare: '....x.......x...',
    hat: 'o.-.o.-.o.-.o.-.',
  },
  2: {
    kick: 'x......-..x.....',
    snare: '....x.......x...',
    hat: 'o.-.o.-.o.-.o.-.',
  },
  5: {
    kick: 'x......-..x.....',
    snare: '....x.......x...',
    hat: 'o.-.o.-.o.-.o.-.',
    shaker: '.-.-.-.-.-.-.-.-',
  },
  7: {
    kick: 'x......-..x...-.',
    snare: '....x..-....x.-.',
    hat: 'o.-.o.-oo.-.o.-.',
    shaker: '.-.-.-.-.-.-.-.-',
  },
};

const VELOCITY: Record<string, number> = { x: 1, o: 0.72, '-': 0.36 };

/** Keys comping rhythms, `[step, length]` in sixteenths — one per bar, cycling. */
const COMPS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [0, 6],
    [6, 4],
    [10, 6],
  ],
  [
    [0, 10],
    [10, 6],
  ],
  [
    [0, 3],
    [3, 5],
    [8, 8],
  ],
  [
    [0, 7],
    [7, 9],
  ],
];

/** Lead rhythms over two bars, `[step, length]` — lyrical, with room to breathe. */
const MOTIF_RHYTHMS: readonly (readonly (readonly [number, number])[])[] = [
  [
    [0, 6],
    [6, 4],
    [10, 6],
    [16, 6],
    [22, 8],
  ],
  [
    [2, 4],
    [6, 2],
    [8, 6],
    [14, 4],
    [18, 6],
    [24, 6],
  ],
  [
    [0, 3],
    [3, 3],
    [6, 6],
    [12, 4],
    [16, 3],
    [19, 3],
    [22, 8],
  ],
  [
    [4, 4],
    [8, 2],
    [10, 2],
    [12, 8],
    [20, 4],
    [24, 6],
  ],
];

interface Motif {
  rhythm: readonly (readonly [number, number])[];
  /** Index into the chord's safe notes, per rhythm onset. */
  contour: number[];
}

/** Where the lead sings. */
const LEAD: readonly [number, number] = [65, 84];
/** Where the pad breathes. */
const PAD: readonly [number, number] = [60, 76];

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

interface Timed<T> {
  /** Sixteenth within the bar, `0..15`. */
  at: number;
  item: T;
}

export class Arranger {
  private readonly opts: Required<ArrangerOptions>;
  private readonly rng: Rng;

  private level = 0;
  private band: BeatPlan['band'] = 'laid back';
  private progression: Progression = PROGRESSIONS[0]!;
  private sectionStart = 0;
  private sectionsOnProgression = 0;
  private readonly heard = new Set<string>();
  private motif: Motif | null = null;
  private chord: Chord | null = null;
  private keys: number[] = [57, 60, 64, 67];
  private bass = 41;
  private pad: number[] = [];

  private barNotes: Timed<Omit<PlannedNote, 'step'>>[] = [];
  private barHits: Timed<PlannedHit>[] = [];
  private fillBeat = -1;

  private sparklePending = false;
  private sunrisePending = false;

  constructor(options: ArrangerOptions = {}) {
    this.opts = { ...DEFAULT_ARRANGER, ...options };
    this.rng = mulberry32(this.opts.seed);
  }

  cue(cue: Cue): void {
    if (cue.kind === 'turnEnd') this.sparklePending = true;
    if (cue.kind === 'sunrise') this.sunrisePending = true;
    // Level-ups arrive through `Mix.level`; the band decides when to play them in.
  }

  /** Plan everything that sounds during `beat`. Call once per beat, in order. */
  planBeat(beat: number, mix: Mix): BeatPlan {
    const bar = Math.floor(beat / 4);
    const inBar = beat % 4;
    let flourish: BeatPlan['flourish'];
    let pad: number[] | undefined;

    if (inBar === 0 || this.chord === null) {
      const started = this.startBar(bar, mix);
      pad = started.pad;
      flourish = started.flourish;
    }

    const from = inBar * 4;
    const notes: PlannedNote[] = this.barNotes
      .filter((n) => n.at >= from && n.at < from + 4)
      .map((n) => ({ ...n.item, step: n.at - from }));
    const drums: PlannedHit[] = this.barHits
      .filter((h) => h.at >= from && h.at < from + 4)
      .map((h) => ({ ...h.item, step: h.at - from }));

    if (inBar === this.fillBeat) flourish = 'levelup';

    // Your turn: four notes climbing through the chord, softly, on the next beat.
    if (this.sparklePending) {
      this.sparklePending = false;
      flourish ??= 'sparkle';
      const climb = notesIn(this.chord!.safe, 76, 93).slice(0, 4);
      climb.forEach((midi, i) =>
        notes.push({ step: i, midi, voice: 'sparkle', velocity: 0.3 + i * 0.04, beats: 2, strum: 0, pan: 0.2 }),
      );
    }

    return {
      beat,
      bar,
      downbeat: inBar === 0,
      chord: this.chord!.label,
      level: this.level,
      band: this.band,
      pad,
      notes,
      drums,
      flourish,
    };
  }

  /** Bar-line decisions: level, band, section, chord — then write the bar. */
  private startBar(bar: number, mix: Mix): { pad?: number[]; flourish?: BeatPlan['flourish'] } {
    let flourish: BeatPlan['flourish'];
    const first = this.chord === null;
    const earned = clamp(Math.round(mix.level), 1, 8);

    // Levels arrive on phrase boundaries, one at a time — a build, not a jump.
    if (first) this.level = 1;
    else if (bar % 4 === 0) this.level = earned > this.level ? this.level + 1 : earned;

    if (first || bar % 2 === 0) {
      this.band = mix.working && mix.presence >= 0.5 ? 'full' : 'laid back';
    }

    const barInSection = bar - this.sectionStart;
    if (first || this.sunrisePending || barInSection >= 8) {
      if (this.sunrisePending) {
        flourish = 'sunrise';
        this.sunrisePending = false;
        this.sectionsOnProgression = 99; // always a fresh loop after a sunrise
      }
      this.newSection(bar, first);
    }

    const chords = this.progression.chords;
    const spec = chords[(bar - this.sectionStart) % chords.length]!;
    this.chord = buildChord(this.opts.tonic, spec, this.level);
    this.keys = voiceLead(this.keys, this.chord.voicing);

    let pad: number[] | undefined;
    if (this.level >= 5) {
      const tones = [this.chord.voicing[0]!, this.chord.voicing[2]!, this.chord.voicing[3]!];
      this.pad = voiceLead(this.pad.length === 3 ? this.pad : [62, 66, 70], tones, PAD);
      pad = [...this.pad];
    } else if (this.pad.length > 0) {
      this.pad = [];
      pad = [];
    }

    this.writeBar(bar, earned);
    return { pad, flourish };
  }

  private newSection(bar: number, first: boolean): void {
    this.sectionStart = bar;
    this.sectionsOnProgression += 1;
    // A loop plays for two sections (16 bars, ~50s) before it changes — long
    // enough to settle into, which is most of what makes lo-fi work.
    if (!first && this.sectionsOnProgression < 2) return;
    this.sectionsOnProgression = 0;

    const pool = PROGRESSIONS.filter((p) => p.minLevel <= this.level);
    // A progression the band hasn't played yet is part of the reward for
    // levelling up; play the new ones first.
    const fresh = pool.filter((p) => !this.heard.has(p.name));
    const others = (fresh.length > 0 ? fresh : pool).filter((p) => p !== this.progression);
    this.progression = first ? PROGRESSIONS[0]! : pick(this.rng, others.length > 0 ? others : pool);
    this.heard.add(this.progression.name);
    this.motif = this.makeMotif();
  }

  private makeMotif(): Motif {
    const rng = mulberry32(this.opts.seed ^ hashString(`${this.progression.name}-${this.heard.size}`));
    const rhythm = pick(rng, MOTIF_RHYTHMS);
    const contour: number[] = [];
    let index = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < rhythm.length; i++) {
      contour.push(index);
      const r = rng();
      index += r < 0.35 ? 1 : r < 0.7 ? -1 : r < 0.85 ? 2 : r < 0.95 ? -2 : 0;
      index = clamp(index, 0, 7);
    }
    return { rhythm, contour };
  }

  /** Write every note and hit of this bar. */
  private writeBar(bar: number, earned: number): void {
    const chord = this.chord!;
    const level = this.level;
    const full = this.band === 'full';
    const notes: Timed<Omit<PlannedNote, 'step'>>[] = [];
    const hits: Timed<PlannedHit>[] = [];
    const human = (): number => 0.92 + this.rng() * 0.08;
    const phrase = bar % 4;
    this.fillBeat = -1;

    // Keys: one long chord per bar to start, a comp once the chords get richer.
    const comp: readonly (readonly [number, number])[] = full && level >= 3 ? COMPS[bar % COMPS.length]! : [[0, 15]];
    comp.forEach(([at, length], hit) => {
      this.keys.forEach((midi, i) => {
        notes.push({
          at,
          item: {
            midi,
            voice: 'keys',
            velocity: (hit === 0 ? 0.56 : 0.44) * human(),
            beats: length / 4,
            strum: i,
            pan: -0.12 + i * 0.08,
          },
        });
      });
    });

    // Bass: roots, then a line.
    const [root, third, fifth, seventh] = chord.tones as [number, number, number, number];
    let line: Array<[number, number, number]> = [[0, 15, root]];
    if (full && level >= 7) {
      line =
        phrase === 3
          ? [
              [0, 4, root],
              [4, 4, third],
              [8, 4, fifth],
              [12, 4, seventh],
            ]
          : [
              [0, 6, root],
              [10, 4, root],
              [14, 2, fifth],
            ];
    } else if (full && level >= 2) {
      line =
        level >= 4 && phrase === 3
          ? [
              [0, 6, root],
              [8, 2, fifth],
              [10, 6, root],
            ]
          : [
              [0, 6, root],
              [10, 6, root],
            ];
    }
    for (const [at, length, pitch] of line) {
      this.bass = bassNote(pitch, this.bass);
      notes.push({
        at,
        item: { midi: this.bass, voice: 'bass', velocity: 0.8 * human(), beats: length / 4, strum: 0, pan: 0 },
      });
    }

    // Drums.
    const kit = !full ? KITS['laid back'] : level >= 7 ? KITS[7] : level >= 5 ? KITS[5] : level >= 2 ? KITS[2] : KITS[1];
    const fill = phrase === 3 && earned > level;
    for (const [piece, pattern] of Object.entries(kit) as [DrumPiece, string][]) {
      for (let at = 0; at < 16; at++) {
        if (fill && at >= 12 && (piece === 'snare' || piece === 'hat')) continue;
        const v = VELOCITY[pattern[at] ?? '.'];
        if (v !== undefined) hits.push({ at, item: { step: 0, piece, velocity: v * human() } });
      }
    }
    if (fill) {
      // Four sixteenths of snare, rising, into the phrase where the new layer lands.
      [0.34, 0.46, 0.58, 0.74].forEach((v, i) =>
        hits.push({ at: 12 + i, item: { step: 0, piece: 'snare', velocity: v } }),
      );
      this.fillBeat = 3;
    } else if (full && level >= 5 && phrase === 3) {
      hits.push({ at: 14, item: { step: 0, piece: 'openhat', velocity: 0.6 } });
    }

    // Lead: the motif, twice, then a variation, then two bars of space.
    const section = (bar - this.sectionStart) % 8;
    if (full && level >= 4 && this.motif && section < 6) {
      const half = (section % 2) * 16;
      const safe = notesIn(chord.safe, LEAD[0], LEAD[1]);
      const tones = new Set(chord.tones);
      const { rhythm, contour } = this.motif;
      rhythm.forEach(([at32, length], i) => {
        if (at32 < half || at32 >= half + 16) return;
        let index = contour[i]!;
        if (section >= 4 && i >= rhythm.length - 2) index += i % 2 === 0 ? 1 : -1; // the variation
        index = clamp(index, 0, safe.length - 1);
        let midi = safe[index]!;
        // A phrase ends on a chord tone.
        if (i === rhythm.length - 1 && !tones.has(midi % 12)) {
          const down = safe[index - 1];
          const up = safe[index + 1];
          if (down !== undefined && tones.has(down % 12)) midi = down;
          else if (up !== undefined && tones.has(up % 12)) midi = up;
        }
        const at = at32 - half;
        notes.push({ at, item: { midi, voice: 'lead', velocity: 0.55 * human(), beats: length / 4, strum: 0, pan: 0.1 } });
        if (level >= 8) {
          const below = safe[safe.indexOf(midi) - 2];
          if (below !== undefined) {
            notes.push({
              at,
              item: { midi: below, voice: 'lead', velocity: 0.36 * human(), beats: length / 4, strum: 0, pan: -0.1 },
            });
          }
        }
      });
    }

    // Arpeggio: eighths through the keys voicing, an octave up.
    if (full && level >= 6 && section >= 2) {
      const up = this.keys.map((m) => m + 12);
      [0, 1, 2, 3, 2, 1, 3, 1].forEach((voice, i) => {
        notes.push({
          at: i * 2,
          item: {
            midi: up[voice]!,
            voice: 'arp',
            velocity: (i % 2 === 0 ? 0.34 : 0.26) * human(),
            beats: 0.5,
            strum: 0,
            pan: 0.35,
          },
        });
      });
    }

    this.barNotes = notes;
    this.barHits = hits;
  }
}
