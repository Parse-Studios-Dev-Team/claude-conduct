import type { Effort, Shape, Tier, ToolKind } from './types';

/**
 * CC-10 — scoring a *finished* session as a piece of music.
 *
 * The live mapping (`mapToTier`) has to decide each turn's tier the moment the
 * turn happens, so it can only compare against **absolute** thresholds. That is
 * why measured sessions pile up: 87% of turns land on ensemble 3–5 and three
 * tier states cover 58% of all playback.
 *
 * Rendering after the fact removes that constraint. The whole timeline is known,
 * so every axis can be scaled to *this session's own range* — the busiest turn
 * in a quiet session becomes its climax just as surely as in a heavy one. That
 * relative scaling is the structural reason a rendered session sounds different
 * from the next one, and it is only available retrospectively.
 */

// The axis vocabularies live in `types.ts` (the recorder and the extractor need
// them too); re-exported here so CC-10's consumers keep importing one module.
export type { Effort, Shape, ToolKind } from './types';

/** One turn's signals, joined from the recording and the session transcript. */
export interface TurnSignals {
  /** Fresh tokens in the turn — the momentary "how much happened". */
  tokens: number;
  /** Context-window occupancy 0–100 at that point in the session. */
  contextPct: number;
  /** Raw model id, or `null` when unknown. */
  model: string | null;
  /** Reasoning effort from the transcript's top-level `.effort`. */
  effort: Effort | null;
  /** Dominant content-block kind for the turn. */
  shape: Shape;
  /** Dominant tool family, when the turn used tools. */
  tool: ToolKind | null;
  /** `stop_reason === 'end_turn'` — Claude handed control back here. */
  endsTurn: boolean;
  /**
   * Epoch ms the turn happened, when known. Drives real-time weighting: without
   * it every turn is treated as taking the same amount of wall clock, so a
   * twenty-minute pause reads exactly like a fast one.
   */
  at?: number;
}

/** One rendered span of the piece: a tier held for a duration, then crossfaded. */
export interface Moment {
  tier: Tier;
  /** Gains for the three harmonic-extension stems (9th, ♯11th, 13th). */
  extensions: number[];
  durationMs: number;
  crossfadeMs: number;
  /** Resolve toward the tonic here — the turn handed control back. */
  cadence: boolean;
  /** Kept for the score panel / debugging; not used by the mixer. */
  shape: Shape;
}

export interface ScoreOptions {
  /** How many spans the session is resampled to. Default 36. */
  moments?: number;
  /** Total piece length. Default 90s — a 6-hour session and a 6-minute one both land here. */
  totalMs?: number;
  /**
   * How much a span's real elapsed time influences its length, `0..1`.
   *
   * `0` is the old behaviour: every turn takes the same share of the piece, so a
   * session's pauses vanish and a long deliberation sounds like a quick reply.
   * `1` would let wall clock alone decide, which hands most of the piece to
   * whatever gap you happened to leave it running through. The default splits
   * the difference — the session's real rhythm shows without dominating.
   */
  timeWeight?: number;
  /**
   * Longest gap between turns that still counts as elapsed time, in ms.
   *
   * Anything longer is a break, not a session: you went to lunch and left the
   * window open. Without a clamp a single overnight gap consumes the entire
   * piece and everything else is compressed to nothing.
   */
  maxGapMs?: number;
}

export const DEFAULT_SCORE_OPTIONS: Required<ScoreOptions> = {
  moments: 36,
  totalMs: 90_000,
  timeWeight: 0.5,
  maxGapMs: 5 * 60_000,
};

/** Extension-stem gains per effort level: triad → add the 9th → open it right up. */
const EFFORT_EXTENSIONS: Record<Effort, number[]> = {
  high: [0, 0, 0],
  max: [0.55, 0, 0.3],
  xhigh: [0.7, 0.5, 0.55],
};

