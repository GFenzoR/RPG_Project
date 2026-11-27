// The corpses of every monster (docs/02 "Muerte", docs/17 "Cadáveres" and "Un cadáver por
// dirección"): corpses/<monster id> (fallen facing south) and corpses/<monster id>_<e|n|w>,
// four per monster of data/monsters, made from the monster's own art, so the remains it
// leaves are that creature lying dead the way it fell and not its family's shared body. The server marks
// the family's container item with the monster that fell (ItemMods remains_of) and the
// client draws this sprite for it (client/src/state/corpse-art.ts). Data drives them: a
// new monster gets its corpse with `make spritegen`, and the committed-PNG test fails
// until it has one (tools/spritepack packs every PNG of assets/sprites); a monster with
// no art to make one from is a problem of `spritegen check` (index.ts checkPaths).
//
// How each one is made, deterministically, with the rule the client plays the fall with
// (packages/renderer anim.ts fallArt), so the fall ends on the corpse's pixels:
// - an engine humanoid (a `look`): its paper doll composed in the last frame of its death
//   in that facing (the engine draws the four), with the look's own tints;
// - a creature with a death clip in that facing (<sprite>/death_<dir>_<n>: the engine's
//   boar and stag): the clip's last frame, how the creature fell;
// - a creature whose death clip faces south only (the hand-made monsters): the last south
//   frame, as it is for the south and the east, mirrored for the north and the west;
// - a single image (no clip): the sprite tipped onto its side (clockwise or counter-
//   clockwise, mirrored or not: four bodies) and flattened against the floor, the
//   procedural fall's last pose.
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
import { FALL_DIRS, fallArt } from "../../../../packages/renderer/src/anim.ts";
import type { AnimDir, FallDir } from "../../../../packages/renderer/src/anim.ts";
import { composeFrame } from "../engine/specs/humanoid/compose.ts";
import { lookOf, lookTables, wornOf } from "../engine/specs/humanoid/previews.ts";
import { HUMANOID_LAYERS } from "../engine/specs/humanoid/index.ts";
import type { Recipe, RecipeBook } from "../recipe.ts";
import { renderRecipe, TILE } from "../render.ts";

/** The sexes a player's body is drawn in (corpses/body_<sex>, client/src/state/corpse-art.ts). */
export const BODY_SEXES = ["male", "female"] as const;

/**
 * The plain person a player's body is drawn as: the server sends the body's owner's name,
 * sex and the way it fell (ItemMods body_of, body_sex, facing) and nothing else of the look,
 * so the corpse has neutral skin, hair and clothes. The same paper doll, the same last frame
 * of the fall.
 */
const BODY_LOOKS: Record<(typeof BODY_SEXES)[number], Record<string, unknown>> = {
  male: {
    sex: "male",
    body: "sturdy",
    skin: "fair",
    hair: "short",
    hair_color: "brown",
    beard: "none",
  },
  female: {
    sex: "female",
    body: "slender",
    skin: "fair",
    hair: "long",
    hair_color: "brown",
    beard: "none",
  },
};
const BODY_WORN = {
  torso: { shape: "tunic", tint: "linen" },
  legs: { shape: "trousers", tint: "brown" },
};

/** The ways a corpse lies (packages/renderer FALL_DIRS): one sprite each. */
export const CORPSE_DIRS = FALL_DIRS;

/**
 * The atlas path of a monster's corpse fallen facing `dir` (client/src/state/corpse-art.ts
 * corpseSprite): the south one keeps the plain path, the one every older client asks for.
 */
export const corpsePath = (monster: string, dir: FallDir = "s"): string =>
  dir === "s" ? `corpses/${monster}` : `corpses/${monster}_${dir}`;

/** The atlas path of a player's body of `sex` fallen facing `dir`. */
export const bodyPath = (sex: string, dir: FallDir = "s"): string => corpsePath(`body_${sex}`, dir);

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

/** A copy of `src` flipped left to right. */
export function mirrored(src: Image): Image {
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      out.data.set(src.data.subarray(s, s + 4), (y * src.width + (src.width - 1 - x)) * 4);
    }
  return out;
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

/**
 * A single image fallen the way `dir` says (fallArt with no clip): mirrored or not, then
 * tipped clockwise (tipOver) or counter-clockwise (the mirror image of tipping its mirror).
 */
