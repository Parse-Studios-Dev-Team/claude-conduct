import { extractTurnFacts, isReadable } from '../extractUsage';
import { mapToTier } from '../mapToTier';
import { recordTier, clearSession, noteUnreadable, unreadableCount } from '../state';
import { sendTier } from '../daemon/client';
import { startDaemon, stopDaemon } from './daemonControl';
import { touchHeartbeat, clearHeartbeat } from './heartbeat';
import { recordTurn, finalizeRecording, pruneRecordings } from '../recorder';
import type { Tier } from '../types';
import type { ConductConfig } from './config';
import type { ConductPaths } from './paths';

const SILENT_TIER: Tier = { ensembleSize: 0, richness: 0 };

/** The subset of a Claude Code hook payload we read (all optional; parsed defensively). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  hook_event_name?: string;
  cwd?: string;
  reason?: string;
  source?: string;
}

/** Injectable collaborators — the defaults are the real modules; tests pass stubs. */
export interface HandlerDeps {
  extractTurnFacts: typeof extractTurnFacts;
  recordTier: typeof recordTier;
  clearSession: typeof clearSession;
  noteUnreadable: typeof noteUnreadable;
  unreadableCount: typeof unreadableCount;
  sendTier: typeof sendTier;
  startDaemon: typeof startDaemon;
  stopDaemon: typeof stopDaemon;
  touchHeartbeat: typeof touchHeartbeat;
  clearHeartbeat: typeof clearHeartbeat;
  recordTurn: typeof recordTurn;
  finalizeRecording: typeof finalizeRecording;
  pruneRecordings: typeof pruneRecordings;
}

export const realDeps: HandlerDeps = {
  extractTurnFacts,
  recordTier,
  clearSession,
  noteUnreadable,
  unreadableCount,
  sendTier,
  startDaemon,
  stopDaemon,
  touchHeartbeat,
  clearHeartbeat,
  recordTurn,
  finalizeRecording,
  pruneRecordings,
};

export interface HandleResult {
  action: 'start' | 'stop' | 'update' | 'noop' | 'unreadable';
  /** The tier sent to the daemon this event, or `null` if nothing was emitted. */
  emitted: Tier | null;
}

/**
 * Route one hook event through the pipeline:
 *
 * - `SessionStart` → nothing. Playback is opt-in per session: the daemon only
 *   starts when you ask for it with `/conduct start` (or `unmute`). Tier updates
 *   still accumulate in the command file while it's down, so starting mid-session
 *   picks up at the right layer instead of from silence.
 * - `SessionEnd`   → stop the daemon, clear the heartbeat, drop this session's state.
 * - `PostToolUse` / `Stop` (anything with a transcript) →
 *   `extractTurnFacts → mapToTier → recordTier` (dedupe) → `sendTier` on change.
 *
 * Pure orchestration over injected deps. It does not catch — the entrypoint
 * wraps it so a failure can never block the Claude Code turn — but nothing here
 * throws on normal input, and a down daemon simply means `sendTier` writes a
 * file no one reads yet.
 */
export function handleEvent(
  input: HookInput,
  config: ConductConfig,
  paths: ConductPaths,
  deps: HandlerDeps = realDeps,
): HandleResult {
  // Any event at all proves Claude Code is still alive, so stamp the marker
  // before branching — including on events we otherwise ignore. `SessionEnd` is
  // the one exception: it clears the marker instead.
  if (input.hook_event_name !== 'SessionEnd') deps.touchHeartbeat(paths.heartbeatPath);

  switch (input.hook_event_name) {
    case 'SessionStart':
      // Deliberately does not start the daemon — see the note above.
      return { action: 'noop', emitted: null };

    case 'SessionEnd':
      deps.stopDaemon(paths);
      deps.clearHeartbeat(paths.heartbeatPath);
      if (input.session_id) {
        // Read the unreadable tally *before* clearing the session that holds it.
        const unreadable = config.recordings.enabled
          ? deps.unreadableCount(paths.statePath, input.session_id)
          : 0;
        deps.clearSession(paths.statePath, input.session_id);
        if (config.recordings.enabled) {
          deps.finalizeRecording(paths.recordingsDir, input.session_id, unreadable);
          deps.pruneRecordings(paths.recordingsDir, config.recordings.keep);
        }
      }
      return { action: 'stop', emitted: null };

    default: {
      // PostToolUse, Stop, or any usage-bearing event.
      if (!input.transcript_path || !input.session_id) {
        return { action: 'noop', emitted: null };
      }
      // One read of the transcript yields both the tier inputs and the axes the
      // recording stores (CC-12); the mapper still sees only the usage fields.
      const facts = deps.extractTurnFacts(input.transcript_path, {
        contextWindows: config.contextWindows,
      });

      // A turn we could not read is not a quiet turn (CC-15). Recording it as
      // tier 0 produced 25,470 lines of pure silence across two sessions on a
      // host whose transcript format carries no usage at all, and drove playback
      // to silence instead of leaving it where it was. Count it and stand down.
      if (!isReadable(facts)) {
        deps.noteUnreadable(paths.statePath, input.session_id);
        return { action: 'unreadable', emitted: null };
      }

      const mapped = mapToTier(facts, config.tier);
      const tier = config.mute ? SILENT_TIER : mapped;

      // Record the *mapped* tier, not the muted one: a recording describes what
      // the session would sound like, so muting playback must not flatten the
      // timeline into silence. Recording is also independent of the dedupe —
      // every turn gets a line, because the playground re-scores from the raw
      // axes and needs them all, not just the turns that changed tier.
      if (config.recordings.enabled) {
        deps.recordTurn(paths.recordingsDir, input.session_id, facts, mapped);
      }

      const { emit } = deps.recordTier(paths.statePath, input.session_id, tier);
      if (emit) deps.sendTier(paths.commandPath, tier);
      return { action: 'update', emitted: emit ? tier : null };
    }
  }
}
