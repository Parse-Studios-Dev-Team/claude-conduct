import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier, TurnFacts, Usage } from './types';
import {
  encodeTurn,
  packTier,
  parseRecording,
  summarize,
  type Recording,
  type RecordedTurn,
} from './recordingFormat';

/**
 * Per-session timeline recording (CC-9) — the filesystem side. The line shape
 * and the pure functions over it live in `recordingFormat.ts`, which the browser
 * playground shares; this module only does I/O.
 *
 * Everything here is **best-effort and never throws** — a recording failure must
 * not disturb a Claude Code turn.
 */

export {
  RECORDING_VERSION,
  parseRecording,
  summarize,
  packTier,
  unpackTier,
  hasSignals,
  turnSignals,
  recordingSignals,
  type RecordedTurn,
  type RecordedSummary,
  type Recording,
} from './recordingFormat';

const FILE_SUFFIX = '.jsonl';

/** Path of one session's recording. `sessionId` is sanitized — it reaches us from hook input. */
export function recordingPath(recordingsDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-') || 'unknown';
  return join(recordingsDir, `${safe}${FILE_SUFFIX}`);
}

/**
 * Append one turn. Creates the directory on first write.
 *
 * The tier recorded here should be the **mapped** tier, not the muted one — a
 * recording describes what the session *sounded like in principle*, so muting
 * playback must not flatten the file into silence.
 */
export function appendTurn(recordingsDir: string, sessionId: string, turn: RecordedTurn): void {
  try {
    mkdirSync(recordingsDir, { recursive: true });
    appendFileSync(recordingPath(recordingsDir, sessionId), `${encodeTurn(turn)}\n`, 'utf8');
  } catch {
    /* recording is never worth failing a turn over */
  }
}

/**
 * Convenience wrapper that takes a {@link Tier} rather than the terse shape.
 *
 * `usage` may be a bare {@link Usage} or the wider {@link TurnFacts}; the v2 axes
 * are written only when they're there, so a caller that has just the three usage
 * fields still produces a valid (if v1-shaped) line.
 */
export function recordTurn(
  recordingsDir: string,
  sessionId: string,
  usage: Usage | TurnFacts,
  tier: Tier,
  now: number = Date.now(),
): void {
  const facts = usage as Partial<TurnFacts> & Usage;
  appendTurn(recordingsDir, sessionId, {
    t: now,
    tok: facts.tokens,
    ctx: facts.contextPct,
    model: facts.model,
    tier: packTier(tier),
    ...(typeof facts.outputTokens === 'number' ? { out: facts.outputTokens } : {}),
    ...(facts.effort ? { ef: facts.effort } : {}),
    ...(facts.shape ? { sh: facts.shape } : {}),
    ...(facts.tool ? { tl: facts.tool } : {}),
    ...(facts.endsTurn ? { end: true } : {}),
  });
}

/** Read a recording back from disk. A missing file is an empty recording, not an error. */
export function readRecording(path: string): Recording {
  try {
    return parseRecording(readFileSync(path, 'utf8'));
  } catch {
    return { turns: [], summary: null };
  }
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
export function listRecordings(
  recordingsDir: string,
): Array<{ sessionId: string; path: string; mtime: number }> {
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
