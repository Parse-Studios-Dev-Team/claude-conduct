import type { Effort } from './types';

/**
 * What the radio needs to know about models: how big each one's context window
 * is (for the sky's time of day), and which reasoning efforts a transcript can
 * record. Node-free.
 */

/**
 * Fallback window for a model we don't recognize. Deliberately small: guessing
 * low overstates context, which moves the sky on rather than leaving it at dawn.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Known context windows, matched by model-id prefix (longest wins). Every
 * current frontier model is 1M; Haiku is the one still at 200k. A 200k blanket
 * default once inflated context 5× on frontier models, so these matter.
 */
export const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable': 1_000_000,
  'claude-mythos': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

/** Longest-prefix (or exact) lookup of `model` in a window table. */
function lookupWindow(model: string, table: Record<string, number>): number | null {
  const exact = table[model];
  if (typeof exact === 'number') return exact;
  let best: number | null = null;
  let bestLength = -1;
  for (const [key, value] of Object.entries(table)) {
    if (key.length > bestLength && model.startsWith(key)) {
      best = value;
      bestLength = key.length;
    }
  }
  return best;
}

/** A model's context window in tokens: overrides first, then what we know, then the fallback. */
export function resolveContextWindow(model: string | null, overrides?: Record<string, number>): number {
  if (model) {
    const configured = overrides ? lookupWindow(model, overrides) : null;
    if (configured !== null) return configured;
    const known = lookupWindow(model, KNOWN_CONTEXT_WINDOWS);
    if (known !== null) return known;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

const EFFORTS = new Set<string>(['high', 'max', 'xhigh']);

/** A transcript's top-level `.effort`, or `null` for anything unrecognized. */
export const asEffort = (value: unknown): Effort | null =>
  typeof value === 'string' && EFFORTS.has(value) ? (value as Effort) : null;
