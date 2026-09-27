import type { RadioEvent } from './types';

/**
 * Tapes: a stretch of a session's work, saved so it can be played back as
 * music. Cut one after Claude finishes something and you can hear what that
 * piece of work sounded like, long after the transcript has scrolled away.
 *
 * A tape holds the same events a live session streams — kinds, sizes and token
 * counts, never conversation text — so it's as safe to keep or share as the
 * radio itself. Pure and DOM-free: the server reads tapes, the page plays them.
 */

export interface Tape {
  app: 'conduct-radio';
  tape: 1;
  title: string;
  /** Basename of the session's working directory. */
  project: string;
  session: string;
  /** Epoch ms the tape was cut. */
  recordedAt: number;
  /** When the work on it started and stopped, epoch ms. */
  from: number;
  to: number;
  /** Output tokens on the tape: what the band builds on. */
  out: number;
  events: RadioEvent[];
}

/**
 * The most recent turn: from the last prompt you typed to where Claude handed
 * back — or to the last event, if it's still going. With `finished`, the most
 * recent turn that has ended: run from a slash command, the turn in progress is
 * the command itself.
 */
export function lastTurn(
  events: readonly RadioEvent[],
  options: { finished?: boolean } = {},
): { from: number; to: number } | null {
  const mine = (e: RadioEvent, type: RadioEvent['type']): boolean => e.type === type && !e.sub;
  for (let start = events.length - 1; start >= 0; start--) {
    if (!mine(events[start]!, 'prompt')) continue;
    let end = -1;
    for (let i = start + 1; i < events.length && !mine(events[i]!, 'prompt'); i++) {
      if (mine(events[i]!, 'end')) {
        end = i;
        break;
      }
    }
    if (end < 0 && options.finished) continue;
    return { from: events[start]!.at, to: events[end < 0 ? events.length - 1 : end]!.at };
  }
  return null;
}

/** Everything between `from` and `to` (inclusive), main thread and subagents, in order. */
export function cut(events: readonly RadioEvent[], from: number, to: number): RadioEvent[] {
  return events.filter((e) => e.at >= from && e.at <= to).sort((a, b) => a.at - b.at);
}

export function makeTape(
  events: readonly RadioEvent[],
  meta: { title: string; project: string; session: string; from: number; to: number },
  now: number,
): Tape {
  const on = cut(events, meta.from, meta.to);
  let out = 0;
  for (const e of on) if (e.type === 'usage') out += e.out;
  return { app: 'conduct-radio', tape: 1, ...meta, recordedAt: now, out, events: on };
}

/** Whether `value` is a tape this version can play. */
export function isTape(value: unknown): value is Tape {
  const t = value as Partial<Tape> | null;
  return !!t && t.app === 'conduct-radio' && t.tape === 1 && Array.isArray(t.events) && typeof t.title === 'string';
}

/** A file name for a tape: its date and title, filesystem-safe. */
export function tapeFileName(tape: Pick<Tape, 'title' | 'recordedAt'>): string {
  const date = new Date(tape.recordedAt).toISOString().slice(0, 10);
  const slug = tape.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${date}-${slug || 'tape'}.json`;
}
