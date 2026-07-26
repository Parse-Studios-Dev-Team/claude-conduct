import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';
import { handleEvent, type HandlerDeps, type HookInput } from '../src/hook/handler';
import { extractUsage } from '../src/extractUsage';
import { recordTier, clearSession, readState } from '../src/state';
import { sendTier } from '../src/daemon/client';
import { mapToTier } from '../src/mapToTier';
import { parseCommand } from '../src/daemon/command';
import type { Usage } from '../src/types';

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
}

function stubDeps(usage: Usage, emit: boolean): { deps: HandlerDeps; calls: Calls } {
  const calls: Calls = { startDaemon: 0, stopDaemon: 0, clearSession: [], sendTier: [], extractUsage: 0 };
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
