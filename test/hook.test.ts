import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';
import { handleEvent, type HandlerDeps, type HookInput } from '../src/hook/handler';
import { extractUsage } from '../src/extractUsage';
import { recordTier, clearSession, readState } from '../src/state';
import { sendTier } from '../src/daemon/client';
import { mapToTier } from '../src/mapToTier';
import {
  recordTurn,
  finalizeRecording,
  pruneRecordings,
  readRecording,
  listRecordings,
  recordingPath,
  parseRecording,
  summarize,
  packTier,
  unpackTier,
} from '../src/recorder';
import { encodeTurn } from '../src/recordingFormat';
import { parseCommand } from '../src/daemon/command';
import type { Usage, Tier } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', name);

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-hook-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- config -----------------------------------------------------------------

test('loadConfig returns defaults for a missing file', () => {
  withTmpDir((dir) => {
    assert.deepEqual(loadConfig(join(dir, 'nope.json')), DEFAULT_CONFIG);
  });
});

test('loadConfig returns defaults for corrupt JSON', () => {
  withTmpDir((dir) => {
    const p = join(dir, 'conduct.config.json');
    writeFileSync(p, '{ not json', 'utf8');
    assert.deepEqual(loadConfig(p), DEFAULT_CONFIG);
  });
});

test('loadConfig merges partial overrides and clamps volume', () => {
  withTmpDir((dir) => {
    const p = join(dir, 'conduct.config.json');
    writeFileSync(p, JSON.stringify({ mute: true, volume: 5, tier: { tokenThresholds: [10] } }), 'utf8');
    const cfg = loadConfig(p);
    assert.equal(cfg.mute, true);
    assert.equal(cfg.volume, 1); // clamped from 5
    assert.deepEqual(cfg.tier, { tokenThresholds: [10] });
    assert.equal(cfg.crossfadeMs, DEFAULT_CONFIG.crossfadeMs); // untouched
  });
});

// --- paths ------------------------------------------------------------------

test('resolvePaths anchors runtime files under .claude and config at the root', () => {
  const p = resolvePaths('/proj');
  assert.equal(p.statePath, '/proj/.claude/conduct-state.json');
  assert.equal(p.commandPath, '/proj/.claude/conduct-command.json');
  assert.equal(p.pidPath, '/proj/.claude/conduct.pid');
  assert.equal(p.configPath, '/proj/conduct.config.json');
});

test('CONDUCT_CONFIG overrides the config path', () => {
  const prev = process.env.CONDUCT_CONFIG;
  process.env.CONDUCT_CONFIG = '/custom/conf.json';
  try {
    assert.equal(resolvePaths('/proj').configPath, '/custom/conf.json');
  } finally {
    if (prev === undefined) delete process.env.CONDUCT_CONFIG;
    else process.env.CONDUCT_CONFIG = prev;
  }
});

// --- handler (stubbed deps) -------------------------------------------------

interface Calls {
  startDaemon: number;
  stopDaemon: number;
  clearSession: string[];
  sendTier: Array<{ path: string; tier: { ensembleSize: number; richness: number } }>;
  extractUsage: number;
  recordTurn: Array<{ dir: string; sessionId: string; tier: Tier }>;
  finalize: string[];
  prune: number[];
}

function stubDeps(usage: Usage, emit: boolean): { deps: HandlerDeps; calls: Calls } {
  const calls: Calls = {
    startDaemon: 0,
    stopDaemon: 0,
    clearSession: [],
    sendTier: [],
    extractUsage: 0,
    recordTurn: [],
    finalize: [],
    prune: [],
  };
  const deps: HandlerDeps = {
    extractUsage: () => {
      calls.extractUsage++;
      return usage;
    },
    recordTier: (_sp, _sid, tier) => ({ emit, tier, previous: null }),
    clearSession: (_sp, sid) => {
      calls.clearSession.push(sid);
    },
    sendTier: (path, tier) => {
      calls.sendTier.push({ path, tier });
    },
    startDaemon: () => {
      calls.startDaemon++;
    },
    stopDaemon: () => {
      calls.stopDaemon++;
    },
    recordTurn: (dir, sessionId, _usage, tier) => {
      calls.recordTurn.push({ dir, sessionId, tier });
    },
    finalizeRecording: (_dir, sessionId) => {
      calls.finalize.push(sessionId);
    },
    pruneRecordings: (_dir, keep) => {
      calls.prune.push(keep);
    },
  };
  return { deps, calls };
}

const paths = resolvePaths('/proj');

