/**
 * Where rendered audio blocks go. Abstracting the output lets the daemon run
 * headless (tests, or a machine without an audio lib) while still producing real
 * sound when the optional `speaker` package is available.
 *
 * The interface is **backpressure-aware**: `write` returns whether the sink can
 * take more immediately, and `drain` resolves when it can again. The daemon
 * writes ahead until the sink is full, then waits — which keeps the audio device
 * continuously fed and avoids the underrun pops a fixed-interval feed produces.
 */
/** Samples per frame in every block moving through the audio path. */
export const CHANNELS = 2;

export interface Sink {
  readonly sampleRate: number;
  /**
   * Consume one block of **interleaved stereo** `Float32` samples in `[-1, 1]`
   * (`[L, R, L, R, …]`, so `block.length` is `frames * 2`). Returns `false` when
   * full.
   */
  write(block: Float32Array): boolean;
  /** Resolves when the sink is ready for more data after `write` returned `false`. */
  drain(): Promise<void>;
  /** Release the output device / stop. Idempotent. */
  close(): void;
}

/**
 * Discards audio but paces itself at real time (one block per its own duration),
 * so a silent daemon doesn't busy-loop. Used in tests and as the graceful
 * fallback when `speaker` isn't installed.
 */
export class NullSink implements Sink {
  private pendingMs = 0;
  constructor(readonly sampleRate: number = 44_100) {}
  write(block: Float32Array): boolean {
    // Blocks are interleaved stereo, so frames are half the sample count.
    this.pendingMs = (block.length / CHANNELS / this.sampleRate) * 1000;
    return false; // always "full" → the pump waits ~one block, keeping it real-time
  }
  drain(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pendingMs));
  }
  close(): void {
    /* nothing to release */
  }
}

interface SpeakerStream {
  write(chunk: Buffer): boolean;
  once(event: string, cb: () => void): void;
  on(event: string, cb: () => void): void;
  end(): void;
}

/**
 * Create a real audio sink backed by the optional native `speaker` package
 * (16-bit interleaved stereo PCM to the system device). Not a declared
 * dependency — install
 * it (`npm i speaker`) to hear output. Throws a clear error if it's unavailable,
 * so callers can fall back to {@link NullSink}.
 *
 * Playback is driven by stream backpressure: a generous write-ahead buffer plus
 * `drain`-paced writes keep the device fed regardless of event-loop jitter, so
 * there are no underrun clicks.
 */
export async function createSpeakerSink(sampleRate = 44_100): Promise<Sink> {
  let SpeakerCtor: new (opts: unknown) => SpeakerStream;
  try {
    // @ts-ignore — optional native dependency, intentionally not installed by default
    const mod = await import('speaker');
    SpeakerCtor = (mod.default ?? mod) as typeof SpeakerCtor;
  } catch {
    throw new Error("real audio output needs the optional 'speaker' package: npm i speaker");
  }

  // ~0.4s of write-ahead so timer/GC jitter can't starve the device (that's what clicks).
  const bytesPerFrame = 2 * CHANNELS;
  const highWaterMark = Math.max(4096, Math.round(sampleRate * bytesPerFrame * 0.4));
  const speaker = new SpeakerCtor({ channels: CHANNELS, bitDepth: 16, sampleRate, highWaterMark });

  let open = true;
  let notifyDrain: (() => void) | null = null;
  speaker.on('drain', () => {
    const resolve = notifyDrain;
    notifyDrain = null;
    resolve?.();
  });

  return {
    sampleRate,
    write(block: Float32Array): boolean {
      if (!open) return false;
      const buf = Buffer.allocUnsafe(block.length * 2);
      for (let i = 0; i < block.length; i++) {
        const s = Math.max(-1, Math.min(1, block[i]!));
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
      }
      return speaker.write(buf);
    },
    drain(): Promise<void> {
      if (!open) return Promise.resolve();
      return new Promise((resolve) => {
        notifyDrain = resolve;
      });
    },
    close(): void {
      if (!open) return;
      open = false;
      const resolve = notifyDrain; // unblock any pending drain so the pump loop can exit
      notifyDrain = null;
      resolve?.();
      try {
        speaker.end();
      } catch {
        /* best-effort */
      }
    },
  };
}
