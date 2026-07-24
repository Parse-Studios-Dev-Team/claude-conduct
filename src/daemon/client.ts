import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeCommand, type Command } from './command';
import type { Tier } from '../types';

/**
 * Atomically write a command for the running daemon (temp file + rename, so the
 * watcher never reads a half-written file).
 */
export function sendCommand(commandPath: string, command: Command, now: number = Date.now()): void {
  mkdirSync(dirname(commandPath), { recursive: true });
  const tmp = `${commandPath}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeCommand(command, now), 'utf8');
  renameSync(tmp, commandPath);
}

/** Tell the daemon to crossfade to `tier`. Called by the CC-6 hook. */
export function sendTier(commandPath: string, tier: Tier, now: number = Date.now()): void {
  sendCommand(commandPath, { tier }, now);
}

/** Set the daemon's master volume `0..1` live. Called by `/conduct volume` and mute. */
export function sendVolume(commandPath: string, volume: number, now: number = Date.now()): void {
  sendCommand(commandPath, { volume }, now);
}
