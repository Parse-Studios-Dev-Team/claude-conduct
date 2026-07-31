import { Mixer } from './audio/mixer';
import { synthesizeStems, type VoiceSpec } from './audio/synth';
import { tierToGains, DEFAULT_LAYOUT, stemCount } from './audio/tierGains';
import { scoreSession, type Moment, type ScoreOptions, type TurnSignals } from './sessionScore';

/**
 * CC-10 — render a scored session to interleaved stereo PCM.
 *
 * Separate from the daemon's {@link Conductor} on purpose: the daemon renders
 * *forever*, block by block, reacting to whatever tier arrives next. This
 * renders a *finite* piece whose whole shape is known up front, which is what
 * lets it fade in, fade out, and vary the crossfade rate per span.
 */

/**
 * Sustained colour tones above the core stack: the 9th, the ♯11th and the 13th.
 *
 * Deliberately drift-free. The five core voices are already wandering between
 * chord tones, and the whole point of these three is to state, unambiguously,
 * that the harmony has opened up — a moving target can't do that. Low peaks:
 * they tint the chord rather than joining it.
 */
export const EXTENSION_VOICES: VoiceSpec[] = [
  // 9th — E5. The first thing a `max`-effort span adds.
  {
    hz: 659.26,
    partials: [1, 0.24, 0.09],
    detune: [0, 1.5],
    lfoCycles: 4,
    lfoDepth: 0.3,
    phase: 0.15,
    peak: 0.075,
  },
  // ♯11th — G♯4. Outside the key signature; the lydian brightening that only
  // the most demanding spans earn.
  {
    hz: 415.3,
    partials: [1, 0.2, 0.07],
    detune: [0, -1.5],
    lfoCycles: 6,
    lfoDepth: 0.36,
    phase: 0.55,
    peak: 0.062,
  },
  // 13th — B4. Rounds the stack out without adding tension.
  {
    hz: 493.88,
    partials: [1, 0.26, 0.1, 0.03],
    detune: [0, 2],
    lfoCycles: 3,
    lfoDepth: 0.32,
    phase: 0.85,
    peak: 0.07,
  },
];

export interface RenderOptions extends ScoreOptions {
  sampleRate?: number;
  /** Master gain applied to the whole piece. */
  masterGain?: number;
  /** Fade applied at each end so the file opens and closes from silence. */
  edgeFadeMs?: number;
  /** Deterministic stereo placement; fixed by default so renders are reproducible. */
  panSeed?: number;
}

export const DEFAULT_RENDER_OPTIONS: Required<Omit<RenderOptions, keyof ScoreOptions>> = {
  sampleRate: 44_100,
  masterGain: 0.85,
  edgeFadeMs: 2_500,
  panSeed: 0x5eed,
};

export interface RenderedPiece {
  /** Interleaved stereo samples, `[L, R, L, R, …]`. */
  pcm: Float32Array;
  sampleRate: number;
  durationMs: number;
  moments: Moment[];
}

/** Build the stem bank: the daemon's seven, plus three harmonic extensions. */
export function buildStems(sampleRate: number): Float32Array[] {
  const core = synthesizeStems(stemCount(DEFAULT_LAYOUT), { sampleRate });
  const extensions = synthesizeStems(EXTENSION_VOICES.length, {
    sampleRate,
    voices: EXTENSION_VOICES,
  });
  return [...core, ...extensions];
}

/**
 * Apply a linear fade to the first and last `edgeFadeMs` of an interleaved
 * stereo buffer, in place. Renders start with every gain at zero anyway, but the
 * *tail* is a hard cut without this.
 */
function applyEdgeFades(pcm: Float32Array, sampleRate: number, edgeFadeMs: number): void {
  const frames = pcm.length / 2;
  const fade = Math.min(Math.round((edgeFadeMs / 1000) * sampleRate), Math.floor(frames / 2));
  if (fade <= 0) return;

  for (let f = 0; f < fade; f++) {
    const k = f / fade;
    pcm[f * 2]! *= k;
    pcm[f * 2 + 1]! *= k;

    const tail = frames - 1 - f;
    pcm[tail * 2]! *= k;
    pcm[tail * 2 + 1]! *= k;
  }
}

/**
 * Render already-scored moments to PCM.
 *
 * The cadence flag pulls a span back toward the tonic — the base stems close to
 * root-and-fifth and the extensions drop out — which is what a turn handing
 * control back to you sounds like.
 */
export function renderMoments(moments: Moment[], options?: RenderOptions): RenderedPiece {
  const opts = { ...DEFAULT_RENDER_OPTIONS, ...options };
  const stems = buildStems(opts.sampleRate);

  const mixer = new Mixer(stems, {
    sampleRate: opts.sampleRate,
    masterGain: opts.masterGain,
    panSeed: opts.panSeed,
  });

  const blocks: Float32Array[] = [];
  let totalFrames = 0;

  for (const moment of moments) {
    mixer.setCrossfadeMs(moment.crossfadeMs);

    const base = tierToGains(moment.tier, DEFAULT_LAYOUT);
    const targets = moment.cadence
      ? // Resolve: hold the root and fifth, let the colour fall away.
        [...base.map((g, i) => (i < 2 ? g : g * 0.25)), 0, 0, 0]
      : [...base, ...moment.extensions];

    mixer.setTargets(targets);

    const frames = Math.max(1, Math.round((moment.durationMs / 1000) * opts.sampleRate));
    blocks.push(mixer.render(frames));
    totalFrames += frames;
  }

  const pcm = new Float32Array(totalFrames * 2);
  let offset = 0;
  for (const block of blocks) {
    pcm.set(block, offset);
    offset += block.length;
  }

  applyEdgeFades(pcm, opts.sampleRate, opts.edgeFadeMs);

  return {
    pcm,
    sampleRate: opts.sampleRate,
    durationMs: (totalFrames / opts.sampleRate) * 1000,
    moments,
  };
}

/** Score a session's turns and render the result in one call. */
export function renderSession(turns: TurnSignals[], options?: RenderOptions): RenderedPiece {
  return renderMoments(scoreSession(turns, options), options);
}
