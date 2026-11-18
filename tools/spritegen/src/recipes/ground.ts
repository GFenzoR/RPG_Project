// Grounds with looks and motion (docs/17 ART-4, ART-6, ART-7). Every ground is a seamless
// 32x32 tile of low-frequency texture (patches of 8-16 px, details of 1-3 px, at most 5
// tones within a lightness step of about 15 L*), so a field reads as one surface and not
// as a grid. Each has alternate looks, <sprite>/var_<n>: the same tile with a small detail
// (flowers, a tuft, pebbles, a crack) kept away from the edges, so any look meets any other
// without a seam; the renderer picks one per tile by a hash (about 70 % the plain one).
// Water and lava are animated, <sprite>/frame_<n>: every frame tiles, and the loop closes
// (the swell sways and comes back, crests flicker in and out, lava bands pulse a quarter of
// a band per frame). Timing in assets/sprites.yaml `tiles`.
import type { Image, Rgba } from "@rpg/spritepack";
import { eachInRect, hash2, line, px, tileNoise } from "../draw.ts";
import type { Rng } from "../draw.ts";
import { hex, mix } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { stones } from "./walls.ts";

const wrap = (v: number): number => ((v % 32) + 32) % 32;
/** px() that wraps around the tile. */
const pxw = (img: Image, x: number, y: number, c: Rgba): void => px(img, wrap(x), wrap(y), c);

/** One of a ramp of colours (darkest first) by level in [0, 1]. */
function ramp(colors: readonly Rgba[], level: number): Rgba {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(level * colors.length)));
  return colors[i] as Rgba;
}

/** A ground with its looks: the base drawer, then each detail drawn over a copy of it. */
function withLooks(
  sprite: string,
  base: (img: Image, seed: number) => void,
  details: ((img: Image, rand: Rng) => void)[],
): RecipeBook {
  const seed = seedOf(sprite);
  const book: RecipeBook = { [sprite]: { kind: "ground", draw: (img) => base(img, seed) } };
  details.forEach((detail, i) => {
    book[`${sprite}/var_${i + 1}`] = {
      kind: "ground",
      draw: (img, rand) => {
        base(img, seed);
        detail(img, rand);
      },
    };
  });
  return book;
}

/** An animated ground: frame 0 is the sprite itself, frames 1.. are <sprite>/frame_<n>. */
function animated(
  sprite: string,
  frames: number,
  draw: (img: Image, seed: number, t: number) => void,
): RecipeBook {
  const seed = seedOf(sprite);
  const book: RecipeBook = { [sprite]: { kind: "ground", draw: (img) => draw(img, seed, 0) } };
  for (let f = 1; f < frames; f++)
    book[`${sprite}/frame_${f}`] = { kind: "ground", draw: (img) => draw(img, seed, f / frames) };
  return book;
}

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---- grass ------------------------------------------------------------------------------------

const GRASS = ["#213f1e", "#284a22", "#2f5426", "#365e2a", "#3f6a2e"].map(hex);
const GRASS_TIP = hex("#4a7634");

/** Blades: a short vertical stroke, lit tip, a dark pixel at its foot. */
function blade(
  img: Image,
  x: number,
  y: number,
  h: number,
  lean: number,
  tip: Rgba,
  body: Rgba,
): void {
  for (let i = 0; i < h; i++)
    pxw(img, x + (i === h - 1 ? lean : 0), y - i, i === h - 1 ? tip : body);
  pxw(img, x, y + 1, GRASS[0] as Rgba);
}

