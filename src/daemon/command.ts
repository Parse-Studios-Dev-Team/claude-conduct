import type { Tier } from '../types';

/**
 * A command written to the watched file for the daemon. Either field may be
 * present: `tier` crossfades the ensemble; `volume` sets the master gain live
 * (used by `/conduct volume` and mute). The hook writes tier changes; the CLI
 * writes volume changes.
 */
export interface Command {
  tier?: Tier;
  volume?: number;
  /**
   * CC-11 cadence: settle on `tier`, hold this long, then fade to silence.
   *
   * The daemon has to own this because the hook cannot — it is a short-lived
   * process that must exit immediately and can never block a turn, so "play this,
   * then stop" is not something it can carry out itself.
   */
  holdMs?: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Serialize a command for the watched file. `ts` makes the content change even on a repeat. */
export function serializeCommand(command: Command, now: number = Date.now()): string {
  const payload: Record<string, unknown> = { ts: now };
  if (command.tier) {
    const tier: Record<string, number> = {
      ensembleSize: command.tier.ensembleSize,
      richness: command.tier.richness,
    };
    if (command.tier.timbre !== undefined) tier.timbre = command.tier.timbre;
    payload.tier = tier;
  }
  if (typeof command.volume === 'number' && Number.isFinite(command.volume)) {
    payload.volume = clamp01(command.volume);
  }
  if (typeof command.holdMs === 'number' && Number.isFinite(command.holdMs) && command.holdMs > 0) {
    payload.holdMs = command.holdMs;
  }
  return `${JSON.stringify(payload)}\n`;
}

/** Parse the command file into a {@link Command}, or `null` if nothing valid is present. */
export function parseCommand(text: string): Command | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const command: Command = {};

  const tier = (parsed as { tier?: unknown }).tier;
  if (tier && typeof tier === 'object') {
    const { ensembleSize, richness, timbre } = tier as {
      ensembleSize?: unknown;
      richness?: unknown;
      timbre?: unknown;
    };
    if (
      typeof ensembleSize === 'number' &&
      typeof richness === 'number' &&
      Number.isFinite(ensembleSize) &&
      Number.isFinite(richness)
    ) {
      command.tier = { ensembleSize, richness };
      if (typeof timbre === 'number' && Number.isFinite(timbre)) command.tier.timbre = timbre;
    }
  }

  const volume = (parsed as { volume?: unknown }).volume;
  if (typeof volume === 'number' && Number.isFinite(volume)) {
    command.volume = clamp01(volume);
  }

  const holdMs = (parsed as { holdMs?: unknown }).holdMs;
  if (typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0) {
    command.holdMs = holdMs;
  }

  if (command.tier === undefined && command.volume === undefined) return null;
  return command;
}
