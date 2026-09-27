import type { Voice } from '../src/arranger';
import { mulberry32 } from '../src/rng';
import { PRE_DAWN, SkyClock } from '../src/skyclock';
import { PALM_PATHS } from './brand';

/**
 * The sky: the same day the music is in, drawn.
 *
 * Built to be glanced at, not watched: slow gradients, no flashing. Everything
 * runs on the clock rather than the frame count, and nothing changes in a single
 * frame — the time of day glides after the session it follows, lanterns and
 * stars fade in and out, and a new day comes up from the east instead of the old
 * one running backwards.
 */

export interface Lantern {
  seat: number;
  /** Mid-turn. */
  working: boolean;
  /** Waiting on the model — breathes. */
  waiting: boolean;
  focused: boolean;
}

export interface SkyState {
  /** Where the focused session's context puts the day, `0..1`. The sky gets there at its own pace. */
  day: number;
  stars: number;
  lanterns: Lantern[];
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
  voice: Voice;
  wobble: number;
}

/** A lantern as drawn: every property eases toward what its session is doing. */
interface Lamp {
  presence: number;
  base: number;
  focus: number;
  breath: number;
  /** Recent notes, decaying. */
  glow: number;
  target: Lantern | null;
}

type RGB = [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/**
 * Sky colours through the day: top, middle, horizon.
 *
 * Keyed to where sessions actually live, not to the ends of the range. A fresh
 * session already holds 4–6% of a 1M window (system prompt, tools, memory),
 * which is day ≈ 0.15 — so dawn's peach has to still be there at 0.15, or a new
 * session would never look like morning at all.
 */
const KEYS: Array<[number, RGB, RGB, RGB]> = [
  [0.0, hex('#27335e'), hex('#9a6488'), hex('#f2ae84')],
  [0.15, hex('#33477e'), hex('#a7789c'), hex('#f7bf93')],
  [0.26, hex('#4c6fae'), hex('#b3b9dc'), hex('#fbdcc0')],
  [0.36, hex('#4a86cf'), hex('#96c1ea'), hex('#e3eff8')],
  [0.5, hex('#3d66a4'), hex('#d9a266'), hex('#ffcf86')],
  [0.66, hex('#1e2552'), hex('#6b3d78'), hex('#dd7657')],
  [0.82, hex('#080c20'), hex('#141b3c'), hex('#2a305a')],
  [1.0, hex('#03050f'), hex('#0a0f26'), hex('#161c3c')],
];

/**
 * Sun height above the horizon (`0..1` of its arc) through the day, from the
 * hour before dawn until it's well under the western hills.
 */
const SUN: Array<[number, number]> = [
  [-PRE_DAWN, -0.42],
  [0.0, -0.02],
  [0.15, 0.3],
  [0.28, 0.72],
  [0.38, 0.95],
  [0.46, 0.7],
  [0.55, 0.32],
  [0.66, 0.08],
  [0.73, -0.08],
  [0.86, -0.42],
  [1.0, -0.42],
];

/**
 * A smooth curve through `keys` (monotone cubic): it passes through every key
 * without overshooting, and without the stop-and-start that easing each segment
 * separately gives — a sun that pauses at every key visibly hitches.
 */
function curve(keys: ReadonlyArray<readonly [number, number]>): (x: number) => number {
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const n = keys.length;
  const secant: number[] = [];
  for (let i = 0; i < n - 1; i++) secant.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!));
  const slope: number[] = [secant[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = secant[i - 1]!;
    const b = secant[i]!;
    if (a * b <= 0) {
      slope.push(0);
      continue;
    }
    const h0 = xs[i]! - xs[i - 1]!;
    const h1 = xs[i + 1]! - xs[i]!;
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    slope.push((w1 + w2) / (w1 / a + w2 / b));
  }
  slope.push(secant[n - 2]!);

  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * slope[i]! +
      (3 * t2 - 2 * t3) * ys[i + 1]! +
      (t3 - t2) * h * slope[i + 1]!
    );
  };
}

const sunHeight = curve(SUN);

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (c: RGB, alpha = 1): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
const smooth = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
/** Move `from` toward `to`, covering 63% of the way every `tau` seconds. */
const ease = (from: number, to: number, tau: number, dt: number): number => from + (to - from) * (1 - Math.exp(-dt / tau));

