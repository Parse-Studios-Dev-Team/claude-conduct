import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tier } from './types';

/** Bumped when the on-disk shape changes; an older/newer file is discarded, not migrated. */
export const STATE_VERSION = 1;

/** Default location, relative to the project dir (git-ignored). */
export const DEFAULT_STATE_PATH = '.claude/conduct-state.json';

/** Last-emitted tier for one session, plus when it was recorded. */
export interface SessionState {
  tier: Tier;
  /** ISO-8601 timestamp of the last emit for this session. */
  updatedAt: string;
}

/** The full persisted document at {@link DEFAULT_STATE_PATH}. */
export interface ConductState {
  version: number;
  sessions: Record<string, SessionState>;
}

/** Outcome of {@link recordTier}. */
export interface RecordResult {
  /** Whether the tier changed for this session and the daemon should be triggered. */
  emit: boolean;
  /** The current tier (echoed back for the caller to hand to the daemon). */
  tier: Tier;
  /** The previously-emitted tier for this session, or `null` if the session is new. */
  previous: Tier | null;
}

/** Tuning for {@link recordTier}. */
export interface RecordOptions {
  /**
   * Defensive GC: drop *other* sessions whose `updatedAt` is older than this many
   * milliseconds. Guards against unbounded growth if a `SessionEnd` cleanup was
   * ever missed (crash, kill). Omit to disable.
   */
  maxSessionAgeMs?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

function emptyState(): ConductState {
  return { version: STATE_VERSION, sessions: {} };
}

function isSessionState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  const tier = o.tier as Record<string, unknown> | undefined;
  return (
    !!tier &&
    typeof tier.ensembleSize === 'number' &&
    typeof tier.richness === 'number' &&
    typeof o.updatedAt === 'string'
  );
}

/** True when two tiers are identical on all axes (ensemble, richness, timbre). */
export function tiersEqual(a: Tier, b: Tier): boolean {
  return (
    a.ensembleSize === b.ensembleSize &&
    a.richness === b.richness &&
    (a.timbre ?? 0) === (b.timbre ?? 0)
  );
}

/**
 * Pure decision: should we emit (trigger the daemon)? A new session
 * (`previous === null`) always emits; otherwise we emit only when the tier
 * actually changed. No I/O — trivially unit-testable.
 */
export function shouldEmit(previous: Tier | null, current: Tier): boolean {
  return previous === null || !tiersEqual(previous, current);
}

/**
 * Read and validate the state file. A missing, unreadable, corrupt, or
 * version-mismatched file yields a fresh empty state rather than throwing —
 * callers on the hot path must never crash on a bad file.
 */
export function readState(statePath: string): ConductState {
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8');
  } catch {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as ConductState).version !== STATE_VERSION ||
      typeof (parsed as ConductState).sessions !== 'object' ||
      (parsed as ConductState).sessions === null
    ) {
      return emptyState();
    }
    // Keep only well-formed session entries; drop anything malformed.
    const sessions: Record<string, SessionState> = {};
    for (const [id, session] of Object.entries((parsed as ConductState).sessions)) {
      if (isSessionState(session)) sessions[id] = session;
    }
    return { version: STATE_VERSION, sessions };
  } catch {
    return emptyState();
  }
}

/**
 * Atomically write state: write a temp file then `rename` over the target, so a
 * concurrent reader never sees a half-written file. Creates the parent directory
 * if needed. May throw on a genuine I/O failure — orchestrators
 * ({@link recordTier}, {@link clearSession}) swallow that so a hook is never
 * broken by it.
 */
export function writeState(statePath: string, state: ConductState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, statePath);
}

/**
 * Record the current tier for a session and decide whether to emit.
 *
 * - First call for a new `sessionId` → `emit: true` (and the tier is persisted).
 * - A repeated call at the same tier → `emit: false`, and the file is left
 *   untouched (no redundant write).
 * - A changed tier → `emit: true`, and the new tier is persisted.
 *
 * Never throws: a failed persist still returns the correct `emit` decision (at
 * worst causing one redundant emit later), so the caller's turn is never blocked.
 */
export function recordTier(
  statePath: string,
  sessionId: string,
  tier: Tier,
  options?: RecordOptions,
): RecordResult {
  const nowMs = (options?.now ?? Date.now)();
  const state = readState(statePath);

  const prevSession = state.sessions[sessionId];
  const previous = prevSession ? prevSession.tier : null;
  const emit = shouldEmit(previous, tier);

  let mutated = false;

  if (options?.maxSessionAgeMs != null) {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (id === sessionId) continue;
      const age = nowMs - Date.parse(session.updatedAt);
      if (Number.isFinite(age) && age > options.maxSessionAgeMs) {
        delete state.sessions[id];
        mutated = true;
      }
    }
  }

  if (emit) {
    // Store a fresh copy so we never retain the caller's object reference.
    const storedTier: Tier = { ensembleSize: tier.ensembleSize, richness: tier.richness };
    if (tier.timbre !== undefined) storedTier.timbre = tier.timbre;
    state.sessions[sessionId] = {
      tier: storedTier,
      updatedAt: new Date(nowMs).toISOString(),
    };
    mutated = true;
  }

  if (mutated) {
    try {
      writeState(statePath, state);
    } catch {
      /* persistence is best-effort; the emit decision above still stands */
    }
  }

  return { emit, tier, previous };
}

/**
 * Remove a session's state — call on `SessionEnd`. No-op when the session is
 * absent; never throws.
 */
export function clearSession(statePath: string, sessionId: string): void {
  const state = readState(statePath);
  if (state.sessions[sessionId]) {
    delete state.sessions[sessionId];
    try {
      writeState(statePath, state);
    } catch {
      /* best-effort */
    }
  }
}
