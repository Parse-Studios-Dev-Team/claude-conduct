import { synthesizeStems, DEFAULT_VOICES, type VoiceSpec } from '../src/audio/synth';
import { tierToGains, stemCount, DEFAULT_LAYOUT } from '../src/audio/tierGains';
import { defaultPanSpecs, type PanSpec } from '../src/audio/mixer';
import type { Tier } from '../src/types';

/**
 * Browser playback of the Conduct engine.
 *
 * The *voices* come from `src/audio/synth.ts` unchanged — that is what makes
 * this sound like the daemon rather than an approximation of it. The transport
 * is native Web Audio instead of the daemon's `Mixer`: one looping
 * `AudioBufferSourceNode` per stem into a `GainNode` (crossfade) into a
 * `StereoPannerNode` (auto-pan). `StereoPannerNode` implements the same
 * equal-power law the `Mixer` does, so the two agree; letting the browser do
 * the per-sample work keeps the UI thread free for the chart.
 */

export interface EngineOptions {
  loopMs?: number;
  crossfadeMs?: number;
  masterGain?: number;
  panSeed?: number;
  voices?: VoiceSpec[];
}

interface Stem {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  pan: PanSpec;
}

export class PlaygroundEngine {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private stems: Stem[] = [];
  private crossfadeMs: number;
  private panTimer: number | null = null;
  private started = false;
  private voices: VoiceSpec[];
  private loopMs: number;
  private panSeed: number;

  constructor(options: EngineOptions = {}) {
    this.context = new AudioContext();
    this.crossfadeMs = options.crossfadeMs ?? 1500;
    this.loopMs = options.loopMs ?? 8000;
    this.voices = options.voices ?? DEFAULT_VOICES;
    this.panSeed = options.panSeed ?? (Date.now() & 0xffffffff);

    this.master = this.context.createGain();
    this.master.gain.value = options.masterGain ?? 0.8;
    this.master.connect(this.context.destination);
  }

  /** Build (or rebuild) the stem graph from the current voice table. */
  build(): void {
    this.teardown();

    const count = stemCount(DEFAULT_LAYOUT);
    const rate = this.context.sampleRate;
    const pcms = synthesizeStems(count, {
      sampleRate: rate,
      loopMs: this.loopMs,
      voices: this.voices,
    });
    const pans = defaultPanSpecs(count, this.panSeed);

    this.stems = pcms.map((pcm, i) => {
      const buffer = this.context.createBuffer(1, pcm.length, rate);
      // `set` rather than `copyToChannel`: the latter's lib.dom signature pins
      // the backing store to ArrayBuffer, which our Float32Array doesn't promise.
      buffer.getChannelData(0).set(pcm);

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gain = this.context.createGain();
      gain.gain.value = 0; // every stem starts silent; tiers fade them in

      const panner = this.context.createStereoPanner();

      source.connect(gain).connect(panner).connect(this.master);
      return { source, gain, panner, pan: pans[i]! };
    });

    if (this.started) this.startSources();
  }

  private startSources(): void {
    const when = this.context.currentTime;
    for (const stem of this.stems) {
      try {
        stem.source.start(when);
      } catch {
        /* already started */
      }
    }
  }

  async start(): Promise<void> {
    if (this.stems.length === 0) this.build();
    await this.context.resume();
    if (!this.started) {
      this.started = true;
      this.startSources();
      this.panTimer = window.setInterval(() => this.updatePan(), 100);
    }
  }

  async suspend(): Promise<void> {
    await this.context.suspend();
  }

  /** Crossfade toward the gains implied by `tier`, exactly as the daemon does. */
  setTier(tier: Tier): void {
    const gains = tierToGains(tier, DEFAULT_LAYOUT);
    const now = this.context.currentTime;
    const seconds = this.crossfadeMs / 1000;

    this.stems.forEach((stem, i) => {
      const target = gains[i] ?? 0;
      stem.gain.gain.cancelScheduledValues(now);
      stem.gain.gain.setValueAtTime(stem.gain.gain.value, now);
      stem.gain.gain.linearRampToValueAtTime(target, now + seconds);
    });
  }

  /** Advance every stem's pan sweep. Mirrors `Mixer.positionOf`. */
  private updatePan(): void {
    const seconds = this.context.currentTime;
    for (const stem of this.stems) {
      const { center, depth, rateHz, phase } = stem.pan;
      const position = Math.max(
        -1,
        Math.min(1, center + depth * Math.sin(2 * Math.PI * (rateHz * seconds + phase))),
      );
      stem.panner.pan.setTargetAtTime(position, seconds, 0.05);
    }
  }

  /** Current pan position per stem — drives the stereo readout in the UI. */
  panPositions(): number[] {
    const seconds = this.context.currentTime;
    return this.stems.map(({ pan }) =>
      Math.max(-1, Math.min(1, pan.center + pan.depth * Math.sin(2 * Math.PI * (pan.rateHz * seconds + pan.phase)))),
    );
  }

  /** Audible gain per stem — drives the layer meters. */
  gains(): number[] {
    return this.stems.map((stem) => stem.gain.gain.value);
  }

  setMasterGain(value: number): void {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, value)), this.context.currentTime, 0.02);
  }

  setCrossfadeMs(ms: number): void {
    this.crossfadeMs = Math.max(1, ms);
  }

  /** Swap the voice table — re-synthesizes and rebuilds the graph. */
  setVoices(voices: VoiceSpec[]): void {
    this.voices = voices;
    this.build();
  }

  /** New stereo arrangement, as if the daemon had just been restarted. */
  reseedPan(seed = (Date.now() & 0xffffffff)): void {
    this.panSeed = seed;
    const pans = defaultPanSpecs(this.stems.length, seed);
    this.stems.forEach((stem, i) => {
      stem.pan = pans[i]!;
    });
  }

  get seed(): number {
    return this.panSeed;
  }

  private teardown(): void {
    for (const stem of this.stems) {
      try {
        stem.source.stop();
      } catch {
        /* never started */
      }
      stem.source.disconnect();
      stem.gain.disconnect();
      stem.panner.disconnect();
    }
    this.stems = [];
  }

  dispose(): void {
    if (this.panTimer !== null) window.clearInterval(this.panTimer);
    this.teardown();
    void this.context.close();
  }
}
