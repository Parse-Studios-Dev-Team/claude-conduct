import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from './audio/wav';
import { readRecording, recordingPath, listRecordings } from './recorder';
import { recordingSignals } from './recordingFormat';
import { readTranscriptSignals } from './transcriptSignals';
import { transcriptDirFor } from './sessionTitle';
import { scoreSession, type TurnSignals } from './sessionScore';
import { renderMoments } from './renderSession';

/**
 * CC-13 — turning a finished session's recording into a file on disk.
 *
 * The filesystem side of playback mode, kept out of the hook: rendering 90
 * seconds of audio is far too slow to do inline on `SessionEnd`, so the hook
 * spawns this and returns immediately.
 */

const RENDER_SUFFIX = '.wav';

/** Where a session's rendered piece lives. `sessionId` is sanitized — it comes from hook input. */
export function renderPath(rendersDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '-') || 'unknown';
  return join(rendersDir, `${safe}${RENDER_SUFFIX}`);
}

export interface RenderSessionOptions {
  /** Target length of the piece regardless of how long the session ran. */
  seconds?: number;
  /** Spans the session is resampled to. */
  moments?: number;
  /** Project dir, used to find Claude Code's transcripts for the v1 fallback. */
  projectDir?: string;
}

export interface RenderOutcome {
  path: string;
  turns: number;
  /** Where the signals came from — the recording, or Claude Code's transcript. */
  source: 'recording' | 'transcript';
  durationMs: number;
}

/**
 * Signals for a session, preferring its own recording (CC-12) and falling back
 * to Claude Code's transcript for recordings that predate the v2 format.
 */
export function signalsFor(
  recordingsDir: string,
  sessionId: string,
  projectDir?: string,
): { turns: TurnSignals[]; source: 'recording' | 'transcript' } {
  const fromRecording = recordingSignals(readRecording(recordingPath(recordingsDir, sessionId)));
  if (fromRecording && fromRecording.length > 0) {
    return { turns: fromRecording, source: 'recording' };
  }

  if (projectDir) {
    const transcript = join(transcriptDirFor(projectDir), `${sessionId}.jsonl`);
    if (existsSync(transcript)) {
      return { turns: readTranscriptSignals(transcript), source: 'transcript' };
    }
  }
  return { turns: [], source: 'recording' };
}

/**
 * Render one session to a WAV. Returns `null` when there is nothing to render —
 * a session with no readable turns is not an error, just not music.
 */
export function renderSessionToFile(
  recordingsDir: string,
  rendersDir: string,
  sessionId: string,
  options: RenderSessionOptions = {},
): RenderOutcome | null {
  const { turns, source } = signalsFor(recordingsDir, sessionId, options.projectDir);
  if (turns.length === 0) return null;

  const totalMs = (options.seconds ?? 90) * 1000;
  const moments = options.moments ?? 36;

  const piece = renderMoments(scoreSession(turns, { totalMs, moments }), { totalMs, moments });

  mkdirSync(rendersDir, { recursive: true });
  const path = renderPath(rendersDir, sessionId);
  writeFileSync(path, encodeWav(piece.pcm, piece.sampleRate, 2));

  return { path, turns: turns.length, source, durationMs: piece.durationMs };
}

/**
 * Keep only the `keep` newest renders. Same policy as recordings, and for a
 * sharper reason: a 90-second stereo render at 44.1kHz is ~15 MB, so an
 * unpruned renders directory is the largest thing this tool puts on disk.
 *
 * `keep <= 0` disables pruning rather than deleting everything.
 */
export function pruneRenders(rendersDir: string, keep: number): void {
  if (!Number.isFinite(keep) || keep <= 0) return;
  try {
    const files = readdirSync(rendersDir)
      .filter((name) => name.endsWith(RENDER_SUFFIX))
      .map((name) => {
        const path = join(rendersDir, name);
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

/**
 * Sessions with a recording but no render yet.
 *
 * `SessionEnd` is not guaranteed to fire — closing the window or killing the
 * process skips it, which is the same gap the idle watchdog exists to cover. A
 * render triggered *only* by `SessionEnd` would therefore silently never happen
 * for exactly those sessions, so playback mode sweeps for stragglers too rather
 * than trusting one event.
 *
 * `olderThanMs` keeps the sweep off sessions that are merely in progress.
 */
export function pendingRenders(
  recordingsDir: string,
  rendersDir: string,
  olderThanMs = 30 * 60 * 1000,
  now: number = Date.now(),
): string[] {
  try {
    return listRecordings(recordingsDir)
      .filter((item) => now - item.mtime > olderThanMs)
      .filter((item) => !existsSync(renderPath(rendersDir, item.sessionId)))
      .map((item) => item.sessionId);
  } catch {
    return [];
  }
}
