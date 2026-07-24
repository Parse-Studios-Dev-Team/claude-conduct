import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierToGains, stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';

const gains = (ensembleSize: number, richness: number, timbre = 0): number[] =>
  tierToGains({ ensembleSize, richness, timbre });

test('the default layout expects 7 stems (5 base + pad + signature)', () => {
  assert.equal(stemCount(), 7);
  assert.equal(stemCount(DEFAULT_LAYOUT), 7);
});

test('silence: ensembleSize 0, richness 0, timbre 0 → all zero', () => {
  assert.deepEqual(gains(0, 0), [0, 0, 0, 0, 0, 0, 0]);
});

test('ensembleSize activates the first N base stems', () => {
  assert.deepEqual(gains(3, 0), [1, 1, 1, 0, 0, 0, 0]);
});

test('full ensemble with max richness (standard model) → pad on, signature off', () => {
  assert.deepEqual(gains(5, 2), [1, 1, 1, 1, 1, 1.0, 0]);
});

test('richness drives the pad stem: 0 → off, 1 → 0.6, 2 → 1.0', () => {
  assert.equal(gains(0, 0)[5], 0);
  assert.equal(gains(0, 1)[5], 0.6);
  assert.equal(gains(0, 2)[5], 1.0);
});

test('timbre drives the signature stem (CC-8): high-end model adds it at any size', () => {
  assert.equal(gains(0, 0, 1)[6], 0.7); // signature on even at silence-size
  assert.equal(gains(5, 2, 1)[6], 0.7);
  assert.equal(gains(5, 2, 0)[6], 0); // standard model: no signature
});

test('ensembleSize and richness are clamped into range', () => {
  assert.deepEqual(gains(99, 0), [1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual(gains(0, 99), [0, 0, 0, 0, 0, 1.0, 0]);
});

test('negative inputs clamp to the floor', () => {
  assert.deepEqual(gains(-5, -5, -1), [0, 0, 0, 0, 0, 0, 0]);
});

test('a missing timbre is treated as 0 (no signature)', () => {
  assert.equal(tierToGains({ ensembleSize: 1, richness: 0 })[6], 0);
});

test('a custom layout is honored', () => {
  const layout = { baseStems: 3, richnessGains: [0, 0.5], timbreGain: 0.9 };
  assert.equal(stemCount(layout), 5); // 3 base + pad + signature
  assert.deepEqual(tierToGains({ ensembleSize: 2, richness: 1 }, layout), [1, 1, 0, 0.5, 0]);
  assert.deepEqual(tierToGains({ ensembleSize: 2, richness: 1, timbre: 1 }, layout), [1, 1, 0, 0.5, 0.9]);
});
