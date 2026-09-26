import { midiToHz } from '../src/harmony';
import type { BeatPlan, DrumPiece, Mix, PlannedNote } from '../src/arranger';

/**
 * The radio's sound: a lo-fi band, synthesized in Web Audio.
 *
 * Every choice here is about smoothness:
 *
 * - **Harmonic timbres only.** A 1:1 FM Rhodes, sines and triangles. No
 *   inharmonic bells, no raw sawtooths — those are what made the first version
 *   harsh.
 * - **Everything is darkened.** A warm lowpass on the whole mix (lower at night),
 *   another on each bus, and a gentle tape saturator that rounds peaks off.
 * - **Tape wobble is shared.** One slow LFO bends every pitched voice by the same
 *   few cents, so the whole band drifts together — the lo-fi warble — and never
 *   drifts *against* itself.
 * - **The chords breathe with the kick.** Keys, pad and arpeggio duck a little
 *   on every kick, the pump that makes a lo-fi loop feel like it's moving.
 * - A compressor keeps the dynamic range narrow, so nothing leaps out.
 */

export interface EngineSettings {
  volume: number;
  /** Vinyl crackle and hiss, `0..1`. */
  vinyl: number;
  /** How late the offbeat sixteenths land, as a fraction of a sixteenth. */
  swing: number;
}

export const DEFAULT_ENGINE: EngineSettings = { volume: 0.7, vinyl: 0.35, swing: 0.22 };

interface Voice {
  midi: number;
  gain: GainNode;
  oscs: OscillatorNode[];
}

/** A note, scheduled — reported back so the sky can draw it when it sounds. */
export interface Sounded {
  time: number;
  note: PlannedNote;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * The balance between the band's buses, measured rather than guessed. The first
 * pass had the sub band 31 dB over the mids — a kick and bass burying the
 * Rhodes, which is meant to be the star. These put the sub about 6 dB over the
 * mids, which is warm without being boomy, and set the melody on top of the keys.
 */
const BUS = { keys: 2.8, lead: 3.2, arp: 2.8, pad: 2, bass: 0.25, drums: 0.45 };

export class Engine {
  readonly ctx: AudioContext;
  private readonly settings: EngineSettings;

  private readonly master: GainNode;
  private readonly music: GainNode;
  private readonly warmth: BiquadFilterNode;
  private readonly reverb: ConvolverNode;
  private readonly pump: GainNode;
  private readonly keysBus: GainNode;
  private readonly padBus: GainNode;
  private readonly arpBus: GainNode;
  private readonly leadBus: GainNode;
  private readonly bassBus: GainNode;
  private readonly drumBus: GainNode;
  private readonly wow: GainNode;
  private readonly vinylGain: GainNode;
  private readonly white: AudioBuffer;
  private readonly pink: AudioBuffer;

  private pad: Voice[] = [];
  private sweepUntil = 0;

  constructor(settings: EngineSettings = DEFAULT_ENGINE) {
    this.settings = { ...settings };
    // `playback` trades a little latency for far fewer glitches in a background
    // tab — which is where focus music lives.
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.ctx;

    // master ← compressor ← tape ← warmth ← music
    this.master = ctx.createGain();
    this.master.gain.value = settings.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 14;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.02;
    comp.release.value = 0.35;
    comp.connect(this.master).connect(ctx.destination);

    const tape = ctx.createWaveShaper();
    tape.curve = softClip(1.3);
    tape.oversample = '2x';
    tape.connect(comp);

    this.warmth = ctx.createBiquadFilter();
    this.warmth.type = 'lowpass';
    this.warmth.frequency.value = 8_500;
    this.warmth.Q.value = 0.5;
    this.warmth.connect(tape);

    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 32;
    rumble.connect(this.warmth);

    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.music.connect(rumble);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.4);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.3;
    this.reverb.connect(reverbReturn).connect(this.music);

    // Tape wobble: one LFO, shared by every pitched voice.
    const wowLfo = ctx.createOscillator();
    wowLfo.frequency.value = 0.33;
    this.wow = ctx.createGain();
    this.wow.gain.value = 4; // cents
    wowLfo.connect(this.wow);
    wowLfo.start();

