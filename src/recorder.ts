import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier } from './types';

/**
 * Per-session timeline recording (CC-9). Every usage-bearing hook appends one
 * line describing that turn; `SessionEnd` appends a summary. The playground
 * replays these files.
 *
 * Everything here is **best-effort and never throws** — a recording failure must
 * not disturb a Claude Code turn, and a corrupt line must not make a whole
 * session unreadable.
 *
 * Field names are deliberately terse (`t`/`tok`/`ctx`, `e`/`r`/`s`). A long
 * session is thousands of lines and this file is machine-read, not browsed.
 */

/** Bumped when the on-disk line shape changes. Readers skip foreign versions. */
export const RECORDING_VERSION = 1;

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
}

/** Terminal line, appended once at `SessionEnd`. */
export interface RecordedSummary {
  type: 'summary';
  version: number;
  turns: number;
  /** Epoch ms of the first and last recorded turn. */
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  /** Highest tier reached across the session. */
  peakTier: { e: number; r: number; s: number };
  /** Every distinct model seen, in first-appearance order. */
  models: string[];
}

/** A parsed recording: the turns, plus the summary when the session ended. */
export interface Recording {
  turns: RecordedTurn[];
  summary: RecordedSummary | null;
}

const FILE_SUFFIX = '.jsonl';

/** Path of one session's recording. `sessionId` is sanitized — it reaches us from hook input. */
export function recordingPath(recordingsDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-') || 'unknown';
  return join(recordingsDir, `${safe}${FILE_SUFFIX}`);
}

const tierOf = (tier: Tier): { e: number; r: number; s: number } => ({
  e: tier.ensembleSize,
  r: tier.richness,
  s: tier.timbre ?? 0,
});

/**
 * Append one turn. Creates the directory on first write.
 *
 * The tier recorded here should be the **mapped** tier, not the muted one — a
 * recording describes what the session *sounded like in principle*, so muting
 * playback must not flatten the file into silence.
 */
export function appendTurn(
  recordingsDir: string,
  sessionId: string,
  turn: Omit<RecordedTurn, 't'> & { t?: number },
): void {
  try {
    mkdirSync(recordingsDir, { recursive: true });
    const line: RecordedTurn = {
      t: turn.t ?? Date.now(),
      tok: turn.tok,
      ctx: Math.round(turn.ctx * 10) / 10,
      model: turn.model,
      tier: turn.tier,
    };
    appendFileSync(recordingPath(recordingsDir, sessionId), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    /* recording is never worth failing a turn over */
  }
}

/** Convenience wrapper that takes a {@link Tier} rather than the terse shape. */
export function recordTurn(
  recordingsDir: string,
  sessionId: string,
  usage: { tokens: number; contextPct: number; model: string | null },
  tier: Tier,
  now: number = Date.now(),
): void {
  appendTurn(recordingsDir, sessionId, {
    t: now,
    tok: usage.tokens,
    ctx: usage.contextPct,
    model: usage.model,
    tier: tierOf(tier),
  });
}

/**
 * Read a recording back. Unparseable lines are skipped rather than throwing, so
 * a partial write (or a crash mid-append) costs one turn, not the file.
 */
export function readRecording(path: string): Recording {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { turns: [], summary: null };
  }

  const turns: RecordedTurn[] = [];
  let summary: RecordedSummary | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const record = parsed as Partial<RecordedSummary> & Partial<RecordedTurn>;
    if (record.type === 'summary') {
      summary = record as RecordedSummary;
      continue;
    }
    if (typeof record.t === 'number' && record.tier && typeof record.tok === 'number') {
      turns.push(record as RecordedTurn);
    }
  }

  return { turns, summary };
}

/** Compute the summary for a set of turns. Pure. */
export function summarize(turns: RecordedTurn[]): RecordedSummary {
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
  };
}

/**
 * Append the summary line for a finished session. A session with no recorded
 * turns writes nothing — an empty file is noise the playground would have to
 * filter, and a summary of zero turns tells nobody anything.
 */
export function finalizeRecording(recordingsDir: string, sessionId: string): void {
  try {
    const path = recordingPath(recordingsDir, sessionId);
    const { turns, summary } = readRecording(path);
    if (turns.length === 0 || summary) return; // nothing to say, or already finalized
    appendFileSync(path, `${JSON.stringify(summarize(turns))}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Keep only the `keep` most-recently-modified recordings, deleting older ones.
 * `keep <= 0` disables pruning entirely rather than deleting everything — an
 * accidental zero should not wipe the archive.
 */
export function pruneRecordings(recordingsDir: string, keep: number): void {
  if (!Number.isFinite(keep) || keep <= 0) return;
  try {
    const files = readdirSync(recordingsDir)
      .filter((name) => name.endsWith(FILE_SUFFIX))
      .map((name) => {
        const path = join(recordingsDir, name);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of files.slice(keep)) {
      try {
        unlinkSync(stale.path);
      } catch {
        /* leave it; we'll try again next session */
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

/** List recordings newest-first — what the playground offers to load. */
export function listRecordings(recordingsDir: string): Array<{ sessionId: string; path: string; mtime: number }> {
  try {
    return readdirSync(recordingsDir)
      .filter((name) => name.endsWith(FILE_SUFFIX))
      .map((name) => ({
        sessionId: name.slice(0, -FILE_SUFFIX.length),
        path: join(recordingsDir, name),
        mtime: statSync(join(recordingsDir, name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