function skyAt(day: number): [RGB, RGB, RGB] {
  if (day < 0) {
    // Before dawn the horizon warms first and the top of the sky last.
    const f = (day + PRE_DAWN) / PRE_DAWN;
    const [, t1, m1, h1] = KEYS[KEYS.length - 1]!;
    const [, t0, m0, h0] = KEYS[0]!;
    return [mix(t1, t0, smooth(0.3, 1, f)), mix(m1, m0, smooth(0.15, 0.9, f)), mix(h1, h0, smooth(0, 0.75, f))];
  }
  for (let i = 1; i < KEYS.length; i++) {
    const [d1, t1, m1, h1] = KEYS[i]!;
    const [d0, t0, m0, h0] = KEYS[i - 1]!;
    if (day <= d1) {
      const t = (day - d0) / (d1 - d0);
      return [mix(t0, t1, t), mix(m0, m1, t), mix(h0, h1, t)];
    }
  }
  const last = KEYS[KEYS.length - 1]!;
  return [last[1], last[2], last[3]];
}

/** How dark it is, `0..1`, at a position on the sky's clock. */
const nightAt = (c: number): number =>
  c <= 1 ? smooth(0.58, 0.85, c) : 1 - smooth(1 + PRE_DAWN * 0.15, 1 + PRE_DAWN * 0.9, c);

const SUN_WHITE = hex('#fff6dc');
const SUN_ORANGE = hex('#ff9a5a');
const WHITE: RGB = [255, 255, 255];

const NOTE_COLORS: Record<Voice, string> = {
  keys: '#ffc9d6',
  bass: '#ffd59a',
  lead: '#d9c6ff',
  arp: '#a8f0ff',
  sparkle: '#ffffff',
};

/** Seat → where its lantern stands, left to right. Matches the stereo seats. */
const SEAT_X = [0.5, 0.3, 0.7, 0.14, 0.86, 0.6];

/** Stars twinkle in this many groups, each one path — not a fill per star. */
const TWINKLE_GROUPS = 12;

export class Sky {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private state: SkyState = { day: 0, stars: 0, lanterns: [] };
  private readonly stars: Array<[number, number, number, number]> = [];
  private shownStars = 0;
  private starPaths: { key: string; groups: Array<{ path: Path2D; phase: number; bright: number }> } | null = null;
  private motes: Mote[] = [];
  private readonly moteSprites = new Map<Voice, HTMLCanvasElement>();
  private rings: Array<{ x: number; born: number }> = [];
  private meteors: Array<{ x: number; y: number; born: number; angle: number }> = [];
  private readonly lamps = new Map<number, Lamp>();
  readonly clock = new SkyClock();
  private flareAt = -Infinity;
  private width = 0;
  private height = 0;
  /** Where the hills meet the sky — kept above the session cards so the lanterns show. */
  private horizon = 0;
  private last = 0;
  private running = false;
  readonly reducedMotion: boolean;
  /** Frame timings, for the preview harness. */
  readonly stats = { frames: 0, drawMs: 0, worstDrawMs: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d')!;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 1200; i++) this.stars.push([rng(), rng() * 0.78, 0.4 + rng() * 1.3, rng() * Math.PI * 2]);
    const resize = (): void => this.resize();
    window.addEventListener('resize', resize);
    resize();
  }

  /**
   * What to show. The sky eases toward it; `snap` puts it there at once — for
   * the moment you tune in, so you don't sit watching dawn catch up.
   */
  set(state: SkyState, snap = false): void {
    this.state = state;
    if (snap) {
      this.clock.snap(state.day);
      this.shownStars = state.stars;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (t: number): void => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      // Up to 60 a second, evenly: a 120 Hz screen draws every other refresh
      // rather than whenever a frame budget happens to line up with one.
      if (this.last > 0 && t - this.last < 1000 / 60 - 4) return;
      // A hidden tab stops the loop; coming back, pick up where it left off.
      const dt = this.last > 0 ? Math.min(0.1, (t - this.last) / 1000) : 0;
      this.last = t;
      const began = performance.now();
      this.draw(t, dt);
      const took = performance.now() - began;
      this.stats.frames += 1;
      this.stats.drawMs += (took - this.stats.drawMs) * 0.05;
      this.stats.worstDrawMs = Math.max(this.stats.worstDrawMs, took);
    };
    requestAnimationFrame(loop);
  }

