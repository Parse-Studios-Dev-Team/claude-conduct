import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav, resample } from '../src/audio/wav';

/** Build a WAV buffer with an explicit format for decode coverage. */
function buildWav(opts: {
  format: number; // 1 = PCM, 3 = float
  channels: number;
  sampleRate: number;
  bits: number;
  interleaved: number[];
}): Buffer {
  const { format, channels, sampleRate, bits, interleaved } = opts;
  const bytes = bits / 8;
  const dataLen = interleaved.length * bytes;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytes, 28);
  buf.writeUInt16LE(channels * bytes, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (const s of interleaved) {
    if (format === 3) {
      if (bits === 64) buf.writeDoubleLE(s, off);
      else buf.writeFloatLE(s, off);
    } else if (bits === 8) {
      buf.writeUInt8(Math.round(s * 128) + 128, off);
    } else if (bits === 16) {
      buf.writeInt16LE(Math.round(s * 32767), off);
    } else if (bits === 24) {
      let v = Math.round(s * 8388607);
      if (v < 0) v += 0x1000000;
      buf.writeUIntLE(v & 0xffffff, off, 3);
    } else if (bits === 32) {
      buf.writeInt32LE(Math.round(s * 2147483647), off);
    }
    off += bytes;
  }
  return buf;
}

const close = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps;

test('encode → decode round-trips mono 16-bit within quantization', () => {
  const samples = Float32Array.from([0, 0.25, -0.5, 0.999, -0.999, 0.1]);
  const decoded = decodeWav(encodeWav(samples, 44_100));
  assert.equal(decoded.sampleRate, 44_100);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.samples.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    assert.ok(close(decoded.samples[i]!, samples[i]!, 1e-4), `sample ${i}`);
  }
});

test('stereo is downmixed to mono by averaging channels', () => {
  // frames: (L,R) = (1,-1) → 0 ; (0.5,0.5) → 0.5
  const wav = buildWav({ format: 1, channels: 2, sampleRate: 8000, bits: 16, interleaved: [1, -1, 0.5, 0.5] });
  const decoded = decodeWav(wav);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.samples.length, 2);
  assert.ok(close(decoded.samples[0]!, 0, 1e-4));
  assert.ok(close(decoded.samples[1]!, 0.5, 1e-4));
});

test('decodes 32-bit float and 24-bit PCM', () => {
  const f = decodeWav(buildWav({ format: 3, channels: 1, sampleRate: 48000, bits: 32, interleaved: [0.3, -0.7] }));
  assert.ok(close(f.samples[0]!, 0.3, 1e-6) && close(f.samples[1]!, -0.7, 1e-6));

  const p24 = decodeWav(buildWav({ format: 1, channels: 1, sampleRate: 48000, bits: 24, interleaved: [0.42, -0.42] }));
  assert.ok(close(p24.samples[0]!, 0.42, 1e-5) && close(p24.samples[1]!, -0.42, 1e-5));
});

test('decodeWav rejects a non-RIFF buffer', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav at all!!')));
});

test('resample changes length by the rate ratio and is a no-op when rates match', () => {
  const ramp = Float32Array.from([0, 0.25, 0.5, 0.75]);
  assert.equal(resample(ramp, 1000, 1000), ramp); // same ref, no work
  const up = resample(ramp, 1000, 2000);
  assert.equal(up.length, 8); // doubled
  assert.ok(close(up[0]!, 0, 1e-6)); // first sample preserved
});
