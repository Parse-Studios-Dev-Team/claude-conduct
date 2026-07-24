import { spawn } from 'node:child_process';
import { readFileSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
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
 * Start the playback daemon detached, unless one is already running. The child
 * outlives this (hook) process; its config is passed through the environment.
 * Best-effort — any failure is swallowed so a hook never blocks the turn.
 */
export function startDaemon(paths: ConductPaths, config: ConductConfig): void {
  if (isDaemonRunning(paths.pidPath)) return;
  try {
    const { command, args } = resolveDaemonEntry(paths.baseDir);

    let out: number | 'ignore' = 'ignore';
    try {
      out = openSync(paths.logPath, 'a');
    } catch {
      out = 'ignore';
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        CONDUCT_COMMAND: paths.commandPath,
        CONDUCT_PID: paths.pidPath,
        CONDUCT_VOLUME: String(config.volume),
        CONDUCT_CROSSFADE_MS: String(config.crossfadeMs),
        CONDUCT_SILENT: config.silent ? '1' : '0',
      },
    });
    child.unref();
  } catch {
    /* never block the turn on a spawn failure */
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