  /** A note sounded: a mote leaves its lantern. */
  note(seat: number, voice: Voice, velocity: number): void {
    const x = this.lanternX(seat);
    const y = this.ridge(x) - 10;
    const lamp = this.lamp(seat);
    lamp.glow = Math.min(1, lamp.glow + 0.25 + velocity * 0.3);
    if (this.motes.length > 260) this.motes.shift();
    this.motes.push({
      x: x + (Math.random() - 0.5) * 18,
      y,
      vx: (Math.random() - 0.5) * 10,
      vy: -(18 + velocity * 26) * (this.reducedMotion ? 0 : 1),
      born: performance.now(),
      life: voice === 'sparkle' ? 6000 : 4200,
      size: (1.6 + velocity * 3) * (voice === 'sparkle' ? 1.4 : voice === 'arp' ? 0.7 : 1),
      voice,
      wobble: Math.random() * Math.PI * 2,
    });
  }

  chime(seat: number): void {
    this.rings.push({ x: this.lanternX(seat), born: performance.now() });
  }

  /** The music's sunrise: the sun swells. */
  sunrise(): void {
    this.flareAt = performance.now();
  }

  /** A level earned: a shooting star across the upper sky. */
  shootingStar(): void {
    if (this.reducedMotion) return;
    this.meteors.push({
      x: this.width * (0.2 + Math.random() * 0.5),
      y: this.horizon * (0.08 + Math.random() * 0.25),
      born: performance.now(),
      angle: 0.35 + Math.random() * 0.25,
    });
  }

  /** The sun's swell after a sunrise: up over a second and a half, then fading. */
  private flare(now: number): number {
    const age = (now - this.flareAt) / 1000;
    if (!(age >= 0) || age > 20) return 0;
    return smooth(0, 1.6, age) * Math.exp(-Math.max(0, age - 1.6) / 3.2);
  }

  // ── pieces ─────────────────────────────────────────────────────────────────

  private lamp(seat: number): Lamp {
    let lamp = this.lamps.get(seat);
    if (!lamp) {
      lamp = { presence: 0, base: 0.22, focus: 0, breath: 0, glow: 0, target: null };
      this.lamps.set(seat, lamp);
    }
    return lamp;
  }

  private readonly palmPaths = PALM_PATHS.map((d) => new Path2D(d));
  private palm: {
    height: number;
    mask: HTMLCanvasElement;
    glow: HTMLCanvasElement;
    tint: HTMLCanvasElement;
    tinted: string;
    ox: number;
    oy: number;
  } | null = null;

  /**
   * Parse Studios' palm, standing on the right-hand hill: a faint line on the
   * landscape by day, a soft teal glow after dark. The sun sets behind it.
   *
   * Its seven traced paths are too much to fill every frame, so they're drawn
   * once per size into two sprites — the shape, and the shape glowing — and the
   * sky crossfades between them.
   */
  private drawPalm(night: number, top: RGB): void {
    // In the mark's own units: the trunk meets the ground at (2060, 1350), and
    // the fronds top out at y 170.
    const height = Math.round(Math.min(150, Math.max(70, this.horizon * 0.22)));
    if (this.palm?.height !== height) {
      const scale = height / 1180;
      const pad = 24;
      const w = Math.ceil(2840 * scale) + pad * 2;
      const h = Math.ceil(2040 * scale) + pad * 2;
      const sprite = (fill: string, glow: boolean): HTMLCanvasElement => {
        const canvas = document.createElement('canvas');
        canvas.width = w * 2;
        canvas.height = h * 2;
        const p = canvas.getContext('2d')!;
        p.scale(2, 2);
        p.translate(pad, pad);
        p.scale(scale, scale);
        // The mark's potrace transform: translate(0, 2040) scale(0.1, -0.1).
        p.translate(0, 2040);
        p.scale(0.1, -0.1);
        p.fillStyle = fill;
        if (glow) {
          p.shadowColor = 'rgba(110,184,180,0.7)';
          p.shadowBlur = 20;
        }
        for (const path of this.palmPaths) p.fill(path);
        return canvas;
      };
      const tint = document.createElement('canvas');
      tint.width = w * 2;
      tint.height = h * 2;
      this.palm = {
        height,
        mask: sprite('#fff', false),
        glow: sprite('rgba(110,184,180,0.72)', true),
        tint,
        tinted: '',
        ox: pad + 2060 * scale,
        oy: pad + 1350 * scale,
      };
    }

    const palm = this.palm!;
    const x = this.width * 0.86 - palm.ox;
    const y = this.ridge(this.width * 0.86) + 3 - palm.oy;
    const w = palm.mask.width / 2;
    const h = palm.mask.height / 2;

    // By day it takes a lighter shade of the sky.
    const shade = rgb(mix(top, WHITE, 0.3));
    if (palm.tinted !== shade) {
      const t = palm.tint.getContext('2d')!;
      t.globalCompositeOperation = 'copy';
      t.drawImage(palm.mask, 0, 0);
      t.globalCompositeOperation = 'source-in';
      t.fillStyle = shade;
      t.fillRect(0, 0, palm.tint.width, palm.tint.height);
      palm.tinted = shade;
    }
    const g = this.g;
    if (night < 0.997) {
      g.globalAlpha = 0.32 * (1 - night);
      g.drawImage(palm.tint, x, y, w, h);
    }
    if (night > 0.003) {
      g.globalAlpha = night;
      g.drawImage(palm.glow, x, y, w, h);
    }
    g.globalAlpha = 1;
  }

