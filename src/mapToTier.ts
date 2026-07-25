import type { Tier, Usage } from './types';

/**
 * Tunable thresholds for {@link mapToTier}. Every knob is configurable — nothing
 * about the token/context/model → tier mapping is hardcoded in the function.
 *
 * Threshold arrays are read as "how many do you meet or exceed"; they don't have
 * to be pre-sorted, but ascending order reads best. Passing a partial config to
 * {@link mapToTier} replaces each provided field wholesale (shallow merge) — e.g.
 * a custom `tokenThresholds` replaces the whole default array, it isn't merged
 * element-wise.
 */
export interface TierConfig {
  /**
   * Ascending token counts. `ensembleSize` gains one level for each threshold
   * the latest turn's {@link Usage.tokens} meets — the momentary "how much just
   * happened" axis.
   */
  tokenThresholds: number[];

  /**
   * Ascending context-occupancy percentages (`0–100`). Contributes to
   * `ensembleSize` the same way, and the *stronger* of the token and context
   * levels wins — so a nearly-full session still sounds big right after a tiny
   * turn.
   */
  contextThresholds: number[];

  /** Ascending context-occupancy percentages (`0–100`) for the `richness` (`0–2`) axis. */
  richnessThresholds: number[];

  /**
   * Per-model `ensembleSize` bump. Keyed by model id; a key that is a prefix of
   * the model id also matches (e.g. `"claude-opus"` matches `"claude-opus-4-8"`),
   * with an exact id and then the longest prefix winning. This honors "model
   * tier climb" — the dedicated *timbre* layer for high-end models is CC-8.
   */
  modelBump: Record<string, number>;

  /** Hard cap on `ensembleSize`. */
  maxEnsemble: number;

  /** Hard cap on `richness`. */
  maxRichness: number;

  /**
   * Model id prefixes that get the high-end **timbre** signature (`timbre: 1`),
   * independent of token count (CC-8). Matched as prefixes, like {@link modelBump}.
   */
  highEndModels: string[];
}

/**
 * Default mapping. Tuned so the CC-2 example inputs land on distinct, sensible
 * tiers (see `test/mapToTier.test.ts`):
 * - 600 tokens  → ensembleSize 1 (Haiku) / 2 (Opus)
 * - 3000 tokens → ensembleSize 3 (Haiku) / 4 (Opus)
 * - near limit  → ensembleSize 5, richness 2
 */
export const DEFAULT_TIER_CONFIG: TierConfig = {
  tokenThresholds: [500, 1500, 3000, 6000, 12000],
  contextThresholds: [30, 50, 70, 85, 95],
  richnessThresholds: [50, 85],
  modelBump: { 'claude-opus': 1 },
  maxEnsemble: 5,
  maxRichness: 2,
  highEndModels: ['claude-opus'],
};

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Count how many thresholds `value` meets or exceeds (order-independent). */
function levelFor(value: number, thresholds: number[]): number {
  let level = 0;
  for (const threshold of thresholds) {
    if (value >= threshold) level++;
  }
  return level;
}

/** Resolve a model's ensemble bump: exact id match, then longest prefix match, else 0. */
function modelBumpFor(model: string | null, map: Record<string, number>): number {
  if (!model) return 0;
  const exact = map[model];
  if (typeof exact === 'number') return exact;

  let best = 0;
  let bestLen = -1;
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (typeof value === 'number' && key.length > bestLen && model.startsWith(key)) {
      best = value;
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Map a {@link Usage} snapshot to the musical {@link Tier} the daemon should
 * render. Pure — no I/O, no clock, no globals — so it is 100% unit-testable and
 * deterministic for a given `(usage, config)`.
 *
 * - `ensembleSize` = `max(tokenLevel, contextLevel) + modelBump`, clamped to
 *   `[0, maxEnsemble]`.
 * - `richness` = context-occupancy level, clamped to `[0, maxRichness]`.
 *
 * @param usage  Snapshot from {@link extractUsage} (CC-1).
 * @param config Optional overrides; each field falls back to {@link DEFAULT_TIER_CONFIG}.
 */
export function mapToTier(usage: Usage, config?: Partial<TierConfig>): Tier {
  const cfg: TierConfig = { ...DEFAULT_TIER_CONFIG, ...config };

  const tokenLevel = levelFor(usage.tokens, cfg.tokenThresholds);
  const contextLevel = levelFor(usage.contextPct, cfg.contextThresholds);
  const bump = modelBumpFor(usage.model, cfg.modelBump);

  const ensembleSize = clamp(Math.max(tokenLevel, contextLevel) + bump, 0, cfg.maxEnsemble);
  const richness = clamp(levelFor(usage.contextPct, cfg.richnessThresholds), 0, cfg.maxRichness);
  const timbre = isHighEndModel(usage.model, cfg.highEndModels) ? 1 : 0;

  return { ensembleSize, richness, timbre };
}

/** True when the model matches any high-end prefix — gets the timbre signature. */
function isHighEndModel(model: string | null, prefixes: string[]): boolean {
  if (!model) return false;
  return prefixes.some((prefix) => model.startsWith(prefix));
}
