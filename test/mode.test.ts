import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleEvent, realDeps, type HandlerDeps, type HookInput } from '../src/hook/handler';
import { DEFAULT_CONFIG, loadConfig, type ConductConfig, type ConductMode } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';
import { renderSessionToFile, pendingRenders, pruneRenders, renderPath } from '../src/renderStore';
import { encodeTurn } from '../src/recordingFormat';
import { recordingPath } from '../src/recorder';
import type { TurnFacts, Tier } from '../src/types';

/**
 * CC-13 — live, playback, both, or off.
 *
 * Live and playback want opposite things: live must be ignorable and legible,
 * playback must be interesting and has no legibility requirement at all.
 * Splitting the difference is what produced "sounds mostly the same", so these
 * tests mostly assert that choosing one genuinely switches the other off.
 */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-mode-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  tokens: 4000,
  contextPct: 20,
  model: 'claude-opus-5',
  outputTokens: 2200,
  effort: 'high',
  shape: 'tool',
  tool: 'exec',
  endsTurn: false,
  ...over,
});

interface Seen {
  sent: Tier[];
  rendered: string[][];
  recorded: number;
}

function modeDeps(): { deps: HandlerDeps; seen: Seen } {
  const seen: Seen = { sent: [], rendered: [], recorded: 0 };
  const deps: HandlerDeps = {
    ...realDeps,
    extractTurnFacts: () => facts(),
    sendTier: (_p, tier) => {
      seen.sent.push(tier);
    },
    sendCadence: (_p, tier) => {
      seen.sent.push(tier);
    },
    recordTurn: () => {
      seen.recorded++;
    },
    finalizeRecording: () => {},
    pruneRecordings: () => {},
    startDaemon: () => {},
    stopDaemon: () => {},
    startRender: (_paths, _config, ids) => {
      seen.rendered.push(ids);
    },
    pendingRenders: () => [],
  };
  return { deps, seen };
}

const configFor = (mode: ConductMode): ConductConfig => ({ ...DEFAULT_CONFIG, mode });

const turn: HookInput = {
  hook_event_name: 'PostToolUse',
  session_id: 'sess',
  transcript_path: '/t.jsonl',
};
const end: HookInput = { hook_event_name: 'SessionEnd', session_id: 'sess' };

// --- what each mode actually does -------------------------------------------

test('live plays and renders nothing', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    handleEvent(turn, configFor('live'), resolvePaths(dir), deps);
    handleEvent(end, configFor('live'), resolvePaths(dir), deps);
    assert.equal(seen.sent.length, 1);
    assert.equal(seen.rendered.length, 0);
  });
});

test('playback stays silent and leaves a piece behind', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    const result = handleEvent(turn, configFor('playback'), resolvePaths(dir), deps);
    handleEvent(end, configFor('playback'), resolvePaths(dir), deps);

    assert.equal(result.action, 'noop');
    assert.equal(seen.sent.length, 0, 'nothing reaches the daemon');
    assert.deepEqual(seen.rendered, [['sess']]);
  });
});

test('both does each', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    handleEvent(turn, configFor('both'), resolvePaths(dir), deps);
    handleEvent(end, configFor('both'), resolvePaths(dir), deps);
    assert.equal(seen.sent.length, 1);
    assert.deepEqual(seen.rendered, [['sess']]);
  });
});

test('off does neither', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    handleEvent(turn, configFor('off'), resolvePaths(dir), deps);
    handleEvent(end, configFor('off'), resolvePaths(dir), deps);
    assert.equal(seen.sent.length, 0);
    assert.equal(seen.rendered.length, 0);
  });
});

test('every mode still records — recording is what playback is made of', () => {
  for (const mode of ['live', 'playback', 'both', 'off'] as const) {
    withTmpDir((dir) => {
      const { deps, seen } = modeDeps();
      handleEvent(turn, configFor(mode), resolvePaths(dir), deps);
      assert.equal(seen.recorded, 1, `${mode} records`);
    });
  }
});

test('a session that never fired SessionEnd is swept up by the next one', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    deps.pendingRenders = () => ['orphan-a', 'sess', 'orphan-b'];

    handleEvent(end, configFor('playback'), resolvePaths(dir), deps);

    assert.deepEqual(
      seen.rendered[0],
      ['sess', 'orphan-a', 'orphan-b'],
      'the ended session first, then stragglers, and no duplicate of itself',
    );
  });
});

test('sweepStale off renders only the session that just ended', () => {
  withTmpDir((dir) => {
    const { deps, seen } = modeDeps();
    deps.pendingRenders = () => ['orphan'];
    const config = { ...configFor('playback'), playback: { ...DEFAULT_CONFIG.playback, sweepStale: false } };

    handleEvent(end, config, resolvePaths(dir), deps);
    assert.deepEqual(seen.rendered, [['sess']]);
  });
});

// --- config -----------------------------------------------------------------

