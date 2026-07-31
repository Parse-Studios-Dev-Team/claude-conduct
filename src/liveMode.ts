import type { Tier, Usage } from './types';

/**
 * CC-11 — live playback as presence and cadence, not a continuous gradient.
 *
 * Ambient information design works when the data is otherwise invisible: network
 * traffic, energy draw, a server's health. Session state is not invisible — it is
 * on the screen you are already looking at, and the statusline already shows
 * context. As a gradient the music is a second channel for information you
 * already have, which is why it reads as decoration.
 *
 * The genuinely useful case is the opposite one: you alt-tab away, Claude works
 * for three minutes, and you want to know *still going? done?* That is a handful
 * of events, not a gradient. Measured over real sessions the tier changed on only
 * 21.7% of turn transitions, so four out of five turns already sounded identical
 * to the one before — the gradient was not carrying information even then.
 *
 * So: **silence means it is your turn.** Music means Claude is working. Every
 * transition now carries a bit, which is more than the old always-on drone ever
 * did. Intensity survives in three coarse steps so a long grind still feels
 * different from a quick answer; the fine-grained axes move to CC-10, where
 * variety is the goal rather than a liability.
 */

/** What the session is doing right now, as far as the hook can tell. */
export type LivePhase =
  /** Claude is mid-turn — tools running, thinking, writing. */
  | 'working'
  /** Claude just handed control back. Resolve, then fall silent. */
  | 'cadence'
  /** Nothing to say. */
  | 'idle';

export interface LiveConfig {
  /**
   * `presence` is CC-11: silence unless Claude is working. `gradient` is the
   * original always-on mapping, kept because it is what the tier ladder and the
   * whole stem layout were built around, and because some people will want it.
   */
  mode: 'presence' | 'gradient';
  /** Ensemble size per intensity step. Three steps, deliberately, not six. */
  levels: [number, number, number];
  /**
   * Token counts at which intensity steps up. Coarse by design — this is the
   * difference between "a quick answer" and "a long grind", not a readout.
   */
  steps: [number, number];
  /**
   * How long the resolved chord holds before the daemon fades to silence.
   * Long enough to register as an ending, short enough not to be a tail you
   * wait through.
   */
  cadenceHoldMs: number;
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  mode: 'presence',
  // Never the full six: a working session should sound like one thing, with
  // headroom above it, not like a meter.
  levels: [2, 3, 5],
  steps: [1_500, 12_000],
  cadenceHoldMs: 2_500,
};

/** Silence — the resting state of presence mode. */
export const SILENT_TIER: Tier = { ensembleSize: 0, richness: 0 };

/** Which of the three coarse steps this much work falls into. */
export function intensity(tokens: number, config: LiveConfig): 0 | 1 | 2 {
  if (tokens >= config.steps[1]) return 2;
  if (tokens >= config.steps[0]) return 1;
  return 0;
}

/**
 * The tier to play for a phase.
 *
 * `timbre` still passes through: which model is working is the one genuinely
 * absolute signal, and it costs nothing to keep.
 *
 * The cadence tier is deliberately *small* rather than loud — root and fifth,
 * no harmonic depth. An ending that swells is a fanfare, and a tool that
 * fanfares every time it finishes a turn is a tool you mute.
 */
export function liveTier(phase: LivePhase, usage: Usage, config: LiveConfig): Tier {
  const timbre = usage.model?.startsWith('claude-opus') || usage.model?.startsWith('claude-fable') ? 1 : 0;

  switch (phase) {
    case 'idle':
      return { ...SILENT_TIER };
    case 'cadence':
      return { ensembleSize: 2, richness: 0, timbre };
    case 'working': {
      const step = intensity(usage.tokens, config);
      return { ensembleSize: config.levels[step], richness: step, timbre };
    }
  }
}

/**
 * Map a hook event to a phase.
 *
 * `Stop` is the event worth having: it fires when Claude hands control back,
 * which is rare and meaningful (80 of 1,887 assistant lines in a measured
 * session) and is the single most valuable bit this tool can convey. Everything
 * else that carries a transcript means work is underway.
 */
export function phaseFor(hookEvent: string | undefined, endsTurn: boolean): LivePhase {
  if (hookEvent === 'Stop' || hookEvent === 'SubagentStop') return 'cadence';
  if (hookEvent === 'SessionStart' || hookEvent === 'SessionEnd') return 'idle';
  // A transcript whose latest line already ended the turn means the same thing
  // as `Stop`, and arrives when `Stop` isn't wired up.
  return endsTurn ? 'cadence' : 'working';
}
