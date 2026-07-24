import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeCommand, parseCommand } from '../src/daemon/command';

test('serialize → parse round-trips a tier command', () => {
  const tier = { ensembleSize: 3, richness: 1 };
  assert.deepEqual(parseCommand(serializeCommand({ tier })), { tier });
});

test('serialize → parse round-trips a volume command', () => {
  assert.deepEqual(parseCommand(serializeCommand({ volume: 0.5 })), { volume: 0.5 });
});

test('a tier command round-trips its timbre (CC-8)', () => {
  const tier = { ensembleSize: 3, richness: 1, timbre: 1 };
  assert.deepEqual(parseCommand(serializeCommand({ tier })), { tier });
});

test('a command can carry both tier and volume', () => {
  const cmd = { tier: { ensembleSize: 2, richness: 1 }, volume: 0.3 };
  assert.deepEqual(parseCommand(serializeCommand(cmd)), cmd);
});

test('volume is clamped to [0,1]', () => {
  assert.deepEqual(parseCommand(serializeCommand({ volume: 5 })), { volume: 1 });
  assert.deepEqual(parseCommand(serializeCommand({ volume: -2 })), { volume: 0 });
});

test('serialized payload carries the timestamp so repeats still change the file', () => {
  const a = serializeCommand({ tier: { ensembleSize: 2, richness: 0 } }, 111);
  const b = serializeCommand({ tier: { ensembleSize: 2, richness: 0 } }, 222);
  assert.notEqual(a, b);
  assert.match(a, /111/);
});

test('parseCommand returns null when nothing valid is present', () => {
  assert.equal(parseCommand('{ not json'), null);
  assert.equal(parseCommand('42'), null);
  assert.equal(parseCommand('{}'), null);
  assert.equal(parseCommand(JSON.stringify({ tier: {} })), null);
  assert.equal(parseCommand(JSON.stringify({ tier: { ensembleSize: 'x', richness: 1 } })), null);
  assert.equal(parseCommand(JSON.stringify({ tier: { ensembleSize: 1 } })), null); // missing richness
  assert.equal(parseCommand(JSON.stringify({ volume: 'loud' })), null);
});

test('parseCommand ignores unrelated extra fields', () => {
  const text = JSON.stringify({ tier: { ensembleSize: 4, richness: 2 }, ts: 1, extra: 'ok' });
  assert.deepEqual(parseCommand(text), { tier: { ensembleSize: 4, richness: 2 } });
});
