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
import { castShadow, composite, rng, seedOf } from "./draw.ts";
import type { Recipe } from "./recipe.ts";
import { RECIPES } from "./recipes/index.ts";

export { RECIPES } from "./recipes/index.ts";
export type { Recipe, RecipeBook, RecipeKind, ShadowOptions } from "./recipe.ts";
export { UI_ICON_BOX, UI_SLOT_BOX, uiIconBox } from "./recipe.ts";

export const TILE = 32;

/** Recipe paths in a stable (sorted) order, optionally only those starting with `only`. */
export function recipePaths(only?: string): string[] {
  return Object.keys(RECIPES)
    .filter((p) => !only || p.startsWith(only))
    .sort();
}

/** Draws one recipe into a fresh image of its size (a creature with its cast shadow). */
export function render(path: string, recipe: Recipe = mustGet(path)): Image {
  const img = createImage(recipe.width ?? TILE, recipe.height ?? TILE);
  const seed = seedOf(path);
  recipe.draw(img, rng(seed), seed);
  // A creature of ours casts the shadow the Dungeon Crawl monsters have, so both sit on
  // the map the same way (assets/README.md, "Sombra de las criaturas"), unless it stands
  // on the renderer's contact ellipse like the animated monsters (shadow: false).
  if (recipe.kind === "creature" && recipe.shadow !== false) castShadow(img, recipe.shadow);
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

/**
 * Tile effect frames, which no data/ file names either: effects/<name>/<frame>. The client
 * maps each protocol effect id to its folder (client/src/render/effects.ts).
 */
export const EFFECT_FRAME = /^effects\/([a-z0-9_]+)\/([0-9]+)$/;

/**
 * Animation frames of a creature sprite (docs/17 ANI-4): <sprite>/<action>_<dir>_<n>, such as
 * creatures/bristleback_boar/walk_w_0. Valid when data/ uses <sprite>; tools/spritepack
 * turns them into that sprite's clips.
 */
export const ANIM_FRAME = /^(.+)\/(idle|walk|attack|shoot|cast|death)_(n|e|s|w)_[0-9]+$/;

/**
 * Map tile art (docs/17 ART-3, ART-4, ART-7, tools/spritepack tiles.ts): a ground's other
 * looks <sprite>/var_<n>, an animation's frames <sprite>/frame_<n>, a wall's pieces
 * <sprite>/wall_<mask> and a cast shadow <sprite>/shadow. Valid when data/ uses <sprite>.
 */
export const TILE_PART =
  /^(.+)\/(?:var_[1-9][0-9]*|frame_[1-9][0-9]*|wall_(?:[0-9]|1[0-5])|shadow)$/;

/**
 * Client interface icons, which the client finds by path (no data/ file names them):
 * ui/<group>/<id>, such as the PvP marks ui/marks/aggressor (client/src/render/marks.ts).
 */
export const UI_ICON = /^ui\/[a-z0-9_]+\/[a-z0-9_]+$/;

/**
 * Problems with the recipe set: paths no data/ file uses (and that are neither outfit nor
 * effect frames nor ui icons), ui icons that are not of kind "ui" (or the other way
 * round), and effect strips whose frames are not 0, 1, ... without a gap (the client
 * stops at the first missing frame).
 */
export function checkPaths(root: string): string[] {
  const used = new Set(collectSpriteRefs(root).map((r) => r.sprite));
  const problems: string[] = [];
  for (const p of recipePaths()) {
    const ui = RECIPES[p]?.kind === "ui";
    if (ui !== UI_ICON.test(p))
      problems.push(`${p}: ui icons are exactly the ui/<group>/<id> paths of kind "ui"`);
    else if (
      !ui &&
      !used.has(p) &&
      !OUTFIT_FRAME.test(p) &&
      !EFFECT_FRAME.test(p) &&
      !used.has(ANIM_FRAME.exec(p)?.[1] ?? "") &&
      !used.has(TILE_PART.exec(p)?.[1] ?? "")
    )
      problems.push(
        `${p}: no sprite field in data/ uses this path (and it is not an outfit, animation, effect or tile art frame)`,
      );
  }
  const strips = new Map<string, number[]>();
  for (const p of recipePaths()) {
    const m = EFFECT_FRAME.exec(p);
    if (!m) continue;
    const frames = strips.get(m[1] ?? "") ?? [];
    frames.push(Number(m[2]));
    strips.set(m[1] ?? "", frames);
  }
  for (const [name, frames] of strips) {
    frames.sort((a, b) => a - b);
    if (frames.some((f, i) => f !== i))
      problems.push(`effects/${name}: frames must be 0..${frames.length - 1} without gaps`);
  }
  return problems;
}

// ---- preview -----------------------------------------------------------------------------

const GRASS = "assets/vendor/dungeon-crawl/dngn/floor/grass/grass0.png";
const LABEL = [230, 230, 220, 255] as const;
const BACKDROP = [24, 24, 28, 255] as const;
/** What effect frames are previewed over. */
const PREVIEW_CREATURE = "creatures/bristleback_boar";

/** A frame path (…/<name>/<n>) belongs to the strip …/<name>; other paths stand alone. */
const stripOf = (path: string): string | undefined => /^(.*)\/[0-9]+$/.exec(path)?.[1];

/** The cell caption: the file name, or "<strip> <n>" for a numbered frame. */
function caption(path: string): string {
  const parts = path.split("/");
  const last = parts.at(-1) ?? "";
  const name = /^[0-9]+$/.test(last) ? `${parts.at(-2) ?? ""} ${last}` : last;
  return name.toUpperCase().replace(/_/g, " ");
}

/**
 * A sheet to look at (1x pixels; scale it up): ground and walls repeated 3x3, everything
 * else on Dungeon Crawl grass, one cell per sprite with its path underneath. The frames of
 * a strip (effects/<name>/<n>) start a new row, so each effect reads left to right.
 */
export function previewSheet(root: string, paths: string[]): Image {
  const grass = decodePng(readFileSync(join(root, GRASS)));
  const cells = paths.map((path) => cell(path, grass));
  const cellW = Math.max(96, ...cells.map((c) => c.width)) + 8;
  const cellH = Math.max(...cells.map((c) => c.height), 32) + GLYPH_H + 6;
  const cols = Math.max(1, Math.min(paths.length, Math.floor(640 / cellW)));
  // Grid slot of each cell: a new strip (or a lone sprite after a strip) starts a new row.
  const slots: { col: number; row: number }[] = [];
  let col = 0;
  let row = 0;
  paths.forEach((path, i) => {
    const prev = i > 0 ? stripOf(paths[i - 1] ?? "") : undefined;
    const strip = stripOf(path);
    if (i > 0 && (col >= cols || strip !== prev)) {
      col = 0;
      row++;
    }
    slots.push({ col, row });
    col++;
  });
  const sheet = createImage(cols * cellW, (row + 1) * cellH);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, BACKDROP);
  cells.forEach((c, i) => {
    const slot = slots[i] ?? { col: 0, row: 0 };
    const x = slot.col * cellW + 4;
    const y = slot.row * cellH + 2;
    blit(c, 0, 0, c.width, c.height, sheet, x, y);
    const label = caption(paths[i] ?? "");
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
  // An effect plays over the creature on its tile: show it over one standing there, its
  // bottom centred on the tile (the boar is 64x64, anchor bc).
  if (recipe.kind === "effect" && RECIPES[PREVIEW_CREATURE]) {
    const c = render(PREVIEW_CREATURE);
    composite(out, c, tileRight - TILE / 2 - c.width / 2, tileBottom - c.height);
  }
  composite(out, sprite, tileRight - sprite.width, tileBottom - sprite.height);
  return out;
}

export function previewPng(root: string, paths: string[], scale: number): Buffer {
  return encodePng(scaleImage(previewSheet(root, paths), scale));
}
