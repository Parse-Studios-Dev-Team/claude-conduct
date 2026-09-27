/**
 * The sky's clock: where the drawn day is, and how it gets to where it's going.
 *
 * The page tells it where the day should be — the focused session's context,
 * as `0..1` — a few times a second, in steps. The clock follows on a critically
 * damped spring, so the sky moves every frame, sets off gently and never
 * overshoots: a sun that passes its mark and sinks back looks like a mistake.
 *
 * The clock runs round. After night comes the hour before dawn (`1..CYCLE`),
 * which leads back into day 0. Context only falls on a compaction (or when you
 * switch to a younger session); when that takes an afternoon or night sky back
 * to a morning, the clock carries on forward through the night and a new day
 * comes up from the east, instead of the old one running backwards.
 *
 * Pure and DOM-free, so it's tested like the music.
 */

/** The hour before dawn, as a length of the clock. */
export const PRE_DAWN = 0.25;
/** Once round: a day, then the hour before the next one. */
export const CYCLE = 1 + PRE_DAWN;

/** How quickly the clock follows, in radians a second: an everyday drift, and a new day. */
const EASY = 0.55;
const HURRY = 0.8;

export class SkyClock {
  /** Unwrapped: past `CYCLE` while a new day is on its way. */
  private pos = 0;
  private vel = 0;
  /** Heading on through the night to a new day; wraps round once past midnight. */
  private wrapping = false;
  /** Moving at a new day's pace until it arrives. */
  private hurry = false;

  /** Where on the clock, `0..CYCLE`. */
  get position(): number {
    const c = this.pos % CYCLE;
    return c < 0 ? c + CYCLE : c;
  }

  /** The same place as a day: `0..1`, or `-PRE_DAWN..0` in the hour before dawn. */
  get day(): number {
    const c = this.position;
    return c > 1 ? c - CYCLE : c;
  }

  /** Whether a new day is on its way. */
  get dawning(): boolean {
    return this.wrapping || this.hurry;
  }

  /** Be at `day` now. */
  snap(day: number): void {
    this.pos = clamp01(day);
    this.vel = 0;
    this.wrapping = false;
    this.hurry = false;
  }

  /** Move `dt` seconds toward `want`. */
  advance(want: number, dt: number): void {
    want = clamp01(want);

    if (!this.wrapping && want < 0.5 && this.pos > 0.5 && want < this.pos - 0.15) {
      // A morning, from past noon: a new day.
      this.wrapping = true;
      this.hurry = true;
    } else if (this.wrapping && want >= 0.5) {
      // Not a morning after all (you went back to the older session): ease back.
      this.wrapping = false;
    }
    if (this.wrapping && this.pos > 1) {
      // Past midnight: the same place on the clock, counted as before dawn.
      this.pos -= CYCLE;
      this.wrapping = false;
    }

    const aim = this.wrapping ? CYCLE + want : want;
    const e = this.pos - aim;
    let omega = this.hurry ? HURRY : EASY;
    // Heading for the aim: brake hard enough not to pass it. A critically damped
    // spring only overshoots when it arrives faster than `omega × distance`.
    if (e * this.vel < 0) omega = Math.min(60, Math.max(omega, -this.vel / e));
    const j = this.vel + omega * e;
    const decay = Math.exp(-omega * dt);
    this.pos = aim + (e + j * dt) * decay;
    this.vel = (this.vel - omega * j * dt) * decay;

    if (this.hurry && !this.wrapping && Math.abs(this.pos - aim) < 0.003 && Math.abs(this.vel) < 0.003) {
      this.hurry = false;
    }
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