    // Keys, pad and arpeggio share the pump.
    this.pump = ctx.createGain();
    this.pump.connect(this.music);

    // Keys: a slow tremolo pan, the Rhodes-suitcase sway, then darkened.
    this.keysBus = ctx.createGain();
    this.keysBus.gain.value = BUS.keys;
    const sway = ctx.createStereoPanner();
    const swayLfo = ctx.createOscillator();
    swayLfo.frequency.value = 2.2;
    const swayDepth = ctx.createGain();
    swayDepth.gain.value = 0.14;
    swayLfo.connect(swayDepth).connect(sway.pan);
    swayLfo.start();
    this.keysBus.connect(sway).connect(lowpass(ctx, 4_200)).connect(this.pump);
    this.keysBus.connect(this.send(0.22));

    this.padBus = ctx.createGain();
    this.padBus.gain.value = BUS.pad;
    this.padBus.connect(lowpass(ctx, 1_300)).connect(this.pump);
    this.padBus.connect(this.send(0.45));

    this.arpBus = ctx.createGain();
    this.arpBus.gain.value = BUS.arp;
    this.arpBus.connect(lowpass(ctx, 2_600)).connect(this.pump);
    this.arpBus.connect(this.send(0.38));

    this.leadBus = ctx.createGain();
    this.leadBus.gain.value = BUS.lead;
    this.leadBus.connect(lowpass(ctx, 3_400)).connect(this.music);
    this.leadBus.connect(this.send(0.3));

    this.bassBus = ctx.createGain();
    this.bassBus.gain.value = BUS.bass;
    this.bassBus.connect(lowpass(ctx, 420)).connect(this.music);

    // Drums: saturated and dusty — rounded, never bright.
    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = BUS.drums;
    const grit = ctx.createWaveShaper();
    grit.curve = softClip(1.8);
    this.drumBus.connect(grit).connect(lowpass(ctx, 9_000)).connect(this.music);
    this.drumBus.connect(this.send(0.06));

    this.white = this.noiseBuffer(2, 'white');
    this.pink = this.noiseBuffer(3, 'pink');

    // Vinyl sits after the warmth filter, so a sunrise sweep doesn't take it with it.
    this.vinylGain = ctx.createGain();
    this.vinylGain.gain.value = settings.vinyl * 0.55;
    const vinyl = ctx.createBufferSource();
    vinyl.buffer = this.vinylBuffer(12);
    vinyl.loop = true;
    const vinylTone = ctx.createBiquadFilter();
    vinylTone.type = 'bandpass';
    vinylTone.frequency.value = 2_400;
    vinylTone.Q.value = 0.4;
    vinyl.connect(vinylTone).connect(this.vinylGain).connect(tape);
    vinyl.start();
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  pause(): Promise<void> {
    return this.ctx.suspend();
  }

  setVolume(volume: number): void {
    this.settings.volume = volume;
    this.master.gain.setTargetAtTime(volume, this.now, 0.08);
  }

  setVinyl(vinyl: number): void {
    this.settings.vinyl = vinyl;
    this.vinylGain.gain.setTargetAtTime(vinyl * 0.55, this.now, 0.3);
  }

  /** Continuous parameters: the time of day's warmth, and how present the band is. */
  applyMix(mix: Mix, time: number): void {
    const t = Math.max(time, this.now);
    if (t >= this.sweepUntil) {
      // A little darker as the night goes on — late-night lo-fi.
      this.warmth.frequency.setTargetAtTime(lerp(8_500, 4_600, Math.pow(mix.day, 1.2)), t, 3);
    }
    this.music.gain.setTargetAtTime(0.9 * mix.presence, t, mix.presence < 1 ? 6 : 1.5);
  }

