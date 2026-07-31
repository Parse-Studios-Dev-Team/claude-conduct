/** Reasoning effort, as it appears on a transcript's top-level `.effort`. */
export type Effort = 'high' | 'max' | 'xhigh';

/** The kind of work a turn was mostly made of. */
export type Shape = 'think' | 'tool' | 'text';

/** The three tool families that sound meaningfully different from each other. */
export type ToolKind = 'read' | 'write' | 'exec';

/**
 * Session usage snapshot derived from a Claude Code transcript.
 *
 * Produced by {@link extractUsage} (CC-1) and consumed by the tier mapper (CC-2).
 * The three fields are the two orthogonal "complexity" signals plus the model:
 *
 * - {@link Usage.tokens}     — how much happened in the *latest* turn (momentary).
 * - {@link Usage.contextPct} — how full the context window is (rises over the session).
 * - {@link Usage.model}      — which model produced the latest turn.
 */
export interface Usage {
  /**
   * Fresh (non-cached) tokens for the most recent assistant turn:
   * `input_tokens + output_tokens`. A proxy for "how much happened this turn".
   *
   * Cache read/creation tokens are deliberately excluded so that reading a large
   * file (which balloons `cache_creation_input_tokens`) doesn't masquerade as a
   * large turn. `0` when the transcript contains no assistant turns.
   */
  tokens: number;

  /**
   * Context-window occupancy for the most recent turn, as a percentage in the
   * range `0–100`:
   *
   * ```
   * (input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
   *   / contextWindow * 100
   * ```
   *
   * clamped to `[0, 100]`. This is the full prompt size sent for the turn, i.e.
   * how much of the window is currently occupied. It tends to rise over the life
   * of a session. `0` when there are no assistant turns.
   */
  contextPct: number;

  /**
   * Raw model id of the most recent assistant turn, e.g. `"claude-opus-4-8"`.
   * `null` when the transcript contains no assistant turns. Kept raw (not
   * classified) so downstream consumers can map tiers however they like.
   */
  model: string | null;
}

/**
 * Everything one assistant turn tells us, read in a single pass (CC-12).
 *
 * A superset of {@link Usage}: the tier mapper still takes only the three usage
 * fields, but the recorder stores all of these so playback never has to go back
 * to Claude Code's transcript for the axes that make turns sound different from
 * each other.
 */
export interface TurnFacts extends Usage {
  /**
   * `output_tokens` alone, kept alongside {@link Usage.tokens} rather than
   * replacing it. Input is 97–100% cache reads in a real session, so the summed
   * total mostly measures how long the conversation has run; output alone spans
   * 172 → 22,848 across measured sessions and is what "how much work was this
   * turn" actually looks like.
   */
  outputTokens: number;

  /** Reasoning effort from the transcript's top-level `.effort`. */
  effort: Effort | null;

  /** Which kind of content block dominated the turn. */
  shape: Shape;

  /** Family of the first tool the turn ran, when it ran one. */
  tool: ToolKind | null;

  /** `stop_reason === 'end_turn'` — Claude handed control back on this turn. */
  endsTurn: boolean;
}

/**
 * Musical "tier" the daemon renders. Produced by `mapToTier` (CC-2) from a
 * {@link Usage} snapshot and consumed by the state layer (CC-3) and the
 * playback daemon (CC-5).
 */
export interface Tier {
  /**
   * How many instrument layers / stems play, `0–5` — the primary "how big does
   * it sound" knob. Rises with the *stronger* of the latest turn's activity
   * ({@link Usage.tokens}) and the session's context occupancy
   * ({@link Usage.contextPct}), plus a per-model bump so a higher tier model
   * sounds fuller at the same usage.
   */
  ensembleSize: number;

  /**
   * Harmonic depth / orchestration density, `0–2`. A slower axis driven purely
   * by context occupancy: the deeper into the session, the richer the texture.
   */
  richness: number;

  /**
   * Model-tier timbre signature (CC-8): `0` for standard models, `1` when a
   * high-end model (Opus) is active. Gates a distinct voicing layer keyed to the
   * model, **independent of token count**. Optional — an absent value is treated
   * as `0`.
   */
  timbre?: number;
}

/** Options for {@link extractUsage} / {@link extractUsageFromString}. */
export interface ExtractOptions {
  /**
   * Context-window sizes in tokens, keyed by model id. A key that is a prefix of
   * the model id also matches (e.g. `"claude-opus"` matches `"claude-opus-4-8"`),
   * with exact matches taking precedence over prefix matches.
   */
  contextWindows?: Record<string, number>;

  /**
   * Fallback context window (tokens) used when the model has no configured size.
   * Defaults to {@link DEFAULT_CONTEXT_WINDOW}.
   */
  defaultContextWindow?: number;
}