test('SessionStart does NOT start the daemon — playback is opt-in per session', () => {
  const { deps, calls } = stubDeps({ tokens: 0, contextPct: 0, model: null }, true);
  const result = handleEvent({ hook_event_name: 'SessionStart' }, DEFAULT_CONFIG, paths, deps);
  assert.equal(result.action, 'noop');
  assert.equal(calls.startDaemon, 0, 'starting is the job of `/conduct start`');
});

test('SessionEnd stops the daemon and clears the session', () => {
  const { deps, calls } = stubDeps({ tokens: 0, contextPct: 0, model: null }, true);
  const result = handleEvent(
    { hook_event_name: 'SessionEnd', session_id: 'abc' },
    DEFAULT_CONFIG,
    paths,
    deps,
  );
  assert.equal(result.action, 'stop');
  assert.equal(calls.stopDaemon, 1);
  assert.deepEqual(calls.clearSession, ['abc']);
});

test('PostToolUse maps usage → tier and sends it when the tier changed', () => {
  const usage: Usage = { tokens: 3000, contextPct: 20, model: 'claude-opus-4-8' };
  const { deps, calls } = stubDeps(usage, true);
  const input: HookInput = {
    hook_event_name: 'PostToolUse',
    session_id: 's',
    transcript_path: '/t.jsonl',
  };
  const result = handleEvent(input, DEFAULT_CONFIG, paths, deps);

  const expected = mapToTier(usage); // {4,0}: token level 3 + opus bump
  assert.equal(result.action, 'update');
  assert.deepEqual(result.emitted, expected);
  assert.equal(calls.sendTier.length, 1);
  assert.deepEqual(calls.sendTier[0]!.tier, expected);
  assert.equal(calls.sendTier[0]!.path, paths.commandPath);
});

test('an unchanged tier (recordTier emit=false) sends nothing', () => {
  const { deps, calls } = stubDeps({ tokens: 3000, contextPct: 20, model: 'claude-opus-4-8' }, false);
  const result = handleEvent(
    { hook_event_name: 'Stop', session_id: 's', transcript_path: '/t.jsonl' },
    DEFAULT_CONFIG,
    paths,
    deps,
  );
  assert.equal(result.emitted, null);
  assert.equal(calls.sendTier.length, 0);
});

test('mute forces the silent tier regardless of usage', () => {
  const { deps, calls } = stubDeps({ tokens: 9999, contextPct: 99, model: 'claude-opus-4-8' }, true);
  handleEvent(
    { hook_event_name: 'PostToolUse', session_id: 's', transcript_path: '/t.jsonl' },
    { ...DEFAULT_CONFIG, mute: true },
    paths,
    deps,
  );
  assert.deepEqual(calls.sendTier[0]!.tier, { ensembleSize: 0, richness: 0 });
});

test('a usage event missing transcript_path or session_id is a no-op', () => {
  const { deps, calls } = stubDeps({ tokens: 5, contextPct: 5, model: null }, true);
  assert.equal(handleEvent({ hook_event_name: 'PostToolUse', session_id: 's' }, DEFAULT_CONFIG, paths, deps).action, 'noop');
  assert.equal(handleEvent({ hook_event_name: 'PostToolUse', transcript_path: '/t' }, DEFAULT_CONFIG, paths, deps).action, 'noop');
  assert.equal(calls.extractUsage, 0);
  assert.equal(calls.sendTier.length, 0);
});

// --- real wiring (only daemon control stubbed) ------------------------------

test('end-to-end wiring: a real transcript drives a real command + state file, and dedupes', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const p = resolvePaths(dir);
    const deps: HandlerDeps = {
      extractUsage,
      recordTier,
      clearSession,
      sendTier,
      startDaemon: () => {},
      stopDaemon: () => {},
      recordTurn,
      finalizeRecording,
      pruneRecordings,
    };

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess',
      transcript_path: fixture('large.jsonl'),
    };

    const first = handleEvent(input, DEFAULT_CONFIG, p, deps);
    // large.jsonl is Opus → full tier + high-end timbre signature.
    assert.deepEqual(first.emitted, { ensembleSize: 5, richness: 1, timbre: 1 });
    assert.ok(existsSync(p.commandPath), 'command file written');
    assert.deepEqual(parseCommand(readFileSync(p.commandPath, 'utf8'))?.tier, {
      ensembleSize: 5,
      richness: 1,
      timbre: 1,
    });
    assert.deepEqual(readState(p.statePath).sessions['sess']?.tier, {
      ensembleSize: 5,
      richness: 1,
      timbre: 1,
    });

    // Same transcript again → deduped, nothing re-emitted.
    const second = handleEvent(input, DEFAULT_CONFIG, p, deps);
    assert.equal(second.emitted, null);
  });
});