  /** Schedule one beat. Returns the notes, with their times, for the visuals. */
  play(plan: BeatPlan, time: number, beatSeconds: number): Sounded[] {
    const sixteenth = beatSeconds / 4;
    const at = (step: number): number =>
      time + step * sixteenth + (step % 2 === 1 ? this.settings.swing * sixteenth : 0);

    if (plan.pad) this.repad(plan.pad, time);

    for (const hit of plan.drums) this.drum(hit.piece, hit.velocity, at(hit.step));

    const sounded: Sounded[] = [];
    for (const note of plan.notes) {
      // Chords are strummed, a few milliseconds a voice; everything else gets a
      // hair of human timing.
      const t = at(note.step) + note.strum * 0.013 + (Math.random() - 0.5) * 0.006;
      this.note(note, t, note.beats * beatSeconds);
      sounded.push({ time: t, note });
    }

    if (plan.flourish === 'levelup') this.swell(time, beatSeconds);
    if (plan.flourish === 'sunrise') this.sweep(time, beatSeconds);
    return sounded;
  }

  // ── pad ──────────────────────────────────────────────────────────────────

  /** Held notes stay; the rest fade out as the new ones fade in. */
  private repad(voicing: number[], time: number): void {
    const keep: Voice[] = [];
    const wanted = [...voicing];
    for (const voice of this.pad) {
      const i = wanted.indexOf(voice.midi);
      if (i >= 0) {
        wanted.splice(i, 1);
        keep.push(voice);
      } else {
        this.release(voice, time, 0.9);
      }
    }
    for (const midi of wanted) keep.push(this.padVoice(midi, time));
    this.pad = keep;
  }

  private padVoice(midi: number, time: number): Voice {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.setTargetAtTime(0.03, time, 1.1);
    gain.connect(this.padBus);
    const oscs = [-6, 6].map((cents) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(midi);
      osc.detune.value = cents;
      this.wow.connect(osc.detune);
      osc.connect(gain);
      osc.start(time);
      return osc;
    });
    return { midi, gain, oscs };
  }

  private release(voice: Voice, time: number, tau: number): void {
    voice.gain.gain.cancelScheduledValues(time);
    voice.gain.gain.setTargetAtTime(0, time, tau);
    for (const osc of voice.oscs) osc.stop(time + tau * 7);
    voice.oscs[0]!.onended = () => {
      voice.gain.disconnect();
      for (const osc of voice.oscs) this.unwow(osc);
    };
  }

  // ── notes ────────────────────────────────────────────────────────────────

