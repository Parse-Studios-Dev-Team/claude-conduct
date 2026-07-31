import type { Effort, Shape, Tier, ToolKind } from './types';
import type { TurnSignals } from './sessionScore';

/**
 * The on-disk shape of a session recording, and the pure functions over it.
 *
 * This module deliberately has **no Node imports** so the browser playground can
 * share it with the hook. `src/recorder.ts` owns the filesystem side; everything
 * that both sides need to agree on — the line shape, how to parse it, how to
 * summarize it — lives here so the two can't drift.
 *
 * Field names are terse (`t`/`tok`/`ctx`, `e`/`r`/`s`) because a long session is
 * thousands of lines and this file is machine-read, not browsed.
 */

/**
 * Bumped when the line shape changes. Readers skip foreign versions.
 *
 * **v2 (CC-12)** added the musical axes — `out`, `ef`, `sh`, `tl`, `end`. Every
 * one of them is optional, so a v1 line still parses; it simply carries no axes
 * and {@link recordingSignals} declines to score it.
 */
export const RECORDING_VERSION = 2;

/** One turn of a session. */
export interface RecordedTurn {
  /** Epoch ms when the turn was recorded. */
  t: number;
  /** `Usage.tokens` — work billed this turn (input + output + cache creation). */
  tok: number;
  /** `Usage.contextPct`, rounded to one decimal. */
  ctx: number;
  /** Model id, or `null` when the transcript didn't carry one. */
  model: string | null;
  /** The mapped tier: ensemble, richness, signature. */
  tier: { e: number; r: number; s: number };

  /**
   * v2 — `output_tokens` alone. Recorded *alongside* `tok` rather than replacing
   * it, so v1 recordings stay readable and the two can be compared.
   */
  out?: number;
  /** v2 — reasoning effort. Absent when the turn didn't declare one. */
  ef?: Effort;
  /** v2 — dominant work shape for the turn. */
  sh?: Shape;
  /** v2 — family of the first tool the turn ran. Absent when it ran none. */
  tl?: ToolKind;
  /** v2 — `stop_reason === 'end_turn'`. Omitted when false; absence means false. */
  end?: boolean;
}

/** Terminal line, appended once at `SessionEnd`. */
export interface RecordedSummary {
  type: 'summary';
  version: number;
  turns: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  peakTier: { e: number; r: number; s: number };
  models: string[];
  /**
   * v2 — turns whose transcript could not be read and were therefore *not*
   * recorded (CC-15). Present and non-zero means Conduct ran against a host
   * whose transcript format it does not understand; a session that is all
   * `unreadable` and no turns is the signature of that failure.
   */
  unreadable?: number;
}

/** A parsed recording: the turns, plus the summary when the session ended. */
export interface Recording {
  turns: RecordedTurn[];
  summary: RecordedSummary | null;
}

/** Compact a {@link Tier} into the recorded shape. */
export const packTier = (tier: Tier): { e: number; r: number; s: number } => ({
  e: tier.ensembleSize,
  r: tier.richness,
  s: tier.timbre ?? 0,
});

/** Expand a recorded tier back into a {@link Tier}. */
export const unpackTier = (tier: { e: number; r: number; s: number }): Tier => ({
  ensembleSize: tier.e,
  richness: tier.r,
  timbre: tier.s,
});

/**
 * Parse recording text. Unparseable lines are skipped rather than throwing, so a
 * partial write (or a crash mid-append) costs one turn, not the file.
 */
export function parseRecording(text: string): Recording {
  const turns: RecordedTurn[] = [];
  let summary: RecordedSummary | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const record = parsed as Partial<RecordedSummary> & Partial<RecordedTurn>;
    if (record.type === 'summary') {
      summary = record as RecordedSummary;
      continue;
    }
    if (typeof record.t === 'number' && typeof record.tok === 'number' && record.tier) {
      turns.push(record as RecordedTurn);
    }
  }

  return { turns, summary };
}

/** Compute the summary for a set of turns. Pure. */
export function summarize(turns: RecordedTurn[], unreadable = 0): RecordedSummary {
  const models: string[] = [];
  let peak = { e: 0, r: 0, s: 0 };

  for (const turn of turns) {
    if (turn.model && !models.includes(turn.model)) models.push(turn.model);
    // Peak is per-axis: the loudest the session ever got on each dimension.
    peak = {
      e: Math.max(peak.e, turn.tier.e),
      r: Math.max(peak.r, turn.tier.r),
      s: Math.max(peak.s, turn.tier.s),
    };
  }

  const startedAt = turns.length > 0 ? turns[0]!.t : null;
  const endedAt = turns.length > 0 ? turns[turns.length - 1]!.t : null;

  return {
    type: 'summary',
    version: RECORDING_VERSION,
    turns: turns.length,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : 0,
    peakTier: peak,
    models,
    ...(unreadable > 0 ? { unreadable } : {}),
  };
}

/**
 * Serialize one turn as a JSONL line (no trailing newline).
 *
 * Absent axes are left out of the JSON rather than written as `null`: a long
 * session is thousands of these lines, and `"end":false` on every one of the
 * ~95% of turns that don't end a turn is pure weight.
 */
export function encodeTurn(turn: RecordedTurn): string {
  const line: Record<string, unknown> = {
    t: turn.t,
    tok: turn.tok,
    ctx: Math.round(turn.ctx * 10) / 10,
    model: turn.model,
    tier: turn.tier,
  };
  if (typeof turn.out === 'number') line.out = turn.out;
  if (turn.ef) line.ef = turn.ef;
  if (turn.sh) line.sh = turn.sh;
  if (turn.tl) line.tl = turn.tl;
  if (turn.end) line.end = true;
  return JSON.stringify(line);
}

/**
 * Whether a turn carries the v2 axes. `sh` is the marker: every v2 turn has a
 * shape (it falls back to `text`), while `ef`/`tl`/`end` are legitimately absent
 * on plenty of v2 turns and so can't distinguish a version.
 */
export const hasSignals = (turn: RecordedTurn): boolean => turn.sh !== undefined;

/**
 * Expand a v2 turn into the {@link TurnSignals} the scorer consumes.
 *
 * `tokens` maps from `out`, not `tok` — the scorer ranks turns against each
 * other, and the summed total mostly tracks conversation length rather than the
 * work in the turn. Falls back to `tok` for a turn that somehow lacks `out`,
 * which ranks worse but is better than scoring every turn as zero.
 */
export function turnSignals(turn: RecordedTurn): TurnSignals {
  return {
    tokens: typeof turn.out === 'number' ? turn.out : turn.tok,
    contextPct: turn.ctx,
    model: turn.model,
    effort: turn.ef ?? null,
    shape: turn.sh ?? 'text',
    tool: turn.tl ?? null,
    endsTurn: turn.end === true,
  };
}

/**
 * Score-ready signals for a whole recording, or `null` when the recording
 * predates v2 and therefore can't answer.
 *
 * `null` rather than a degraded array on purpose: it is the caller's cue to fall
 * back to `readTranscriptSignals`, which can still recover the axes for old
 * sessions as long as Claude Code's transcript is around. Silently scoring every
 * turn as `text`/no-effort would render an old session as a flat drone and look
 * like a bug in the scorer.
 *
 * A recording is treated as scorable when *any* turn carries the axes, so a file
 * spanning an upgrade renders from its v2 turns instead of being rejected whole.
 */
export function recordingSignals(recording: Recording): TurnSignals[] | null {
  const usable = recording.turns.filter(hasSignals);
  if (usable.length === 0) return null;
  return usable.map(turnSignals);
}