// --- CC-9 session recording -------------------------------------------------

test('every turn is recorded, including turns whose tier did not change', () => {
  // emit=false means the daemon hears nothing — the recording still gets a line,
  // because the playground re-scores from raw axes and needs the whole timeline.
  const { deps, calls } = stubDeps({ tokens: 3000, contextPct: 20, model: 'claude-opus-5' }, false);
  handleEvent(
    { hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: '/t.jsonl' },
    DEFAULT_CONFIG,
    paths,
    deps,
  );

  assert.equal(calls.sendTier.length, 0, 'daemon not triggered');
  assert.equal(calls.recordTurn.length, 1, 'but the turn is still recorded');
  assert.equal(calls.recordTurn[0]!.dir, paths.recordingsDir);
  assert.equal(calls.recordTurn[0]!.sessionId, 'sess');
});

test('a muted session records the tier it *would* have played, not silence', () => {
  const usage: Usage = { tokens: 9999, contextPct: 40, model: 'claude-opus-5' };
  const { deps, calls } = stubDeps(usage, true);
  handleEvent(
    { hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: '/t.jsonl' },
    { ...DEFAULT_CONFIG, mute: true },
    paths,
    deps,
  );

  assert.deepEqual(calls.sendTier[0]!.tier, { ensembleSize: 0, richness: 0 }, 'daemon silenced');
  assert.deepEqual(calls.recordTurn[0]!.tier, mapToTier(usage), 'recording keeps the real tier');
});

test('recordings can be turned off entirely', () => {
  const { deps, calls } = stubDeps({ tokens: 3000, contextPct: 20, model: 'claude-opus-5' }, true);
  const config = { ...DEFAULT_CONFIG, recordings: { enabled: false, keep: 20 } };

  handleEvent(
    { hook_event_name: 'PostToolUse', session_id: 'sess', transcript_path: '/t.jsonl' },
    config,
    paths,
    deps,
  );
  handleEvent({ hook_event_name: 'SessionEnd', session_id: 'sess' }, config, paths, deps);

  assert.equal(calls.recordTurn.length, 0);
  assert.equal(calls.finalize.length, 0);
  assert.equal(calls.prune.length, 0);
  assert.equal(calls.sendTier.length, 1, 'playback is unaffected');
});

test('SessionEnd finalizes the recording and prunes to the configured limit', () => {
  const { deps, calls } = stubDeps({ tokens: 0, contextPct: 0, model: null }, true);
  handleEvent(
    { hook_event_name: 'SessionEnd', session_id: 'sess' },
    { ...DEFAULT_CONFIG, recordings: { enabled: true, keep: 5 } },
    paths,
    deps,
  );

  assert.deepEqual(calls.finalize, ['sess']);
  assert.deepEqual(calls.prune, [5]);
});

// --- recorder module (real filesystem) --------------------------------------

test('a recording round-trips: append turns, finalize, read back', () => {
  withTmpDir((dir) => {
    const tier = (e: number, r: number, s: number) => ({ ensembleSize: e, richness: r, timbre: s });

    recordTurn(dir, 'sess-1', { tokens: 500, contextPct: 4.62, model: 'claude-opus-5' }, tier(2, 0, 1), 1000);
    recordTurn(dir, 'sess-1', { tokens: 9000, contextPct: 31.4, model: 'claude-opus-5' }, tier(5, 2, 1), 5000);
    recordTurn(dir, 'sess-1', { tokens: 300, contextPct: 33.0, model: 'claude-haiku-4-5' }, tier(1, 2, 0), 9000);
    finalizeRecording(dir, 'sess-1');

    const { turns, summary } = readRecording(recordingPath(dir, 'sess-1'));

    assert.equal(turns.length, 3);
    assert.deepEqual(turns[0], { t: 1000, tok: 500, ctx: 4.6, model: 'claude-opus-5', tier: { e: 2, r: 0, s: 1 } });
    assert.equal(turns[1]!.ctx, 31.4, 'one decimal is preserved');

    assert.ok(summary);
    assert.equal(summary!.turns, 3);
    assert.equal(summary!.durationMs, 8000);
    // Peak is per-axis, so the Haiku turn's richness 2 and the Opus signature both survive.
    assert.deepEqual(summary!.peakTier, { e: 5, r: 2, s: 1 });
    assert.deepEqual(summary!.models, ['claude-opus-5', 'claude-haiku-4-5']);
  });
});