  private moon: { r: number; sprite: HTMLCanvasElement } | null = null;

  /**
   * The moon as a sprite: a disc with a bite cut out of it. Cut, not painted
   * over — painting the bite in sky colour also blots out the halo behind it,
   * and the crescent reads as an eclipse. Drawn at 2× and scaled down.
   */
  private crescent(r: number): HTMLCanvasElement {
    if (this.moon && this.moon.r === r) return this.moon.sprite;
    const sprite = document.createElement('canvas');
    const size = Math.ceil(r * 2 + 4);
    sprite.width = size * 2;
    sprite.height = size * 2;
    const g = sprite.getContext('2d')!;
    g.scale(2, 2);
    g.fillStyle = 'rgb(236,240,255)';
    g.beginPath();
    g.arc(r + 2, r + 2, r, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(r + 2 + r * 0.5, r + 2 - r * 0.22, r * 0.88, 0, Math.PI * 2);
    g.fill();
    this.moon = { r, sprite };
    return sprite;
  }

  /** A soft dot of light in a note's colour, drawn once and stamped for every mote. */
  private moteSprite(voice: Voice): HTMLCanvasElement {
    let sprite = this.moteSprites.get(voice);
    if (!sprite) {
      sprite = document.createElement('canvas');
      sprite.width = sprite.height = 64;
      const g = sprite.getContext('2d')!;
      const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      glow.addColorStop(0, NOTE_COLORS[voice]);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, 64, 64);
      this.moteSprites.set(voice, sprite);
    }
    return sprite;
  }

  /** The first `count` stars, grouped by twinkle into a few paths. Rebuilt only when a star arrives. */
  private starGroups(count: number): Array<{ path: Path2D; phase: number; bright: number }> {
    const key = `${count}:${this.width}:${this.horizon}`;
    if (this.starPaths?.key === key) return this.starPaths.groups;
    const groups = Array.from({ length: TWINKLE_GROUPS * 2 }, (_, i) => ({
      path: new Path2D(),
      phase: ((i % TWINKLE_GROUPS) / TWINKLE_GROUPS) * Math.PI * 2,
      bright: i < TWINKLE_GROUPS ? 0.5 + 0.7 * 0.3 : 0.5 + 1.4 * 0.3,
    }));
    for (let i = 0; i < count; i++) {
      const [sx, sy, size, phase] = this.stars[i]!;
      const group = Math.floor((phase / (Math.PI * 2)) * TWINKLE_GROUPS) % TWINKLE_GROUPS;
      const { path } = groups[group + (size < 1.05 ? 0 : TWINKLE_GROUPS)]!;
      const x = sx * this.width;
      const y = sy * this.horizon;
      path.moveTo(x + size * 0.8, y);
      path.arc(x, y, size * 0.8, 0, Math.PI * 2);
    }
    this.starPaths = { key, groups };
    return groups;
  }

