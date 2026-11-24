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
import type { Recipe, RecipeBook } from "./recipe.ts";
import { MAX_ORB_FRAMES, ORB_ELEMENTS } from "./recipes/effects.ts";
import { RECIPES, recipesAt } from "./recipes/index.ts";
import { corpsePath, monsterIds } from "./recipes/corpses.ts";

export { RECIPES, recipesAt } from "./recipes/index.ts";
export type { Recipe, RecipeBook, RecipeKind, ShadowOptions } from "./recipe.ts";
export { UI_ICON_BOX, UI_SLOT_BOX, UI_STATUS_BOX, uiIconBox } from "./recipe.ts";

export const TILE = 32;

/**
 * Recipe paths in a stable (sorted) order, optionally only those starting with `only`, of
 * `book` (the repo's recipes, or recipesAt another root).
 */
export function recipePaths(only?: string, book: RecipeBook = RECIPES): string[] {
  return Object.keys(book)
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

function mustGet(path: string, book: RecipeBook = RECIPES): Recipe {
  const r = book[path];
  if (!r) throw new Error(`spritegen: no recipe for ${path}`);
  return r;
}

/** The living world's sprites (livingworld/README.md) keep their own folder of assets/. */
export const LIVING_PREFIX = "livingworld/";

/**
 * Where a path's PNG lives under root: assets/sprites/<path>.png, or for the living world's
 * livingworld/<rest> paths assets/livingworld/sprites/<rest>.png (tools/spritepack reads
 * both, under the same names).
 */
export function spriteFile(root: string, path: string): string {
  if (path.startsWith(LIVING_PREFIX))
    return join(
      root,
      "assets",
      "livingworld",
      "sprites",
      `${path.slice(LIVING_PREFIX.length)}.png`,
    );
  return join(root, "assets", "sprites", `${path}.png`);
}

/**
 * The living world's effect masks (footprints, ripples, dust, leaves, critters), which the
 * client looks up by name (livingworld/client): livingworld/fx/<name>, of kind "effect".
 */
export const LIVING_FX = /^livingworld\/fx\/[a-z0-9_]+$/;

/** Renders and writes every recipe (or those under `only`); returns path and bytes. */
export function buildSprites(root: string, only?: string): { path: string; bytes: number }[] {
  const book = recipesAt(root);
  return recipePaths(only, book).map((path) => {
    const png = encodePng(render(path, mustGet(path, book)));
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
 * Missile art, which no data/ file names: exactly the paths the client looks for
 * (client/src/render/effects.ts missileArt): the arrow missiles/arrow/e and /se, and per
 * element with an orb its frames missiles/<element>/0 .. MAX_ORB_FRAMES - 1 and its trail
 * missiles/<element>/trail. An orb's path gives its element (group 1) and frame (group 2).
 */
export const MISSILE_ART = new RegExp(
  `^missiles/(?:arrow/(?:e|se)|(${ORB_ELEMENTS.join("|")})/(${Array.from(
    { length: MAX_ORB_FRAMES },
    (_, f) => f,
  ).join("|")}|trail))$`,
);

/**
 * Animation frames of a creature sprite (docs/17 ANI-4): <sprite>/<action>_<dir>_<n>, such as
 * creatures/bristleback_boar/walk_w_0. Valid when data/ uses <sprite>; tools/spritepack
 * turns them into that sprite's clips.
 */
export const ANIM_FRAME =
  /^(.+)\/(idle|walk|attack|shoot|cast|death)_(n|e|s|w|ne|se|sw|nw)_[0-9]+$/;

/**
 * Map tile art (docs/17 ART-3, ART-4, ART-7, tools/spritepack tiles.ts): a ground's other
 * looks <sprite>/var_<n> and its decals <sprite>/decal_<n>, an animation's frames <sprite>/frame_<n>, a wall's pieces
 * <sprite>/wall_<mask> and a cast shadow <sprite>/shadow. Valid when data/ uses <sprite>.
 */
export const TILE_PART =
  /^(.+)\/(?:var_[1-9][0-9]*|decal_[1-9][0-9]*|frame_[1-9][0-9]*|wall_(?:[0-9]|1[0-5])|shadow)$/;

/**
 * Client interface icons, which the client finds by path (no data/ file names them):
 * ui/<group>/<id>, such as the PvP marks ui/marks/aggressor (client/src/render/marks.ts).
 */
export const UI_ICON = /^ui\/[a-z0-9_]+\/[a-z0-9_]+$/;

/**
 * Problems with the recipe set: paths no data/ file uses (and that are neither outfit nor
 * effect frames, missile art nor ui icons), ui icons that are not of kind "ui" (or the
 * other way round), and effect or missile strips whose frames are not 0, 1, ... without a
 * gap (the client stops at the first missing frame).
 */
export function checkPaths(root: string): string[] {
  const used = new Set(collectSpriteRefs(root).map((r) => r.sprite));
  const book = recipesAt(root);
  // A monster's corpse (recipes/corpses.ts), which the client finds by the monster's id.
  const corpses = new Set(monsterIds(root).map(corpsePath));
  const problems: string[] = [];
  for (const p of recipePaths(undefined, book)) {
    const ui = book[p]?.kind === "ui";
    if (ui !== UI_ICON.test(p))
      problems.push(`${p}: ui icons are exactly the ui/<group>/<id> paths of kind "ui"`);
    else if (
      !ui &&
      !used.has(p) &&
      !OUTFIT_FRAME.test(p) &&
      !EFFECT_FRAME.test(p) &&
      !MISSILE_ART.test(p) &&
      !LIVING_FX.test(p) &&
      !corpses.has(p) &&
      !used.has(ANIM_FRAME.exec(p)?.[1] ?? "") &&
      !used.has(TILE_PART.exec(p)?.[1] ?? "")
    )
      problems.push(
        `${p}: no sprite field in data/ uses this path (and it is not an outfit, animation, effect or tile art frame)`,
      );
  }
  const strips = new Map<string, number[]>();
  for (const p of recipePaths(undefined, book)) {
    const m = EFFECT_FRAME.exec(p);
    const missile = MISSILE_ART.exec(p);
    const folder = m ? `effects/${m[1] ?? ""}` : missile?.[1] ? `missiles/${missile[1]}` : "";
    const frame = m ? m[2] : missile?.[2];
    if (!folder || frame === undefined || !/^[0-9]+$/.test(frame)) continue;
    if (book[p]?.kind !== "effect") problems.push(`${p}: must be of kind "effect"`);
    const frames = strips.get(folder) ?? [];
    frames.push(Number(frame));
    strips.set(folder, frames);
  }
  for (const [folder, frames] of strips) {
    frames.sort((a, b) => a - b);
    if (frames.some((f, i) => f !== i))
      problems.push(`${folder}: frames must be 0..${frames.length - 1} without gaps`);
  }
  return problems;
}

// ---- preview -----------------------------------------------------------------------------

const GRASS = "assets/vendor/dungeon-crawl/dngn/floor/grass/grass0.png";
const LABEL = [230, 230, 220, 255] as const;
const BACKDROP = [24, 24, 28, 255] as const;
/** What effect frames are previewed over (an engine frame: the boar standing, facing south). */
const PREVIEW_CREATURE = "creatures/bristleback_boar/idle_s_0";

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
  const book = recipesAt(root);
  const cells = paths.map((path) => cell(path, grass, book));
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

function cell(path: string, grass: Image, book: RecipeBook): Image {
  const recipe = mustGet(path, book);
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
