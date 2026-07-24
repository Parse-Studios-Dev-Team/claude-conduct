import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeCommand, parseCommand } from '../src/daemon/command';

test('serialize → parse round-trips the tier', () => {
  const tier = { ensembleSize: 3, richness: 1 };
  assert.deepEqual(parseCommand(serializeCommand(tier)), tier);
});

test('serialized payload carries the timestamp so repeated tiers still change the file', () => {
  const a = serializeCommand({ ensembleSize: 2, richness: 0 }, 111);
  const b = serializeCommand({ ensembleSize: 2, richness: 0 }, 222);
  assert.notEqual(a, b);
  assert.match(a, /111/);
});

test('parseCommand rejects malformed input', () => {
  assert.equal(parseCommand('{ not json'), null);
  assert.equal(parseCommand('42'), null);
  assert.equal(parseCommand('{}'), null);
  assert.equal(parseCommand(JSON.stringify({ tier: {} })), null);
  assert.equal(parseCommand(JSON.stringify({ tier: { ensembleSize: 'x', richness: 1 } })), null);
  assert.equal(parseCommand(JSON.stringify({ tier: { ensembleSize: 1 } })), null);
});

test('parseCommand ignores extra fields', () => {
  const text = JSON.stringify({ tier: { ensembleSize: 4, richness: 2 }, ts: 1, extra: 'ok' });
  assert.deepEqual(parseCommand(text), { ensembleSize: 4, richness: 2 });
});
