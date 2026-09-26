import { dayPosition, phaseAt, type Phase } from './harmony';
import type { Cue, Mix } from './arranger';
import type { Effort, RadioEvent, SessionState } from './types';

/**
 * The conductor listens to every session on the machine and keeps score.
 *
 * **The more you do, the better it sounds.** Every output token Claude writes —
 * in any session, including subagents — counts toward the track's level, and
 * each level brings in another layer of the band. Nothing is taken away for
 * spending: the only way the music changes with usage is by getting richer.
 *
 * The rest is flow, not accounting:
 *
 * | the session          | the music                                              |
 * | -------------------- | ------------------------------------------------------ |
 * | output tokens        | **levels** — each one adds a layer                     |
 * | Claude working       | the full band                                          |
 * | your turn            | a soft flourish, then the band lays back (the beat stays) |
 * | `/compact`           | a filter sweep into a fresh progression                |
 * | context fill         | the sky's time of day, and a warmer, late-night tone   |
 * | other sessions       | more lanterns — and their tokens count too             |
 *
 * Pure: time is always passed in, so live, replayed and scripted events are
 * handled identically.
 */

export type BuildSpeed = 'slow' | 'normal' | 'fast';

export interface Level {
  level: number;
  /** Output tokens, since tuning in, that unlock it. */
  at: number;
  name: string;
}

/**
 * The ladder. Paced so a busy session climbs it in about half an hour — a new
 * layer every few minutes early on, then further apart, so the top feels earned.
 */
export const LEVELS: readonly Level[] = [
  { level: 1, at: 0, name: 'Tuned in' },
  { level: 2, at: 1_500, name: 'Groove' },
  { level: 3, at: 5_000, name: 'Warmth' },
  { level: 4, at: 12_000, name: 'Melody' },
  { level: 5, at: 24_000, name: 'Strings' },
  { level: 6, at: 40_000, name: 'Sparkle' },
  { level: 7, at: 65_000, name: 'Pocket' },
  { level: 8, at: 100_000, name: 'Flow state' },
];

const SPEED: Record<BuildSpeed, number> = { slow: 1.6, normal: 1, fast: 0.5 };

export interface ConductorOptions {
  buildSpeed?: BuildSpeed;
  /** Multiplies every threshold — the demo compresses an afternoon into minutes. */
  levelScale?: number;
  /** Silence from every session this long before the band starts to leave. */
  idleMs?: number;
  /** How long the band takes to leave. */
  fadeMs?: number;
  /** How present the band stays once it has left. */
  floor?: number;
  /** A session this quiet is treated as idle, even without an end-of-turn. */
  staleMs?: number;
  /** A session this quiet leaves the stage. */
  forgetMs?: number;
}

export const DEFAULT_CONDUCTOR: Required<ConductorOptions> = {
  buildSpeed: 'normal',
  levelScale: 1,
  idleMs: 10 * 60_000,
  fadeMs: 15 * 60_000,
  floor: 0.3,
  staleMs: 5 * 60_000,
  forgetMs: 45 * 60_000,
};

/** What the HUD shows for one session. */
export interface SessionView {
  session: string;
  project: string;
  title: string | null;
  model: string | null;
  effort: Effort | null;
  contextPct: number;
  outTotal: number;
  activity: 'model' | 'tool' | 'idle';
  tool: string | null;
  seat: number;
  /** Local clock ms of the last event. */
  seenAt: number;
  /** When it started waiting on the model, if it is. */
  waitingSince: number | null;
  subSeenAt: number;
  compactions: number;
}

/** Where the track is on the ladder. */
export interface Progress {
  level: number;
  name: string;
  /** Output tokens counted since tuning in. */
  earned: number;
  next: Level | null;
  /** Tokens still to go to the next level. */
  toNext: number;
  /** `0..1` through the current level. */
  fraction: number;
}

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

