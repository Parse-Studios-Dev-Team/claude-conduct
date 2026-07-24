import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStems } from '../src/audio/loadStems';
import { encodeWav } from '../src/audio/wav';

function withTmpDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'conduct-stems-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a WAV of `len` samples all equal to `value` at `sampleRate`. */
function writeConstWav(path: string, value: number, len = 16, sampleRate = 44_100): void {
  writeFileSync(path, encodeWav(Float32Array.from({ length: len }, () => value), sampleRate));
}

test('loads .wav files in lexical order when there is no manifest', () => {
  withTmpDir((dir) => {
    for (let i = 0; i < 6; i++) writeConstWav(join(dir, `0${i + 1}-layer.wav`), i * 0.1);
    const stems = loadStems(dir, { count: 6, sampleRate: 44_100 });
    assert.equal(stems.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.ok(Math.abs(stems[i]![0]! - i * 0.1) < 1e-4, `stem ${i} value/order`);
    }
  });
});

test('a stems.json manifest sets the order explicitly', () => {
  withTmpDir((dir) => {
    writeConstWav(join(dir, 'c.wav'), 0.3);
    writeConstWav(join(dir, 'a.wav'), 0.1);
    writeConstWav(join(dir, 'b.wav'), 0.2);
    writeFileSync(join(dir, 'stems.json'), JSON.stringify({ files: ['a.wav', 'b.wav', 'c.wav'] }));
    const stems = loadStems(dir, { count: 3, sampleRate: 44_100 });
    assert.ok(Math.abs(stems[0]![0]! - 0.1) < 1e-4);
    assert.ok(Math.abs(stems[1]![0]! - 0.2) < 1e-4);
    assert.ok(Math.abs(stems[2]![0]! - 0.3) < 1e-4);
  });
});

test('stems recorded at another rate are resampled to the target', () => {
  withTmpDir((dir) => {
    writeConstWav(join(dir, '01.wav'), 0.5, 100, 22_050);
    const [stem] = loadStems(dir, { count: 1, sampleRate: 44_100 });
    assert.equal(stem!.length, 200); // 100 * 44100/22050
  });
});

test('throws when the directory has fewer stems than the layout needs', () => {
  withTmpDir((dir) => {
    writeConstWav(join(dir, '01.wav'), 0.1);
    writeConstWav(join(dir, '02.wav'), 0.2);
    assert.throws(() => loadStems(dir, { count: 6, sampleRate: 44_100 }), /found 2/);
  });
});

test('throws when the directory does not exist', () => {
  assert.throws(() => loadStems('/no/such/conduct-stems-dir', { count: 1, sampleRate: 44_100 }));
});
