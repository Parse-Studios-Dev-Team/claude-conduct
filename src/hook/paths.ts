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
 * Resolve every Conduct path from a project directory. Runtime files live under
 * `.claude/` (all git-ignored); the config sits at the project root so it's easy
 * to find and commit. Pure — no I/O.
 */
export function resolvePaths(baseDir: string): ConductPaths {
  const claudeDir = join(baseDir, '.claude');
  return {
    baseDir,
    configPath: process.env.CONDUCT_CONFIG ?? join(baseDir, 'conduct.config.json'),
    statePath: join(claudeDir, 'conduct-state.json'),
    commandPath: join(claudeDir, 'conduct-command.json'),
    pidPath: join(claudeDir, 'conduct.pid'),
    logPath: join(claudeDir, 'conduct-daemon.log'),
  };
}
