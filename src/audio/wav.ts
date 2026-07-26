/**
 * Minimal WAV (RIFF/WAVE) codec — enough to load real stem files and to export
 * the synth placeholders for preview. Decoding downmixes to mono `Float32`;
 * encoding writes mono 16-bit PCM.
 *
 * Supports PCM 8/16/24/32-bit and IEEE float 32/64-bit, any channel count
 * (averaged to mono), including WAVE_FORMAT_EXTENSIBLE.
 */

export interface DecodedWav {
  sampleRate: number;
  /** Original channel count (before the mono downmix). */
  channels: number;
  /** Mono samples in `[-1, 1]`. */
  samples: Float32Array;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

interface Fmt {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function parseFmt(buf: Buffer, body: number, size: number): Fmt {
  let audioFormat = buf.readUInt16LE(body);
  const channels = buf.readUInt16LE(body + 2);
  const sampleRate = buf.readUInt32LE(body + 4);
  const bitsPerSample = buf.readUInt16LE(body + 14);
  // Extensible: the true format is the first 2 bytes of the SubFormat GUID.
  if (audioFormat === FORMAT_EXTENSIBLE && size >= 26) {
    audioFormat = buf.readUInt16LE(body + 24);
  }
  return { audioFormat, channels, sampleRate, bitsPerSample };
}

/** Read one sample at byte offset `off` as a float in `[-1, 1]`. */
function readSample(buf: Buffer, off: number, format: number, bits: number): number {
  if (format === FORMAT_FLOAT) {
    return bits === 64 ? buf.readDoubleLE(off) : buf.readFloatLE(off);
  }
  // PCM integer
  switch (bits) {
    case 8:
      return (buf.readUInt8(off) - 128) / 128; // 8-bit WAV is unsigned
    case 16:
      return buf.readInt16LE(off) / 32768;
    case 24: {
      const unsigned = buf.readUIntLE(off, 3);
      const signed = unsigned >= 0x800000 ? unsigned - 0x1000000 : unsigned;
      return signed / 8388608;
    }
    case 32:
      return buf.readInt32LE(off) / 2147483648;
    default:
      throw new Error(`unsupported PCM bit depth: ${bits}`);
  }
}

/** Decode a WAV buffer to mono float samples. Throws on anything it can't read. */
export function decodeWav(buf: Buffer): DecodedWav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt: Fmt | undefined;
  let dataOff = -1;
  let dataLen = 0;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = parseFmt(buf, body, size);
    else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body); // clamp streaming/oversized sizes
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) throw new Error('missing fmt chunk');
  if (dataOff < 0) throw new Error('missing data chunk');
  if (fmt.audioFormat !== FORMAT_PCM && fmt.audioFormat !== FORMAT_FLOAT) {
    throw new Error(`unsupported WAV format: ${fmt.audioFormat}`);
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  const channels = Math.max(1, fmt.channels);
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const mono = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const frameOff = dataOff + f * frameBytes;
    for (let c = 0; c < channels; c++) {
      sum += readSample(buf, frameOff + c * bytesPerSample, fmt.audioFormat, fmt.bitsPerSample);
    }
    mono[f] = sum / channels;
  }

  return { sampleRate: fmt.sampleRate, channels, samples: mono };
}

/**
 * Linear-resample a mono loop to a new rate. Neighbors wrap around the end, so a
 * seamless loop stays seamless. Returns the input unchanged when rates match.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(samples.length * (toRate / fromRate)));
  const out = new Float32Array(outLen);
  const n = samples.length;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos) % n;
    const frac = pos - Math.floor(pos);
    const a = samples[idx]!;
    const b = samples[(idx + 1) % n]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Encode float samples as a 16-bit PCM WAV buffer. Pass `channels: 2` with
 * interleaved `[L, R, …]` input to write a stereo file.
 */
export function encodeWav(samples: Float32Array, sampleRate: number, channels = 1): Buffer {
  const ch = Math.max(1, Math.round(channels));
  const bytesPerFrame = 2 * ch;
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(FORMAT_PCM, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerFrame, 28); // byte rate
  buf.writeUInt16LE(bytesPerFrame, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}
