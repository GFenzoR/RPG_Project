// Ground variety (docs/17 ART-4): the pieces every ground uses for its many looks and its
// decals. A look must meet any other look of its ground without a seam, so it keeps the
// main look's outer ring of pixels and only redraws its heart: another seed of the same
// texture (or a rippled, coarser, lusher or drier take on it). A level ground (sand, grass,
// dirt) blends the heart's level field in smoothly (levelHeart) from a main look whose
// ring is close to its mean (calmSeed), so no frame shows; a grain ground (ash, cinders)
// fades the heart in with an ordered dither (heart), which keeps every colour in palette. Decals are transparent sprites
// the renderer lays flat on a few tiles (groundDecal in packages/renderer tile-art.ts):
// small, flat, low in contrast, kept in the middle of the tile, so they read as part of the
// ground and never as an item lying on it.
import type { Image } from "@rpg/spritepack";
import { canvas, eachInRect } from "../draw.ts";
import type { Rng } from "../draw.ts";
import type { RecipeBook } from "../recipe.ts";

/** 4x4 Bayer matrix: the order the pixels of a fade switch in. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Pixels of the outer ring every look shares with the main look. */
export const RING = 1;
/** Pixels over which the heart fades in after the ring. */
export const FADE = 6;

/** How much of the heart shows at (x, y) of a 32x32 tile: 0 on the ring, 1 inside. */
export function heartWeight(x: number, y: number): number {
  const d = Math.min(x, y, 31 - x, 31 - y);
  return Math.max(0, Math.min(1, (d - RING + 1) / (FADE + 1)));
}

/** Copies `heart` over `img` where heartWeight beats the dither threshold. */
export function blendHeart(img: Image, heart: Image): void {
  eachInRect(0, 0, 32, 32, (x, y) => {
    const t = ((BAYER[(y & 3) * 4 + (x & 3)] as number) + 0.5) / 16;
    if (heartWeight(x, y) <= t) return;
    const i = (y * 32 + x) * 4;
    img.data[i] = heart.data[i] as number;
    img.data[i + 1] = heart.data[i + 1] as number;
    img.data[i + 2] = heart.data[i + 2] as number;
    img.data[i + 3] = 255;
  });
}

/** A look drawn over the main look: gets the image (main look drawn), the rng, the seed. */
export type Look = (img: Image, rand: Rng, seed: number) => void;

/**
 * A look whose heart is `draw` with another seed (salt): the same texture, other patches,
 * ripples and specks, joined to the ring of the main look.
 */
export function heart(draw: (img: Image, seed: number) => void, salt: number): Look {
  return (img, _rand, seed) => {
    const inner = canvas(32, 32);
    draw(inner, (seed + Math.imul(salt, 0x9e3779b1)) >>> 0);
    blendHeart(img, inner);
  };
}

/**
 * A ground with its looks <sprite>/var_<n> (each drawn over the main look) and its decals
 * <sprite>/decal_<n> (transparent objects). Looks are listed so that neighbours in the list
 * are alike: the renderer lets an area lean to a run of neighbouring looks.
 */
export function groundBook(
  sprite: string,
  seed: number,
  base: (img: Image, seed: number) => void,
  looks: readonly Look[],
  decals: readonly ((img: Image, rand: Rng) => void)[] = [],
): RecipeBook {
  const book: RecipeBook = { [sprite]: { kind: "ground", draw: (img) => base(img, seed) } };
  looks.forEach((look, i) => {
    book[`${sprite}/var_${i + 1}`] = {
      kind: "ground",
      draw: (img, rand) => {
        base(img, seed);
        look(img, rand, seed);
      },
    };
  });
  decals.forEach((decal, i) => {
    book[`${sprite}/decal_${i + 1}`] = { kind: "object", draw: (img, rand) => decal(img, rand) };
  });
  return book;
}

/** heartWeight eased (smoothstep): a fade with no edge of its own. */
export function smoothHeart(x: number, y: number): number {
  const t = heartWeight(x, y);
  return t * t * (3 - 2 * t);
}

/**
 * A ground drawn from a level field (patches, ripples, grain) that `paint` turns into its
 * tones and specks. Its looks blend the level of another seed into the heart continuously
 * (levelHeart), which reads as one surface: no dithered frame where the heart begins.
 */
export interface LevelGround<T> {
  level(x: number, y: number, seed: number, take: T): number;
  /** Paints every pixel: levelAt gives the level, seedAt and takeAt the specks' seed and take. */
  paint(
    img: Image,
    levelAt: (x: number, y: number) => number,
    seedAt: (x: number, y: number) => number,
    takeAt: (x: number, y: number) => T,
  ): void;
}

/** The main look of a level ground. */
export function drawLevel<T>(g: LevelGround<T>, take: T): (img: Image, seed: number) => void {
  return (img, seed) =>
    g.paint(
      img,
      (x, y) => g.level(x, y, seed, take),
      () => seed,
      () => take,
    );
}

/** The seed of a heart: the ground's seed with a salt. */
export const heartSeed = (seed: number, salt: number): number =>
  (seed + Math.imul(salt, 0x9e3779b1)) >>> 0;

/**
 * A look of a level ground whose heart is another seed (salt) and take of it: the levels
 * blend smoothly from the main look's ring (base take) to the heart's, and the specks of
 * the inner half are the heart's.
 */
export function levelHeart<T>(g: LevelGround<T>, base: T, salt: number, take: T): Look {
  return (img, _rand, seed) => {
    const inner = heartSeed(seed, salt);
    const inside = (x: number, y: number): boolean => smoothHeart(x, y) > 0.5;
    g.paint(
      img,
      (x, y) => {
        const w = smoothHeart(x, y);
        const a = g.level(x, y, seed, base);
        return w === 0 ? a : a + (g.level(x, y, inner, take) - a) * w;
      },
      (x, y) => (inside(x, y) ? inner : seed),
      (x, y) => (inside(x, y) ? take : base),
    );
  };
}

/** Seeds calmSeed tries. */
export const CALM_TRIES = 64;

/**
 * The seed of a level ground's main look: of CALM_TRIES seeds from `seed`, the one whose
 * edge lines (the two outer rows and columns on each side, which every look shares) come
 * closest to the tile's mean level. Otherwise a darker or lighter ring would draw the grid.
 */
export function calmSeed<T>(g: LevelGround<T>, take: T, seed: number): number {
  let best = seed;
  let bestScore = Infinity;
  for (let k = 0; k < CALM_TRIES; k++) {
    const s = heartSeed(seed, k * 7919);
    const lv: number[] = [];
    let sum = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const v = g.level(x, y, s, take);
        lv.push(v);
        sum += v;
      }
    const mean = sum / 1024;
    let score = 0;
    for (const i of [0, 1, 30, 31]) {
      let row = 0;
      let col = 0;
      for (let j = 0; j < 32; j++) {
        row += lv[i * 32 + j] as number;
        col += lv[j * 32 + i] as number;
      }
      score = Math.max(score, Math.abs(row / 32 - mean), Math.abs(col / 32 - mean));
    }
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
