import { Mixer, type MixerOptions } from '../audio/mixer';
import { tierToGains, DEFAULT_LAYOUT, type StemLayout } from '../audio/tierGains';
import type { Sink } from '../audio/sink';
import type { Tier } from '../types';

export interface ConductorOptions extends MixerOptions {
  /** Stem layout used to translate a tier into gains. Default {@link DEFAULT_LAYOUT}. */
  layout?: StemLayout;
  /** Samples rendered per block. Default 1024. */
  blockFrames?: number;
}

/**
 * The daemon's "brain": owns the {@link Mixer} and pushes rendered blocks to a
 * {@link Sink}. Transport-free (no fs, no timers), so it's fully testable with a
 * capturing sink. {@link ConductDaemon} wraps it with a file watcher and pacing.
 */
export class Conductor {
  readonly mixer: Mixer;
  readonly blockFrames: number;
  private readonly sink: Sink;
  private readonly layout: StemLayout;

  constructor(stems: Float32Array[], sink: Sink, options?: ConductorOptions) {
    this.sink = sink;
    this.layout = options?.layout ?? DEFAULT_LAYOUT;
    this.blockFrames = Math.max(1, Math.round(options?.blockFrames ?? 1024));
    // Force the mixer to the sink's rate so output timing is correct.
    this.mixer = new Mixer(stems, { ...options, sampleRate: sink.sampleRate });
  }

  /** Crossfade toward the gains implied by `tier`. */
  setTier(tier: Tier): void {
    this.mixer.setTargets(tierToGains(tier, this.layout));
  }

  /** Render one block and hand it to the sink. */
  renderBlock(): void {
    this.sink.write(this.mixer.render(this.blockFrames));
  }

  close(): void {
    this.sink.close();
  }
}