export class Conductor {
  private readonly opts: Required<ConductorOptions>;
  private readonly sessions = new Map<string, SessionView>();
  private focus: string | null = null;
  private earned = 0;
  private level = 1;
  private day = -1;
  private smoothedAt = 0;
  private lastEventAt = 0;

  constructor(options: ConductorOptions = {}) {
    this.opts = { ...DEFAULT_CONDUCTOR, ...options };
  }

  setBuildSpeed(speed: BuildSpeed): void {
    this.opts.buildSpeed = speed;
    this.level = this.levelFor(this.earned);
  }

  /** A level's threshold, after build speed and scale. */
  threshold(level: Level): number {
    return level.at * SPEED[this.opts.buildSpeed] * this.opts.levelScale;
  }

  private levelFor(earned: number): number {
    let level = 1;
    for (const l of LEVELS) if (earned >= this.threshold(l)) level = l.level;
    return level;
  }

  /**
   * Start from where the server says every session already is, so the cards
   * and the sky are right the moment you tune in. Tokens spent before tuning in
   * don't count toward the level — the track builds from here.
   */
  seed(states: readonly SessionState[], now: number): void {
    for (const state of [...states].sort((a, b) => a.lastAt - b.lastAt)) {
      if (now - state.lastAt > this.opts.forgetMs) continue;
      const view = this.ensure(state.session, state.lastAt);
      Object.assign(view, {
        project: state.project,
        title: state.title,
        model: state.model,
        effort: state.effort,
        contextPct: state.contextPct,
        outTotal: state.outTotal,
        activity: now - state.lastAt > this.opts.staleMs ? 'idle' : state.activity,
        tool: state.tool,
        compactions: state.compactions,
      });
      if (view.activity === 'model') view.waitingSince = state.lastAt;
      this.focus = state.session;
      this.lastEventAt = Math.max(this.lastEventAt, state.lastAt);
    }
    this.day = -1; // arrive at the right time of day rather than watching dawn catch up
  }

  /** Name a session without touching its live state. */
  describe(session: string, meta: { project?: string; title?: string | null }, now: number): void {
    const view = this.ensure(session, now);
    if (meta.project) view.project = meta.project;
    if (meta.title) view.title = meta.title;
  }

  /** Take one event; return the moments worth marking. */
  handle(event: RadioEvent, now: number): Cue[] {
    const s = this.ensure(event.session, now);
    s.seenAt = now;
    this.lastEventAt = now;

    if (event.sub) {
      s.subSeenAt = now;
      if (event.type === 'usage') {
        s.outTotal += event.out;
        return this.earn(event.out);
      }
      return [];
    }

    switch (event.type) {
      case 'prompt':
        s.activity = 'model';
        s.tool = null;
        s.waitingSince = now;
        this.focus = s.session;
        return [];

      case 'think':
        s.activity = 'model';
        return [];

      case 'text':
        s.activity = 'model';
        s.waitingSince = null;
        return [];

      case 'tool':
        s.activity = 'tool';
        s.tool = event.name;
        s.waitingSince = null;
        return [];

      case 'result':
        s.activity = 'model';
        s.tool = null;
        s.waitingSince = now;
        return [];

      case 'usage': {
        if (event.model) s.model = event.model;
        if (event.effort) s.effort = event.effort;
        s.contextPct = event.contextPct;
        s.outTotal += event.out;
        return this.earn(event.out);
      }

      case 'end':
        if (s.activity === 'idle') return [];
        s.activity = 'idle';
        s.tool = null;
        s.waitingSince = null;
        return event.interrupted ? [] : [{ kind: 'turnEnd' }];

      case 'compact':
        s.contextPct = 0;
        s.compactions += 1;
        return [{ kind: 'sunrise' }];

      case 'title':
        s.title = event.title;
        return [];
    }
  }

  private earn(tokens: number): Cue[] {
    this.earned += Math.max(0, tokens);
    const level = this.levelFor(this.earned);
    const cues: Cue[] = [];
    for (let l = this.level + 1; l <= level; l++) cues.push({ kind: 'levelUp', level: l });
    this.level = Math.max(this.level, level);
    return cues;
  }

