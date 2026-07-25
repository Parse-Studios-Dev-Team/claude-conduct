import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Usage } from '../src/types';
import { mapToTier, DEFAULT_TIER_CONFIG } from '../src/mapToTier';

const usage = (over: Partial<Usage> = {}): Usage => ({
  tokens: 0,
  contextPct: 0,
  model: null,
  ...over,
});

// --- Documented example inputs (the CC-2 acceptance criterion) --------------

test('600 tokens → a light ensemble; Opus sounds fuller than Haiku', () => {
  const light = { tokens: 600, contextPct: 5 };
  assert.deepEqual(
    mapToTier(usage({ ...light, model: 'claude-haiku-4-5-20251001' })),
    { ensembleSize: 1, richness: 0, timbre: 0 },
  );
  assert.deepEqual(
    mapToTier(usage({ ...light, model: 'claude-opus-4-8' })),
    { ensembleSize: 2, richness: 0, timbre: 1 }, // +1 model bump, high-end signature
  );
});

test('3000 tokens → a larger ensemble; Opus still one above Haiku', () => {
  const heavy = { tokens: 3000, contextPct: 20 };
  assert.deepEqual(
    mapToTier(usage({ ...heavy, model: 'claude-haiku-4-5-20251001' })),
    { ensembleSize: 3, richness: 0, timbre: 0 },
  );
  assert.deepEqual(
    mapToTier(usage({ ...heavy, model: 'claude-opus-4-8' })),
    { ensembleSize: 4, richness: 0, timbre: 1 },
  );
});

test('near the context limit → full ensemble + max richness, even after a tiny turn', () => {
  // Only ~300 tokens in the latest turn, but the window is 97% full.
  const nearLimit = { tokens: 300, contextPct: 97 };
  assert.deepEqual(
    mapToTier(usage({ ...nearLimit, model: 'claude-opus-4-8' })),
    { ensembleSize: 5, richness: 2, timbre: 1 }, // context level 5 dominates the tiny token level
  );
  // At the ceiling the model bump is clamped away, but Haiku still lacks the signature.
  assert.deepEqual(
    mapToTier(usage({ ...nearLimit, model: 'claude-haiku-4-5-20251001' })),
    { ensembleSize: 5, richness: 2, timbre: 0 },
  );
});

test('Opus vs Haiku differ at identical usage (when not clamped)', () => {
  const same = { tokens: 700, contextPct: 10 };
  const opus = mapToTier(usage({ ...same, model: 'claude-opus-4-8' }));
  const haiku = mapToTier(usage({ ...same, model: 'claude-haiku-4-5-20251001' }));
  assert.ok(opus.ensembleSize > haiku.ensembleSize);
});

// --- Bounds & clamping ------------------------------------------------------

test('a fresh session (all zero, null model) → the silent tier', () => {
  assert.deepEqual(mapToTier(usage()), { ensembleSize: 0, richness: 0, timbre: 0 });
});

test('timbre signature (CC-8): high-end models get timbre 1, others 0', () => {
  const same = { tokens: 700, contextPct: 10 };
  assert.equal(mapToTier(usage({ ...same, model: 'claude-opus-4-8' })).timbre, 1);
  assert.equal(mapToTier(usage({ ...same, model: 'claude-sonnet-5' })).timbre, 0);
  assert.equal(mapToTier(usage({ ...same, model: 'claude-haiku-4-5-20251001' })).timbre, 0);
  assert.equal(mapToTier(usage({ ...same, model: null })).timbre, 0);
});

test('timbre is independent of token count and configurable via highEndModels', () => {
  // Tiny turn, standard model bumped to high-end via config.
  const t = mapToTier(usage({ tokens: 10, contextPct: 1, model: 'claude-sonnet-5' }), {
    highEndModels: ['claude-sonnet'],
  });
  assert.equal(t.timbre, 1);
  // And opus is no longer high-end under this override.
  assert.equal(
    mapToTier(usage({ tokens: 10, contextPct: 1, model: 'claude-opus-4-8' }), {
      highEndModels: ['claude-sonnet'],
    }).timbre,
    0,
  );
});

