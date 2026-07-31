import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIVE_CONFIG,
  intensity,
  liveTier,
  phaseFor,
  type LiveConfig,
} from '../src/liveMode';
import { parseCommand, serializeCommand } from '../src/daemon/command';
import { handleEvent, realDeps, type HandlerDeps, type HookInput } from '../src/hook/handler';
import { DEFAULT_CONFIG } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';
import type { TurnFacts, Tier } from '../src/types';

/**
 * CC-11 — live playback as presence and cadence.
 *
 * The property under test throughout: **silence means it is your turn**. Music
 * starting and stopping has to carry information, which it cannot do while the
 * drone is always on.
 */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-live-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  tokens: 800,
  contextPct: 10,
  model: 'claude-opus-5',
  outputTokens: 500,
  effort: 'high',
  shape: 'tool',
  tool: 'exec',
  endsTurn: false,
  ...over,
});

// --- the mapping ------------------------------------------------------------

test('intensity is three coarse steps, not a readout', () => {
  const c = DEFAULT_LIVE_CONFIG;
  assert.equal(intensity(0, c), 0);
  assert.equal(intensity(c.steps[0] - 1, c), 0);
  assert.equal(intensity(c.steps[0], c), 1);
  assert.equal(intensity(c.steps[1], c), 2);
  assert.equal(intensity(10_000_000, c), 2, 'and it saturates rather than climbing forever');
});

test('idle is silence — the resting state of presence mode', () => {
  assert.deepEqual(liveTier('idle', facts(), DEFAULT_LIVE_CONFIG), {
    ensembleSize: 0,
    richness: 0,
  });
});

test('working never reaches the top of the old six-step ladder on a small turn', () => {
  const quiet = liveTier('working', facts({ tokens: 10 }), DEFAULT_LIVE_CONFIG);
  const grind = liveTier('working', facts({ tokens: 50_000 }), DEFAULT_LIVE_CONFIG);
  assert.equal(quiet.ensembleSize, DEFAULT_LIVE_CONFIG.levels[0]);
  assert.equal(grind.ensembleSize, DEFAULT_LIVE_CONFIG.levels[2]);
  assert.ok(grind.ensembleSize > quiet.ensembleSize, 'a long grind still feels different');
});

test('a cadence is small, not a fanfare', () => {
  const cadence = liveTier('cadence', facts({ tokens: 50_000 }), DEFAULT_LIVE_CONFIG);
  const grind = liveTier('working', facts({ tokens: 50_000 }), DEFAULT_LIVE_CONFIG);
  assert.ok(
    cadence.ensembleSize < grind.ensembleSize,
    'an ending that swells is a fanfare, and a fanfare every turn is a mute button',
  );
  assert.equal(cadence.richness, 0);
});

test('the model signature still passes through', () => {
  assert.equal(liveTier('working', facts({ model: 'claude-opus-5' }), DEFAULT_LIVE_CONFIG).timbre, 1);
  assert.equal(liveTier('working', facts({ model: 'claude-haiku-4-5' }), DEFAULT_LIVE_CONFIG).timbre, 0);
  assert.equal(liveTier('working', facts({ model: null }), DEFAULT_LIVE_CONFIG).timbre, 0);
});

test('Stop is the cadence, tool use is work', () => {
  assert.equal(phaseFor('Stop', false), 'cadence');
  assert.equal(phaseFor('SubagentStop', false), 'cadence');
  assert.equal(phaseFor('PostToolUse', false), 'working');
  assert.equal(phaseFor('SessionStart', false), 'idle');
  // A transcript that already ended the turn says the same thing as `Stop`.
  assert.equal(phaseFor('PostToolUse', true), 'cadence');
});

// --- the command protocol ---------------------------------------------------

test('holdMs round-trips, and is dropped when meaningless', () => {
  const tier: Tier = { ensembleSize: 2, richness: 0 };
  assert.equal(parseCommand(serializeCommand({ tier, holdMs: 2500 }))?.holdMs, 2500);
  assert.equal(parseCommand(serializeCommand({ tier, holdMs: 0 }))?.holdMs, undefined);
  assert.equal(parseCommand(serializeCommand({ tier }))?.holdMs, undefined);
});

// --- end to end through the handler -----------------------------------------

