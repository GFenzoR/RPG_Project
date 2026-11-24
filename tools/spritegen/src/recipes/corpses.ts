// The corpse of every monster (docs/02 "Muerte", docs/17 "Cadáveres"): corpses/<monster id>,
// one per monster of data/monsters, made from the monster's own art, so the remains it
// leaves are that creature lying dead and not its family's shared body. The server marks
// the family's container item with the monster that fell (ItemMods remains_of) and the
// client draws this sprite for it (client/src/state/corpse-art.ts). Data drives them: a
// new monster gets its corpse with `make spritegen`, and the committed-PNG test fails
// until it has one (tools/spritepack packs every PNG of assets/sprites); a monster with
// no art to make one from is a problem of `spritegen check` (index.ts checkPaths).
//
// How each one is made, deterministically:
// - an engine humanoid (a `look`): its paper doll composed in the last frame of its death
//   (facing south, as the client draws the fall), with the look's own tints;
// - a creature with a death clip (<sprite>/death_s_<n>): the clip's last frame, how the
//   creature fell;
// - a single image (no clip): the sprite tipped onto its side and flattened against the
//   floor, the procedural fall's last pose.
// Art that code draws (the engine's frames, recipes/creatures.ts) is taken from its recipe,
// drawn when the corpse is, never from its committed PNG: one `make spritegen` after
// changing a creature (or adding one) writes its frames and the corpse of those frames, in
// any order. Only art no recipe draws (a hand-made or third-party PNG, which a build never
// rewrites) is read from assets/sprites.
// Then the body is darkened and a little greyed (no blood: the hit effects have it), and
// placed so the client can draw every corpse centred on its tile with its lowest pixel
// where the creature's feet stood (FEET_LINE above the tile's bottom), as big as the
// creature was: a 96x96 boss keeps its footprint.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createImage, decodePng, parseYaml } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { composeFrame } from "../engine/specs/humanoid/compose.ts";
import { lookOf, lookTables, wornOf } from "../engine/specs/humanoid/previews.ts";
import { HUMANOID_LAYERS } from "../engine/specs/humanoid/index.ts";
import type { Recipe, RecipeBook } from "../recipe.ts";
import { renderRecipe, TILE } from "../render.ts";

/** The atlas path of a monster's corpse (client/src/state/corpse-art.ts corpseSprite). */
export const corpsePath = (monster: string): string => `corpses/${monster}`;

/** Where a standing creature's feet are, px above its tile's bottom (packages/renderer FEET_LINE). */
export const FEET_LINE = 4;
/** How much light a corpse keeps (of 256) and how much of its colour (of 256). */
export const CORPSE_LIGHT = 200;
export const CORPSE_COLOUR = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Frames of the humanoid's death (the body layer's spec). */
const HUMANOID_DEATH_FRAMES =
  HUMANOID_LAYERS.find((l) => l.slot === "body")?.spec.actions?.death?.frames ?? 4;

/** Darkens and greys `img` in place (alpha untouched). */
export function deaden(img: Image): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 0) === 0) continue;
    const r = d[i] ?? 0;
    const g = d[i + 1] ?? 0;
    const b = d[i + 2] ?? 0;
    const y = (77 * r + 151 * g + 28 * b) >> 8;
    for (let k = 0; k < 3; k++) {
      const c = d[i + k] ?? 0;
      const mixed = y + (((c - y) * CORPSE_COLOUR) >> 8);
      d[i + k] = Math.max(0, Math.min(255, (mixed * CORPSE_LIGHT) >> 8));
    }
  }
}

/** Lowest row with an opaque pixel (-1: none). */
function lowestRow(img: Image): number {
  for (let y = img.height - 1; y >= 0; y--)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) > 0) return y;
  return -1;
}

/**
 * A single image (no death clip) fallen: turned a quarter onto its side (its back to the
 * floor's far side) and flattened to 3/5 of its height, as the procedural fall squashes it.
 * Square sprites only (the turn keeps the size): another shape throws instead of losing
 * pixels.
 */
export function tipOver(src: Image): Image {
  if (src.width !== src.height)
    throw new Error(
      `spritegen: a corpse is tipped over from a square image, not ${src.width}x${src.height} (give the creature a death clip)`,
    );
  const n = src.width;
  const turned = createImage(n, n);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      if ((src.data[s + 3] ?? 0) === 0) continue;
      // Clockwise: (x, y) -> (n - 1 - y, x).
      const d = (x * n + (n - 1 - y)) * 4;
      turned.data.set(src.data.subarray(s, s + 4), d);
    }
  const out = createImage(n, n);
  const h = Math.max(1, Math.round((n * 3) / 5));
  for (let y = 0; y < h; y++) {
    const sy = Math.min(n - 1, Math.floor((y * n) / h));
    for (let x = 0; x < n; x++) {
      const s = (sy * n + x) * 4;
      if ((turned.data[s + 3] ?? 0) === 0) continue;
      out.data.set(turned.data.subarray(s, s + 4), ((n - h + y) * n + x) * 4);
    }
  }
  return out;
}