/**
 * Articulation per work shape. Thinking turns breathe — long spans, long
 * crossfades; tool runs are short and defined; prose sits between them. This is
 * what stops consecutive turns from sounding interchangeable.
 *
 * Measured against a real transcript, thinking and tool_use never appear in the
 * same assistant turn (0 of 367), so the per-turn signal is unambiguous — but a
 * *span* is a mix, and taking its majority shape threw that away: 33 of 36 spans
 * came back "tool" simply because tool turns are the most common kind. Spans
 * therefore blend these by proportion. Voting is what absolute thresholds did to
 * the live mapping, and it flattens here for the same reason.
 */
const SHAPE_FEEL: Record<Shape, { weight: number; crossfadeMs: number }> = {
  think: { weight: 1.5, crossfadeMs: 2600 },
  tool: { weight: 0.75, crossfadeMs: 600 },
  text: { weight: 1.0, crossfadeMs: 1400 },
};

const SHAPES: Shape[] = ['think', 'tool', 'text'];

const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n);

/** Split `count` items into `groups` contiguous, near-equal buckets of indices. */
function bucketRanges(count: number, groups: number): Array<[number, number]> {
  const n = Math.max(1, Math.min(groups, count));
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    out.push([Math.floor((i * count) / n), Math.floor(((i + 1) * count) / n)]);
  }
  return out;
}

