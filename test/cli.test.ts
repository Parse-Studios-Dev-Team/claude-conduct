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

// Deterministic clock + a fixed "current session" transcript (large.jsonl → E5 R2).
const deps: CliDeps = { now: () => 1000, findTranscript: () => fixture('large.jsonl') };
const cfgOf = (baseDir: string) => loadConfig(resolvePaths(baseDir).configPath);
const commandOf = (baseDir: string) => parseCommand(readFileSync(resolvePaths(baseDir).commandPath, 'utf8'));

test('status reports daemon state, config, usage, and the mapped tier', () => {
  withProject((baseDir) => {
    const { output, exitCode } = runConduct(['status'], baseDir, deps);
    assert.equal(exitCode, 0);
    assert.match(output, /not running/);
    assert.match(output, /mute:\s+off/);
    assert.match(output, /tok=1502/); // large.jsonl usage
    assert.match(output, /E5 R2/); // mapped tier
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
    assert.deepEqual(cmd?.tier, { ensembleSize: 5, richness: 2, timbre: 1 }); // resumed (Opus)
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
