import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierToGains, stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';

const gains = (ensembleSize: number, richness: number): number[] =>
  tierToGains({ ensembleSize, richness });

test('the default layout expects 6 stems (5 base + 1 pad)', () => {
  assert.equal(stemCount(), 6);
  assert.equal(stemCount(DEFAULT_LAYOUT), 6);
});

test('silence: ensembleSize 0, richness 0 → all zero', () => {
  assert.deepEqual(gains(0, 0), [0, 0, 0, 0, 0, 0]);
});

test('ensembleSize activates the first N base stems', () => {
  assert.deepEqual(gains(3, 0), [1, 1, 1, 0, 0, 0]);
});

test('full ensemble with max richness → everything on, pad at full', () => {
  assert.deepEqual(gains(5, 2), [1, 1, 1, 1, 1, 1.0]);
});

test('richness drives the pad stem: 0 → off, 1 → 0.6, 2 → 1.0', () => {
  assert.equal(gains(0, 0)[5], 0);
  assert.equal(gains(0, 1)[5], 0.6);
  assert.equal(gains(0, 2)[5], 1.0);
});

test('ensembleSize and richness are clamped into range', () => {
  assert.deepEqual(gains(99, 0), [1, 1, 1, 1, 1, 0]); // capped at 5 base stems
  assert.deepEqual(gains(0, 99), [0, 0, 0, 0, 0, 1.0]); // capped at richnessGains[2]
});

test('negative inputs clamp to the floor', () => {
  assert.deepEqual(gains(-5, -5), [0, 0, 0, 0, 0, 0]);
});

test('a custom layout is honored', () => {
  const layout = { baseStems: 3, richnessGains: [0, 0.5] };
  assert.equal(stemCount(layout), 4);
  assert.deepEqual(tierToGains({ ensembleSize: 2, richness: 1 }, layout), [1, 1, 0, 0.5]);
});
