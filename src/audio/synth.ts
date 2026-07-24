/**
 * Placeholder stem generator. Until CC-4 delivers real loopable stems, the
 * daemon runs on synthesized tones so it is fully runnable and testable. Each
 * stem is a **seamless** mono loop: it holds an integer number of cycles over a
 * shared loop length, so the wrap point is phase-continuous (no click) and all
 * stems stay phase-locked with each other.
 *
 * The default pitches spell a fixed C-major stack (matching v1's "fixed-key"
 * decision), so any subset played together sounds intentional.
 */

// C3 E3 G3 C4 E4 G4 C5 — a consonant stack; index i → stem i's pitch.
const DEFAULT_SCALE_HZ = [130.81, 164.81, 196.0, 261.63, 329.63, 392.0, 523.25];

export interface SynthOptions {
  sampleRate?: number;
  /** Loop length in ms (shared by all stems). Default 2000. */
  loopMs?: number;
  /** Override the per-stem pitches (Hz). */
  scaleHz?: number[];
}

/**
 * Generate `count` seamless placeholder stems as mono `Float32Array` loops, all
 * the same length.
 */
export function synthesizeStems(count: number, options?: SynthOptions): Float32Array[] {
  const sampleRate = options?.sampleRate ?? 44_100;
  const loopMs = options?.loopMs ?? 2_000;
  const scale = options?.scaleHz && options.scaleHz.length > 0 ? options.scaleHz : DEFAULT_SCALE_HZ;

  const loopLength = Math.max(1, Math.round((loopMs / 1000) * sampleRate));
  const stems: Float32Array[] = [];

  for (let i = 0; i < count; i++) {
    const targetHz = scale[i % scale.length]!;
    // Round to a whole number of cycles across the loop so it wraps seamlessly.
    const cycles = Math.max(1, Math.round((targetHz * loopLength) / sampleRate));
    const buffer = new Float32Array(loopLength);
    for (let n = 0; n < loopLength; n++) {
      const phase = (2 * Math.PI * cycles * n) / loopLength;
      // Fundamental plus a soft second harmonic; low amplitude to leave mix headroom.
      buffer[n] = 0.2 * Math.sin(phase) + 0.05 * Math.sin(2 * phase);
    }
    stems.push(buffer);
  }

  return stems;
}
