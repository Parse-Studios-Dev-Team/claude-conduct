import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConductConfig } from './config';
import type { ConductPaths } from './paths';

/**
 * CC-13 — kick off a session render without blocking the turn.
 *
 * Rendering a 90-second piece takes seconds of CPU, which is orders of magnitude
 * more than a hook may spend: `SessionEnd` has to return immediately. So this
 * spawns a detached process and forgets about it, exactly as `startDaemon` does,
 * and for the same reason.
 */

/** Conduct's own install directory — never the session's project. See `daemonControl`. */
function installRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDir) === 'dist' ? dirname(moduleDir) : join(moduleDir, '..', '..');
}

/** Prefer the bundled entrypoint, else run the TS source via tsx. */
function resolveRenderEntry(): { command: string; args: string[] } {
  const root = installRoot();
  const bundled = join(root, 'dist', 'conduct-render.mjs');
  if (existsSync(bundled)) return { command: process.execPath, args: [bundled] };
  return { command: 'npx', args: ['tsx', join(root, 'bin', 'conduct-render.ts')] };
}

/**
 * Render `sessionIds` in the background. Best-effort and silent: a render that
 * fails is a missing file, never a broken turn.
 */
export function startRender(
  paths: ConductPaths,
  config: ConductConfig,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0) return;

  try {
    const { command, args } = resolveRenderEntry();

    let out: number | 'ignore' = 'ignore';
    try {
      out = openSync(paths.logPath, 'a');
    } catch {
      out = 'ignore';
    }

    const child = spawn(command, [...args, ...sessionIds], {
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        CONDUCT_RECORDINGS_DIR: paths.recordingsDir,
        CONDUCT_RENDERS_DIR: paths.rendersDir,
        CONDUCT_PROJECT_DIR: paths.baseDir,
        CONDUCT_RENDER_SECONDS: String(config.playback.seconds),
        CONDUCT_RENDER_KEEP: String(config.playback.keep),
      },
      cwd: installRoot(),
    });
    child.unref();

    if (typeof out === 'number') {
      try {
        closeSync(out);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* never block the turn on a spawn failure */
  }
}
