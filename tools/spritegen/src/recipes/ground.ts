// Grounds with looks and motion (docs/17 ART-4, ART-6, ART-7). Every ground is a seamless
// 32x32 tile of low-frequency texture (patches of 8-16 px, details of 1-3 px, at most 5
// tones within a lightness step of about 15 L*), so a field reads as one surface and not
// as a grid. Each has alternate looks, <sprite>/var_<n> (recipes/variety.ts): the main
// look's outer ring with another heart (another seed of the texture, a rippled, coarse,
// lush or dry take on it, or a detail: a tuft, pebbles, a crack), so any look meets any
// other without a seam; sand and grass also have decals, <sprite>/decal_<n>. The renderer
// picks a look per tile (groundLook: areas lean to runs of alike looks, side-by-side tiles
// never repeat one) and lays decals on a few tiles (docs/17 ART-4).
// Water and lava are animated, <sprite>/frame_<n>: every frame tiles, and the loop closes
// (the swell sways and comes back, crests flicker in and out, lava bands pulse a quarter of
// a band per frame). Timing in assets/sprites.yaml `tiles`.
import type { Image, Rgba } from "@rpg/spritepack";
import { eachInRect, hash2, line, px, tileNoise } from "../draw.ts";
import type { Rng } from "../draw.ts";
import { hex, mix } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { calmSeed, drawLevel, groundBook, levelHeart } from "./variety.ts";
import type { LevelGround, Look } from "./variety.ts";
import { stones } from "./walls.ts";

const wrap = (v: number): number => ((v % 32) + 32) % 32;
/** px() that wraps around the tile. */
const pxw = (img: Image, x: number, y: number, c: Rgba): void => px(img, wrap(x), wrap(y), c);

/** One of a ramp of colours (darkest first) by level in [0, 1]. */
function ramp(colors: readonly Rgba[], level: number): Rgba {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(level * colors.length)));
  return colors[i] as Rgba;
}

/**
 * A ground with its looks (each drawn over the main look) and its decals (recipes/variety.ts).
 */
function withLooks(
  sprite: string,
  base: (img: Image, seed: number) => void,
  looks: readonly Look[],
  decals: readonly ((img: Image, rand: Rng) => void)[] = [],
  seed = seedOf(sprite),
): RecipeBook {
  return groundBook(sprite, seed, base, looks, decals);
}