test('a corrupt line costs one turn, not the whole recording', () => {
  withTmpDir((dir) => {
    const path = recordingPath(dir, 'sess-2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ t: 1, tok: 100, ctx: 1, model: null, tier: { e: 1, r: 0, s: 0 } }),
        '{ this is not json',
        '',
        JSON.stringify({ t: 2, tok: 200, ctx: 2, model: null, tier: { e: 2, r: 0, s: 0 } }),
      ].join('\n'),
      'utf8',
    );

    const { turns } = readRecording(path);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((t) => t.tok), [100, 200]);
  });
});

test('finalize is idempotent and skips a session that recorded nothing', () => {
  withTmpDir((dir) => {
    finalizeRecording(dir, 'never-ran');
    assert.equal(existsSync(recordingPath(dir, 'never-ran')), false, 'no empty file created');

    recordTurn(dir, 'sess-3', { tokens: 1, contextPct: 1, model: null }, { ensembleSize: 1, richness: 0 }, 1);
    finalizeRecording(dir, 'sess-3');
    finalizeRecording(dir, 'sess-3'); // second call must not append a second summary

    const raw = readFileSync(recordingPath(dir, 'sess-3'), 'utf8').trim().split('\n');
    assert.equal(raw.length, 2, 'one turn + exactly one summary');
  });
});

test('pruning keeps the newest recordings and never wipes on keep=0', () => {
  withTmpDir((dir) => {
    for (const id of ['a', 'b', 'c', 'd']) {
      recordTurn(dir, id, { tokens: 1, contextPct: 1, model: null }, { ensembleSize: 1, richness: 0 });
    }
    // Force a deterministic recency order via mtime.
    const now = Date.now();
    ['a', 'b', 'c', 'd'].forEach((id, i) => {
      const p = recordingPath(dir, id);
      utimesSync(p, new Date(now), new Date(now + i * 1000));
    });

    pruneRecordings(dir, 0); // disabled — must not delete anything
    assert.equal(listRecordings(dir).length, 4);

    pruneRecordings(dir, 2);
    assert.deepEqual(
      listRecordings(dir).map((r) => r.sessionId),
      ['d', 'c'],
      'newest two survive, newest first',
    );
  });
});

test('a session id that looks like a path cannot escape the recordings directory', () => {
  // Session ids arrive from hook input, so treat them as untrusted. Dots survive
  // (they're legal in a filename); separators are what would let one traverse.
  for (const hostile of ['../../etc/passwd', '/abs/olute', 'a/b/c', '..']) {
    const path = recordingPath('/recordings', hostile);
    assert.equal(dirname(path), '/recordings', `"${hostile}" escaped to ${path}`);
    assert.ok(!basename(path).includes('/'), 'no separator survives into the filename');
  }
});

test('summarize is pure and handles an empty session', () => {
  const empty = summarize([]);
  assert.equal(empty.turns, 0);
  assert.equal(empty.startedAt, null);
  assert.equal(empty.durationMs, 0);
  assert.deepEqual(empty.peakTier, { e: 0, r: 0, s: 0 });
  assert.deepEqual(empty.models, []);
});

test('the recording format round-trips through the shared parser the playground uses', () => {
  // The playground imports parseRecording/summarize from src/recordingFormat.ts
  // rather than re-declaring them. This asserts the writer and that shared
  // reader agree, which is the contract that keeps the two from drifting.
  const turns = [
    { t: 10, tok: 500, ctx: 4.6, model: 'claude-opus-5', tier: { e: 2, r: 0, s: 1 } },
    { t: 20, tok: 9000, ctx: 31.4, model: 'claude-sonnet-5', tier: { e: 5, r: 2, s: 0 } },
  ];
  const text = turns.map(encodeTurn).join('\n') + '\n';

  const parsed = parseRecording(text);
  assert.deepEqual(parsed.turns, turns);
  assert.equal(parsed.summary, null, 'no summary until the session ends');

  const derived = summarize(parsed.turns);
  assert.deepEqual(derived.peakTier, { e: 5, r: 2, s: 1 });
  assert.deepEqual(derived.models, ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(derived.durationMs, 10);

  // And a finalized file parses the summary back out rather than deriving it.
  const finalized = parseRecording(text + JSON.stringify(derived) + '\n');
  assert.deepEqual(finalized.summary, derived);
  assert.equal(finalized.turns.length, 2);
});

test('packTier / unpackTier round-trip, including an absent timbre', () => {
  assert.deepEqual(packTier({ ensembleSize: 3, richness: 1, timbre: 1 }), { e: 3, r: 1, s: 1 });
  assert.deepEqual(packTier({ ensembleSize: 3, richness: 1 }), { e: 3, r: 1, s: 0 });
  assert.deepEqual(unpackTier({ e: 4, r: 2, s: 1 }), { ensembleSize: 4, richness: 2, timbre: 1 });
});
