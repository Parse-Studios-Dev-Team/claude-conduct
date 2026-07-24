import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tier } from '../src/types';
import {
  recordTier,
  clearSession,
  readState,
  writeState,
  shouldEmit,
  tiersEqual,
  STATE_VERSION,
  type ConductState,
} from '../src/state';

const tier = (ensembleSize: number, richness: number): Tier => ({ ensembleSize, richness });

/** Run a test body with a private temp dir that's always cleaned up. */
function withTmp(fn: (statePath: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-state-'));
  try {
    fn(join(dir, '.claude', 'conduct-state.json'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Pure helpers -----------------------------------------------------------

test('shouldEmit: a new session (null previous) always emits', () => {
  assert.equal(shouldEmit(null, tier(0, 0)), true);
});

test('shouldEmit: same tier does not emit, changed tier emits', () => {
  assert.equal(shouldEmit(tier(3, 1), tier(3, 1)), false);
  assert.equal(shouldEmit(tier(3, 1), tier(4, 1)), true);
  assert.equal(shouldEmit(tier(3, 1), tier(3, 2)), true);
});

test('tiersEqual compares both axes', () => {
  assert.equal(tiersEqual(tier(2, 1), tier(2, 1)), true);
  assert.equal(tiersEqual(tier(2, 1), tier(2, 0)), false);
});

// --- Acceptance criteria ----------------------------------------------------

test('first call for a new session always emits, and persists the tier', () => {
  withTmp((statePath) => {
    const r = recordTier(statePath, 'sess-A', tier(2, 1));
    assert.equal(r.emit, true);
    assert.equal(r.previous, null);
    assert.ok(existsSync(statePath), 'state file should be created');
    assert.deepEqual(readState(statePath).sessions['sess-A']?.tier, tier(2, 1));
  });
});

test('repeated calls at the same tier emit nothing (and do not rewrite the file)', () => {
  withTmp((statePath) => {
    const first = recordTier(statePath, 'sess-A', tier(2, 1), { now: () => 1000 });
    assert.equal(first.emit, true);
    const stampAfterFirst = readState(statePath).sessions['sess-A']?.updatedAt;

    const second = recordTier(statePath, 'sess-A', tier(2, 1), { now: () => 5000 });
    assert.equal(second.emit, false);
    assert.deepEqual(second.previous, tier(2, 1));

    // Unchanged tier ⇒ no rewrite ⇒ the timestamp from the first emit is preserved.
    assert.equal(readState(statePath).sessions['sess-A']?.updatedAt, stampAfterFirst);
  });
});

test('a changed tier emits and reports the previous tier', () => {
  withTmp((statePath) => {
    recordTier(statePath, 'sess-A', tier(1, 0));
    const r = recordTier(statePath, 'sess-A', tier(3, 2));
    assert.equal(r.emit, true);
    assert.deepEqual(r.previous, tier(1, 0));
    assert.deepEqual(readState(statePath).sessions['sess-A']?.tier, tier(3, 2));
  });
});

test('state is scoped per session_id — sessions do not interfere', () => {
  withTmp((statePath) => {
    assert.equal(recordTier(statePath, 'sess-A', tier(2, 1)).emit, true);
    // A brand-new session B emits even though A already sits at the same tier.
    assert.equal(recordTier(statePath, 'sess-B', tier(2, 1)).emit, true);
    // A repeat at A's tier still doesn't emit.
    assert.equal(recordTier(statePath, 'sess-A', tier(2, 1)).emit, false);

    const state = readState(statePath);
    assert.deepEqual(Object.keys(state.sessions).sort(), ['sess-A', 'sess-B']);
  });
});

test('clearSession removes only that session (SessionEnd cleanup)', () => {
  withTmp((statePath) => {
    recordTier(statePath, 'sess-A', tier(2, 1));
    recordTier(statePath, 'sess-B', tier(4, 2));

    clearSession(statePath, 'sess-A');

    const state = readState(statePath);
    assert.deepEqual(Object.keys(state.sessions), ['sess-B']);
  });
});

test('clearSession on an unknown session is a no-op and does not throw', () => {
  withTmp((statePath) => {
    recordTier(statePath, 'sess-A', tier(2, 1));
    assert.doesNotThrow(() => clearSession(statePath, 'sess-missing'));
    assert.deepEqual(Object.keys(readState(statePath).sessions), ['sess-A']);
  });
});

// --- Persistence robustness -------------------------------------------------

test('readState returns an empty state for a missing file', () => {
  withTmp((statePath) => {
    assert.deepEqual(readState(statePath), { version: STATE_VERSION, sessions: {} });
  });
});

test('readState tolerates corrupt JSON and a version mismatch', () => {
  withTmp((statePath) => {
    writeState(statePath, { version: STATE_VERSION, sessions: {} }); // creates the dir
    writeFileSync(statePath, '{ this is not json', 'utf8');
    assert.deepEqual(readState(statePath).sessions, {});

    writeFileSync(statePath, JSON.stringify({ version: 999, sessions: { x: 1 } }), 'utf8');
    assert.deepEqual(readState(statePath).sessions, {});
  });
});

test('writeState creates the parent .claude directory and round-trips', () => {
  withTmp((statePath) => {
    const doc: ConductState = {
      version: STATE_VERSION,
      sessions: { s: { tier: tier(1, 1), updatedAt: '2026-07-24T00:00:00.000Z' } },
    };
    writeState(statePath, doc);
    assert.ok(existsSync(statePath));
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sessions.s.tier.ensembleSize, 1);
  });
});

test('recordTier never throws even when the state path is unwritable', () => {
  withTmp((_statePath, dir) => {
    // Make a FILE inside the (existing) temp dir, then point the state path at a
    // location *underneath* that file, so mkdir/write fails (ENOTDIR).
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'x', 'utf8');
    const impossible = join(blocker, 'nested', 'state.json');

    let result;
    assert.doesNotThrow(() => {
      result = recordTier(impossible, 'sess-A', tier(2, 1));
    });
    // The emit decision is still correct despite the failed persist.
    assert.equal(result!.emit, true);
  });
});

// --- Defensive GC of stale sessions -----------------------------------------

test('maxSessionAgeMs prunes other stale sessions but keeps the active one', () => {
  withTmp((statePath) => {
    const day = 24 * 60 * 60 * 1000;
    // Seed an old session directly.
    writeState(statePath, {
      version: STATE_VERSION,
      sessions: {
        old: { tier: tier(1, 0), updatedAt: new Date(0).toISOString() },
      },
    });

    const now = day * 3; // 3 days after epoch
    const r = recordTier(statePath, 'fresh', tier(2, 1), { maxSessionAgeMs: day, now: () => now });
    assert.equal(r.emit, true);

    const sessions = readState(statePath).sessions;
    assert.deepEqual(Object.keys(sessions), ['fresh'], 'the >1-day-old session should be pruned');
  });
});
