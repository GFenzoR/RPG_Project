// spritegen: draws the project's own pixel art from code recipes (src/recipes/) into
// assets/sprites/<path>.png. The PNGs are committed; `make spritegen` regenerates them.
// Deterministic: a recipe's seed comes from its path, so the same code gives the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blit,
  collectSpriteRefs,
  createImage,
  decodePng,
  drawText,
  encodePng,
  fillRect,
  GLYPH_H,
  scaleImage,
  textWidth,
} from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { composite, rng, seedOf } from "./draw.ts";
import type { Recipe } from "./recipe.ts";
import { RECIPES } from "./recipes/index.ts";

export { RECIPES } from "./recipes/index.ts";
export type { Recipe, RecipeBook, RecipeKind } from "./recipe.ts";

export const TILE = 32;

/** Recipe paths in a stable (sorted) order, optionally only those starting with `only`. */
export function recipePaths(only?: string): string[] {
  return Object.keys(RECIPES)
    .filter((p) => !only || p.startsWith(only))
    .sort();
}

/** Draws one recipe into a fresh image of its size. */
export function render(path: string, recipe: Recipe = mustGet(path)): Image {
  const img = createImage(recipe.width ?? TILE, recipe.height ?? TILE);
  const seed = seedOf(path);
  recipe.draw(img, rng(seed), seed);
  return img;
}

function mustGet(path: string): Recipe {
  const r = RECIPES[path];
  if (!r) throw new Error(`spritegen: no recipe for ${path}`);
  return r;
}

/** Where a path's PNG lives under root. */
export function spriteFile(root: string, path: string): string {
  return join(root, "assets", "sprites", `${path}.png`);
}

/** Renders and writes every recipe (or those under `only`); returns path and bytes. */
export function buildSprites(root: string, only?: string): { path: string; bytes: number }[] {
  return recipePaths(only).map((path) => {
    const png = encodePng(render(path));
    const file = spriteFile(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
    return { path, bytes: png.length };
  });
}

/** Player outfit frames, which no data/ file names: outfits/<id>/<dir>_<frame>. */
export const OUTFIT_FRAME = /^outfits\/[a-z0-9_]+\/(n|e|s|w)_[0-9]+$/;

/** Problems with the recipe set: paths no data/ file uses (and that are not outfit frames). */
export function checkPaths(root: string): string[] {
  const used = new Set(collectSpriteRefs(root).map((r) => r.sprite));
  return recipePaths()
    .filter((p) => !used.has(p) && !OUTFIT_FRAME.test(p))
    .map((p) => `${p}: no sprite field in data/ uses this path (and it is not an outfit frame)`);
}

// ---- preview -----------------------------------------------------------------------------

const GRASS = "assets/vendor/dungeon-crawl/dngn/floor/grass/grass0.png";
const LABEL = [230, 230, 220, 255] as const;
const BACKDROP = [24, 24, 28, 255] as const;

/**
 * A sheet to look at (1x pixels; scale it up): ground and walls repeated 3x3, everything
 * else on Dungeon Crawl grass, one cell per sprite with its path underneath.
 */
export function previewSheet(root: string, paths: string[]): Image {
  const grass = decodePng(readFileSync(join(root, GRASS)));
  const cells = paths.map((path) => cell(path, grass));
  const cellW = Math.max(96, ...cells.map((c) => c.width)) + 8;
  const cellH = Math.max(...cells.map((c) => c.height), 32) + GLYPH_H + 6;
  const cols = Math.max(1, Math.min(paths.length, Math.floor(640 / cellW)));
  const rows = Math.ceil(paths.length / cols);
  const sheet = createImage(cols * cellW, rows * cellH);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, BACKDROP);
  cells.forEach((c, i) => {
    const x = (i % cols) * cellW + 4;
    const y = Math.floor(i / cols) * cellH + 2;
    blit(c, 0, 0, c.width, c.height, sheet, x, y);
    const label = (paths[i] ?? "").replace(/^.*\//, "").toUpperCase().replace(/_/g, " ");
    if (textWidth(label, 1) <= cellW) drawText(sheet, label, x, y + c.height + 2, 1, LABEL);
  });
  return sheet;
}

function cell(path: string, grass: Image): Image {
  const recipe = mustGet(path);
  const sprite = render(path, recipe);
  if (recipe.kind === "ground" || recipe.kind === "wall") {
    const out = createImage(sprite.width * 3, sprite.height * 3);
    for (let ty = 0; ty < 3; ty++)
      for (let tx = 0; tx < 3; tx++)
        blit(sprite, 0, 0, sprite.width, sprite.height, out, tx * sprite.width, ty * sprite.height);
    return out;
  }
  // On grass: a 3x3 tile field with the sprite anchored at the bottom-right corner of the
  // centre tile when it is bigger than a tile (as the renderer does), centred otherwise.
  const w = Math.max(96, sprite.width + 32);
  const h = Math.max(96, sprite.height + 32);
  const out = createImage(w, h);
  for (let y = 0; y < h; y += TILE)
    for (let x = 0; x < w; x += TILE) blit(grass, 0, 0, TILE, TILE, out, x, y);
  const tileRight = w - 32;
  const tileBottom = h - 32;
  composite(out, sprite, tileRight - sprite.width, tileBottom - sprite.height);
  return out;
}

export function previewPng(root: string, paths: string[], scale: number): Buffer {
  return encodePng(scaleImage(previewSheet(root, paths), scale));
}
