/**
 * Seeded randomness for the radio.
 *
 * Every melodic choice goes through one of these, seeded from the session id,
 * so a session has a consistent voice across reloads and a test can pin the
 * exact phrase it expects. `Math.random` would make both impossible.
 */

/** A deterministic generator returning floats in `[0, 1)`. */
export type Rng = () => number;

/** mulberry32 — tiny, fast, and plenty for choosing notes. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a over a string — turns a session id into a seed. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick one element, uniformly. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length]!;
}