function liveDeps(over: Partial<HandlerDeps> = {}): {
  deps: HandlerDeps;
  sent: Array<{ tier: Tier; holdMs?: number }>;
} {
  const sent: Array<{ tier: Tier; holdMs?: number }> = [];
  const deps: HandlerDeps = {
    ...realDeps,
    sendTier: (_p, tier) => {
      sent.push({ tier });
    },
    sendCadence: (_p, tier, holdMs) => {
      sent.push({ tier, holdMs });
    },
    startDaemon: () => {},
    stopDaemon: () => {},
    recordTurn: () => {},
    ...over,
  };
  return { deps, sent };
}

const event = (name: string): HookInput => ({
  hook_event_name: name,
  session_id: 'live-sess',
  transcript_path: '/t.jsonl',
});

test('working lifts the music, Stop resolves it and hands back the silence', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const { deps, sent } = liveDeps({ extractTurnFacts: () => facts({ tokens: 20_000 }) });

    const work = handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    assert.equal(work.action, 'update');
    assert.equal(sent[0]!.tier.ensembleSize, DEFAULT_LIVE_CONFIG.levels[2]);
    assert.equal(sent[0]!.holdMs, undefined);

    const stop = handleEvent(event('Stop'), DEFAULT_CONFIG, paths, deps);
    assert.equal(stop.action, 'cadence');
    assert.equal(sent[1]!.holdMs, DEFAULT_LIVE_CONFIG.cadenceHoldMs, 'the daemon is told to fall silent');
    assert.ok(sent[1]!.tier.ensembleSize < sent[0]!.tier.ensembleSize);
  });
});

test('the next turn lifts the music back up after a cadence', () => {
  // The regression this guards: the daemon goes silent on a timer the state
  // layer never sees, so a naive dedupe would consider the working tier
  // "unchanged" and leave the session silent for good.
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const { deps, sent } = liveDeps({ extractTurnFacts: () => facts({ tokens: 20_000 }) });

    handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    handleEvent(event('Stop'), DEFAULT_CONFIG, paths, deps);
    const resumed = handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);

    assert.equal(resumed.action, 'update');
    assert.equal(sent.length, 3, 'the third event re-emits rather than being deduped');
    assert.deepEqual(sent[2]!.tier, sent[0]!.tier);
  });
});

test('consecutive working turns at the same intensity are still deduped', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const { deps, sent } = liveDeps({ extractTurnFacts: () => facts({ tokens: 20_000 }) });

    handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    assert.equal(sent.length, 1, 'presence mode does not chatter at the daemon');
  });
});

test('mute silences the cadence too', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const { deps, sent } = liveDeps({ extractTurnFacts: () => facts() });
    const result = handleEvent(
      event('Stop'),
      { ...DEFAULT_CONFIG, mute: true },
      paths,
      deps,
    );
    assert.equal(result.action, 'cadence');
    assert.equal(result.emitted, null);
    assert.equal(sent.length, 0);
  });
});

test('gradient mode is still available and behaves as it always did', () => {
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const { deps, sent } = liveDeps({ extractTurnFacts: () => facts({ tokens: 20_000 }) });
    const config = { ...DEFAULT_CONFIG, live: { ...DEFAULT_CONFIG.live, mode: 'gradient' as const } };

    const stop = handleEvent(event('Stop'), config, paths, deps);
    assert.equal(stop.action, 'update', 'no cadence, no fall to silence');
    assert.equal(sent[0]!.holdMs, undefined);
  });
});

test('the recording keeps the full gradient even while live mode is narrowed', () => {
  // Live mode flattens deliberately; the recording must not inherit that, or
  // CC-10 would render every session as three states.
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    const recorded: Tier[] = [];
    const { deps } = liveDeps({
      extractTurnFacts: () => facts({ tokens: 20_000, contextPct: 60 }),
      recordTurn: (_d, _s, _u, tier) => {
        recorded.push(tier);
      },
    });

    handleEvent(event('PostToolUse'), DEFAULT_CONFIG, paths, deps);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.richness, 2, 'richness survives, though live mode never plays it');
  });
});

// --- config -----------------------------------------------------------------

test('live tuning is configurable and validated', async () => {
  const { loadConfig } = await import('../src/hook/config');
  withTmpDir((dir) => {
    const path = join(dir, 'c.json');
    const write = (o: unknown) => writeFileSync(path, JSON.stringify(o), 'utf8');

    write({ live: { mode: 'gradient', cadenceHoldMs: 4000, levels: [1, 2, 3], steps: [10, 20] } });
    const good = loadConfig(path);
    assert.equal(good.live.mode, 'gradient');
    assert.equal(good.live.cadenceHoldMs, 4000);
    assert.deepEqual(good.live.levels, [1, 2, 3]);

    // Junk falls back rather than breaking the hook.
    write({ live: { mode: 'sideways', levels: [1, 2], steps: 'nope', cadenceHoldMs: -5 } });
    const bad = loadConfig(path);
    assert.deepEqual(bad.live, DEFAULT_LIVE_CONFIG);
  });
});

