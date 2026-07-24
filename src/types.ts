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
