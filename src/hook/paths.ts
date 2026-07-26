import { join } from 'node:path';

/** All filesystem locations the hook and daemon share, derived from the project dir. */
export interface ConductPaths {
  /** Project directory the paths are anchored to. */
  baseDir: string;
  /** Config file (default `<baseDir>/conduct.config.json`, or `$CONDUCT_CONFIG`). */
  configPath: string;
  /** CC-3 per-session tier state. */
  statePath: string;
  /** CC-5 watched command file the daemon reads. */
  commandPath: string;
  /** Daemon pidfile. */
  pidPath: string;
  /** Daemon stdout/stderr log. */
  logPath: string;
}

/**
 * Turn a project directory into a filesystem-safe single segment, so several
 * projects can keep runtime files side by side under one shared root.
 */
export function projectSlug(baseDir: string): string {
  return baseDir.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/**
 * Resolve every Conduct path from a project directory. Pure — no I/O.
 *
 * By default runtime files live in the project's own `.claude/` (all
 * git-ignored) and the config sits at the project root, which is right when
 * Conduct is installed into a single repo.
 *
 * When Conduct is installed for *every* project, writing runtime files into each
 * one would litter unrelated repos — so `$CONDUCT_STATE_DIR` relocates them to a
 * per-project subdirectory under one shared root, and `$CONDUCT_CONFIG` points
 * every project at one config so volume and mute carry across sessions.
 */
export function resolvePaths(baseDir: string): ConductPaths {
  const stateRoot = process.env.CONDUCT_STATE_DIR;
  const runtimeDir = stateRoot
    ? join(stateRoot, projectSlug(baseDir))
    : join(baseDir, '.claude');

  return {
    baseDir,
    configPath: process.env.CONDUCT_CONFIG ?? join(baseDir, 'conduct.config.json'),
    statePath: join(runtimeDir, 'conduct-state.json'),
    commandPath: join(runtimeDir, 'conduct-command.json'),
    pidPath: join(runtimeDir, 'conduct.pid'),
    logPath: join(runtimeDir, 'conduct-daemon.log'),
  };
}