function grass(img: Image, seed: number): void {
  eachInRect(0, 0, 32, 32, (x, y) => {
    // Mostly mid-scale patches: a feature as big as the tile would repeat as a grid.
    const patch =
      tileNoise(x, y, 16, 16, seed) * 0.2 +
      tileNoise(x, y, 8, 8, seed + 1) * 0.5 +
      tileNoise(x, y, 4, 4, seed + 9) * 0.3;
    const grain = (tileNoise(x, y, 2, 2, seed + 2) - 0.5) * 0.2;
    px(img, x, y, ramp(GRASS.slice(1, 4), (patch - 0.5) * 1.4 + 0.5 + grain));
  });
  // Dark tufts between the blades (a small v), then blades on a jittered 4 px lattice.
  for (let cy = 0; cy < 8; cy++)
    for (let cx = 0; cx < 8; cx++) {
      if (hash2(cx, cy, seed + 6) > 0.55) continue;
      const x = cx * 4 + 2 + Math.floor(hash2(cx, cy, seed + 7) * 3);
      const y = cy * 4 + 2 + Math.floor(hash2(cx, cy, seed + 8) * 3);
      pxw(img, x, y, GRASS[0] as Rgba);
      pxw(img, x - 1, y - 1, GRASS[1] as Rgba);
      pxw(img, x + 1, y - 1, GRASS[1] as Rgba);
    }
  for (let cy = 0; cy < 8; cy++)
    for (let cx = 0; cx < 8; cx++) {
      const h = hash2(cx, cy, seed + 3);
      if (h > 0.85) continue;
      const x = cx * 4 + Math.floor(hash2(cx, cy, seed + 4) * 4);
      const y = cy * 4 + Math.floor(hash2(cx, cy, seed + 5) * 4);
      const lean = h < 0.2 ? -1 : h > 0.5 ? 1 : 0;
      const tall = h < 0.1 ? 3 : 2;
      blade(img, x, y, tall, lean, h < 0.35 ? GRASS_TIP : (GRASS[4] as Rgba), GRASS[3] as Rgba);
    }
}

const FLOWER = [hex("#c9b85a"), hex("#d6d2b8"), hex("#9a6fa8")];

const GRASS_LOOKS = [
  // A few small flowers.
  (img: Image, rand: Rng): void => {
    const c = FLOWER[Math.floor(rand() * FLOWER.length)] as Rgba;
    for (let i = 0; i < 4; i++) {
      const x = 8 + Math.floor(rand() * 16);
      const y = 8 + Math.floor(rand() * 16);
      px(img, x, y, c);
      px(img, x + 1, y, mix(c, GRASS[1] as Rgba, 0.45));
      px(img, x, y + 1, GRASS[0] as Rgba);
    }
  },
  // A tall tuft.
  (img: Image, rand: Rng): void => {
    const x0 = 11 + Math.floor(rand() * 8);
    const y0 = 14 + Math.floor(rand() * 8);
    for (let i = -3; i <= 3; i++) {
      const h = 5 - Math.abs(i) + Math.floor(rand() * 2);
      blade(img, x0 + i, y0, h, i < 0 ? -1 : i > 0 ? 1 : 0, GRASS_TIP, GRASS[4] as Rgba);
    }
    line(img, x0 - 3, y0 + 1, x0 + 3, y0 + 1, GRASS[0] as Rgba);
  },
  // Two pebbles in the grass.
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 2; i++)
      pebble(img, 9 + Math.floor(rand() * 13), 9 + Math.floor(rand() * 13), rand() < 0.5);
  },
];

const PEBBLE = ["#3b3a38", "#5b5853", "#77736a"].map(hex);
function pebble(img: Image, x: number, y: number, big: boolean): void {
  const w = big ? 3 : 2;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < w; dx++)
      px(img, x + dx, y + dy, PEBBLE[dy === 0 && dx === 0 ? 2 : 1] as Rgba);
  line(img, x, y + 2, x + w - 1, y + 2, PEBBLE[0] as Rgba);
}

// ---- dirt -------------------------------------------------------------------------------------

const DIRT = ["#2f241a", "#3a2d20", "#453626", "#51402d", "#5d4a34"].map(hex);

function dirt(img: Image, seed: number): void {
  eachInRect(0, 0, 32, 32, (x, y) => {
    const patch = tileNoise(x, y, 16, 16, seed) * 0.25 + tileNoise(x, y, 8, 8, seed + 1) * 0.35;
    const grain = (tileNoise(x, y, 2, 2, seed + 2) - 0.5) * 0.45;
    px(img, x, y, ramp(DIRT.slice(1, 4), patch + grain + 0.2));
  });
  // Clods: a lit pixel over a dark one, on a jittered lattice.
  for (let cy = 0; cy < 8; cy++)
    for (let cx = 0; cx < 8; cx++) {
      if (hash2(cx, cy, seed + 3) > 0.45) continue;
      const x = cx * 4 + Math.floor(hash2(cx, cy, seed + 4) * 4);
      const y = cy * 4 + Math.floor(hash2(cx, cy, seed + 5) * 4);
      pxw(img, x, y, DIRT[4] as Rgba);
      pxw(img, x + 1, y, DIRT[3] as Rgba);
      pxw(img, x, y + 1, DIRT[0] as Rgba);
    }
}