/** How wide the corpse of a body `width` px wide anchored `anchor` is (corpseOf). */
export const corpseWidth = (width: number, anchor: "bc" | "br"): number =>
  anchor === "br" && width > TILE ? 2 * width - TILE : width;

/**
 * The fallen body `src` (anchored `anchor` as the creature was drawn) as a corpse sprite:
 * darkened, centred on its tile (a bottom-right sprite wider than a tile is widened so
 * its centre falls where it stood) and with its lowest pixel FEET_LINE above the bottom.
 */
export function corpseOf(src: Image, anchor: "bc" | "br"): Image {
  const width = corpseWidth(src.width, anchor);
  const out = createImage(width, src.height);
  const low = lowestRow(src);
  const dy = low < 0 ? 0 : src.height - 1 - FEET_LINE - low;
  for (let y = 0; y < src.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= out.height) continue;
    const s = y * src.width * 4;
    out.data.set(src.data.subarray(s, s + src.width * 4), ty * width * 4);
  }
  deaden(out);
  return out;
}

const recipeOf = (width: number, height: number, body: () => Image): Recipe => ({
  kind: "object",
  width,
  height,
  draw: (img) => img.data.set(body().data),
});

/** The animation hints of assets/sprites.yaml (anchor) by sprite path. */
function anchors(root: string): Map<string, "bc" | "br"> {
  const out = new Map<string, "bc" | "br">();
  const file = join(root, "assets", "sprites.yaml");
  if (!existsSync(file)) return out;
  const doc = parseYaml(readFileSync(file, "utf8"));
  const anims = isObj(doc) && isObj(doc["animations"]) ? doc["animations"] : {};
  for (const [sprite, entry] of Object.entries(anims))
    out.set(sprite, isObj(entry) && entry["anchor"] === "bc" ? "bc" : "br");
  return out;
}

/** The highest <n> of the names `<prefix><n><suffix>` among `names` (undefined: none). */
function lastFrame(names: Iterable<string>, prefix: string, suffix: string): number | undefined {
  let last: number | undefined;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const digits = name.slice(prefix.length, name.length - suffix.length);
    if (!/^[0-9]+$/.test(digits)) continue;
    last = Math.max(last ?? 0, Number(digits));
  }
  return last;
}

/** A fallen body before it is made a corpse: its size, and how to draw it. */
interface Fallen {
  width: number;
  height: number;
  body: () => Image;
}

/**
 * The fallen body of the creature drawn with `sprite`: the last frame of its death clip
 * facing south, or its single image tipped over. Art of `coded` (the recipes in code) is
 * drawn from its recipe when asked, so it is never an older PNG; other art is the PNG of
 * assets/sprites under `root`. Undefined: nothing to make it from (a single image that is
 * not square cannot be tipped over).
 */
function fallenOf(root: string, sprite: string, coded: RecipeBook): Fallen | undefined {
  const clip = `${sprite}/death_s_`;
  const codedLast = lastFrame(Object.keys(coded), clip, "");
  const frame = codedLast === undefined ? undefined : coded[`${clip}${codedLast}`];
  if (frame)
    return {
      width: frame.width ?? TILE,
      height: frame.height ?? TILE,
      body: () => renderRecipe(`${clip}${codedLast ?? 0}`, frame),
    };
  const dir = join(root, "assets", "sprites", sprite);
  const fileLast = existsSync(dir) ? lastFrame(readdirSync(dir), "death_s_", ".png") : undefined;
  if (fileLast !== undefined) {
    const img = decodePng(readFileSync(join(dir, `death_s_${fileLast}.png`)));
    return { width: img.width, height: img.height, body: () => img };
  }
  const recipe = coded[sprite];
  if (recipe) {
    const size = { width: recipe.width ?? TILE, height: recipe.height ?? TILE };
    if (size.width !== size.height) return undefined;
    return { ...size, body: () => tipOver(renderRecipe(sprite, recipe)) };
  }
  const single = join(root, "assets", "sprites", `${sprite}.png`);
  if (!existsSync(single)) return undefined;
  const img = decodePng(readFileSync(single));
  if (img.width !== img.height) return undefined;
  return { width: img.width, height: img.height, body: () => tipOver(img) };
}

/** The ids of data/monsters under `root`, sorted by file. */
export function monsterIds(root: string): string[] {
  const dir = join(root, "data", "monsters");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")))
    .filter(isObj)
    .map((m) => m["id"])
    .filter((id): id is string => typeof id === "string");
}