  private lanternX(seat: number): number {
    return (SEAT_X[seat % SEAT_X.length] ?? 0.5) * this.width;
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.horizon = Math.min(this.height * 0.74, this.height - 225);
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Height of the front hills at `x`. */
  private ridge(x: number): number {
    const h = this.height;
    const u = x / Math.max(1, this.width);
    return this.horizon - Math.sin(u * 5.1 + 0.6) * h * 0.022 - Math.sin(u * 11.3 + 2) * h * 0.012;
  }

  // ── the frame ──────────────────────────────────────────────────────────────

  private draw(t: number, dt: number): void {
    const { g, width: w, height: h, horizon } = this;
    const now = performance.now();
    this.clock.advance(this.state.day, dt);
    const c = this.clock.position;
    const day = this.clock.day;
    const [top, middle, low] = skyAt(day);
    const night = nightAt(c);

    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, rgb(top));
    sky.addColorStop(0.62, rgb(middle));
    sky.addColorStop(1, rgb(low));
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // Stars: every thousand output tokens is one, visible once it gets dark.
    // Each new one fades in.
    this.shownStars = ease(this.shownStars, Math.min(this.stars.length, this.state.stars), 1.2, dt);
    const whole = Math.floor(this.shownStars);
    const starAlpha = Math.max(night, 0.06 * (1 - smooth(0, 0.1, day)));
    if (starAlpha > 0.01 && this.shownStars > 0.01) {
      for (const { path, phase, bright } of this.starGroups(whole)) {
        const twinkle = this.reducedMotion ? 1 : 0.7 + 0.3 * Math.sin(t / 900 + phase);
        g.fillStyle = `rgba(255,250,235,${starAlpha * twinkle * bright})`;
        g.fill(path);
      }
      const arriving = this.stars[whole];
      if (arriving) {
        const [sx, sy, size, phase] = arriving;
        const twinkle = this.reducedMotion ? 1 : 0.7 + 0.3 * Math.sin(t / 900 + phase);
        g.fillStyle = `rgba(255,250,235,${starAlpha * twinkle * (0.5 + size * 0.3) * (this.shownStars - whole)})`;
        g.beginPath();
        g.arc(sx * w, sy * horizon, size * 0.8, 0, Math.PI * 2);
        g.fill();
      }
    }

    // The sun comes up through dawn, peaks mid-morning, is low by golden hour
    // and gone by dusk, fading as it goes under the hills rather than blinking
    // out; the moon rises for the night and fades before the next dawn.
    const elevation = sunHeight(day);
    const sunAlpha = smooth(-0.34, -0.04, elevation);
    if (sunAlpha > 0.003) {
      const flare = this.flare(now);
      const x = w * (0.1 + 0.8 * (day / 0.73));
      const y = horizon - elevation * horizon * 0.62 + h * 0.02;
      const warm = smooth(0.4, 0.7, day) + smooth(0.24, 0.08, day);
      const core: RGB = mix(SUN_WHITE, SUN_ORANGE, Math.min(1, warm));
      const radius = Math.min(w, h) * (0.045 + flare * 0.03);
      const reach = radius * (5 + flare * 4);
      const halo = g.createRadialGradient(x, y, 0, x, y, reach);
      halo.addColorStop(0, rgb(core, (0.55 + flare * 0.3) * sunAlpha));
      halo.addColorStop(0.2, rgb(core, 0.18 * sunAlpha));
      halo.addColorStop(1, rgb(core, 0));
      g.fillStyle = halo;
      g.fillRect(x - reach, y - reach, reach * 2, reach * 2);
      g.fillStyle = rgb(core, 0.95 * sunAlpha);
      g.beginPath();
      g.arc(x, y, radius, 0, Math.PI * 2);
      g.fill();
    }
    const moonAlpha = smooth(0.7, 0.8, c) * (1 - smooth(1, 1 + PRE_DAWN * 0.8, c));
    if (moonAlpha > 0.003) {
      const moonT = (c - 0.7) / 0.3;
      const x = w * (0.12 + 0.5 * moonT);
      const y = horizon - h * 0.16 - moonT * horizon * 0.45;
      const r = Math.min(w, h) * 0.028;
      const halo = g.createRadialGradient(x, y, 0, x, y, r * 6);
      halo.addColorStop(0, `rgba(220,228,255,${0.22 * moonAlpha})`);
      halo.addColorStop(1, 'rgba(220,228,255,0)');
      g.fillStyle = halo;
      g.fillRect(x - r * 6, y - r * 6, r * 12, r * 12);
      g.globalAlpha = 0.9 * moonAlpha;
      const size = Math.ceil(r * 2 + 4);
      g.drawImage(this.crescent(r), x - r - 2, y - r - 2, size, size);
      g.globalAlpha = 1;
    }

    // Hills: far, then near.
    const far = mix(low, top, 0.55);
    g.fillStyle = rgb(mix(far, [10, 12, 24], 0.35 + night * 0.4));
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) {
      const u = x / w;
      g.lineTo(x, horizon - h * 0.06 - Math.sin(u * 3.3 + 1.2) * h * 0.035 - Math.sin(u * 8.7) * h * 0.012);
    }
    g.lineTo(w, h);
    g.fill();