const ROOT = hex("#2a2016");
const DIRT_LOOKS = [
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 3; i++)
      pebble(img, 8 + Math.floor(rand() * 16), 8 + Math.floor(rand() * 16), rand() < 0.4);
  },
  // A root across the path.
  (img: Image, rand: Rng): void => {
    let x = 6;
    let y = 10 + Math.floor(rand() * 12);
    while (x < 26) {
      px(img, x, y, ROOT);
      px(img, x, y - 1, DIRT[4] as Rgba);
      x++;
      if (rand() < 0.3) y += rand() < 0.5 ? -1 : 1;
      y = Math.max(7, Math.min(25, y));
    }
  },
  // A dry crack.
  (img: Image, rand: Rng): void => {
    let x = 10 + Math.floor(rand() * 10);
    let y = 7;
    while (y < 25) {
      px(img, x, y, DIRT[0] as Rgba);
      px(img, x + 1, y, DIRT[4] as Rgba);
      y++;
      if (rand() < 0.4) x += rand() < 0.5 ? -1 : 1;
      x = Math.max(7, Math.min(24, x));
    }
  },
];

// ---- sand -------------------------------------------------------------------------------------

const SAND = ["#6a5b41", "#76664a", "#827153", "#8e7c5b", "#9a8864"].map(hex);

function sandBase(img: Image, seed: number, colors: readonly Rgba[]): void {
  eachInRect(0, 0, 32, 32, (x, y) => {
    const patch = tileNoise(x, y, 16, 16, seed) * 0.2 + tileNoise(x, y, 8, 8, seed + 1) * 0.45;
    // Wind ripples: diagonal bands warped by noise (periodic: x + 2y over 8 px).
    const warp = (tileNoise(x, y, 8, 8, seed + 2) - 0.5) * 6;
    const band = ((((x + 2 * y + warp) / 8) % 1) + 1) % 1;
    const ripple = band < 0.18 ? 0.18 : band > 0.8 ? -0.12 : 0;
    px(img, x, y, ramp(colors.slice(1, 5), patch + ripple + 0.15));
  });
  eachInRect(0, 0, 32, 32, (x, y) => {
    const h = hash2(x, y, seed + 4);
    if (h < 0.012) px(img, x, y, colors[0] as Rgba);
    else if (h > 0.992) px(img, x, y, colors[4] as Rgba);
  });
}

const SHELL = ["#8a7a72", "#c9b8aa", "#e2d6c6"].map(hex);
const SAND_LOOKS = [
  // A shell.
  (img: Image, rand: Rng): void => {
    const x = 10 + Math.floor(rand() * 12);
    const y = 10 + Math.floor(rand() * 12);
    px(img, x, y, SHELL[2] as Rgba);
    px(img, x + 1, y, SHELL[1] as Rgba);
    px(img, x - 1, y + 1, SHELL[1] as Rgba);
    px(img, x, y + 1, SHELL[2] as Rgba);
    px(img, x + 1, y + 1, SHELL[0] as Rgba);
    line(img, x - 1, y + 2, x + 1, y + 2, SAND[0] as Rgba);
  },
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 3; i++)
      pebble(img, 8 + Math.floor(rand() * 16), 8 + Math.floor(rand() * 16), rand() < 0.3);
  },
  // Footprints of a gull.
  (img: Image, rand: Rng): void => {
    let x = 8 + Math.floor(rand() * 4);
    let y = 20;
    for (let i = 0; i < 4; i++) {
      px(img, x, y, SAND[0] as Rgba);
      px(img, x - 1, y - 1, SAND[1] as Rgba);
      px(img, x + 1, y - 1, SAND[1] as Rgba);
      x += 4;
      y -= 2 + (i % 2);
    }
  },
];

const WET_SAND = ["#4f4433", "#594d3a", "#625541", "#6c5e48", "#857760"].map(hex);
const SHEEN = hex("#8c8270");

function wetSand(img: Image, seed: number): void {
  sandBase(img, seed, WET_SAND);
  // Thin sheen streaks where the water just drew back.
  eachInRect(0, 0, 32, 32, (x, y) => {
    const v = tileNoise(x, y * 3, 16, 4, seed + 7);
    if (v > 0.78 && hash2(x, y, seed + 8) < 0.6) px(img, x, y, SHEEN);
  });
}

// ---- cut stone floor (towns, temples, mines) -------------------------------------------------

