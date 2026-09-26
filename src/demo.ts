import type { RadioEvent, ToolFamily } from './types';

/**
 * A scripted two-session afternoon, compressed into about two minutes.
 *
 * It exists so the radio can be heard without a live session, and so the whole
 * ladder gets climbed: the track builds from a bare beat to flow state, the band
 * lays back at each turn's end, a second session joins, a subagent pitches in,
 * the sky runs from dawn to night, and a compaction brings the sun back up.
 *
 * `at` is milliseconds from the start of the demo; the player rebases it.
 */

const MAIN = 'demo-conduct';
const SIDE = 'demo-regret';

interface Step {
  /** Pause before this step, ms. */
  wait: number;
  session: string;
  kind:
    | 'prompt'
    | 'text'
    | 'tool'
    | 'ok'
    | 'fail'
    | 'end'
    | 'compact'
    | 'sub-text'
    | 'sub-tool';
  tool?: string;
  tokens?: number;
}

const FAMILY: Record<string, ToolFamily> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  WebSearch: 'web',
  Edit: 'write',
  Write: 'write',
  Bash: 'exec',
  Agent: 'agent',
};

const s = (wait: number, session: string, kind: Step['kind'], tool?: string, tokens?: number): Step => ({
  wait,
  session,
  kind,
  tool,
  tokens,
});

const SCRIPT: Step[] = [
  // Dawn. A question, and a long think before the first word — the suspension.
  s(0, MAIN, 'prompt'),
  s(5200, MAIN, 'text', undefined, 60),
  s(700, MAIN, 'tool', 'Read', 30),
  s(900, MAIN, 'ok'),
  s(1300, MAIN, 'tool', 'Grep', 25),
  s(600, MAIN, 'ok'),
  s(1500, MAIN, 'tool', 'Read', 30),
  s(800, MAIN, 'ok'),
  s(2400, MAIN, 'text', undefined, 180),
  s(900, MAIN, 'tool', 'Edit', 420),
  s(700, MAIN, 'ok'),
  s(1600, MAIN, 'tool', 'Bash', 40),
  s(2600, MAIN, 'fail'),
  s(2200, MAIN, 'text', undefined, 50),
  s(600, MAIN, 'tool', 'Edit', 160),
  s(600, MAIN, 'ok'),
  s(1200, MAIN, 'tool', 'Bash', 40),
  s(2400, MAIN, 'ok'),
  s(2600, MAIN, 'text', undefined, 900),
  s(1400, MAIN, 'end'),

  // Your turn: the groove steps out, the pad holds.
  s(9000, MAIN, 'prompt'),
  s(3400, MAIN, 'tool', 'Agent', 120),
  s(900, MAIN, 'sub-tool', 'Glob', 20),
  s(1100, MAIN, 'sub-tool', 'Read', 30),
  s(1000, MAIN, 'sub-text', undefined, 200),

  // A second session starts in another worktree — a second player.
  s(800, SIDE, 'prompt'),
  s(1200, MAIN, 'sub-tool', 'Grep', 25),
  s(1500, SIDE, 'tool', 'Read', 30),
  s(700, SIDE, 'ok'),
  s(900, MAIN, 'ok'),
  s(700, MAIN, 'text', undefined, 140),
  s(600, SIDE, 'tool', 'Bash', 60),
  s(500, MAIN, 'tool', 'Write', 600),
  s(700, MAIN, 'ok'),
  s(900, SIDE, 'ok'),
  s(800, MAIN, 'tool', 'Edit', 300),
  s(600, SIDE, 'text', undefined, 120),
  s(500, MAIN, 'ok'),
  s(700, SIDE, 'tool', 'Edit', 200),
  s(900, MAIN, 'tool', 'Bash', 50),
  s(600, SIDE, 'ok'),
  s(1600, MAIN, 'ok'),
  s(500, SIDE, 'tool', 'Bash', 40),
  s(900, MAIN, 'tool', 'WebSearch', 20),
  s(1400, MAIN, 'ok'),
  s(700, SIDE, 'fail'),
  s(1800, SIDE, 'tool', 'Edit', 90),
  s(800, MAIN, 'text', undefined, 260),
  s(600, SIDE, 'ok'),
  s(700, MAIN, 'tool', 'Read', 30),
  s(500, SIDE, 'tool', 'Bash', 40),
  s(700, MAIN, 'ok'),
  s(1500, SIDE, 'ok'),
  s(800, MAIN, 'tool', 'Edit', 250),
  s(700, SIDE, 'text', undefined, 400),
  s(600, MAIN, 'ok'),
  s(900, SIDE, 'end'),
  s(1200, MAIN, 'tool', 'Bash', 45),
  s(2500, MAIN, 'ok'),
  s(1800, MAIN, 'text', undefined, 700),
  s(1200, MAIN, 'end'),

  // Night: one more push with a full window.
  s(5000, MAIN, 'prompt'),
  s(3200, MAIN, 'tool', 'Read', 30),
  s(700, MAIN, 'ok'),
  s(1300, MAIN, 'tool', 'Edit', 220),
  s(600, MAIN, 'ok'),
  s(1500, MAIN, 'tool', 'Bash', 40),
  s(2200, MAIN, 'ok'),
  s(1400, MAIN, 'tool', 'Grep', 25),
  s(600, MAIN, 'ok'),
  s(1600, MAIN, 'tool', 'Edit', 180),
  s(700, MAIN, 'ok'),
  s(1900, MAIN, 'text', undefined, 400),
  s(1200, MAIN, 'end'),

  // Your turn, at night. The stars are every thousand tokens the day produced.
  s(6000, MAIN, 'prompt'),

  // Compact, and the sun comes back up.
  s(2000, MAIN, 'compact'),
  s(5500, MAIN, 'text', undefined, 90),
  s(900, MAIN, 'tool', 'Read', 30),
  s(700, MAIN, 'ok'),
  s(2600, MAIN, 'text', undefined, 300),
  s(1300, MAIN, 'end'),
];