/**
 * One corpse recipe per monster of data/monsters under `root` that has art to make it from
 * (see fallenOf; `coded` are the recipes in code, whose art is drawn and not read). A
 * monster left out is a problem of `spritegen check`.
 */
export function corpseRecipes(root: string, coded: RecipeBook): RecipeBook {
  const book: RecipeBook = {};
  const dir = join(root, "data", "monsters");
  if (!existsSync(dir)) return book;
  const read = (file: string): unknown => parseYaml(readFileSync(join(root, file), "utf8"));
  let tables: ReturnType<typeof lookTables> | undefined;
  const hints = anchors(root);
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const m = parseYaml(readFileSync(join(dir, file), "utf8"));
    if (!isObj(m) || typeof m["id"] !== "string") continue;
    const path = corpsePath(m["id"]);
    if (isObj(m["look"])) {
      tables ??= lookTables(read("data/looks.yaml"));
      const t = tables;
      const look = lookOf(m["look"]);
      const worn = wornOf(m["look"]["worn"]);
      book[path] = recipeOf(64, 64, () =>
        corpseOf(composeFrame(look, worn, t, "death", "s", HUMANOID_DEATH_FRAMES - 1), "bc"),
      );
      continue;
    }
    const sprite = m["sprite"];
    if (typeof sprite !== "string") continue;
    const anchor = hints.get(sprite) ?? "br";
    const fallen = fallenOf(root, sprite, coded);
    if (!fallen) continue;
    book[path] = recipeOf(corpseWidth(fallen.width, anchor), fallen.height, () =>
      corpseOf(fallen.body(), anchor),
    );
  }
  return book;
}

/** The living creature of a monster, standing facing south (the review sheet's left half). */
function living(root: string, m: Obj): { img: Image; anchor: "bc" | "br" } | undefined {
  if (isObj(m["look"])) {
    const t = lookTables(parseYaml(readFileSync(join(root, "data", "looks.yaml"), "utf8")));
    const img = composeFrame(lookOf(m["look"]), wornOf(m["look"]["worn"]), t, "idle", "s", 0);
    return { img, anchor: "bc" };
  }
  const sprite = m["sprite"];
  if (typeof sprite !== "string") return undefined;
  const anchor = anchors(root).get(sprite) ?? "br";
  const idle = join(root, "assets", "sprites", sprite, "idle_s_0.png");
  const single = join(root, "assets", "sprites", `${sprite}.png`);
  const file = existsSync(idle) ? idle : existsSync(single) ? single : undefined;
  return file ? { img: decodePng(readFileSync(file)), anchor } : undefined;
}

/**
 * The review sheet of the corpses (cli.ts corpses): one cell per monster on a grass-like
 * floor with the tile grid, the living creature on its tile at the left and its corpse on
 * the tile at the right, both placed as the client places them (centred, feet FEET_LINE
 * above the tile's bottom). 1x; scale it to look.
 */
export function corpseSheet(root: string, book: RecipeBook): Image {
  const dir = join(root, "data", "monsters");
  const ids = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")))
    .filter(isObj);
  const CELL_W = 224;
  const CELL_H = 112;
  const COLS = 4;
  const rows = Math.ceil(ids.length / COLS);
  const sheet = createImage(CELL_W * COLS, CELL_H * rows);
  for (let y = 0; y < sheet.height; y++)
    for (let x = 0; x < sheet.width; x++) {
      const grid = x % 32 === 0 || y % 32 === 0;
      const v = grid ? [70, 92, 58] : [84, 108, 66];
      sheet.data.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, 255], (y * sheet.width + x) * 4);
    }
  const put = (img: Image, cx: number, bottom: number): void => {
    const low = lowestRow(img);
    const dy = low < 0 ? 0 : bottom - FEET_LINE - 1 - low;
    const x0 = cx - Math.floor(img.width / 2);
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        if ((img.data[s + 3] ?? 0) === 0) continue;
        const tx = x0 + x;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= sheet.width || ty >= sheet.height) continue;
        sheet.data.set(img.data.subarray(s, s + 4), (ty * sheet.width + tx) * 4);
      }
  };
  ids.forEach((m, i) => {
    const ox = (i % COLS) * CELL_W;
    const oy = Math.floor(i / COLS) * CELL_H;
    const bottom = oy + 96; // the bottom of the cell's third row of tiles
    const alive = living(root, m);
    if (alive) put(alive.img, ox + 48, bottom);
    const recipe = typeof m["id"] === "string" ? book[corpsePath(m["id"])] : undefined;
    if (recipe) {
      const img = createImage(recipe.width ?? 32, recipe.height ?? 32);
      recipe.draw(img, () => 0, 0);
      put(img, ox + 144 + 16, bottom);
    }
  });
  return sheet;
}
