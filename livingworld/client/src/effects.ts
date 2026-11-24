// The pure side of the living world's effects: which particles a hit, a break, a push or a
// fade throws, and where each one is at a given time. No PixiJS here, so the tests run it
// as numbers (index.ts draws them).

/** Material of an object's particles (data/livingworld `effect`). */
export type Material = "wood" | "stone" | "plant" | "web" | "clay";

/** The colours of each material's chips, dark to light (the dark fantasy palette). */
export const MATERIAL_COLORS: Readonly<Record<Material, readonly number[]>> = {
  wood: [0x4a2e1a, 0x6e4526, 0x8f6236],
  stone: [0x4b4a48, 0x6d6a64, 0x8c8780],
  plant: [0x24361c, 0x3d5a26, 0x5d7a34],
  web: [0xb8b4a8, 0xd8d4c8, 0xeeeae0],
  clay: [0x6b3a22, 0x8e5130, 0xb06d42],
};

/** The material of an effect key, or wood for an unknown or empty one. */
export function materialOf(effect: string | undefined): Material {
  return effect !== undefined && effect in MATERIAL_COLORS ? (effect as Material) : "wood";
}

/** One particle: starts at (x, y) in tiles, moves (vx, vy) tiles per second, falls. */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Upward speed in tiles per second at the start; gravity pulls it back. */
  vz: number;
  start: number;
  life: number;
  color: number;
  /** Side in pixels. */
  size: number;
}

/** How long the particles of each kind live (ms). */
export const HIT_MS = 380;
export const BREAK_MS = 720;
export const DUST_MS = 600;
/** Gravity in tiles per second squared. */
const GRAVITY = 9;

/** What throws particles. */
export type BurstKind = "hit" | "break" | "dust";

/** How many particles each kind throws (break is the big one). */
export const BURST_COUNT: Readonly<Record<BurstKind, number>> = { hit: 5, break: 16, dust: 7 };

/**
 * The particles of one burst at tile (x, y) (its top-left corner), started at `start`.
 * `random` is Math.random in the game and a seeded one in tests.
 */
export function burst(
  kind: BurstKind,
  material: Material,
  x: number,
  y: number,
  start: number,
  random: () => number,
): Particle[] {
  const colors = MATERIAL_COLORS[material];
  const out: Particle[] = [];
  const n = BURST_COUNT[kind];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + random() * 0.6;
    const speed =
      kind === "break"
        ? 1.2 + random() * 1.6
        : kind === "hit"
          ? 0.6 + random()
          : 0.3 + random() * 0.4;
    const dust = kind === "dust";
    out.push({
      x: x + 0.5 + (random() - 0.5) * 0.4,
      y: y + 0.7 + (random() - 0.5) * 0.3,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed * 0.5,
      vz: dust ? 0.4 : 1.5 + random() * (kind === "break" ? 2.5 : 1.2),
      start,
      life: kind === "break" ? BREAK_MS : kind === "hit" ? HIT_MS : DUST_MS,
      color: dust ? 0x8c8270 : (colors[i % colors.length] ?? 0x6e4526),
      size: dust ? 3 : kind === "break" ? 2 + Math.round(random() * 2) : 2,
    });
  }
  return out;
}

/** Where a particle is drawn at `now`, in tiles, and its opacity; undefined once dead. */
export function particleAt(
  p: Particle,
  now: number,
): { x: number; y: number; alpha: number } | undefined {
  const t = (now - p.start) / 1000;
  if (t < 0 || now - p.start >= p.life) return undefined;
  // The height above the ground: thrown up, falling back, resting on the ground.
  const z = Math.max(0, p.vz * t - (GRAVITY * t * t) / 2);
  const k = (now - p.start) / p.life;
  return { x: p.x + p.vx * t, y: p.y + p.vy * t - z, alpha: 1 - k * k };
}

/** A sprite of an item drawn over the map for a while: a push's slide, a fade. */
export interface Ghost {
  itemId: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  ms: number;
  /** Opacity at the start and at the end. */
  alpha0: number;
  alpha1: number;
}

/** How long a pushed object slides and a debris fades (ms). */
export const SLIDE_MS = 260;
export const FADE_MS = 700;

/** A ghost's place (tiles, top-left) and opacity at now; undefined once over. */
export function ghostAt(
  g: Ghost,
  now: number,
): { x: number; y: number; alpha: number } | undefined {
  if (now < g.start || now - g.start >= g.ms) return undefined;
  const k = (now - g.start) / g.ms;
  const e = 1 - (1 - k) * (1 - k); // ease out
  return {
    x: g.fromX + (g.toX - g.fromX) * e,
    y: g.fromY + (g.toY - g.fromY) * e,
    alpha: g.alpha0 + (g.alpha1 - g.alpha0) * k,
  };
}