test('mode and playback tuning load, and junk falls back', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ mode: 'both', playback: { seconds: 30, keep: 5 } }), 'utf8');
    const good = loadConfig(path);
    assert.equal(good.mode, 'both');
    assert.equal(good.playback.seconds, 30);
    assert.equal(good.playback.keep, 5);

    writeFileSync(path, JSON.stringify({ mode: 'sideways', playback: { seconds: -1 } }), 'utf8');
    const bad = loadConfig(path);
    assert.equal(bad.mode, 'live', 'an unknown mode falls back rather than disabling everything');
    assert.equal(bad.playback.seconds, 90);
  });
});

test('renders live beside recordings, under the same runtime dir', () => {
  const paths = resolvePaths('/tmp/some-project');
  assert.equal(paths.rendersDir, '/tmp/some-project/.claude/renders');
});

// --- the render store -------------------------------------------------------

/** A v2 recording with enough shape to render. */
function seedRecording(recordingsDir: string, sessionId: string, turns = 40): void {
  const shapes = ['think', 'tool', 'text'] as const;
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(
      encodeTurn({
        t: 1000 + i * 5000,
        tok: 500 + i * 90,
        ctx: i * 1.7,
        model: 'claude-opus-5',
        tier: { e: Math.min(5, i % 6), r: Math.min(2, i % 3), s: 1 },
        out: 200 + i * 60,
        ef: i % 7 === 0 ? 'max' : 'high',
        sh: shapes[i % 3],
        tl: 'exec',
        ...(i % 9 === 0 ? { end: true } : {}),
      }),
    );
  }
  mkdirSync(recordingsDir, { recursive: true });
  writeFileSync(recordingPath(recordingsDir, sessionId), `${lines.join('\n')}\n`, 'utf8');
}

test('a recording renders to a real WAV without any transcript present', () => {
  withTmpDir((dir) => {
    const recordings = join(dir, 'recordings');
    const renders = join(dir, 'renders');
    seedRecording(recordings, 'sess');

    const outcome = renderSessionToFile(recordings, renders, 'sess', { seconds: 4 });
    assert.ok(outcome);
    assert.equal(outcome!.source, 'recording');
    assert.equal(outcome!.turns, 40);
    assert.ok(existsSync(outcome!.path));
    // 4s stereo @44.1kHz, 16-bit ≈ 705 KB. Assert it is real audio, not a stub.
    assert.ok(statSync(outcome!.path).size > 500_000, 'the file has actual samples in it');
  });
});

test('a session with nothing renderable is skipped, not an error', () => {
  withTmpDir((dir) => {
    const outcome = renderSessionToFile(join(dir, 'recordings'), join(dir, 'renders'), 'ghost', {
      seconds: 2,
    });
    assert.equal(outcome, null);
  });
});

test('pendingRenders finds only settled sessions that have no render yet', () => {
  withTmpDir((dir) => {
    const recordings = join(dir, 'recordings');
    const renders = join(dir, 'renders');
    seedRecording(recordings, 'old');
    seedRecording(recordings, 'fresh');
    seedRecording(recordings, 'done');

    // Age two of them past the settle window.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(recordingPath(recordings, 'old'), old, old);
    utimesSync(recordingPath(recordings, 'done'), old, old);

    renderSessionToFile(recordings, renders, 'done', { seconds: 2 });

    const pending = pendingRenders(recordings, renders);
    assert.deepEqual(pending, ['old'], 'in-progress and already-rendered sessions are left alone');
  });
});

test('renders are pruned — they are the biggest thing this puts on disk', () => {
  withTmpDir((dir) => {
    const renders = join(dir, 'renders');
    mkdirSync(renders, { recursive: true });
    for (const id of ['a', 'b', 'c']) {
      writeFileSync(renderPath(renders, id), 'x');
    }
    // Make `a` clearly the oldest.
    const old = new Date(Date.now() - 60_000);
    utimesSync(renderPath(renders, 'a'), old, old);

    pruneRenders(renders, 2);
    assert.equal(existsSync(renderPath(renders, 'a')), false);
    assert.equal(existsSync(renderPath(renders, 'b')), true);

    // A zero keep must not wipe the directory.
    pruneRenders(renders, 0);
    assert.equal(existsSync(renderPath(renders, 'b')), true);
  });
});

// --- the CLI ----------------------------------------------------------------

test('/conduct render renders the newest recording when none is named', async () => {
  const { runConduct } = await import('../src/cli/conduct');
  withTmpDir((dir) => {
    seedRecording(join(dir, '.claude', 'recordings'), 'cli-sess');
    writeFileSync(join(dir, 'conduct.config.json'), JSON.stringify({ playback: { seconds: 3 } }), 'utf8');

    const result = runConduct(['render'], dir);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Rendered 40 turns \(recording\)/);
    assert.ok(existsSync(renderPath(join(dir, '.claude', 'renders'), 'cli-sess')));
  });
});

test('/conduct render says so when there is nothing to render', async () => {
  const { runConduct } = await import('../src/cli/conduct');
  withTmpDir((dir) => {
    const result = runConduct(['render'], dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /No recordings found/);
  });
});

test('/conduct render names an unknown session rather than rendering silence', async () => {
  const { runConduct } = await import('../src/cli/conduct');
  withTmpDir((dir) => {
    seedRecording(join(dir, '.claude', 'recordings'), 'real');
    const result = runConduct(['render', 'nonexistent'], dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Nothing renderable for "nonexistent"/);
  });
});
