import type { Voice } from '../src/arranger';
import { mulberry32 } from '../src/rng';
import { PALM_PATHS } from './brand';

/**
 * The sky: the same day the music is in, drawn.
 *
 * Built to be glanced at, not watched — slow gradients, no flashing, 30fps. The
 * one thing that moves quickly is a note leaving a lantern, and even that drifts.
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
  color: string;
  wobble: number;
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

/** Sun height above the horizon (`0..1` of its arc) through the day. */
const SUN: Array<[number, number]> = [
  [0.0, -0.02],
  [0.15, 0.16],
  [0.28, 0.72],
  [0.38, 0.95],
  [0.46, 0.7],
  [0.55, 0.32],
  [0.66, 0.08],
  [0.73, -0.08],
];

function sunHeight(day: number): number {
  for (let i = 1; i < SUN.length; i++) {
    const [d1, h1] = SUN[i]!;
    const [d0, h0] = SUN[i - 1]!;
    if (day <= d1) {
      const t = (day - d0) / (d1 - d0);
      return h0 + (h1 - h0) * (t * t * (3 - 2 * t));
    }
  }
  return -1;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgb = (c: RGB, alpha = 1): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${alpha})`;
const smooth = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function skyAt(day: number): [RGB, RGB, RGB] {
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

const NOTE_COLORS: Record<Voice, string> = {
  keys: '#ffc9d6',
  bass: '#ffd59a',
  lead: '#d9c6ff',
  arp: '#a8f0ff',
  sparkle: '#ffffff',
};

/** Seat → where its lantern stands, left to right. Matches the stereo seats. */
const SEAT_X = [0.5, 0.3, 0.7, 0.14, 0.86, 0.6];

export class Sky {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private state: SkyState = { day: 0, stars: 0, lanterns: [] };
  private readonly stars: Array<[number, number, number, number]> = [];
  private motes: Mote[] = [];
  private rings: Array<{ x: number; born: number }> = [];
  private meteors: Array<{ x: number; y: number; born: number; angle: number }> = [];
  private flare = 0;
  private glow = new Map<number, number>();
  private width = 0;
  private height = 0;
  /** Where the hills meet the sky — kept above the session cards so the lanterns show. */
  private horizon = 0;
  private last = 0;
  private running = false;
  readonly reducedMotion: boolean;

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

  set(state: SkyState): void {
    this.state = state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (t: number): void => {
      if (!this.running) return;
      // 30fps is plenty for a sky, and half the battery of 60.
      if (t - this.last >= 1000 / 30) {
        this.last = t;
        this.draw(t);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** A note sounded: a mote leaves its lantern. */
  note(seat: number, voice: Voice, velocity: number): void {
    const x = this.lanternX(seat);
    const y = this.ridge(x) - 10;
    this.glow.set(seat, Math.min(1, (this.glow.get(seat) ?? 0) + 0.25 + velocity * 0.3));
    if (this.motes.length > 260) this.motes.shift();
    const now = performance.now();
    this.motes.push({
      x: x + (Math.random() - 0.5) * 18,
      y,
      vx: (Math.random() - 0.5) * 10,
      vy: -(18 + velocity * 26) * (this.reducedMotion ? 0 : 1),
      born: now,
      life: voice === 'sparkle' ? 6000 : 4200,
      size: (1.6 + velocity * 3) * (voice === 'sparkle' ? 1.4 : voice === 'arp' ? 0.7 : 1),
      color: NOTE_COLORS[voice],
      wobble: Math.random() * Math.PI * 2,
    });
  }

  chime(seat: number): void {
    this.rings.push({ x: this.lanternX(seat), born: performance.now() });
  }

  sunrise(): void {
    this.flare = 1;
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

  private readonly palmPaths = PALM_PATHS.map((d) => new Path2D(d));
  private palmSprite: { key: string; canvas: HTMLCanvasElement; ox: number; oy: number } | null = null;

  /**
   * Parse Studios' palm, standing on the right-hand hill: a faint line on the
   * landscape by day, a soft teal glow after dark. The sun sets behind it.
   *
   * Rendered once per size and light into a sprite — its seven traced paths,
   * with a glow, are too much to fill thirty times a second.
   */
  private drawPalm(night: number, top: RGB): void {
    // In the mark's own units: the trunk meets the ground at (2060, 1350), and
    // the fronds top out at y 170.
    const height = Math.min(150, Math.max(70, this.horizon * 0.22));
    const scale = height / 1180;
    const glow = Math.round(night * 10) / 10;
    const key = `${Math.round(height)}:${glow}:${top.map(Math.round).join(',')}`;

    if (this.palmSprite?.key !== key) {
      const pad = 24;
      const w = Math.ceil(2840 * scale) + pad * 2;
      const h = Math.ceil(2040 * scale) + pad * 2;
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
      const day: RGB = mix(top, [255, 255, 255], 0.3);
      const teal: RGB = [110, 184, 180];
      p.fillStyle = rgb(mix(day, teal, glow), 0.32 + glow * 0.4);
      if (glow > 0) {
        p.shadowColor = `rgba(110,184,180,${0.7 * glow})`;
        p.shadowBlur = 10 * glow * 2;
      }
      for (const path of this.palmPaths) p.fill(path);
      this.palmSprite = { key, canvas, ox: pad + 2060 * scale, oy: pad + 1350 * scale };
    }

    const sprite = this.palmSprite!;
    const x = this.width * 0.86;
    const y = this.ridge(x) + 3;
    this.g.drawImage(sprite.canvas, x - sprite.ox, y - sprite.oy, sprite.canvas.width / 2, sprite.canvas.height / 2);
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

  private draw(t: number): void {
    const { g, width: w, height: h, horizon } = this;
    const { day } = this.state;
    const [top, middle, low] = skyAt(day);
    const night = smooth(0.58, 0.85, day);

    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, rgb(top));
    sky.addColorStop(0.62, rgb(middle));
    sky.addColorStop(1, rgb(low));
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // Stars: every thousand output tokens is one, visible once it gets dark.
    const count = Math.min(this.stars.length, Math.floor(this.state.stars));
    const starAlpha = Math.max(night, 0.06 * (1 - smooth(0, 0.1, day)));
    if (starAlpha > 0.01) {
      for (let i = 0; i < count; i++) {
        const [sx, sy, size, phase] = this.stars[i]!;
        const twinkle = this.reducedMotion ? 1 : 0.7 + 0.3 * Math.sin(t / 900 + phase);
        g.fillStyle = `rgba(255,250,235,${starAlpha * twinkle * (0.5 + size * 0.3)})`;
        g.beginPath();
        g.arc(sx * w, sy * horizon, size * 0.8, 0, Math.PI * 2);
        g.fill();
      }
    }

    // The sun rises through dawn, peaks mid-morning, is low by golden hour and
    // gone by dusk; the moon rises for the night.
    const elevation = sunHeight(day);
    if (elevation > -0.07) {
      const x = w * (0.1 + 0.8 * Math.min(1, day / 0.73));
      const y = horizon - elevation * horizon * 0.62 + h * 0.02;
      const warm = smooth(0.4, 0.7, day) + smooth(0.24, 0.08, day);
      const core: RGB = mix(hex('#fff6dc'), hex('#ff9a5a'), Math.min(1, warm));
      const radius = Math.min(w, h) * (0.045 + this.flare * 0.03);
      const halo = g.createRadialGradient(x, y, 0, x, y, radius * (5 + this.flare * 4));
      halo.addColorStop(0, rgb(core, 0.55 + this.flare * 0.3));
      halo.addColorStop(0.2, rgb(core, 0.18));
      halo.addColorStop(1, rgb(core, 0));
      g.fillStyle = halo;
      g.fillRect(0, 0, w, h);
      g.fillStyle = rgb(core, 0.95);
      g.beginPath();
      g.arc(x, y, radius, 0, Math.PI * 2);
      g.fill();
    }
    if (day > 0.7) {
      const moonT = (day - 0.7) / 0.3;
      const x = w * (0.12 + 0.5 * moonT);
      const y = horizon - h * 0.16 - moonT * horizon * 0.45;
      const r = Math.min(w, h) * 0.028;
      const alpha = smooth(0.7, 0.8, day);
      const halo = g.createRadialGradient(x, y, 0, x, y, r * 6);
      halo.addColorStop(0, `rgba(220,228,255,${0.22 * alpha})`);
      halo.addColorStop(1, 'rgba(220,228,255,0)');
      g.fillStyle = halo;
      g.fillRect(0, 0, w, h);
      g.globalAlpha = 0.9 * alpha;
      const size = Math.ceil(r * 2 + 4);
      g.drawImage(this.crescent(r), x - r - 2, y - r - 2, size, size);
      g.globalAlpha = 1;
    }
    this.flare *= 0.985;

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

    // Lanterns: one per session, in its seat.
    for (const lantern of this.state.lanterns) {
      const x = this.lanternX(lantern.seat);
      const y = this.ridge(x) - 6;
      const glow = (this.glow.get(lantern.seat) ?? 0) * 0.92;
      this.glow.set(lantern.seat, glow);
      const breathe = lantern.waiting && !this.reducedMotion ? 0.5 + 0.5 * Math.sin(t / 700) : 0;
      const base = lantern.working ? 0.55 : 0.22;
      const strength = Math.min(1, base + glow * 0.6 + breathe * 0.25);
      const r = 26 + strength * 34 + (lantern.focused ? 8 : 0);
      const halo = g.createRadialGradient(x, y, 0, x, y, r);
      halo.addColorStop(0, `rgba(255,214,150,${0.65 * strength})`);
      halo.addColorStop(0.3, `rgba(255,190,120,${0.22 * strength})`);
      halo.addColorStop(1, 'rgba(255,190,120,0)');
      g.fillStyle = halo;
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.fillStyle = `rgba(255,236,200,${0.5 + strength * 0.5})`;
      g.beginPath();
      g.arc(x, y, lantern.focused ? 4.5 : 3.5, 0, Math.PI * 2);
      g.fill();
    }

    // The doorbell: a ring spreading from the lantern whose turn just ended.
    const now = performance.now();
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
    for (const m of this.motes) {
      const age = (now - m.born) / m.life;
      const dt = 1 / 30;
      m.x += (m.vx + Math.sin(now / 600 + m.wobble) * 6) * dt;
      m.y += m.vy * dt;
      m.vy *= 0.995;
      const alpha = Math.sin(Math.PI * Math.min(1, age * 1.2)) * (1 - age * 0.3);
      const glow = g.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.size * 4);
      glow.addColorStop(0, m.color);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = Math.max(0, alpha) * 0.85;
      g.fillStyle = glow;
      g.fillRect(m.x - m.size * 4, m.y - m.size * 4, m.size * 8, m.size * 8);
      g.globalAlpha = 1;
    }
  }
}
