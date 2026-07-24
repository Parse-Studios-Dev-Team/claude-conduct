import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TierConfig } from '../mapToTier';

/**
 * User-tunable configuration for the Conduct hook. Loaded from a JSON file
 * (default `conduct.config.json` at the project root; override with
 * `CONDUCT_CONFIG`). Every field is optional in the file and falls back to
 * {@link DEFAULT_CONFIG}.
 */
export interface ConductConfig {
  /** Silence output: the hook drives every turn to the silent tier. */
  mute: boolean;
  /** Playback volume `0..1` — the daemon's master gain (applied at daemon start). */
  volume: number;
  /** Force headless output even if `speaker` is installed. */
  silent: boolean;
  /** Crossfade time in ms for tier changes. */
  crossfadeMs: number;
  /** Threshold overrides passed to `mapToTier` (see {@link TierConfig}). */
  tier: Partial<TierConfig>;
  /** Per-model context-window sizes passed to `extractUsage`. */
  contextWindows: Record<string, number>;
  /** Directory of real WAV stems to play; relative paths resolve from the project dir. Unset ⇒ synth placeholders. */
  stemsDir?: string;
}

export const DEFAULT_CONFIG: ConductConfig = {
  mute: false,
  volume: 0.8,
  silent: false,
  crossfadeMs: 1500,
  tier: {},
  contextWindows: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load and validate config from `configPath`, merged over {@link DEFAULT_CONFIG}.
 * A missing, unreadable, or malformed file yields the defaults — the hook must
 * never fail to run because of a bad config.
 */
export function loadConfig(configPath: string): ConductConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!isPlainObject(parsed)) return { ...DEFAULT_CONFIG };

  const config: ConductConfig = { ...DEFAULT_CONFIG };
  if (typeof parsed.mute === 'boolean') config.mute = parsed.mute;
  if (typeof parsed.silent === 'boolean') config.silent = parsed.silent;
  if (typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)) {
    config.volume = Math.max(0, Math.min(1, parsed.volume));
  }
  if (typeof parsed.crossfadeMs === 'number' && Number.isFinite(parsed.crossfadeMs) && parsed.crossfadeMs > 0) {
    config.crossfadeMs = parsed.crossfadeMs;
  }
  if (isPlainObject(parsed.tier)) config.tier = parsed.tier as Partial<TierConfig>;
  if (isPlainObject(parsed.contextWindows)) {
    config.contextWindows = parsed.contextWindows as Record<string, number>;
  }
  if (typeof parsed.stemsDir === 'string' && parsed.stemsDir.length > 0) {
    config.stemsDir = parsed.stemsDir;
  }
  return config;
}

/**
 * Merge `patch` into the config file on disk, preserving any keys we don't manage
 * (and not writing out defaults). Creates the file/dir if needed. Used by
 * `/conduct` to persist `mute`/`volume`.
 */
export function updateConfig(configPath: string, patch: Partial<ConductConfig>): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (isPlainObject(parsed)) existing = parsed;
  } catch {
    /* no/!valid file yet — start from empty */
  }
  const merged = { ...existing, ...patch };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}