/** withLooks for a level ground, from the calmest seed near its path's (calmSeed). */
function levelLooks<T>(
  sprite: string,
  field: LevelGround<T>,
  take: T,
  looks: readonly Look[],
  decals: readonly ((img: Image, rand: Rng) => void)[] = [],
): RecipeBook {
  const seed = calmSeed(field, take, seedOf(sprite));
  return withLooks(sprite, drawLevel(field, take), looks, decals, seed);
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

/** A take on the grass: lusher (darker, fuller) or drier (sparser, paler tips). */
interface GrassTake {
  /** Shifts the patches darker (+) or lighter (-), in ramp steps of about 1/3. */
  lush?: number;
  /** Share of blades with a dry, pale tip. */
  dry?: number;
  /** Share of lattice cells with a blade (default 0.85). */
  blades?: number;
}

/**
 * Grass as a level field (patches and grain; the broad shading is the renderer's
 * groundTone) with dark tufts and blades on jittered 4 px lattices, each cell drawn with
 * the seed and take of its centre (so a heart's cells are the heart's).
 */
const GRASS_FIELD: LevelGround<GrassTake> = {
  level(x, y, seed, take) {
    // Mostly mid-scale patches: a feature as big as the tile would repeat as a grid.
    const patch =
      tileNoise(x, y, 16, 16, seed) * 0.12 +
      tileNoise(x, y, 8, 8, seed + 1) * 0.5 +
      tileNoise(x, y, 4, 4, seed + 9) * 0.38;
    const grain = (tileNoise(x, y, 2, 2, seed + 2) - 0.5) * 0.2;
    return (patch - 0.5) * 1.4 + 0.5 + grain - (take.lush ?? 0) * 0.25;
  },
  paint(img, levelAt, seedAt, takeAt) {
    eachInRect(0, 0, 32, 32, (x, y) => px(img, x, y, ramp(GRASS.slice(1, 4), levelAt(x, y))));
    // Dark tufts between the blades (a small v), then the blades.
    for (let cy = 0; cy < 8; cy++)
      for (let cx = 0; cx < 8; cx++) {
        const seed = seedAt(cx * 4 + 2, cy * 4 + 2);
        const lush = takeAt(cx * 4 + 2, cy * 4 + 2).lush ?? 0;
        if (hash2(cx, cy, seed + 6) > 0.55 + lush * 0.15) continue;
        const x = cx * 4 + 2 + Math.floor(hash2(cx, cy, seed + 7) * 3);
        const y = cy * 4 + 2 + Math.floor(hash2(cx, cy, seed + 8) * 3);
        pxw(img, x, y, GRASS[0] as Rgba);
        pxw(img, x - 1, y - 1, GRASS[1] as Rgba);
        pxw(img, x + 1, y - 1, GRASS[1] as Rgba);
      }
    for (let cy = 0; cy < 8; cy++)
      for (let cx = 0; cx < 8; cx++) {
        const seed = seedAt(cx * 4 + 2, cy * 4 + 2);
        const take = takeAt(cx * 4 + 2, cy * 4 + 2);
        const lush = take.lush ?? 0;
        const h = hash2(cx, cy, seed + 3);
        if (h > (take.blades ?? 0.85)) continue;
        const x = cx * 4 + Math.floor(hash2(cx, cy, seed + 4) * 4);
        const y = cy * 4 + Math.floor(hash2(cx, cy, seed + 5) * 4);
        const lean = h < 0.2 ? -1 : h > 0.5 ? 1 : 0;
        const tall = h < 0.1 + lush * 0.15 ? 3 : 2;
        const dry = hash2(cx, cy, seed + 10) < (take.dry ?? 0);
        const tip = dry ? GRASS_DRY : h < 0.35 ? GRASS_TIP : (GRASS[4] as Rgba);
        blade(img, x, y, tall, lean, tip, GRASS[3] as Rgba);
      }
  },
};
const grassLook = (salt: number, take: GrassTake): Look => levelHeart(GRASS_FIELD, {}, salt, take);
const grassWith =
  (salt: number, take: GrassTake, detail: (img: Image, rand: Rng) => void): Look =>
  (img, rand, seed) => {
    grassLook(salt, take)(img, rand, seed);
    detail(img, rand);
  };

const GRASS_DRY = hex("#5d6b36");
const FLOWER = [hex("#c9b85a"), hex("#d6d2b8"), hex("#9a6fa8")];
const CLOVER = ["#2f5a2a", "#3d6e33", "#4d7f3c"].map(hex);
const LEAF = ["#5a3a1e", "#7a5228", "#94683a"].map(hex);

/** Clover: a few three-leaf sprigs, light leaves on a dark heart. */
function clover(img: Image, rand: Rng, n: number, x0: number, y0: number, spread: number): void {
  for (let i = 0; i < n; i++) {
    const x = x0 + Math.floor(rand() * spread);
    const y = y0 + Math.floor(rand() * spread);
    px(img, x, y, CLOVER[0] as Rgba);
    px(img, x - 1, y, CLOVER[2] as Rgba);
    px(img, x + 1, y, CLOVER[1] as Rgba);
    px(img, x, y - 1, CLOVER[2] as Rgba);
  }
}

/** A few small flowers of one colour: a bloom, its shaded side and a dark stem below. */
function flowers(img: Image, rand: Rng, c: Rgba, n: number, x0: number, spread: number): void {
  for (let i = 0; i < n; i++) {
    const x = x0 + Math.floor(rand() * spread);
    const y = x0 + Math.floor(rand() * spread);
    px(img, x, y, c);
    px(img, x + 1, y, mix(c, GRASS[1] as Rgba, 0.45));
    px(img, x, y + 1, GRASS[0] as Rgba);
  }
}

/**
 * Grass looks, alike ones together (the renderer lets an area lean to a run of them):
 * plain hearts, lusher ones, a tall tuft, drier ones, clover.
 */
const GRASS_LOOKS: Look[] = [
  grassLook(1, {}),
  grassLook(2, {}),
  grassLook(3, {}),
  grassLook(4, { lush: 0.5 }),
  grassLook(5, { lush: 0.8 }),
  // A tall tuft in a lush heart.
  grassWith(6, { lush: 0.5 }, (img, rand) => {
    const x0 = 11 + Math.floor(rand() * 8);
    const y0 = 14 + Math.floor(rand() * 8);
    for (let i = -3; i <= 3; i++) {
      const h = 5 - Math.abs(i) + Math.floor(rand() * 2);
      blade(img, x0 + i, y0, h, i < 0 ? -1 : i > 0 ? 1 : 0, GRASS_TIP, GRASS[4] as Rgba);
    }
    line(img, x0 - 3, y0 + 1, x0 + 3, y0 + 1, GRASS[0] as Rgba);
  }),
  grassLook(7, { dry: 0.35, blades: 0.75 }),
  grassLook(8, { dry: 0.55, blades: 0.65, lush: -0.3 }),
  grassLook(9, { blades: 0.6, lush: -0.2 }),
  grassWith(10, { blades: 0.7 }, (img, rand) => clover(img, rand, 6, 9, 9, 14)),
  grassLook(11, { lush: 0.3, blades: 0.95 }),
];

/** Grass decals: wildflowers, clover, a pair of stones, fallen leaves (never items). */
const GRASS_DECALS = [
  (img: Image, rand: Rng): void => flowers(img, rand, FLOWER[0] as Rgba, 5, 10, 12),
  (img: Image, rand: Rng): void => flowers(img, rand, FLOWER[1] as Rgba, 4, 10, 12),
  (img: Image, rand: Rng): void => flowers(img, rand, FLOWER[2] as Rgba, 4, 10, 12),
  (img: Image, rand: Rng): void => clover(img, rand, 7, 10, 10, 12),
  (img: Image, rand: Rng): void => {
    pebble(img, 12 + Math.floor(rand() * 4), 13 + Math.floor(rand() * 3), true);
    pebble(img, 17 + Math.floor(rand() * 3), 16 + Math.floor(rand() * 3), false);
  },
  // Two fallen leaves: a lit edge, a dark vein.
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 2; i++) {
      const x = 10 + i * 6 + Math.floor(rand() * 4);
      const y = 11 + i * 5 + Math.floor(rand() * 4);
      line(img, x, y, x + 3, y + 1, LEAF[1] as Rgba);
      line(img, x + 1, y - 1, x + 3, y, LEAF[2] as Rgba);
      line(img, x, y + 1, x + 2, y + 2, LEAF[0] as Rgba);
    }
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

/**
 * Dirt as a level field: fine patches and grain (the broad shading is the renderer's
 * groundTone), with clods, a lit pixel over a dark one, on a jittered lattice.
 */
const DIRT_FIELD: LevelGround<null> = {
  level(x, y, seed) {
    const patch =
      tileNoise(x, y, 16, 16, seed) * 0.12 +
      tileNoise(x, y, 8, 8, seed + 1) * 0.3 +
      tileNoise(x, y, 4, 4, seed + 6) * 0.1;
    const grain = (tileNoise(x, y, 2, 2, seed + 2) - 0.5) * 0.45;
    return patch + grain + 0.24;
  },
  paint(img, levelAt, seedAt) {
    eachInRect(0, 0, 32, 32, (x, y) => px(img, x, y, ramp(DIRT.slice(1, 4), levelAt(x, y))));
    for (let cy = 0; cy < 8; cy++)
      for (let cx = 0; cx < 8; cx++) {
        const seed = seedAt(cx * 4 + 2, cy * 4 + 2);
        if (hash2(cx, cy, seed + 3) > 0.45) continue;
        const x = cx * 4 + Math.floor(hash2(cx, cy, seed + 4) * 4);
        const y = cy * 4 + Math.floor(hash2(cx, cy, seed + 5) * 4);
        pxw(img, x, y, DIRT[4] as Rgba);
        pxw(img, x + 1, y, DIRT[3] as Rgba);
        pxw(img, x, y + 1, DIRT[0] as Rgba);
      }
  },
};
const dirtHeart = (salt: number): Look => levelHeart(DIRT_FIELD, null, salt, null);
const dirtWith =
  (salt: number, detail: (img: Image, rand: Rng) => void): Look =>
  (img, rand, seed) => {
    dirtHeart(salt)(img, rand, seed);
    detail(img, rand);
  };

const ROOT = hex("#2a2016");
/** Dirt looks: plain hearts, then hearts with pebbles, a root, a dry crack. */
const DIRT_DETAILS = [
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
const DIRT_LOOKS: Look[] = [
  dirtHeart(1),
  dirtHeart(2),
  dirtHeart(3),
  ...DIRT_DETAILS.map((detail, i) => dirtWith(4 + i, detail)),
];

// ---- sand -------------------------------------------------------------------------------------

const SAND = ["#6a5b41", "#76664a", "#827153", "#8e7c5b", "#9a8864"].map(hex);

/** A take on the sand: rippled dunes, coarse grit, a damp or a sun-bleached patch. */
interface SandTake {
  /** Ripple strength (default 1). */
  ripple?: number;
  /** Ripple slant: bands run along x + slant * y (default 2). */
  slant?: number;
  /** Specks per pixel, a multiple of the plain sand's (default 1). */
  grit?: number;
  /** Shifts the level lighter (+) or darker (-), in ramp steps of about 1/4. */
  shift?: number;
}

/**
 * Sand as a level field: fine patches (the broad shading comes from the renderer's tone,
 * groundTone, so no blotch repeats tile after tile), wind ripples and specks of grit; wet
 * sand adds the sheen the water leaves.
 */
function sandGround(colors: readonly Rgba[], sheen = false): LevelGround<SandTake> {
  return {
    level(x, y, seed, take) {
      const patch =
        tileNoise(x, y, 16, 16, seed) * 0.08 +
        tileNoise(x, y, 8, 8, seed + 1) * 0.2 +
        tileNoise(x, y, 4, 4, seed + 5) * 0.14;
      // Wind ripples: diagonal bands warped by noise (periodic: x + slant * y over 8 px).
      const warp = (tileNoise(x, y, 8, 8, seed + 2) - 0.5) * 6;
      const band = ((((x + (take.slant ?? 2) * y + warp) / 8) % 1) + 1) % 1;
      const crest = band < 0.18 ? 0.18 : band > 0.8 ? -0.12 : 0;
      return patch + crest * (take.ripple ?? 1) + 0.22 + (take.shift ?? 0) * 0.25;
    },
    paint(img, levelAt, seedAt, takeAt) {
      eachInRect(0, 0, 32, 32, (x, y) => px(img, x, y, ramp(colors.slice(1, 5), levelAt(x, y))));
      eachInRect(0, 0, 32, 32, (x, y) => {
        const seed = seedAt(x, y);
        const grit = takeAt(x, y).grit ?? 1;
        const h = hash2(x, y, seed + 4);
        if (h < 0.012 * grit) px(img, x, y, colors[0] as Rgba);
        else if (h > 1 - 0.008 * grit) px(img, x, y, colors[4] as Rgba);
        // Thin sheen streaks where the water just drew back.
        if (!sheen) return;
        const v = tileNoise(x, y * 3, 16, 4, seed + 7);
        if (v > 0.82 && hash2(x, y, seed + 8) < 0.5) px(img, x, y, SHEEN);
      });
    },
  };
}

const SHELL = ["#8a7a72", "#c9b8aa", "#e2d6c6"].map(hex);
const TWIG = ["#3f3224", "#5c4a36", "#7a6650"].map(hex);
const WEED = ["#2c3322", "#3d4529", "#56603a"].map(hex);

/** A small fan shell: ribbed, lit on its top edge, a shadow under it. */
function shell(img: Image, x: number, y: number): void {
  px(img, x, y, SHELL[2] as Rgba);
  px(img, x + 1, y, SHELL[1] as Rgba);
  px(img, x - 1, y + 1, SHELL[1] as Rgba);
  px(img, x, y + 1, SHELL[2] as Rgba);
  px(img, x + 1, y + 1, SHELL[0] as Rgba);
  line(img, x - 1, y + 2, x + 1, y + 2, SAND[0] as Rgba);
}

/** Sand looks, alike ones together: plain hearts, rippled dunes, coarse grit, patches. */
const SAND_FIELD = sandGround(SAND);
const sandLook = (salt: number, take: SandTake): Look => levelHeart(SAND_FIELD, {}, salt, take);
const SAND_LOOKS: Look[] = [
  sandLook(1, {}),
  sandLook(2, {}),
  sandLook(3, { ripple: 0.6 }),
  sandLook(4, { ripple: 0.5, slant: 3 }),
  sandLook(5, { ripple: 1.4 }),
  sandLook(6, { ripple: 1.4, slant: 1 }),
  sandLook(7, { ripple: 1.3, slant: 3 }),
  sandLook(8, { ripple: 0.7, grit: 2.5 }),
  sandLook(9, { ripple: 0.6, grit: 3.5, shift: -0.15 }),
  sandLook(10, { ripple: 0.6, shift: -0.3 }),
  sandLook(11, { ripple: 0.8, grit: 0.5 }),
];

/**
 * Sand decals: shells, pebbles, a dry twig, gull footprints, a strand of dried weed, wind
 * ripples. Small and flat, in the sand's own light, so they read as beach, not as loot.
 */
const SAND_DECALS = [
  (img: Image, rand: Rng): void => {
    shell(img, 12 + Math.floor(rand() * 6), 12 + Math.floor(rand() * 6));
    if (rand() < 0.6) shell(img, 17 + Math.floor(rand() * 4), 17 + Math.floor(rand() * 3));
  },
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 3; i++)
      pebble(img, 10 + Math.floor(rand() * 11), 10 + Math.floor(rand() * 11), rand() < 0.3);
  },
  // A dry twig of driftwood, lit along its top.
  (img: Image, rand: Rng): void => {
    const x = 9 + Math.floor(rand() * 4);
    const y = 13 + Math.floor(rand() * 5);
    line(img, x, y + 1, x + 11, y + 4, TWIG[0] as Rgba);
    line(img, x, y, x + 11, y + 3, TWIG[1] as Rgba);
    line(img, x + 1, y, x + 6, y + 1, TWIG[2] as Rgba);
    line(img, x + 7, y + 2, x + 9, y, TWIG[1] as Rgba);
  },
  // Footprints of a gull.
  (img: Image, rand: Rng): void => {
    let x = 9 + Math.floor(rand() * 3);
    let y = 21;
    for (let i = 0; i < 4; i++) {
      px(img, x, y, SAND[0] as Rgba);
      px(img, x - 1, y - 1, SAND[1] as Rgba);
      px(img, x + 1, y - 1, SAND[1] as Rgba);
      x += 4;
      y -= 2 + (i % 2);
    }
  },
  // A strand of dried weed with a couple of bladders.
  (img: Image, rand: Rng): void => {
    let x = 9;
    let y = 14 + Math.floor(rand() * 4);
    while (x < 23) {
      px(img, x, y, WEED[1] as Rgba);
      px(img, x, y + 1, WEED[0] as Rgba);
      if (rand() < 0.15) px(img, x, y - 1, WEED[2] as Rgba);
      x++;
      if (rand() < 0.35) y += rand() < 0.5 ? -1 : 1;
      y = Math.max(11, Math.min(21, y));
    }
  },
  // A few wind ripples: short light crests over their shadow.
  (img: Image, rand: Rng): void => {
    for (let i = 0; i < 3; i++) {
      const x = 9 + Math.floor(rand() * 6);
      const y = 11 + i * 4 + Math.floor(rand() * 2);
      const len = 6 + Math.floor(rand() * 5);
      line(img, x, y, x + len, y - 1, SAND[4] as Rgba);
      line(img, x + 1, y + 1, x + len, y, SAND[1] as Rgba);
    }
  },
];

