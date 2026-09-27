import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findTranscripts, readSession, safeName } from './tail';
import { isTape, lastTurn, makeTape, tapeFileName, type Tape } from './tape';

/**
 * The tape shelf: a folder of saved tapes, shared by the radio run from source
 * and the installed plugin, so a tape cut either way plays in both.
 */
export const DEFAULT_SHELF = join(homedir(), '.claude', 'conduct-radio', 'tapes');

export interface TapeListing {
  /** `tape:<file>`, as `/api/replay` takes it. */
  id: string;
  title: string;
  project: string;
  /** When it was cut. */
  mtime: number;
  minutes: number;
  out: number;
}

/** Tapes on the shelf, newest first. */
export function listTapes(shelf: string): TapeListing[] {
  let files: string[];
  try {
    files = readdirSync(shelf).filter((f) => f.endsWith('.json') && safeName(f));
  } catch {
    return [];
  }
  const found: TapeListing[] = [];
  for (const file of files) {
    const tape = readTape(shelf, file);
    if (!tape) continue;
    found.push({
      id: `tape:${file}`,
      title: tape.title,
      project: tape.project,
      mtime: tape.recordedAt,
      minutes: tapeMinutes(tape),
      out: tape.out,
    });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

export function readTape(shelf: string, file: string): Tape | null {
  if (!safeName(file) || !file.endsWith('.json')) return null;
  try {
    const tape: unknown = JSON.parse(readFileSync(join(shelf, file), 'utf8'));
    return isTape(tape) ? tape : null;
  } catch {
    return null;
  }
}

/** One line of at most 80 characters: no control characters, no runs of space. */
export function cleanTitle(title: string | null | undefined): string {
  const flat = (title ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

export const tapeMinutes = (tape: Pick<Tape, 'from' | 'to'>): number => Math.max(1, Math.round((tape.to - tape.from) / 60_000));

export interface CutOptions {
  /** `~/.claude/projects`, or another. */
  root: string;
  shelf: string;
  /** A session id or the start of one. Default: the most recently active session. */
  session?: string | null;
  /** Epoch ms. Default: the last turn. */
  from?: number | null;
  to?: number | null;
  /** Default: the session's title. */
  title?: string | null;
  /** Take the last turn that has ended, not one still going. */
  finished?: boolean;
  now?: number;
}

/** Cut a tape from a session on disk and put it on the shelf. */
export function cutTape(options: CutOptions): { tape: Tape; file: string } | { error: string } {
  const wanted = options.session || null;
  const transcripts = findTranscripts(options.root).filter((t) => !t.sub && (!wanted || t.session.startsWith(wanted)));
  if (transcripts.length === 0) {
    return { error: wanted ? `No session starting "${wanted}" under ${options.root}.` : `No sessions under ${options.root}.` };
  }
  const latest = transcripts
    .map((t) => {
      try {
        return { ...t, mtime: statSync(t.path).mtimeMs };
      } catch {
        return { ...t, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)[0]!;

  const session = readSession(options.root, latest.project, latest.session);
  if (!session || session.events.length === 0) return { error: `Nothing to tape in ${latest.session}.` };
  const { events } = session;

  let from = options.from ?? null;
  let to = options.to ?? null;
  if (from === null) {
    const turn = lastTurn(events, { finished: options.finished });
    if (!turn) return { error: options.finished ? 'No finished turn to tape yet.' : 'No turn to tape yet.' };
    from = turn.from;
    to ??= turn.to;
  }
  to ??= events[events.length - 1]!.at;
  if (to < from) return { error: 'The end is before the start.' };

  const tape = makeTape(
    events,
    {
      title: cleanTitle(options.title) || cleanTitle(session.state.title) || latest.session.slice(0, 8),
      project: session.state.project,
      session: latest.session,
      from,
      to,
    },
    options.now ?? Date.now(),
  );
  if (tape.events.length === 0) return { error: 'No events in that stretch.' };

  mkdirSync(options.shelf, { recursive: true });
  // Two tapes with the same name on the same day: keep both.
  const name = tapeFileName(tape).replace(/\.json$/, '');
  let file = join(options.shelf, `${name}.json`);
  for (let n = 2; existsSync(file); n++) file = join(options.shelf, `${name}-${n}.json`);
  writeFileSync(file, `${JSON.stringify(tape)}\n`);
  return { tape, file };
}
