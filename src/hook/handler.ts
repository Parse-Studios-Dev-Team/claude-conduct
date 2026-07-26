import { extractUsage } from '../extractUsage';
import { mapToTier } from '../mapToTier';
import { recordTier, clearSession } from '../state';
import { sendTier } from '../daemon/client';
import { startDaemon, stopDaemon } from './daemonControl';
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
  extractUsage: typeof extractUsage;
  recordTier: typeof recordTier;
  clearSession: typeof clearSession;
  sendTier: typeof sendTier;
  startDaemon: typeof startDaemon;
  stopDaemon: typeof stopDaemon;
  recordTurn: typeof recordTurn;
  finalizeRecording: typeof finalizeRecording;
  pruneRecordings: typeof pruneRecordings;
}

export const realDeps: HandlerDeps = {
  extractUsage,
  recordTier,
  clearSession,
  sendTier,
  startDaemon,
  stopDaemon,
  recordTurn,
  finalizeRecording,
  pruneRecordings,
};

export interface HandleResult {
  action: 'start' | 'stop' | 'update' | 'noop';
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
 * - `SessionEnd`   → stop the daemon and drop this session's state.
 * - `PostToolUse` / `Stop` (anything with a transcript) →
 *   `extractUsage → mapToTier → recordTier` (dedupe) → `sendTier` on change.
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
  switch (input.hook_event_name) {
    case 'SessionStart':
      // Deliberately does not start the daemon — see the note above.
      return { action: 'noop', emitted: null };

    case 'SessionEnd':
      deps.stopDaemon(paths);
      if (input.session_id) {
        deps.clearSession(paths.statePath, input.session_id);
        if (config.recordings.enabled) {
          deps.finalizeRecording(paths.recordingsDir, input.session_id);
          deps.pruneRecordings(paths.recordingsDir, config.recordings.keep);
        }
      }
      return { action: 'stop', emitted: null };

    default: {
      // PostToolUse, Stop, or any usage-bearing event.
      if (!input.transcript_path || !input.session_id) {
        return { action: 'noop', emitted: null };
      }
      const usage = deps.extractUsage(input.transcript_path, {
        contextWindows: config.contextWindows,
      });
      const mapped = mapToTier(usage, config.tier);
      const tier = config.mute ? SILENT_TIER : mapped;

      // Record the *mapped* tier, not the muted one: a recording describes what
      // the session would sound like, so muting playback must not flatten the
      // timeline into silence. Recording is also independent of the dedupe —
      // every turn gets a line, because the playground re-scores from the raw
      // axes and needs them all, not just the turns that changed tier.
      if (config.recordings.enabled) {
        deps.recordTurn(paths.recordingsDir, input.session_id, usage, mapped);
      }

      const { emit } = deps.recordTier(paths.statePath, input.session_id, tier);
      if (emit) deps.sendTier(paths.commandPath, tier);
      return { action: 'update', emitted: emit ? tier : null };
    }
  }
}