const WET_SAND = ["#4f4433", "#594d3a", "#625541", "#6c5e48", "#857760"].map(hex);
const SHEEN = hex("#8c8270");

const WET_SAND_FIELD = sandGround(WET_SAND, true);
const wetSandLook = (salt: number, take: SandTake): Look =>
  levelHeart(WET_SAND_FIELD, {}, salt, take);

const WET_SAND_LOOKS: Look[] = [
  wetSandLook(1, {}),
  wetSandLook(2, { ripple: 0.5 }),
  (img, rand, seed) => {
    wetSandLook(3, {})(img, rand, seed);
    shell(img, 10 + Math.floor(rand() * 12), 10 + Math.floor(rand() * 12));
  },
  wetSandLook(4, { ripple: 1.4 }),
  wetSandLook(5, { shift: -0.25, grit: 2 }),
];

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
  (img: Image, rand: Rng): void => {
    const x0 = 7 + Math.floor(rand() * 10);
    const y0 = 7 + Math.floor(rand() * 10);
    eachInRect(x0, y0, 8 + Math.floor(rand() * 3), 8 + Math.floor(rand() * 3), (x, y) => {
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
/**
 * Water with a shoal: the very water of ground/water_shallow (same seed, so the two meet
 * without a seam and need no border, docs/06 "Bordes"), with small dark fish circling and a
 * ring where one breaks the surface.
 */
function shoal(img: Image, _seed: number, t: number): void {
  water(img, seedOf("ground/water_shallow"), t);
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
  ...levelLooks("ground/grass", GRASS_FIELD, {}, GRASS_LOOKS, GRASS_DECALS),
  ...levelLooks("ground/dirt", DIRT_FIELD, null, DIRT_LOOKS),
  ...levelLooks("ground/sand", SAND_FIELD, {}, SAND_LOOKS, SAND_DECALS),
  ...levelLooks("ground/wet_sand", WET_SAND_FIELD, {}, WET_SAND_LOOKS),
  // Each look of the stone floor twice: the rng of each path puts its detail elsewhere.
  ...withLooks("ground/stone_floor", stoneFloor, [...STONE_LOOKS, ...STONE_LOOKS]),
  ...animated("ground/water_shallow", WATER_FRAMES, water),
  ...animated("ground/water_shoal", WATER_FRAMES, shoal),
  ...animated("ground/lava", LAVA_FRAMES, lava),
};
