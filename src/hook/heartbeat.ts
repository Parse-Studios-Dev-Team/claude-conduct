import { writeFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The session-liveness marker behind the daemon's idle watchdog.
 *
 * The daemon is spawned **detached** so it outlives the hook that starts it, and
 * it only ever exits on an explicit `SIGTERM` — from `SessionEnd` or
 * `/conduct stop`. That leaves one uncovered case: when Claude Code goes away
 * without running `SessionEnd` (window closed, `kill -9`, a crash, the machine
 * sleeping through it), nobody is left to send that signal and the daemon loops
 * forever with no session attached to it.
 *
 * So the hook stamps this file on every turn and the daemon watches its mtime:
 * a live session keeps it fresh, and a session that vanished stops touching it.
 * The mtime is the whole payload — the file's contents are only there to make it
 * legible when someone opens it while debugging.
 */

/** Mark the session alive. Best-effort — a hook must never fail on this. */
export function touchHeartbeat(heartbeatPath: string): void {
  try {
    mkdirSync(dirname(heartbeatPath), { recursive: true });
    writeFileSync(heartbeatPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Drop the marker on a clean `SessionEnd`, so a restarted daemon can't read a stale one. */
export function clearHeartbeat(heartbeatPath: string): void {
  try {
    unlinkSync(heartbeatPath);
  } catch {
    /* already gone */
  }
}

/**
 * Age of the heartbeat in ms, or `null` when it's missing or unreadable.
 *
 * `null` is deliberately distinct from "very old": a daemon started by
 * `/conduct start` before any hook has fired yet has no heartbeat to read, and
 * must not treat that as an expired session.
 *
 * Clamped at `0` because `mtimeMs` carries sub-millisecond precision and can
 * land a fraction of a millisecond ahead of `Date.now()` on a stamp we just
 * wrote — a negative age is meaningless to every caller.
 */
export function heartbeatAgeMs(heartbeatPath: string, now: number = Date.now()): number | null {
  try {
    return Math.max(0, now - statSync(heartbeatPath).mtimeMs);
  } catch {
    return null;
  }
}
