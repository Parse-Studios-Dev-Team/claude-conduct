import type { Tier } from '../types';

/**
 * The command transport is a small JSON file the hook writes and the daemon
 * watches (chosen over a socket: no socket-path length limits, and it composes
 * with the existing `.claude/conduct-*.json` files). Rapid writes coalesce
 * harmlessly — the daemon always reads the latest tier and crossfades to it.
 */
export interface CommandFile {
  tier: Tier;
  /** Millisecond timestamp; makes the file content change even on a repeated tier. */
  ts: number;
}

/** Serialize a tier command for the watched file. */
export function serializeCommand(tier: Tier, now: number = Date.now()): string {
  const payload: CommandFile = {
    tier: { ensembleSize: tier.ensembleSize, richness: tier.richness },
    ts: now,
  };
  return `${JSON.stringify(payload)}\n`;
}

/** Parse the command file's contents into a {@link Tier}, or `null` if malformed. */
export function parseCommand(text: string): Tier | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const tier = (parsed as { tier?: unknown }).tier;
  if (!tier || typeof tier !== 'object') return null;

  const { ensembleSize, richness } = tier as { ensembleSize?: unknown; richness?: unknown };
  if (
    typeof ensembleSize !== 'number' ||
    typeof richness !== 'number' ||
    !Number.isFinite(ensembleSize) ||
    !Number.isFinite(richness)
  ) {
    return null;
  }
  return { ensembleSize, richness };
}