test('ensembleSize is clamped to maxEnsemble even with model bump', () => {
  const t = mapToTier(usage({ tokens: 999_999, contextPct: 100, model: 'claude-opus-4-8' }));
  assert.equal(t.ensembleSize, 5); // 5 (maxed levels) + 1 bump → clamped to 5
  assert.equal(t.richness, 2);
});

test('negative / garbage numbers clamp to the floor, never NaN', () => {
  const t = mapToTier(usage({ tokens: -100, contextPct: -5, model: 'claude-opus-4-8' }));
  assert.equal(t.ensembleSize, 1); // max(0,0) + 1 bump
  assert.equal(t.richness, 0);
  assert.ok(Number.isFinite(t.ensembleSize) && Number.isFinite(t.richness));
});

// --- Threshold boundaries (>= is inclusive) ---------------------------------

test('token threshold boundary is inclusive', () => {
  assert.equal(mapToTier(usage({ tokens: 499 })).ensembleSize, 0);
  assert.equal(mapToTier(usage({ tokens: 500 })).ensembleSize, 1);
});

test('context threshold boundary is inclusive for both ensemble and richness', () => {
  assert.equal(mapToTier(usage({ contextPct: 29.99 })).ensembleSize, 0);
  assert.equal(mapToTier(usage({ contextPct: 30 })).ensembleSize, 1);
  assert.equal(mapToTier(usage({ contextPct: 49.99 })).richness, 0);
  assert.equal(mapToTier(usage({ contextPct: 50 })).richness, 1);
});

// --- Configurability (the "not hardcoded" acceptance criterion) -------------

test('custom tokenThresholds change the outcome', () => {
  // Default: 600 tokens → level 1. Raise the bar past 600 → level 0.
  assert.equal(
    mapToTier(usage({ tokens: 600 }), { tokenThresholds: [1000] }).ensembleSize,
    0,
  );
});

test('custom richnessThresholds change the outcome', () => {
  // Default: 60% → richness 1. Require 90% → richness 0.
  assert.equal(mapToTier(usage({ contextPct: 60 })).richness, 1);
  assert.equal(mapToTier(usage({ contextPct: 60 }), { richnessThresholds: [90] }).richness, 0);
});

test('custom modelBump and caps are honored', () => {
  const t = mapToTier(usage({ tokens: 600, model: 'claude-haiku-4-5-20251001' }), {
    modelBump: { 'claude-haiku': 2 },
    maxEnsemble: 10,
  });
  assert.equal(t.ensembleSize, 3); // level 1 + custom bump 2
});

// --- Model matching ---------------------------------------------------------

test('model bump matches by prefix, with the longest prefix winning', () => {
  const cfg = { modelBump: { claude: 0, 'claude-opus': 1 } };
  assert.equal(mapToTier(usage({ tokens: 600, model: 'claude-opus-4-8' }), cfg).ensembleSize, 2);
});

test('an exact model id beats a prefix entry', () => {
  const cfg = { modelBump: { 'claude-opus': 1, 'claude-opus-4-8': 3 } };
  const t = mapToTier(usage({ tokens: 600, model: 'claude-opus-4-8' }), cfg);
  assert.equal(t.ensembleSize, 4); // level 1 + exact bump 3
});

test('an unknown / null model contributes no bump', () => {
  assert.equal(mapToTier(usage({ tokens: 600, model: 'some-other-model' })).ensembleSize, 1);
  assert.equal(mapToTier(usage({ tokens: 600, model: null })).ensembleSize, 1);
});

// --- Purity -----------------------------------------------------------------

test('mapToTier is pure: same input → same output, and it mutates nothing', () => {
  const input = usage({ tokens: 3000, contextPct: 60, model: 'claude-opus-4-8' });
  const inputCopy = { ...input };
  const cfg = { tokenThresholds: [1000, 2000] };
  const cfgTokens = [...cfg.tokenThresholds];

  const a = mapToTier(input, cfg);
  const b = mapToTier(input, cfg);

  assert.deepEqual(a, b);
  assert.deepEqual(input, inputCopy); // input untouched
  assert.deepEqual(cfg.tokenThresholds, cfgTokens); // config untouched
  assert.deepEqual(DEFAULT_TIER_CONFIG.tokenThresholds, [500, 1500, 3000, 6000, 12000]); // default untouched
});