  private note(note: PlannedNote, t: number, seconds: number): void {
    const ctx = this.ctx;
    const f = midiToHz(note.midi);
    const v = note.velocity;
    const end = t + Math.max(0.08, seconds);
    const oscs: OscillatorNode[] = [];

    const out = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = note.pan;
    out.connect(pan);
    let bus: GainNode = this.keysBus;
    let extraSend: GainNode | null = null;

    const osc = (type: OscillatorType, hz: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz;
      this.wow.connect(o.detune);
      oscs.push(o);
      return o;
    };
    /** Attack to `peak`, fall toward `sustain × peak`, release at the note's end. */
    const shape = (g: GainNode, peak: number, attack: number, decay: number, sustain: number, releaseTau: number): void => {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setTargetAtTime(peak * sustain, t + attack, decay);
      g.gain.setTargetAtTime(0, end, releaseTau);
    };

    let tail = 1.6;
    switch (note.voice) {
      case 'keys':
      case 'sparkle': {
        // Rhodes: a 1:1 FM pair — harmonic, so it can't clash with itself —
        // whose brightness fades quickly, over a faint tine.
        const carrier = osc('sine', f);
        const mod = osc('sine', f);
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(f * 0.85, t);
        depth.gain.setTargetAtTime(f * 0.12, t, 0.35);
        mod.connect(depth).connect(carrier.frequency);
        const body = ctx.createGain();
        const sparkle = note.voice === 'sparkle';
        shape(body, (sparkle ? 0.05 : 0.07) * v, 0.006, 0.9, 0.38, sparkle ? 0.7 : 0.22);
        carrier.connect(body).connect(out);
        const tine = ctx.createGain();
        tine.gain.setValueAtTime(0, t);
        tine.gain.linearRampToValueAtTime(0.012 * v, t + 0.003);
        tine.gain.setTargetAtTime(0, t + 0.003, 0.05);
        osc('sine', f * 4).connect(tine).connect(out);
        if (sparkle) extraSend = this.send(0.4);
        tail = sparkle ? 4 : 1.8;
        break;
      }
      case 'bass': {
        bus = this.bassBus;
        const g = ctx.createGain();
        shape(g, 0.3 * v, 0.012, 0.6, 0.8, 0.07);
        osc('sine', f).connect(g);
        const edge = ctx.createGain();
        edge.gain.value = 0.12;
        osc('triangle', f).connect(edge).connect(g);
        g.connect(out);
        tail = 0.8;
        break;
      }
      case 'lead': {
        // A soft, flute-ish sine with a little breath of harmonics, and a
        // vibrato that only arrives once the note has settled.
        bus = this.leadBus;
        const g = ctx.createGain();
        shape(g, 0.055 * v, 0.035, 0.5, 0.72, 0.2);
        const main = osc('sine', f);
        main.connect(g);
        const second = ctx.createGain();
        second.gain.value = 0.1;
        osc('sine', f * 2).connect(second).connect(g);
        const vibrato = ctx.createOscillator();
        vibrato.frequency.value = 4.8;
        const vibratoDepth = ctx.createGain();
        vibratoDepth.gain.setValueAtTime(0, t);
        vibratoDepth.gain.linearRampToValueAtTime(0, t + 0.25);
        vibratoDepth.gain.linearRampToValueAtTime(8, t + 0.6);
        vibrato.connect(vibratoDepth).connect(main.detune);
        vibrato.start(t);
        vibrato.stop(end + 1.2);
        g.connect(out);
        tail = 1.2;
        break;
      }
      case 'arp': {
        bus = this.arpBus;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.04 * v, t + 0.004);
        g.gain.setTargetAtTime(0, t + 0.004, 0.2);
        osc('triangle', f).connect(g).connect(out);
        tail = 1.2;
        break;
      }
    }

    pan.connect(bus);
    if (extraSend) pan.connect(extraSend);

