import type { Tier } from '../types';

/**
 * How a {@link Tier} maps onto stems. The default matches CC-4's example set —
 * five progressive "ensemble" layers (piano → strings → woodwinds → brass →
 * percussion) plus one richness/pad layer (choir/pad).
 */
export interface StemLayout {
  /** Progressive base stems driven by `ensembleSize`: the first `ensembleSize` are on. */
  baseStems: number;
  /** Gain for the richness/pad stem at `richness` 0, 1, 2, … (index = richness). */
  richnessGains: number[];
  /** Gain for the model-timbre signature stem when the tier's `timbre >= 1` (CC-8). */
  timbreGain: number;
}

export const DEFAULT_LAYOUT: StemLayout = {
  baseStems: 5,
  richnessGains: [0, 0.6, 1.0],
  timbreGain: 0.7,
};

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  return n < min ? min : n > max ? max : n;
}

/** Total stems a layout expects: base layers + one richness/pad + one timbre signature. */
export function stemCount(layout: StemLayout = DEFAULT_LAYOUT): number {
  return Math.max(0, Math.round(layout.baseStems)) + 2;
}

/**
 * Map a {@link Tier} to per-stem target gains for {@link Mixer.setTargets}. Pure.
 *
 * - Base stems `0..baseStems-1`: gain `1` while their index `< ensembleSize`, else `0`.
 * - The pad stem: `richnessGains[richness]` (clamped into range).
 * - The signature stem: `timbreGain` when `timbre >= 1`, else `0` (CC-8).
 *
 * So `{ensembleSize:0, richness:0}` is silence and `{ensembleSize:5, richness:2,
 * timbre:1}` is the full ensemble with pad and the high-end signature.
 */
export function tierToGains(tier: Tier, layout: StemLayout = DEFAULT_LAYOUT): number[] {
  const base = Math.max(0, Math.round(layout.baseStems));
  const ensemble = clampInt(tier.ensembleSize, 0, base);

  const gains: number[] = new Array(base + 2);
  for (let i = 0; i < base; i++) {
    gains[i] = i < ensemble ? 1 : 0;
  }

  const richnessGains = layout.richnessGains.length > 0 ? layout.richnessGains : [0];
  const richnessIndex = clampInt(tier.richness, 0, richnessGains.length - 1);
  gains[base] = richnessGains[richnessIndex] ?? 0;

  const timbre = clampInt(tier.timbre ?? 0, 0, 1);
  gains[base + 1] = timbre >= 1 ? layout.timbreGain : 0;

  return gains;
}