/** Most frequent value in a list, with a deterministic tie-break toward `fallback`. */
function dominant<T extends string>(values: T[], fallback: T): T {
  if (values.length === 0) return fallback;
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Fractional rank of `value` within `sorted` (ascending), in `0..1`.
 * Ties share the midpoint of their run so a flat session doesn't collapse to 0.
 */
function percentile(value: number, sorted: number[]): number {
  const n = sorted.length;
  if (n <= 1) return 0.5;
  let lo = 0;
  let hi = 0;
  for (const v of sorted) {
    if (v < value) lo++;
    if (v <= value) hi++;
  }
  return (lo + hi) / 2 / n;
}

/**
 * Wall-clock time covered by `turns[from..to)`, summing per-turn gaps with each
 * one clamped to `maxGapMs`.
 *
 * Summing clamped gaps rather than taking `last.at - first.at` is what keeps one
 * break from swallowing a whole span: a bucket holding a 30-second turn and a
 * two-hour lunch should read as "a bit longer than usual", not as the session.
 *
 * Returns `0` when no turn carries a timestamp, which callers read as "no
 * real-time information" and fall back to even weighting.
 */
function elapsedOf(
  turns: TurnSignals[],
  from: number,
  to: number,
  maxGapMs: number,
): number {
  let total = 0;
  let seen = false;
  for (let i = from; i < to; i++) {
    const at = turns[i]?.at;
    const previous = i > 0 ? turns[i - 1]?.at : undefined;
    if (typeof at !== 'number' || typeof previous !== 'number') continue;
    seen = true;
    total += clamp(at - previous, 0, maxGapMs);
  }
  return seen ? total : 0;
}

const HIGH_END = ['claude-opus', 'claude-fable'];
const isHighEnd = (model: string | null): boolean =>
  model !== null && HIGH_END.some((p) => model.startsWith(p));

/**
 * Score a finished session into a fixed-length piece.
 *
 * Every axis is normalized against the session itself:
 * - `ensembleSize` is the turn's **percentile** among the session's turns, so
 *   the full 0–5 ladder is used whether the session was heavy or light;
 * - `richness` tracks progress through the session's own context span, so it
 *   always arcs 0 → 2 rather than depending on how full the window happened to get;
 * - `timbre` still marks a high-end model, the one genuinely absolute signal.
 *
 * Pure: no clock, no I/O. `turns` is consumed in order and never mutated.
 */
export function scoreSession(turns: TurnSignals[], options?: ScoreOptions): Moment[] {
  const opts = { ...DEFAULT_SCORE_OPTIONS, ...options };
  if (turns.length === 0) return [];

  const ranges = bucketRanges(turns.length, Math.max(1, Math.round(opts.moments)));

  // Aggregate each bucket first, then rank buckets against each other — ranking
  // raw turns would let one 600k-token outlier flatten everything around it.
  const buckets = ranges.map(([from, to]) => {
    const slice = turns.slice(from, to);
    const efforts = slice.map((t) => t.effort).filter((e): e is Effort => e !== null);
    return {
      tokens: median(slice.map((t) => t.tokens)),
      contextPct: Math.max(...slice.map((t) => t.contextPct)),
      model: slice[slice.length - 1]!.model,
      // The most demanding effort in the span sets the harmony: a single `max`
      // turn is the interesting thing about a span, not something to average away.
      effort: efforts.includes('xhigh')
        ? ('xhigh' as Effort)
        : efforts.includes('max')
          ? ('max' as Effort)
          : efforts.length > 0
            ? ('high' as Effort)
            : null,
      // Proportion of the span spent in each kind of work, not a winner.
      mix: {
        think: slice.filter((t) => t.shape === 'think').length / slice.length,
        tool: slice.filter((t) => t.shape === 'tool').length / slice.length,
        text: slice.filter((t) => t.shape === 'text').length / slice.length,
      } as Record<Shape, number>,
      shape: dominant(
        slice.map((t) => t.shape),
        'tool' as Shape,
      ),
      tool: dominant(
        slice.map((t) => t.tool).filter((t): t is ToolKind => t !== null),
        'exec' as ToolKind,
      ),
      endsTurn: slice.some((t) => t.endsTurn),
      elapsedMs: elapsedOf(turns, from, to, opts.maxGapMs),
    };
  });

  const sortedTokens = buckets.map((b) => b.tokens).sort((a, b) => a - b);
  const ctxValues = buckets.map((b) => b.contextPct);
  const ctxMin = Math.min(...ctxValues);
  const ctxMax = Math.max(...ctxValues);
  const ctxSpan = ctxMax - ctxMin;

  /** Blend a per-shape trait by how much of the span was spent in each shape. */
  const blend = (mix: Record<Shape, number>, pick: (f: { weight: number; crossfadeMs: number }) => number): number =>
    SHAPES.reduce((sum, s) => sum + mix[s] * pick(SHAPE_FEEL[s]), 0);

  // Distribute the fixed total across spans, weighted so thinking breathes.
  const shapeWeights = buckets.map((b) => blend(b.mix, (f) => f.weight));

  // …and so the session's real rhythm shows: a span you spent twenty minutes in
  // should not pass at the same rate as one that took thirty seconds. Scaled
  // against the mean span so this stretches and compresses around the existing
  // weighting rather than replacing it.
  const elapsed = buckets.map((b) => b.elapsedMs);
  const totalElapsed = elapsed.reduce((a, b) => a + b, 0);
  const meanElapsed = totalElapsed / Math.max(1, elapsed.length);
  const timeWeight = clamp(opts.timeWeight, 0, 1);

  const weights = shapeWeights.map((shapeWeight, i) => {
    // No timestamps anywhere (a v1 recording, a transcript without them) means
    // no real-time information to use, so fall back to even weighting.
    if (totalElapsed <= 0 || meanElapsed <= 0) return shapeWeight;
    const share = elapsed[i]! / meanElapsed;
    return shapeWeight * (1 - timeWeight + timeWeight * share);
  });

  // A span of pure zero weight would render as no audio at all.
  const floored = weights.map((w) => Math.max(w, 0.05));
  const weightSum = floored.reduce((a, b) => a + b, 0) || 1;

  return buckets.map((b, i) => {
    const rank = percentile(b.tokens, sortedTokens);
    const ensembleSize = clamp(Math.round(rank * 5), 0, 5);

    // Relative depth: 0 at the session's own opening, 1 at its own deepest point.
    const depth = ctxSpan > 0 ? (b.contextPct - ctxMin) / ctxSpan : i / Math.max(1, buckets.length - 1);
    const richness = clamp(Math.round(depth * 2), 0, 2);

    const durationMs = (floored[i]! / weightSum) * opts.totalMs;

    return {
      tier: { ensembleSize, richness, timbre: isHighEnd(b.model) ? 1 : 0 },
      extensions: b.effort ? [...EFFORT_EXTENSIONS[b.effort]] : [0, 0, 0],
      durationMs,
      // Never crossfade for longer than the span it belongs to.
      crossfadeMs: Math.min(blend(b.mix, (f) => f.crossfadeMs), durationMs * 0.8),
      cadence: b.endsTurn,
      shape: b.shape,
    };
  });
}