    g.fillStyle = rgb(mix(top, [6, 8, 16], 0.55 + night * 0.35));
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) g.lineTo(x, this.ridge(x));
    g.lineTo(w, h);
    g.fill();

    // The studio's palm, on the western hill — where the sun goes down.
    this.drawPalm(night, top);

    // Lanterns: one per session, in its seat. They fade in when a session
    // arrives and out when it goes, and ease between working and resting.
    for (const lamp of this.lamps.values()) lamp.target = null;
    for (const lantern of this.state.lanterns) this.lamp(lantern.seat).target = lantern;
    for (const [seat, lamp] of this.lamps) {
      const target = lamp.target;
      lamp.presence = ease(lamp.presence, target ? 1 : 0, 0.5, dt);
      if (!target && lamp.presence < 0.01) {
        this.lamps.delete(seat);
        continue;
      }
      if (target) {
        lamp.base = ease(lamp.base, target.working ? 0.55 : 0.22, 0.6, dt);
        lamp.focus = ease(lamp.focus, target.focused ? 1 : 0, 0.4, dt);
        lamp.breath = ease(lamp.breath, target.waiting && !this.reducedMotion ? 1 : 0, 0.8, dt);
      }
      lamp.glow *= Math.exp(-dt / 0.4);

      const x = this.lanternX(seat);
      const y = this.ridge(x) - 6;
      const breathe = lamp.breath * (0.5 + 0.5 * Math.sin(t / 700));
      const strength = Math.min(1, lamp.base + lamp.glow * 0.6 + breathe * 0.25) * lamp.presence;
      const r = 26 + strength * 34 + lamp.focus * 8;
      const halo = g.createRadialGradient(x, y, 0, x, y, r);
      halo.addColorStop(0, `rgba(255,214,150,${0.65 * strength})`);
      halo.addColorStop(0.3, `rgba(255,190,120,${0.22 * strength})`);
      halo.addColorStop(1, 'rgba(255,190,120,0)');
      g.fillStyle = halo;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.fillStyle = `rgba(255,236,200,${(0.5 + strength * 0.5) * lamp.presence})`;
      g.beginPath();
      g.arc(x, y, 3.5 + lamp.focus, 0, Math.PI * 2);
      g.fill();
    }

    // The doorbell: a ring spreading from the lantern whose turn just ended.
    this.rings = this.rings.filter((ring) => now - ring.born < 3000);
    for (const ring of this.rings) {
      const age = (now - ring.born) / 3000;
      const y = this.ridge(ring.x) - 6;
      g.strokeStyle = `rgba(255,245,225,${0.5 * (1 - age)})`;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(ring.x, y, 12 + age * 120, 0, Math.PI * 2);
      g.stroke();
    }

    // Shooting stars: a level earned.
    this.meteors = this.meteors.filter((m) => now - m.born < 1400);
    for (const m of this.meteors) {
      const age = (now - m.born) / 1400;
      const travel = age * Math.min(w, 900) * 0.45;
      const hx = m.x + Math.cos(m.angle) * travel;
      const hy = m.y + Math.sin(m.angle) * travel;
      const length = 90 * (1 - age * 0.5);
      const trail = g.createLinearGradient(hx, hy, hx - Math.cos(m.angle) * length, hy - Math.sin(m.angle) * length);
      const alpha = Math.sin(Math.PI * age);
      trail.addColorStop(0, `rgba(255,248,230,${0.9 * alpha})`);
      trail.addColorStop(1, 'rgba(255,248,230,0)');
      g.strokeStyle = trail;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(hx - Math.cos(m.angle) * length, hy - Math.sin(m.angle) * length);
      g.stroke();
    }

    // Notes, drifting up like fireflies.
    this.motes = this.motes.filter((m) => now - m.born < m.life);
    const drag = Math.pow(0.995, dt * 30);
    for (const m of this.motes) {
      const age = (now - m.born) / m.life;
      m.x += (m.vx + Math.sin(now / 600 + m.wobble) * 6) * dt;
      m.y += m.vy * dt;
      m.vy *= drag;
      const alpha = Math.sin(Math.PI * Math.min(1, age * 1.2)) * (1 - age * 0.3);
      if (alpha <= 0) continue;
      const s = m.size * 4;
      g.globalAlpha = alpha * 0.85;
      g.drawImage(this.moteSprite(m.voice), m.x - s, m.y - s, s * 2, s * 2);
    }
    g.globalAlpha = 1;
  }
}
