import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TierConfig } from '../mapToTier';
import { DEFAULT_LIVE_CONFIG, type LiveConfig } from '../liveMode';

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
  /**
   * Shut the daemon down after this long with no hook activity, so a session
   * that dies without firing `SessionEnd` can't leave music looping forever.
   * `0` disables the watchdog (the daemon then only stops on an explicit signal).
   */
  idleTimeoutMs: number;
  /** Threshold overrides passed to `mapToTier` (see {@link TierConfig}). */
  tier: Partial<TierConfig>;
  /** Per-model context-window sizes passed to `extractUsage`. */
  contextWindows: Record<string, number>;
  /** Directory of real WAV stems to play; relative paths resolve from the project dir. Unset ⇒ synth placeholders. */
  stemsDir?: string;
  /** CC-9 session recording: whether to log a timeline, and how many to keep. */
  recordings: RecordingsConfig;
  /** CC-11 live playback shape: presence + cadence, or the original gradient. */
  live: LiveConfig;
  /**
   * CC-13 — what this session is for.
   *
   * Live and playback are not two settings on one engine; they want opposite
   * things. Live has to be ignorable and legible. Playback has to be interesting
   * and has no legibility requirement at all. Splitting the difference is what
   * produced "sounds mostly the same", so the choice is explicit and each side
   * is tuned for its own goal.
   */
  mode: ConductMode;
  /** CC-13 tuning for rendered pieces. */
  playback: PlaybackConfig;
}

/**
 * `live` plays as you work and renders nothing. `playback` stays silent and
 * leaves a piece behind at the end — which plenty of people will want, and is
 * the only mode that coexists with music you are already playing. `both` does
 * each. `off` disables audio *and* rendering, but not recording.
 */
export type ConductMode = 'live' | 'playback' | 'both' | 'off';

/** Tuning for CC-13 rendered playback. */
export interface PlaybackConfig {
  /** Target length of the piece, regardless of how long the session ran. */
  seconds: number;
  /**
   * Also render sessions that ended without firing `SessionEnd`. Closing the
   * window or killing the process skips that event entirely, so a render
   * triggered only by it would silently never happen for those sessions.
   */
  sweepStale: boolean;
  /** Keep this many renders. ~15 MB each, so this is the real disk cost. */
  keep: number;
}

/** Tuning for the CC-9 session recorder. */
export interface RecordingsConfig {
  /** Write a per-session timeline. Recording is independent of playback. */
  enabled: boolean;
  /** Keep this many recordings per project, newest first. `0` disables pruning. */
  keep: number;
}

export const DEFAULT_CONFIG: ConductConfig = {
  mute: false,
  volume: 0.8,
  silent: false,
  crossfadeMs: 1500,
  // 15 minutes: comfortably longer than any gap between hooks in a session you
  // are still using (a single tool call resets it), short enough that an
  // orphaned daemon stops well before it becomes a mystery.
  idleTimeoutMs: 15 * 60 * 1000,
  tier: {},
  contextWindows: {},
  recordings: { enabled: true, keep: 20 },
  live: { ...DEFAULT_LIVE_CONFIG },
  mode: 'live',
  playback: { seconds: 90, sweepStale: true, keep: 20 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const allFinite = (value: unknown, length: number): boolean =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isTwoNumbers = (value: unknown): value is [number, number] => allFinite(value, 2);
const isThreeNumbers = (value: unknown): value is [number, number, number] => allFinite(value, 3);

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
  // `0` is meaningful here (disable), so this accepts any finite non-negative
  // number rather than reusing the `> 0` guard above.
  if (typeof parsed.idleTimeoutMs === 'number' && Number.isFinite(parsed.idleTimeoutMs) && parsed.idleTimeoutMs >= 0) {
    config.idleTimeoutMs = parsed.idleTimeoutMs;
  }
  if (isPlainObject(parsed.tier)) config.tier = parsed.tier as Partial<TierConfig>;
  if (isPlainObject(parsed.contextWindows)) {
    config.contextWindows = parsed.contextWindows as Record<string, number>;
  }
  if (typeof parsed.stemsDir === 'string' && parsed.stemsDir.length > 0) {
    config.stemsDir = parsed.stemsDir;
  }
  if (isPlainObject(parsed.recordings)) {
    const recordings = { ...DEFAULT_CONFIG.recordings };
    if (typeof parsed.recordings.enabled === 'boolean') recordings.enabled = parsed.recordings.enabled;
    if (typeof parsed.recordings.keep === 'number' && Number.isFinite(parsed.recordings.keep)) {
      recordings.keep = Math.max(0, Math.floor(parsed.recordings.keep));
    }
    config.recordings = recordings;
  }
  if (isPlainObject(parsed.live)) {
    const live: LiveConfig = { ...DEFAULT_LIVE_CONFIG };
    if (parsed.live.mode === 'presence' || parsed.live.mode === 'gradient') {
      live.mode = parsed.live.mode;
    }
    if (isThreeNumbers(parsed.live.levels)) live.levels = parsed.live.levels;
    if (isTwoNumbers(parsed.live.steps)) live.steps = parsed.live.steps;
    if (
      typeof parsed.live.cadenceHoldMs === 'number' &&
      Number.isFinite(parsed.live.cadenceHoldMs) &&
      parsed.live.cadenceHoldMs > 0
    ) {
      live.cadenceHoldMs = parsed.live.cadenceHoldMs;
    }
    config.live = live;
  }
  if (
    parsed.mode === 'live' ||
    parsed.mode === 'playback' ||
    parsed.mode === 'both' ||
    parsed.mode === 'off'
  ) {
    config.mode = parsed.mode;
  }
  if (isPlainObject(parsed.playback)) {
    const playback = { ...DEFAULT_CONFIG.playback };
    if (
      typeof parsed.playback.seconds === 'number' &&
      Number.isFinite(parsed.playback.seconds) &&
      parsed.playback.seconds > 0
    ) {
      playback.seconds = parsed.playback.seconds;
    }
    if (typeof parsed.playback.sweepStale === 'boolean') {
      playback.sweepStale = parsed.playback.sweepStale;
    }
    if (typeof parsed.playback.keep === 'number' && Number.isFinite(parsed.playback.keep)) {
      playback.keep = Math.max(0, Math.floor(parsed.playback.keep));
    }
    config.playback = playback;
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