test('an absent live section keeps presence as the default', () => {
  const config: LiveConfig = DEFAULT_CONFIG.live;
  assert.equal(config.mode, 'presence');
});

// --- the daemon side --------------------------------------------------------

test('the daemon falls to silence after the hold, and a new command cancels it', async () => {
  const { ConductDaemon } = await import('../src/daemon/server');
  const { NullSink } = await import('../src/audio/sink');

  withTmpDir((dir) => {
    const commandPath = join(dir, 'cmd.json');
    const stems = Array.from({ length: 10 }, () => new Float32Array(64));
    const daemon = new ConductDaemon(stems, new NullSink(), {
      commandPath,
      pidPath: join(dir, 'pid'),
      sampleRate: 44_100,
      autoRender: false,
      autoWatchdog: false,
    });

    const write = (o: unknown) => writeFileSync(commandPath, JSON.stringify(o), 'utf8');

    write({ ts: 1, tier: { ensembleSize: 2, richness: 0 }, holdMs: 50_000 });
    daemon.refresh();
    assert.equal(daemon.cadencePending, true);

    // Claude started working again inside the hold — the music must stay up.
    write({ ts: 2, tier: { ensembleSize: 5, richness: 1 } });
    daemon.refresh();
    assert.equal(daemon.cadencePending, false, 'a new command supersedes the pending cadence');

    daemon.stop();
    assert.equal(existsSync(commandPath), true);
    assert.ok(readFileSync(commandPath, 'utf8').length > 0);
  });
});

test('a dropped fs.watch event still lands, via the poll backstop', async () => {
  const { ConductDaemon } = await import('../src/daemon/server');
  const { NullSink } = await import('../src/audio/sink');
  const { tierToGains } = await import('../src/audio/tierGains');

  await new Promise<void>((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'conduct-poll-'));
    const commandPath = join(dir, 'cmd.json');
    const stems = Array.from({ length: 10 }, () => new Float32Array(64));
    const daemon = new ConductDaemon(stems, new NullSink(), {
      commandPath,
      autoRender: false,
      autoWatchdog: false,
      blockFrames: 32,
      pollMs: 20,
    });
    daemon.start();

    // Write *without* triggering a rename the watcher would see reliably; the
    // poll is the only thing that can notice this.
    writeFileSync(commandPath, JSON.stringify({ ts: 7, tier: { ensembleSize: 4, richness: 2 } }));

    const expected = tierToGains({ ensembleSize: 4, richness: 2 });
    const deadline = Date.now() + 5_000;
    const check = (): void => {
      try {
        // The bank has extra stems for the CC-10 extensions; compare the core.
        assert.deepEqual(daemon.targets.slice(0, expected.length), expected);
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
        resolve();
      } catch (error) {
        if (Date.now() > deadline) {
          daemon.stop();
          rmSync(dir, { recursive: true, force: true });
          reject(error);
          return;
        }
        setTimeout(check, 20);
      }
    };
    check();
  });
});

test('re-reading the same command does not restart a pending cadence forever', async () => {
  const { ConductDaemon } = await import('../src/daemon/server');
  const { NullSink } = await import('../src/audio/sink');

  withTmpDir((dir) => {
    const commandPath = join(dir, 'cmd.json');
    const stems = Array.from({ length: 10 }, () => new Float32Array(64));
    const daemon = new ConductDaemon(stems, new NullSink(), {
      commandPath,
      autoRender: false,
      autoWatchdog: false,
      autoPoll: false,
    });

    writeFileSync(commandPath, JSON.stringify({ ts: 1, tier: { ensembleSize: 2, richness: 0 }, holdMs: 30 }));
    daemon.start();
    assert.equal(daemon.cadencePending, true);

    // The watcher fires twice for one rename all the time. If each refresh
    // rescheduled, the fall to silence would never arrive.
    daemon.refresh();
    daemon.refresh();
    assert.equal(daemon.cadencePending, true, 'still the original timer, not a fresh one');

    daemon.stop();
    assert.equal(daemon.cadencePending, false, 'stopping clears it');
  });
});
