import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeCommand } from './command';
import type { Tier } from '../types';

/**
 * Tell the running daemon to crossfade to `tier` by atomically writing the
 * command file (temp file + rename, so the watcher never reads a half-written
 * file). This is what the CC-6 hook calls after CC-3 decides an emit is due.
 *
 * Best-effort by contract, but surfaces write errors to the caller; the hook
 * wrapper is expected to swallow them so a turn is never blocked.
 */
export function sendTier(commandPath: string, tier: Tier, now: number = Date.now()): void {
  mkdirSync(dirname(commandPath), { recursive: true });
  const tmp = `${commandPath}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeCommand(tier, now), 'utf8');
  renameSync(tmp, commandPath);
}
