import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conductor } from '../src/daemon/conductor';
import { ConductDaemon } from '../src/daemon/server';
import { sendTier } from '../src/daemon/client';
import { tierToGains } from '../src/audio/tierGains';
import { synthesizeStems } from '../src/audio/synth';
import type { Sink } from '../src/audio/sink';

class CapturingSink implements Sink {
  blocks: Float32Array[] = [];
  closed = false;
  constructor(readonly sampleRate = 1000) {}
  write(block: Float32Array): void {
    this.blocks.push(block);
  }
  close(): void {
    this.closed = true;
  }
}

const stems = (): Float32Array[] => synthesizeStems(6, { sampleRate: 1000, loopMs: 100 });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTmp(fn: (paths: { commandPath: string; pidPath: string }) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-daemon-'));
  const paths = {
    commandPath: join(dir, '.claude', 'conduct-command.json'),
    pidPath: join(dir, '.claude', 'conduct.pid'),
  };
  const done = () => rmSync(dir, { recursive: true, force: true });
  const result = fn(paths);
  if (result instanceof Promise) return result.finally(done);
  done();
  return undefined;
}

// --- Conductor (transport-free brain) ---------------------------------------

test('Conductor.setTier maps the tier onto the mixer targets', () => {
  const c = new Conductor(stems(), new CapturingSink(), { blockFrames: 64 });
  c.setTier({ ensembleSize: 3, richness: 1 });
  assert.deepEqual(c.mixer.getTargets(), tierToGains({ ensembleSize: 3, richness: 1 }));
});

test('Conductor.renderBlock writes exactly blockFrames to the sink', () => {
  const sink = new CapturingSink();
  const c = new Conductor(stems(), sink, { blockFrames: 64 });
  c.renderBlock();
  c.renderBlock();
  assert.equal(sink.blocks.length, 2);
  assert.equal(sink.blocks[0]!.length, 64);
});

test('Conductor forces the mixer to the sink sample rate', () => {
  const c = new Conductor(stems(), new CapturingSink(1000), { sampleRate: 48000, blockFrames: 64 });
  assert.equal(c.mixer.sampleRate, 1000);
});

// --- ConductDaemon lifecycle ------------------------------------------------

test('start() applies a pre-existing command and writes a pidfile; stop() cleans up', () => {
  withTmp(({ commandPath, pidPath }) => {
    // A tier written before the daemon starts must be honored on start.
    sendTier(commandPath, { ensembleSize: 2, richness: 1 });

    const daemon = new ConductDaemon(stems(), new CapturingSink(), {
      commandPath,
      pidPath,
      autoRender: false,
      blockFrames: 64,
    });
    daemon.start();

    assert.equal(daemon.isRunning, true);
    assert.ok(existsSync(pidPath), 'pidfile is written on start');
    assert.deepEqual(
      daemon.targets,
      tierToGains({ ensembleSize: 2, richness: 1 }),
    );

    daemon.stop();
    assert.equal(daemon.isRunning, false);
    assert.ok(!existsSync(pidPath), 'pidfile is removed on stop');
    assert.doesNotThrow(() => daemon.stop(), 'stop is idempotent');
  });
});

test('refresh() picks up a newly written command (10 rapid changes converge to the last)', () => {
  withTmp(({ commandPath, pidPath }) => {
    const daemon = new ConductDaemon(stems(), new CapturingSink(), {
      commandPath,
      pidPath,
      autoRender: false,
      blockFrames: 32,
    });
    daemon.start();

    let last = { ensembleSize: 0, richness: 0 };
    for (let i = 0; i < 10; i++) {
      last = { ensembleSize: i % 6, richness: i % 3 };
      sendTier(commandPath, last, 1000 + i);
      daemon.refresh();
      daemon.renderBlock();
    }
    assert.deepEqual(daemon.targets, tierToGains(last));

    daemon.stop();
  });
});

test('start() is idempotent and does not double-run', () => {
  withTmp(({ commandPath, pidPath }) => {
    const daemon = new ConductDaemon(stems(), new CapturingSink(), {
      commandPath,
      pidPath,
      autoRender: false,
    });
    daemon.start();
    assert.doesNotThrow(() => daemon.start());
    assert.equal(daemon.isRunning, true);
    daemon.stop();
  });
});

// --- File-watch transport (best-effort, timing-tolerant) --------------------

test('the file watcher applies a tier written while the daemon is running', async () => {
  await withTmp(async ({ commandPath, pidPath }) => {
    const daemon = new ConductDaemon(stems(), new CapturingSink(), {
      commandPath,
      pidPath,
      autoRender: false,
      blockFrames: 32,
    });
    daemon.start();

    const expected = tierToGains({ ensembleSize: 4, richness: 2 });
    sendTier(commandPath, { ensembleSize: 4, richness: 2 });

    // Poll for the watch event (fs.watch latency varies); generous timeout.
    let applied = false;
    for (let i = 0; i < 150 && !applied; i++) {
      await sleep(20);
      try {
        assert.deepEqual(daemon.targets, expected);
        applied = true;
      } catch {
        /* keep polling */
      }
    }

    daemon.stop();
    assert.ok(applied, 'watcher applied the command within the timeout');
  });
});
