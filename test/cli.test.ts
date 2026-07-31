import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runConduct, type CliDeps } from '../src/cli/conduct';
import { loadConfig } from '../src/hook/config';
import { resolvePaths } from '../src/hook/paths';
import { parseCommand } from '../src/daemon/command';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, 'fixtures', name);

function withProject(fn: (baseDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-cli-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Deterministic clock + a fixed "current session" transcript (large.jsonl → E5 R1).
// The process controls are stubbed out here too: these tests are about config and
// the command file, but `unmute` (and `start`) launch playback as a side effect,
// which would otherwise spawn a real, audible daemon that outlives the test run.
// `playbackDeps` below spreads these and re-stubs them with counters.
const deps: CliDeps = {
  now: () => 1000,
  findTranscript: () => fixture('large.jsonl'),
  startDaemon: () => {},
  stopDaemon: () => {},
  // The launch is stubbed, so no daemon ever writes a `ready` pidfile — the
  // boot confirmation (CC-16) has to be stubbed with it. Tests that care about
  // the confirmation itself override this.
  waitForDaemon: () => true,
};
const cfgOf = (baseDir: string) => loadConfig(resolvePaths(baseDir).configPath);
const commandOf = (baseDir: string) => parseCommand(readFileSync(resolvePaths(baseDir).commandPath, 'utf8'));

test('status reports daemon state, config, usage, and the mapped tier', () => {
  withProject((baseDir) => {
    const { output, exitCode } = runConduct(['status'], baseDir, deps);
    assert.equal(exitCode, 0);
    assert.match(output, /not running/);
    assert.match(output, /mute:\s+off/);
    assert.match(output, /tok=6502/); // large.jsonl usage
    assert.match(output, /E5 R1/); // mapped tier
  });
});

test('no args defaults to status', () => {
  withProject((baseDir) => {
    assert.match(runConduct([], baseDir, deps).output, /Claude Conduct/);
  });
});

test('mute persists in config and silences the daemon immediately', () => {
  withProject((baseDir) => {
    const { output } = runConduct(['mute'], baseDir, deps);
    assert.match(output, /Muted/);
    assert.equal(cfgOf(baseDir).mute, true);
    assert.equal(commandOf(baseDir)?.volume, 0); // sent volume 0
  });
});

test('mute persists until unmute, which restores volume and resumes the tier', () => {
  withProject((baseDir) => {
    runConduct(['mute'], baseDir, deps);
    assert.match(runConduct(['status'], baseDir, deps).output, /mute:\s+on/);

    runConduct(['unmute'], baseDir, deps);
    const cfg = cfgOf(baseDir);
    assert.equal(cfg.mute, false);
    const cmd = commandOf(baseDir);
    assert.equal(cmd?.volume, cfg.volume); // restored
    assert.deepEqual(cmd?.tier, { ensembleSize: 5, richness: 1, timbre: 1 }); // resumed (Opus)
  });
});

test('volume accepts a 0–1 value and applies it live', () => {
  withProject((baseDir) => {
    const { output } = runConduct(['volume', '0.4'], baseDir, deps);
    assert.match(output, /0\.4/);
    assert.equal(cfgOf(baseDir).volume, 0.4);
    assert.equal(commandOf(baseDir)?.volume, 0.4);
  });
});

test('volume accepts a percent and clamps', () => {
  withProject((baseDir) => {
    runConduct(['volume', '80'], baseDir, deps);
    assert.equal(cfgOf(baseDir).volume, 0.8);
    runConduct(['volume', '999'], baseDir, deps);
    assert.equal(cfgOf(baseDir).volume, 1);
  });
});

test('volume while muted persists but is not sent live', () => {
  withProject((baseDir) => {
    runConduct(['mute'], baseDir, deps); // command file → volume 0
    const { output } = runConduct(['volume', '0.6'], baseDir, deps);
    assert.match(output, /muted/);
    assert.equal(cfgOf(baseDir).volume, 0.6);
    assert.equal(commandOf(baseDir)?.volume, 0); // still muted, not 0.6
  });
});

test('bad volume and unknown commands exit non-zero', () => {
  withProject((baseDir) => {
    assert.equal(runConduct(['volume'], baseDir, deps).exitCode, 1);
    assert.equal(runConduct(['volume', 'loud'], baseDir, deps).exitCode, 1);
    assert.equal(runConduct(['frobnicate'], baseDir, deps).exitCode, 1);
  });
});

// --- Opt-in playback: start / stop -----------------------------------------

/** Deps with the daemon process controls stubbed, plus a settable running state. */
function playbackDeps(startsRunning = false) {
  const calls = { start: 0, stop: 0 };
  let alive = startsRunning;
  const stubbed: CliDeps = {
    ...deps,
    isDaemonRunning: () => alive,
    startDaemon: () => {
      calls.start++;
      alive = true;
    },
    stopDaemon: () => {
      calls.stop++;
      alive = false;
    },
  };
  return { deps: stubbed, calls, isAlive: () => alive };
}

test('start launches the daemon and seeds it with the current tier', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps();
    const { output, exitCode } = runConduct(['start'], baseDir, d);

    assert.equal(exitCode, 0);
    assert.equal(calls.start, 1);
    assert.match(output, /Playing/);
    assert.match(output, /E5 R1/); // opens on the live tier, not from silence
    assert.deepEqual(commandOf(baseDir)?.tier, { ensembleSize: 5, richness: 1, timbre: 1 });
  });
});

test('start is idempotent — a second start does not spawn another daemon', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps();
    runConduct(['start'], baseDir, d);
    const { output } = runConduct(['start'], baseDir, d);

    assert.equal(calls.start, 1, 'the second start must not spawn');
    assert.match(output, /Already playing/);
  });
});

test('start while muted opens silent and says so', () => {
  withProject((baseDir) => {
    const { deps: d } = playbackDeps();
    runConduct(['mute'], baseDir, d);
    const { output } = runConduct(['start'], baseDir, d);

    assert.match(output, /muted/);
    assert.equal(commandOf(baseDir)?.volume, 0);
  });
});

test('stop halts a running daemon and is a no-op when nothing plays', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps();
    assert.match(runConduct(['stop'], baseDir, d).output, /Not playing/);
    assert.equal(calls.stop, 0);

    runConduct(['start'], baseDir, d);
    const { output } = runConduct(['stop'], baseDir, d);
    assert.equal(calls.stop, 1);
    assert.match(output, /Stopped/);
  });
});

test('unmute starts playback when it is not already running', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps();
    const { output } = runConduct(['unmute'], baseDir, d);

    assert.equal(calls.start, 1, 'asking to hear it should start it');
    assert.match(output, /Started playback/);
    assert.equal(cfgOf(baseDir).mute, false);
  });
});

test('unmute on an already-running daemon does not re-spawn it', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps(true);
    const { output } = runConduct(['unmute'], baseDir, d);

    assert.equal(calls.start, 0);
    assert.doesNotMatch(output, /Started playback/);
  });
});

test('status and volume never start playback on their own', () => {
  withProject((baseDir) => {
    const { deps: d, calls } = playbackDeps();
    runConduct(['status'], baseDir, d);
    runConduct(['volume', '50'], baseDir, d);
    assert.equal(calls.start, 0, 'only start/unmute may spawn the daemon');
  });
});

test('help lists start and stop', () => {
  withProject((baseDir) => {
    const { output } = runConduct(['help'], baseDir, deps);
    assert.match(output, /start\s+begin playback/);
    assert.match(output, /stop\s+stop playback/);
  });
});