const FLAG = ["#36332f", "#423e39", "#4d4842", "#58524a", "#635c53"].map(hex);
const JOINT = hex("#211f1e");
const MOSS = ["#2b3a22", "#37482a"].map(hex);
/**
 * Irregular flagstones (crazy paving) of about 16 px: a jittered lattice, each stone with its
 * own tone, lit on its top-left rim, a dark joint where two stones meet.
 */
function stoneFloor(img: Image, seed: number): void {
  eachInRect(0, 0, 32, 32, (x, y) => {
    const st = stones(x, y, 16, 16, seed);
    if (st.gap < 0.07) return px(img, x, y, JOINT);
    const tone = (hash2(st.id, 1, seed) - 0.5) * 0.35;
    let level = 0.5 + tone + (tileNoise(x, y, 4, 4, seed + 2) - 0.5) * 0.18;
    // The rim: lit toward the top-left of the stone, in shadow toward the bottom-right.
    if (st.gap < 0.13) level += st.dx + st.dy < 0 ? 0.22 : -0.22;
    if (hash2(x, y, seed + 3) < 0.02) level -= 0.3; // pits
    px(img, x, y, ramp(FLAG, level));
  });
}

const STONE_LOOKS = [
  // A cracked flag.
  (img: Image, rand: Rng): void => {
    let x = 9 + Math.floor(rand() * 6);
    let y = 3;
    while (y < 13) {
      px(img, x, y, JOINT);
      y++;
      if (rand() < 0.5) x += 1;
    }
  },
  // Moss in the joints.
  (img: Image, rand: Rng): void => {
    eachInRect(5, 5, 22, 22, (x, y) => {
      const c = img.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      if (c[0] !== JOINT[0] || c[1] !== JOINT[1] || rand() < 0.3) return;
      px(img, x, y, MOSS[rand() < 0.5 ? 0 : 1] as Rgba);
      if (rand() < 0.3) px(img, x, y - 1, MOSS[1] as Rgba);
    });
  },
  // A worn, darker patch.
  (img: Image): void => {
    eachInRect(12, 12, 9, 9, (x, y) => {
      const c = img.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
      if (c[0] === JOINT[0] && c[1] === JOINT[1]) return;
      px(img, x, y, mix([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, 255], FLAG[0] as Rgba, 0.35));
    });
  },
];

// ---- water ------------------------------------------------------------------------------------

const WATER = ["#14293b", "#183247", "#1d3c54", "#234661", "#2a516e"].map(hex);
const CREST = ["#3a6886", "#5f8ea8", "#9cbfcf"].map(hex);

/**
 * Shallow water at time t (0..1 over the loop): a slow swell that sways and comes back, and
 * short crests on a jittered lattice that each rise and fade at their own phase.
 */
function water(img: Image, seed: number, t: number): void {
  const a = 2 * Math.PI * t;
  const ox = Math.round(2 * Math.sin(a));
  const oy = Math.round(Math.cos(a));
  eachInRect(0, 0, 32, 32, (x, y) => {
    const swell =
      tileNoise(x + ox, y + oy, 16, 8, seed) * 0.6 + tileNoise(x - ox, y, 8, 8, seed + 1) * 0.4;
    px(img, x, y, ramp(WATER.slice(1), swell + 0.05));
  });
  for (let cy = 0; cy < 4; cy++)
    for (let cx = 0; cx < 4; cx++) {
      const phase = hash2(cx, cy, seed + 2);
      const life = (t + phase) % 1; // 0..1: rises, peaks, fades
      if (life > 0.75 || hash2(cx, cy, seed + 6) > 0.6) continue;
      const x = cx * 8 + Math.floor(hash2(cx, cy, seed + 3) * 8) + Math.round(life * 2);
      const y = cy * 8 + Math.floor(hash2(cx, cy, seed + 4) * 8);
      const len = 2 + Math.floor(hash2(cx, cy, seed + 5) * 3) + (life > 0.25 && life < 0.5 ? 1 : 0);
      const c = CREST[life < 0.25 ? 0 : life < 0.5 ? 2 : 1] as Rgba;
      for (let i = 0; i < len; i++)
        pxw(img, x + i, y, i === 0 || i === len - 1 ? (CREST[0] as Rgba) : c);
      for (let i = 0; i < len; i++) pxw(img, x + i, y + 1, WATER[1] as Rgba);
    }
}