  /** The continuous state, advanced to `now`. */
  mix(now: number): Mix {
    this.prune(now);
    const focused = this.focused();
    this.advance(now, focused);

    const working = [...this.sessions.values()].some(
      (s) => (s.activity !== 'idle' && now - s.seenAt < this.opts.staleMs) || now - s.subSeenAt < 45_000,
    );

    let presence = 0.8; // a room waiting for someone to start
    if (this.lastEventAt > 0) {
      const quiet = now - this.lastEventAt;
      presence =
        quiet <= this.opts.idleMs
          ? 1
          : Math.max(this.opts.floor, 1 - ((quiet - this.opts.idleMs) / this.opts.fadeMs) * (1 - this.opts.floor));
    }

    let stars = 0;
    for (const s of this.sessions.values()) stars += s.outTotal / 1000;

    return { day: clamp(this.day, 0, 1), level: this.level, working, presence, stars };
  }

  /** Where the track is on the ladder. */
  progress(): Progress {
    const current = LEVELS[this.level - 1]!;
    const next = LEVELS[this.level] ?? null;
    const from = this.threshold(current);
    const to = next ? this.threshold(next) : from;
    return {
      level: this.level,
      name: current.name,
      earned: this.earned,
      next,
      toNext: next ? Math.max(0, to - this.earned) : 0,
      fraction: next ? clamp((this.earned - from) / Math.max(1, to - from), 0, 1) : 1,
    };
  }

  /** Every session on stage, by seat, for the HUD. */
  view(now: number): { sessions: SessionView[]; focus: string | null; phase: Phase } {
    this.prune(now);
    const focused = this.focused();
    this.advance(now, focused);
    return {
      sessions: [...this.sessions.values()].sort((a, b) => a.seat - b.seat),
      focus: focused?.session ?? null,
      phase: phaseAt(this.day < 0 ? 0 : this.day),
    };
  }

  /**
   * The session the sky follows: the one you last prompted. Not the one that
   * spoke last — with two sessions working that flips every second.
   */
  private focused(): SessionView | null {
    const current = this.focus ? this.sessions.get(this.focus) : undefined;
    if (current) return current;
    let latest: SessionView | null = null;
    for (const s of this.sessions.values()) if (!latest || s.seenAt > latest.seenAt) latest = s;
    this.focus = latest?.session ?? null;
    return latest;
  }

  /** Move the sky toward the focused session's context. */
  private advance(now: number, focused: SessionView | null): void {
    const dt = this.smoothedAt > 0 ? Math.max(0, now - this.smoothedAt) : 0;
    this.smoothedAt = Math.max(this.smoothedAt, now);
    const target = focused ? dayPosition(focused.contextPct) : 0;
    // Context only falls on a compaction, and then the sun should come up in
    // seconds, not drift.
    const tau = target < this.day - 0.15 ? 1_800 : 6_000;
    if (this.day < 0) this.day = target;
    else this.day += (target - this.day) * (1 - Math.exp(-dt / tau));
  }

  private prune(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now - s.seenAt > this.opts.forgetMs && id !== this.focus) this.sessions.delete(id);
    }
  }

  private ensure(session: string, now: number): SessionView {
    let view = this.sessions.get(session);
    if (view) return view;
    const taken = new Set([...this.sessions.values()].map((s) => s.seat));
    let seat = 0;
    while (taken.has(seat)) seat += 1;
    view = {
      session,
      project: '',
      title: null,
      model: null,
      effort: null,
      contextPct: 0,
      outTotal: 0,
      activity: 'idle',
      tool: null,
      seat,
      seenAt: now,
      waitingSince: null,
      subSeenAt: 0,
      compactions: 0,
    };
    this.sessions.set(session, view);
    if (!this.focus) this.focus = session;
    return view;
  }
}