    for (const o of oscs) {
      o.start(t);
      o.stop(end + tail);
    }
    oscs[0]!.onended = () => {
      pan.disconnect();
      extraSend?.disconnect();
      for (const o of oscs) this.unwow(o);
    };
  }

  private unwow(osc: OscillatorNode): void {
    try {
      this.wow.disconnect(osc.detune);
    } catch {
      /* never connected */
    }
  }

  // ── drums ────────────────────────────────────────────────────────────────

  private drum(piece: DrumPiece, velocity: number, t: number): void {
    const ctx = this.ctx;
    const v = velocity;
    const out = ctx.createGain();
    out.connect(this.drumBus);

    if (piece === 'kick') {
      // Round and low; no click.
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(92, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(0.6 * v, t + 0.004);
      out.gain.setTargetAtTime(0, t + 0.004, 0.13);
      o.connect(out);
      o.start(t);
      o.stop(t + 0.8);
      o.onended = () => out.disconnect();
      // The pump: chords dip under the kick and swell back.
      this.pump.gain.setTargetAtTime(0.72, t, 0.008);
      this.pump.gain.setTargetAtTime(1, t + 0.05, 0.14);
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const filter = ctx.createBiquadFilter();
    let peak = 0;
    let attack = 0.002;
    let decay = 0.03;
    switch (piece) {
      case 'snare': {
        filter.type = 'bandpass';
        filter.frequency.value = 1_700;
        filter.Q.value = 0.7;
        peak = 0.2;
        decay = 0.065;
        // A little body under the noise, so it's a thud rather than a hiss.
        const body = ctx.createOscillator();
        body.frequency.setValueAtTime(190, t);
        body.frequency.exponentialRampToValueAtTime(150, t + 0.08);
        const bodyGain = ctx.createGain();
        bodyGain.gain.setValueAtTime(0, t);
        bodyGain.gain.linearRampToValueAtTime(0.1 * v, t + 0.002);
        bodyGain.gain.setTargetAtTime(0, t + 0.002, 0.04);
        body.connect(bodyGain).connect(out);
        body.start(t);
        body.stop(t + 0.4);
        break;
      }
      case 'hat':
        filter.type = 'highpass';
        filter.frequency.value = 7_000;
        peak = 0.075;
        decay = 0.02;
        break;
      case 'openhat':
        filter.type = 'highpass';
        filter.frequency.value = 6_500;
        peak = 0.035;
        decay = 0.14;
        break;
      case 'shaker':
        filter.type = 'bandpass';
        filter.frequency.value = 6_500;
        filter.Q.value = 1;
        peak = 0.03;
        attack = 0.009;
        decay = 0.024;
        break;
    }
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(peak * v, t + attack);
    out.gain.setTargetAtTime(0, t + attack, decay);
    src.connect(filter).connect(out);
    src.start(t, Math.random() * 1.4, 0.6);
    src.onended = () => out.disconnect();
  }

  // ── flourishes ───────────────────────────────────────────────────────────

  /** A level-up: a soft whoosh rising into the downbeat where the new layer lands. */
  private swell(time: number, beatSeconds: number): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(600, time);
    filter.frequency.exponentialRampToValueAtTime(4_500, time + beatSeconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.1, time + beatSeconds);
    g.gain.linearRampToValueAtTime(0, time + beatSeconds + 0.04);
    src.connect(filter).connect(g).connect(this.music);
    g.connect(this.send(0.5));
    src.start(time, 0, beatSeconds + 0.1);
    src.onended = () => g.disconnect();
  }

  /** A sunrise: the whole mix closes down, then opens back up over two bars. */
  private sweep(time: number, beatSeconds: number): void {
    const f = this.warmth.frequency;
    f.cancelScheduledValues(time);
    f.setTargetAtTime(420, time, 0.2);
    f.setTargetAtTime(8_500, time + beatSeconds * 2, beatSeconds * 1.6);
    this.sweepUntil = time + beatSeconds * 8;
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private send(amount: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = amount;
    g.connect(this.reverb);
    return g;
  }

  /** A dark room: decaying stereo noise that loses its top end as it fades. */
  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = this.ctx.createBuffer(2, length, rate);
    const predelay = Math.floor(0.018 * rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let lp = 0;
      for (let i = predelay; i < length; i++) {
        const t = (i - predelay) / (length - predelay);
        const coeff = 0.72 + 0.26 * t;
        lp = lp * coeff + (Math.random() * 2 - 1) * (1 - coeff);
        data[i] = lp * Math.pow(1 - t, 2.6) * 3;
      }
    }
    return buffer;
  }

  private noiseBuffer(seconds: number, colour: 'white' | 'pink'): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        if (colour === 'white') {
          data[i] = w * 0.5;
        } else {
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
        }
      }
    }
    return buffer;
  }

  /** Vinyl: a low hiss with dust — sparse, soft clicks and the odd pop. */
  private vinylBuffer(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let b0 = 0;
      let b1 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.995 * b0 + w * 0.05;
        b1 = 0.9 * b1 + w * 0.1;
        data[i] = (b0 + b1) * 0.05;
      }
      // Dust: ~14 soft clicks a second, a pop every couple of seconds.
      const clicks = Math.floor(seconds * 14);
      for (let k = 0; k < clicks; k++) {
        const at = Math.floor(Math.random() * (length - 40));
        const pop = Math.random() < 0.035;
        const amp = (pop ? 0.35 : 0.05 + Math.random() * 0.12) * (Math.random() < 0.5 ? -1 : 1);
        const width = pop ? 24 : 4 + Math.floor(Math.random() * 6);
        for (let j = 0; j < width; j++) data[at + j]! += amp * Math.exp(-j / (width / 3));
      }
    }
    return buffer;
  }
}

function lowpass(ctx: AudioContext, hz: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = hz;
  f.Q.value = 0.6;
  return f;
}

/** A tanh curve, normalized: rounds peaks off gently, like tape. */
function softClip(drive: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}