export function tipTo(src: Image, dir: FallDir): Image {
  const art = fallArt(undefined, dir);
  const from = art.mirror ? mirrored(src) : src;
  return art.tip === 1 ? tipOver(from) : mirrored(tipOver(mirrored(from)));
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

/** The last frame of the death clip of `sprite` facing `dir`, if it has one. */
function lastDeath(
  root: string,
  sprite: string,
  coded: RecipeBook,
  dir: FallDir,
): Fallen | undefined {
  const clip = `${sprite}/death_${dir}_`;
  const codedLast = lastFrame(Object.keys(coded), clip, "");
  const frame = codedLast === undefined ? undefined : coded[`${clip}${codedLast}`];
  if (frame)
    return {
      width: frame.width ?? TILE,
      height: frame.height ?? TILE,
      body: () => renderRecipe(`${clip}${codedLast ?? 0}`, frame),
    };
  const folder = join(root, "assets", "sprites", sprite);
  const prefix = `death_${dir}_`;
  const fileLast = existsSync(folder) ? lastFrame(readdirSync(folder), prefix, ".png") : undefined;
  if (fileLast === undefined) return undefined;
  const img = decodePng(readFileSync(join(folder, `${prefix}${fileLast}.png`)));
  return { width: img.width, height: img.height, body: () => img };
}

/**
 * The fallen body of the creature drawn with `sprite`, fallen facing `dir`, by the client's
 * own rule (fallArt): the last frame of its death clip in that facing, the south one
 * (mirrored to the north and the west) when the clip has no such facing, or its single
 * image tipped over. Art of `coded` (the recipes in code) is drawn from its recipe when
 * asked, so it is never an older PNG; other art is the PNG of assets/sprites under `root`.
 * Undefined: nothing to make it from (a single image that is not square cannot be tipped
 * over). `derived`: no art of its own for that facing.
 */
function fallenOf(
  root: string,
  sprite: string,
  coded: RecipeBook,
  dir: FallDir,
): (Fallen & { derived: boolean }) | undefined {
  const dirs: AnimDir[] = CORPSE_DIRS.filter((d) => lastDeath(root, sprite, coded, d));
  if (dirs.length > 0) {
    const art = fallArt(dirs, dir);
    const last = lastDeath(root, sprite, coded, art.clip);
    if (!last) return undefined; // a clip with no south frames and none facing `dir`
    const body = last.body;
    return {
      ...last,
      body: art.mirror ? () => mirrored(body()) : body,
      derived: art.clip !== dir,
    };
  }
  const recipe = coded[sprite];
  if (recipe) {
    const size = { width: recipe.width ?? TILE, height: recipe.height ?? TILE };
    if (size.width !== size.height) return undefined;
    return { ...size, body: () => tipTo(renderRecipe(sprite, recipe), dir), derived: true };
  }
  const single = join(root, "assets", "sprites", `${sprite}.png`);
  if (!existsSync(single)) return undefined;
  const img = decodePng(readFileSync(single));
  if (img.width !== img.height) return undefined;
  return { width: img.width, height: img.height, body: () => tipTo(img, dir), derived: true };
}

/**
 * Which facings of the corpse of the creature drawn with `sprite` are its own art (a death
 * clip drawn in that facing); the others are derived (mirrored or tipped). docs/17's table.
 */
export function ownCorpseDirs(root: string, sprite: string, coded: RecipeBook): FallDir[] {
  return CORPSE_DIRS.filter((d) => fallenOf(root, sprite, coded, d)?.derived === false);
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
  if (existsSync(join(root, "data", "looks.yaml"))) {
    tables ??= lookTables(read("data/looks.yaml"));
    const t = tables;
    for (const sex of BODY_SEXES)
      for (const dir of CORPSE_DIRS)
        book[bodyPath(sex, dir)] = recipeOf(64, 64, () =>
          corpseOf(
            composeFrame(
              lookOf(BODY_LOOKS[sex]),
              wornOf(BODY_WORN),
              t,
              "death",
              dir,
              HUMANOID_DEATH_FRAMES - 1,
            ),
            "bc",
          ),
        );
  }
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const m = parseYaml(readFileSync(join(dir, file), "utf8"));
    if (!isObj(m) || typeof m["id"] !== "string") continue;
    const id = m["id"];
    if (isObj(m["look"])) {
      tables ??= lookTables(read("data/looks.yaml"));
      const t = tables;
      const look = lookOf(m["look"]);
      const worn = wornOf(m["look"]["worn"]);
      for (const dir of CORPSE_DIRS)
        book[corpsePath(id, dir)] = recipeOf(64, 64, () =>
          corpseOf(composeFrame(look, worn, t, "death", dir, HUMANOID_DEATH_FRAMES - 1), "bc"),
        );
      continue;
    }
    const sprite = m["sprite"];
    if (typeof sprite !== "string") continue;
    const anchor = hints.get(sprite) ?? "br";
    for (const dir of CORPSE_DIRS) {
      const fallen = fallenOf(root, sprite, coded, dir);
      if (!fallen) continue;
      book[corpsePath(id, dir)] = recipeOf(corpseWidth(fallen.width, anchor), fallen.height, () =>
        corpseOf(fallen.body(), anchor),
      );
    }
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
 * The review sheet of the corpses (cli.ts corpses): one row per monster (and per player's
 * body) on a grass-like floor with the tile grid, the living creature on its tile at the
 * left and its four corpses (fallen facing south, east, north, west) to the right, all
 * placed as the client places them (centred, feet FEET_LINE above the tile's bottom). 1x;
 * scale it to look. `only`: the rows whose id starts with it.
 */
export function corpseSheet(root: string, book: RecipeBook, only = ""): Image {
  const dir = join(root, "data", "monsters");
  const monsters = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")))
    .filter(isObj);
  const rowsOf: { id: string; alive: Image | undefined }[] = [];
  for (const m of monsters)
    if (typeof m["id"] === "string") rowsOf.push({ id: m["id"], alive: living(root, m)?.img });
  if (existsSync(join(root, "data", "looks.yaml"))) {
    const t = lookTables(parseYaml(readFileSync(join(root, "data", "looks.yaml"), "utf8")));
    for (const sex of BODY_SEXES)
      rowsOf.push({
        id: `body_${sex}`,
        alive: composeFrame(lookOf(BODY_LOOKS[sex]), wornOf(BODY_WORN), t, "idle", "s", 0),
      });
  }
  const rows = rowsOf.filter((r) => r.id.startsWith(only));
  const STEP = 128;
  const CELL_H = 128;
  const sheet = createImage(STEP * (1 + CORPSE_DIRS.length), CELL_H * Math.max(1, rows.length));
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
  rows.forEach((row, i) => {
    const bottom = i * CELL_H + 96; // the bottom of the row's third line of tiles
    if (row.alive) put(row.alive, 48, bottom);
    CORPSE_DIRS.forEach((d, k) => {
      const recipe = book[corpsePath(row.id, d)];
      if (!recipe) return;
      const img = createImage(recipe.width ?? 32, recipe.height ?? 32);
      recipe.draw(img, () => 0, 0);
      put(img, STEP * (k + 1) + 48, bottom);
    });
  });
  return sheet;
}
