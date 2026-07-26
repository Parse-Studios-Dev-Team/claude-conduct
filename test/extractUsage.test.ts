import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractUsage,
  extractUsageFromString,
  DEFAULT_CONTEXT_WINDOW,
  KNOWN_CONTEXT_WINDOWS,
} from '../src/extractUsage';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', name);

const EPS = 1e-6;
const pct = (totalInput: number, window = DEFAULT_CONTEXT_WINDOW): number =>
  (totalInput / window) * 100;

// --- The three required size fixtures (small / medium / large) --------------

test('small transcript: a single light turn', () => {
  const u = extractUsage(fixture('small.jsonl'));
  assert.equal(u.tokens, 600); // input 5 + output 595 — matches the CC-2 "600 tokens" example
  assert.equal(u.model, 'claude-haiku-4-5-20251001');
  assert.ok(Math.abs(u.contextPct - pct(2005)) < EPS); // (5 + 0 + 2000) / 200k ≈ 1.0025%
});

test('medium transcript: reads the LAST assistant turn, skipping the trailing title and a usage-less remnant', () => {
  const u = extractUsage(fixture('medium.jsonl'));
  assert.equal(u.tokens, 5000); // input 10 + output 2990 + cache_creation 2000
  assert.equal(u.model, 'claude-sonnet-5');
  assert.ok(Math.abs(u.contextPct - pct(50010, 1_000_000)) < EPS); // sonnet-5 is a 1M window ≈ 5.001%
});

test('large transcript: a heavy turn on a 1M-window model', () => {
  const u = extractUsage(fixture('large.jsonl'));
  assert.equal(u.tokens, 6502); // input 2 + output 1500 + cache_creation 5000
  assert.equal(u.model, 'claude-opus-4-8');
  assert.ok(Math.abs(u.contextPct - pct(195002, 1_000_000)) < EPS); // opus-4-8 is a 1M window ≈ 19.5%
  assert.ok(u.contextPct > 19 && u.contextPct < 20);
});

// --- Cached turns -----------------------------------------------------------

test('cache_creation counts as work done this turn; cache_read does not', () => {
  // A warm-cache turn: input_tokens collapses to ~2 and the real input arrives
  // as cache_creation. Counting only input+output would read this as 132 tokens.
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        output_tokens: 130,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 50_000,
      },
    },
  });

  const u = extractUsageFromString(line);
  assert.equal(u.tokens, 4132); // 2 + 130 + 4000, and *not* the 50k cache read
  assert.ok(Math.abs(u.contextPct - pct(54_002, 1_000_000)) < EPS); // context still sees all of it
});

// --- Required edge case: zero assistant turns -------------------------------

test('empty transcript (zero assistant turns) → zeros and null model, no crash', () => {
  const u = extractUsage(fixture('empty.jsonl'));
  assert.deepEqual(u, { tokens: 0, contextPct: 0, model: null });
});

// --- Robustness -------------------------------------------------------------

test('malformed / non-JSON lines are skipped, valid turn still found', () => {
  const u = extractUsage(fixture('malformed.jsonl'));
  assert.equal(u.tokens, 300); // input 3 + output 297
  assert.equal(u.model, 'claude-opus-4-8');
  assert.ok(Math.abs(u.contextPct - pct(1002, 1_000_000)) < EPS); // (3 + 0 + 999) / 1M ≈ 0.1002%
});

test('sub-agent (sidechain) turns are ignored in favor of the main thread', () => {
  const u = extractUsage(fixture('sidechain.jsonl'));
  assert.equal(u.tokens, 500); // the 500-token main turn, NOT the 5002-token subagent turn
  assert.equal(u.model, 'claude-opus-4-8');
});

test('a missing file returns the empty snapshot instead of throwing', () => {
  const u = extractUsage(fixture('does-not-exist.jsonl'));
  assert.deepEqual(u, { tokens: 0, contextPct: 0, model: null });
});

test('a completely empty string returns the empty snapshot', () => {
  assert.deepEqual(extractUsageFromString(''), {
    tokens: 0,
    contextPct: 0,
    model: null,
  });
});

// --- contextPct math: clamping and per-model overrides ----------------------

test('contextPct clamps to 100 when occupancy exceeds the window', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      // An unknown model, so `defaultContextWindow` applies — a known model's
      // real window rightly beats the caller's generic default.
      model: 'some-tiny-window-model',
      usage: { input_tokens: 5, output_tokens: 595, cache_read_input_tokens: 2000 },
    },
  });
  const u = extractUsageFromString(line, { defaultContextWindow: 1000 });
  assert.equal(u.contextPct, 100); // 2005 / 1000 → clamped
  assert.equal(u.tokens, 600);
});

test('per-model context window override (exact model id match)', () => {
  const u = extractUsage(fixture('large.jsonl'), {
    contextWindows: { 'claude-opus-4-8': 1_000_000 },
  });
  assert.ok(Math.abs(u.contextPct - pct(195002, 1_000_000)) < EPS); // ≈ 19.5%
});

test('per-model context window override (prefix match)', () => {
  const u = extractUsage(fixture('large.jsonl'), {
    contextWindows: { 'claude-opus': 500_000 },
  });
  assert.ok(Math.abs(u.contextPct - pct(195002, 500_000)) < EPS); // ≈ 39%
});

test('missing usage fields are treated as zero (no NaN); output_tokens do not count toward contextPct', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-4-8', usage: { input_tokens: 42 } },
  });
  const u = extractUsageFromString(line);
  assert.equal(u.tokens, 42); // input 42 + missing output (0)
  assert.ok(Math.abs(u.contextPct - pct(42, 1_000_000)) < EPS); // only input contributes to occupancy
  assert.ok(Number.isFinite(u.contextPct));
});

test('DEFAULT_CONTEXT_WINDOW is exported for downstream (CC-2) reuse', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 200_000);
});

test('current frontier models resolve to their real 1M window, not the 200k fallback', () => {
  const heavy = (model: string): number =>
    extractUsageFromString(
      JSON.stringify({
        type: 'assistant',
        message: { model, usage: { input_tokens: 100_000 } },
      }),
    ).contextPct;

  // 100k of a 1M window is 10%; against the old 200k blanket default it read 50%.
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8']) {
    assert.ok(Math.abs(heavy(model) - 10) < EPS, `${model} should be a 1M window`);
  }

  // Haiku really is 200k.
  assert.ok(Math.abs(heavy('claude-haiku-4-5-20251001') - 50) < EPS);

  // An unknown model falls back conservatively.
  assert.ok(Math.abs(heavy('some-future-model') - 50) < EPS);
});

test('config contextWindows still overrides the built-in table', () => {
  const u = extractUsageFromString(
    JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { input_tokens: 100_000 } },
    }),
    { contextWindows: { 'claude-opus-5': 200_000 } },
  );
  assert.ok(Math.abs(u.contextPct - 50) < EPS);
  assert.equal(KNOWN_CONTEXT_WINDOWS['claude-opus-5'], 1_000_000); // table untouched
});
