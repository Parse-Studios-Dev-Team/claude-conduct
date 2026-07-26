import { spawn } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  mkdirSync,
  statSync,
  ftruncateSync,
} from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import type { ConductConfig } from './config';
import type { ConductPaths } from './paths';

/** Read the daemon pid, or `null` if the pidfile is missing/garbage. */
function readPid(pidPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is a daemon process currently alive for this project? */
export function isDaemonRunning(pidPath: string): boolean {
  const pid = readPid(pidPath);
  if (pid === null) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false; // stale pidfile
  }
}

/** Prefer the fast bundled entrypoint (`dist/conduct-daemon.mjs`), else run the TS source via tsx. */
function resolveDaemonEntry(baseDir: string): { command: string; args: string[] } {
  const bundled = join(baseDir, 'dist', 'conduct-daemon.mjs');
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  return { command: 'npx', args: ['tsx', join(baseDir, 'bin', 'conduct-daemon.ts')] };
}

/**
 * How long a pidfile with no readable pid is assumed to be an in-flight claim
 * rather than debris. Only has to cover the microseconds between `open` and the
 * first `write`; the generous margin costs nothing because the only price of
 * waiting is that one hook skips a start attempt.
 */
const CLAIM_GRACE_MS = 5_000;

/** Age of a file in ms, or `Infinity` if it can't be stat'd. */
function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Atomically claim the right to start the daemon by creating the pidfile with
 * `wx` (create-exclusive) and immediately stamping our own pid into it. Returns
 * the open fd on success, or `null` when somebody else owns the claim.
 *
 * A plain `isDaemonRunning()` check before `spawn()` is not enough: the daemon
 * writes its own pidfile only after it has booted Node, synthesized stems and
 * opened the audio device — hundreds of milliseconds later. Two hooks firing
 * inside that window both saw "not running" and both spawned, leaving two
 * daemons rendering the same stems slightly out of phase (audible as beating,
 * and loud enough together to clip) with only one reachable via the pidfile.
 *
 * The pid is written before the fd is returned so that a racer which loses the
 * `wx` sees a *live* owner immediately. Distinguishing the three conflict cases
 * is what makes this correct:
 *
 * - a readable, live pid → a daemon (or a hook mid-spawn) owns it: back off;
 * - a readable, dead pid → debris from a killed daemon: clear it and retry;
 * - no readable pid → another hook is between `open` and `write` right now, so
 *   back off unless the file is old enough to be a crashed claim.
 *
 * Treating that last case as debris is exactly what let five concurrent hooks
 * each unlink the winner's fresh claim and spawn their own daemon.
 */
function claimPidfile(pidPath: string): number | null {
  try {
    mkdirSync(dirname(pidPath), { recursive: true });
  } catch {
    /* best-effort */
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(pidPath, 'wx');
      try {
        // Publish ownership before returning, so a racer never sees an empty file.
        writeSync(fd, `${process.pid}\n`, 0);
      } catch {
        /* best-effort; the grace window still covers us */
      }
      return fd;
    } catch {
      if (attempt === 1) return null; // lost the retry — someone else is starting

      const pid = readPid(pidPath);
      if (pid === null) {
        // Mid-claim by another hook, unless it's been sitting there too long.
        if (ageMs(pidPath) < CLAIM_GRACE_MS) return null;
      } else if (isDaemonRunning(pidPath)) {
        return null; // a healthy owner
      }

      try {
        unlinkSync(pidPath); // debris: dead pid, or an abandoned claim
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Start the playback daemon detached, unless one is already running or another
 * hook is concurrently starting it. The child outlives this (hook) process; its
 * config is passed through the environment. Best-effort — any failure is
 * swallowed so a hook never blocks the turn.
 */
export function startDaemon(paths: ConductPaths, config: ConductConfig): void {
  if (isDaemonRunning(paths.pidPath)) return;

  const claim = claimPidfile(paths.pidPath);
  if (claim === null) return;

  let spawned = false;
  try {
    const { command, args } = resolveDaemonEntry(paths.baseDir);

    let out: number | 'ignore' = 'ignore';
    try {
      out = openSync(paths.logPath, 'a');
    } catch {
      out = 'ignore';
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CONDUCT_COMMAND: paths.commandPath,
      CONDUCT_PID: paths.pidPath,
      CONDUCT_VOLUME: String(config.volume),
      CONDUCT_CROSSFADE_MS: String(config.crossfadeMs),
      CONDUCT_SILENT: config.silent ? '1' : '0',
    };
    if (config.stemsDir) {
      env.CONDUCT_STEMS_DIR = isAbsolute(config.stemsDir)
        ? config.stemsDir
        : join(paths.baseDir, config.stemsDir);
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env,
    });
    child.unref();

    // Hand ownership from this (short-lived) hook to the daemon itself, so a
    // hook firing while the daemon is still booting sees a live owner. The
    // daemon rewrites the same value once it finishes starting.
    if (typeof child.pid === 'number') {
      ftruncateSync(claim, 0);
      writeSync(claim, `${child.pid}\n`, 0);
      spawned = true;
    }
  } catch {
    /* never block the turn on a spawn failure */
  } finally {
    try {
      closeSync(claim);
    } catch {
      /* best-effort */
    }
    // Never leave an empty pidfile behind: it would look like a live claim and
    // block every future start attempt.
    if (!spawned) {
      try {
        unlinkSync(paths.pidPath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Signal the daemon to stop. Best-effort; the daemon cleans up its own pidfile/socket. */
export function stopDaemon(paths: ConductPaths): void {
  const pid = readPid(paths.pidPath);
  if (pid === null) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
