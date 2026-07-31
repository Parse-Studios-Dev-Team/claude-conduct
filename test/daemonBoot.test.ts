import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDaemonStatus, waitForDaemon, isDaemonRunning } from '../src/hook/daemonControl';
import { runConduct, type CliDeps } from '../src/cli/conduct';
import { resolvePaths } from '../src/hook/paths';

/**
 * CC-16 — "Playing" must mean the daemon started, not that `spawn` returned.
 *
 * The failure being guarded against: `npx` exists and returns a pid, so the
 * pidfile looks healthy while the daemon dies a millisecond later with
 * ERR_MODULE_NOT_FOUND. That is how CC-14 stayed invisible for days — status
 * said running, tiers kept flowing, and there was no sound.
 */

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-boot-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- reading the pidfile ----------------------------------------------------

test('a launcher pid is not a ready daemon', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'conduct.pid');
    // What `startDaemon` writes: a pid, and no claim about having booted.
    writeFileSync(path, `${process.pid}\n`, 'utf8');
    assert.deepEqual(readDaemonStatus(path), { pid: process.pid, ready: false });
  });
});

test('the daemon marks itself ready, and old readers still see the pid', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'conduct.pid');
    writeFileSync(path, `${process.pid} ready\n`, 'utf8');
    assert.deepEqual(readDaemonStatus(path), { pid: process.pid, ready: true });
    // `readPid` parses the leading integer — the marker must stay invisible to it.
    assert.equal(isDaemonRunning(path), true);
  });
});

test('a missing or junk pidfile reads as nothing, not a crash', () => {
  withTmpDir((dir) => {
    assert.deepEqual(readDaemonStatus(join(dir, 'nope.pid')), { pid: null, ready: false });
    const junk = join(dir, 'junk.pid');
    writeFileSync(junk, 'not a pid at all\n', 'utf8');
    assert.deepEqual(readDaemonStatus(junk), { pid: null, ready: false });
  });
});

// --- waiting ----------------------------------------------------------------

test('waitForDaemon returns immediately once the marker is there', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'conduct.pid');
    writeFileSync(path, `${process.pid} ready\n`, 'utf8');
    const started = Date.now();
    assert.equal(waitForDaemon(path, 2_000), true);
    assert.ok(Date.now() - started < 500, 'no reason to wait when the answer is already there');
  });
});

test('waitForDaemon gives up, bounded, when the daemon never confirms', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'conduct.pid');
    // A launcher pid that never becomes ready — precisely the CC-14 shape.
    writeFileSync(path, `${process.pid}\n`, 'utf8');
    const started = Date.now();
    assert.equal(waitForDaemon(path, 250, 25), false);
    const waited = Date.now() - started;
    assert.ok(waited >= 200, `should actually wait, waited ${waited}ms`);
    assert.ok(waited < 3_000, `must stay bounded, waited ${waited}ms`);
  });
});

test('a pid that is marked ready but dead is not running', () => {
  withTmpDir((dir) => {
    const path = join(dir, 'conduct.pid');
    // 2^22 is above every real pid_max on macOS and Linux, so nothing owns it.
    writeFileSync(path, `${4_194_304} ready\n`, 'utf8');
    assert.equal(waitForDaemon(path, 100, 25), false);
  });
});

test('waitForDaemon never hangs on a zero timeout', () => {
  withTmpDir((dir) => {
    const started = Date.now();
    assert.equal(waitForDaemon(join(dir, 'absent.pid'), 0), false);
    assert.ok(Date.now() - started < 1_000);
  });
});

// --- through the CLI --------------------------------------------------------

const baseDeps = (over: Partial<CliDeps> = {}): CliDeps => ({
  now: () => 1000,
  findTranscript: () => null,
  stopDaemon: () => {},
  ...over,
});

test('/conduct start reports failure when the daemon never comes up', () => {
  withTmpDir((dir) => {
    const result = runConduct(
      ['start'],
      dir,
      baseDeps({
        isDaemonRunning: () => false,
        // Launch "succeeds" — a pid exists — but nothing ever marks itself ready.
        startDaemon: () => {},
        waitForDaemon: () => false,
      }),
    );

    assert.equal(result.exitCode, 1, 'a silent failure must not exit 0');
    assert.match(result.output, /did not start/);
    assert.match(result.output, /conduct-daemon\.log/, 'points at where the reason actually is');
    assert.doesNotMatch(result.output, /^Playing/m);
  });
});

test('/conduct start still reports Playing when the daemon confirms', () => {
  withTmpDir((dir) => {
    const result = runConduct(
      ['start'],
      dir,
      baseDeps({
        isDaemonRunning: () => false,
        startDaemon: () => {},
        waitForDaemon: () => true,
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Playing/);
  });
});

test('an already-running daemon is not re-verified', () => {
  withTmpDir((dir) => {
    let waited = 0;
    const result = runConduct(
      ['start'],
      dir,
      baseDeps({
        isDaemonRunning: () => true,
        startDaemon: () => assert.fail('must not relaunch'),
        waitForDaemon: () => {
          waited++;
          return false;
        },
      }),
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Already playing/);
    assert.equal(waited, 0, 'nothing was started, so there is nothing to confirm');
  });
});

test('unmute reports the boot failure but still unmutes', () => {
  withTmpDir((dir) => {
    const result = runConduct(
      ['unmute'],
      dir,
      baseDeps({
        isDaemonRunning: () => false,
        startDaemon: () => {},
        waitForDaemon: () => false,
      }),
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /Unmuted/, 'the config change took effect regardless');
    assert.match(result.output, /did not start/);

    // And it really did persist, rather than being rolled back with the error.
    const config = JSON.parse(readFileSync(resolvePaths(dir).configPath, 'utf8')) as { mute: boolean };
    assert.equal(config.mute, false);
  });
});

// --- the real thing ---------------------------------------------------------

test('a genuinely broken daemon entrypoint is reported, not announced as Playing', () => {
  // The closest reproduction of CC-14 available without breaking the install:
  // a real spawn of a real command that exits immediately, exactly as
  // `npx tsx <missing file>` did.
  withTmpDir((dir) => {
    const paths = resolvePaths(dir);
    mkdirSync(join(dir, '.claude'), { recursive: true });

    const result = runConduct(
      ['start'],
      dir,
      baseDeps({
        isDaemonRunning: () => false,
        startDaemon: () => {
          // Stand in for `spawn` succeeding: a pid gets written, and dies.
          writeFileSync(paths.pidPath, `${4_194_304}\n`, 'utf8');
        },
        waitForDaemon: (pidPath) => waitForDaemon(pidPath, 150, 25),
      }),
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /did not start/);
    assert.ok(existsSync(paths.pidPath), 'the stale pidfile is left for the next claim to clear');
  });
});
