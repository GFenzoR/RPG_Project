// Deterministic noise for the living world: everything that looks random (gusts, where
// critters live, which leaf falls) comes from a tile's position and the clock, never from
// Math.random, so tests and screenshots are repeatable.

/** A number in [0, 1) from integer coordinates and a salt. */
export function hash01(x: number, y: number, salt = 0): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A small seeded generator (mulberry32): the same seed, the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tile key for maps (world coordinates stay well under 100 000). */
export function tileKey(x: number, y: number): number {
  return x * 100003 + y;
}