/**
 * Where each session's context sits, as `[seconds, percent]` keyframes: a whole
 * day in two minutes. The side session is already mid-afternoon when it joins.
 */
const CONTEXT: Record<string, Array<[number, number]>> = {
  [MAIN]: [
    [0, 4.5],
    [30, 11],
    [55, 24],
    [74, 52],
    [84, 76],
    [130, 84],
  ],
  [SIDE]: [
    [0, 28],
    [110, 46],
  ],
};

function contextAt(session: string, atMs: number, compacted: boolean): number {
  if (compacted && session === MAIN) return 3 + atMs / 60_000;
  const frames = CONTEXT[session]!;
  const t = atMs / 1000;
  for (let i = 1; i < frames.length; i++) {
    const [t1, c1] = frames[i]!;
    const [t0, c0] = frames[i - 1]!;
    if (t <= t1) return c0 + ((t - t0) / (t1 - t0)) * (c1 - c0);
  }
  return frames[frames.length - 1]![1];
}

/**
 * Output tokens a turn spends thinking before its visible block. Real turns run
 * 300–1,500 output tokens even for a one-line command; leaving this out would
 * leave the demo's night sky nearly empty.
 */
const THINKING = 650;

/** The demo as a list of events, `at` in ms from the start. */
export function demoScript(): RadioEvent[] {
  const events: RadioEvent[] = [];
  let at = 0;
  let compacted = false;
  const models: Record<string, string> = { [MAIN]: 'claude-opus-5-5', [SIDE]: 'claude-sonnet-5' };

  events.push(
    { session: MAIN, at: 0, type: 'title', title: 'Rethink the focus radio' },
    { session: SIDE, at: 0, type: 'title', title: 'Fix the cash-flow projection' },
    // The side session has been open all afternoon: it arrives with context.
    {
      session: SIDE,
      at: 0,
      type: 'usage',
      model: models[SIDE]!,
      effort: null,
      out: 0,
      fresh: 0,
      cached: 280_000,
      contextPct: contextAt(SIDE, 0, false),
    },
    // Main was prompted last, so the sky starts on it.
  );

  SCRIPT.forEach((step, index) => {
    at += step.wait;
    const session = step.session;
    const base = { session, at };
    const usage = (out: number, fresh: number): RadioEvent => ({
      ...base,
      type: 'usage',
      model: models[session]!,
      effort: session === MAIN ? 'xhigh' : null,
      out,
      fresh,
      cached: 60_000 + index * 4_000,
      contextPct: contextAt(session, at, compacted),
    });

    switch (step.kind) {
      case 'prompt':
        events.push({ ...base, type: 'prompt' });
        break;
      case 'text':
        events.push(usage(THINKING + (step.tokens ?? 50), 9_000), { ...base, type: 'text', tokens: step.tokens ?? 50 });
        break;
      case 'tool': {
        const name = step.tool ?? 'Bash';
        events.push(usage(THINKING + (step.tokens ?? 40), 6_000), {
          ...base,
          type: 'tool',
          family: FAMILY[name] ?? 'other',
          name,
          tokens: step.tokens ?? 40,
        });
        break;
      }
      case 'ok':
        events.push({ ...base, type: 'result', error: false, size: 2_000 });
        break;
      case 'fail':
        events.push({ ...base, type: 'result', error: true, size: 600 });
        break;
      case 'end':
        events.push({ ...base, type: 'end' });
        break;
      case 'compact':
        compacted = true;
        events.push({ ...base, type: 'compact', preTokens: 740_000 });
        break;
      case 'sub-text':
        events.push({ ...base, sub: true, type: 'text', tokens: step.tokens ?? 80 });
        break;
      case 'sub-tool': {
        const name = step.tool ?? 'Read';
        events.push({ ...base, sub: true, type: 'tool', family: FAMILY[name] ?? 'other', name, tokens: step.tokens ?? 30 });
        break;
      }
    }
  });

  return events;
}

/**
 * The demo compresses an afternoon into two minutes, so it climbs the level
 * ladder on a quarter of the tokens a real session would need.
 */
export const DEMO_LEVEL_SCALE = 0.25;

/** Project names for the demo's two sessions. */
export const DEMO_PROJECTS: Record<string, string> = {
  [MAIN]: 'claude-conduct',
  [SIDE]: 'nomore-regret',
};