const FISH = hex("#10202e");
/** Water with a shoal: small dark fish circling, and a ring where one breaks the surface. */
function shoal(img: Image, seed: number, t: number): void {
  water(img, seed, t);
  for (let i = 0; i < 3; i++) {
    const a = 2 * Math.PI * (t + i / 3);
    const x = Math.round(16 + 7 * Math.cos(a));
    const y = Math.round(16 + 5 * Math.sin(a));
    const dx = Math.sin(a) > 0 ? -1 : 1; // swims along the circle
    px(img, x, y, FISH);
    px(img, x + dx, y, FISH);
    px(img, x - dx, y, FISH);
    px(img, x - 2 * dx, y + (i % 2 === 0 ? -1 : 1), FISH);
  }
  if (t >= 0.5) {
    const r = t >= 0.75 ? 3.5 : 2;
    const c = CREST[t >= 0.75 ? 0 : 1] as Rgba;
    eachInRect(4, 4, 24, 24, (x, y) => {
      const d = Math.hypot((x + 0.5 - 22) / 1.5, y + 0.5 - 10);
      const inner = Math.hypot((x + 0.5 - 22) / 1.5, y + 0.5 - 10) < r - 0.8;
      if (d < r && !inner) px(img, x, y, c);
    });
  }
}

// ---- lava -------------------------------------------------------------------------------------

const EMBER = ["#4a1a10", "#7e2e12", "#c4581f", "#f39a35", "#ffd36b"].map(hex);
const CRUST = ["#2f2a2b", "#403a3a", "#5a5251"].map(hex);
const SPARK = hex("#fff1c2");

/**
 * Molten lava at time t: marbled bands (a warped noise read as contour lines) that pulse a
 * quarter of a band per frame, with flecks of black crust drifting on it.
 */
function lava(img: Image, seed: number, t: number): void {
  const flowAt = (x: number, y: number): number => {
    const wx = x + (tileNoise(x, y, 8, 8, seed + 5) - 0.5) * 8;
    const wy = y + (tileNoise(x, y, 8, 8, seed + 6) - 0.5) * 8;
    return (
      tileNoise(wx, wy, 4, 4, seed + 1) * 0.5 +
      tileNoise(wx, wy, 8, 8, seed) * 0.3 +
      tileNoise(wx, wy, 16, 16, seed + 2) * 0.2
    );
  };
  eachInRect(0, 0, 32, 32, (x, y) => {
    const band = (flowAt(x, y) * 3 + 1 - t) % 1;
    let c: Rgba;
    if (band < 0.08) c = EMBER[4] as Rgba;
    else if (band < 0.22) c = EMBER[3] as Rgba;
    else if (band < 0.5) c = EMBER[2] as Rgba;
    else if (band < 0.8) c = EMBER[1] as Rgba;
    else c = mix(EMBER[1] as Rgba, EMBER[0] as Rgba, 0.5);
    px(img, x, y, c);
  });
  // Crust flecks on a lattice, drifting 2 px per frame to the right (8 px a loop: the
  // lattice repeats every 8 px, so the loop closes).
  const drift = Math.round(t * 8);
  eachInRect(0, 0, 32, 32, (x, y) => {
    const st = stones(wrap(x - drift), y, 8, 8, seed + 4);
    if (hash2(st.id, 7, seed) > 0.4) return;
    const d = Math.hypot(st.dx, st.dy);
    if (d > 0.22) return;
    px(img, x, y, d > 0.16 ? (EMBER[1] as Rgba) : (CRUST[st.dx + st.dy < -0.05 ? 2 : 1] as Rgba));
  });
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (hash2(x, y, seed + 9 + Math.round(t * 4)) < 0.01) px(img, x, y, SPARK);
  });
}

/** Frames of each animated ground (assets/sprites.yaml tiles has their timing). */
export const WATER_FRAMES = 4;
export const LAVA_FRAMES = 4;

export const GROUND: RecipeBook = {
  ...withLooks("ground/grass", grass, GRASS_LOOKS),
  ...withLooks("ground/dirt", dirt, DIRT_LOOKS),
  ...withLooks("ground/sand", (img, seed) => sandBase(img, seed, SAND), SAND_LOOKS),
  ...withLooks("ground/wet_sand", wetSand, [SAND_LOOKS[0] as (img: Image, rand: Rng) => void]),
  ...withLooks("ground/stone_floor", stoneFloor, STONE_LOOKS),
  ...animated("ground/water_shallow", WATER_FRAMES, water),
  ...animated("ground/water_shoal", WATER_FRAMES, shoal),
  ...animated("ground/lava", LAVA_FRAMES, lava),
};
