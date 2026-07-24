/**
 * Where rendered audio blocks go. Abstracting the output lets the daemon run
 * headless (tests, or a machine without an audio lib) while still producing real
 * sound when the optional `speaker` package is available.
 */
export interface Sink {
  readonly sampleRate: number;
  /** Consume one mono block of `Float32` samples in `[-1, 1]`. */
  write(block: Float32Array): void;
  /** Release the output device / stop. Idempotent. */
  close(): void;
}

/** Discards audio. Used in tests and as the graceful fallback when `speaker` isn't installed. */
export class NullSink implements Sink {
  constructor(readonly sampleRate: number = 44_100) {}
  write(_block: Float32Array): void {
    /* discard */
  }
  close(): void {
    /* nothing to release */
  }
}

/**
 * Create a real audio sink backed by the optional native `speaker` package
 * (16-bit mono PCM to the system device). Not a declared dependency — install
 * it (`npm i speaker`) to hear output. Throws a clear error if it's unavailable,
 * so callers can fall back to {@link NullSink}.
 */
export async function createSpeakerSink(sampleRate = 44_100): Promise<Sink> {
  let SpeakerCtor: new (opts: unknown) => { write(b: Buffer): void; end(): void };
  try {
    // @ts-ignore — optional native dependency, intentionally not installed by default
    const mod = await import('speaker');
    SpeakerCtor = (mod.default ?? mod) as typeof SpeakerCtor;
  } catch {
    throw new Error("real audio output needs the optional 'speaker' package: npm i speaker");
  }

  const speaker = new SpeakerCtor({ channels: 1, bitDepth: 16, sampleRate });
  let open = true;

  return {
    sampleRate,
    write(block: Float32Array): void {
      if (!open) return;
      const buf = Buffer.allocUnsafe(block.length * 2);
      for (let i = 0; i < block.length; i++) {
        const s = Math.max(-1, Math.min(1, block[i]!));
        buf.writeInt16LE(Math.round(s * 32767), i * 2);
      }
      speaker.write(buf);
    },
    close(): void {
      if (!open) return;
      open = false;
      try {
        speaker.end();
      } catch {
        /* best-effort */
      }
    },
  };
}
