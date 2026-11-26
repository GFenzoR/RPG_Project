// The wind metadata of the plant sprites (livingworld/README.md "Viento"; a glue file of the
// living world: it reads its pure wind maths, @rpg/living-world/wind).
//
// A recipe (or an engine spec) of a tree, a bush or any other plant says how it takes the
// wind: `wind: plantWind("tree", { pivot: 28 })`. From that and the drawing itself this
// module works out what the client needs (where the trunk ends, how high the drawing
// reaches), checks the drawing will deform well, and writes it all to
// data/livingworld/wind_sprites.yaml (make spritegen). A plant sprite no recipe draws (a
// pack's, Gemini's) says the same with a `wind` hint in the tiles section of
// assets/sprites.yaml. The client reads the file: a new plant sways with no code and no
// hand-written wind data. `swaySheet` draws a plant swaying over a few frames with the
// client's own maths, to look at before it ships.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exposureOf,
  flutterOf,
  flutterPhase,
  gustAt,
  parseWind,
  resolveWind,
  snapSteps,
  strengthAt,
  stripLayout,
  stripOffsets,
  swayOf,
  WIND_KINDS,
} from "@rpg/living-world/wind";
import type { SpriteWind, WindData, WindKind } from "@rpg/living-world/wind";
import {
  blit,
  createImage,
  decodePng,
  drawText,
  fillRect,
  GLYPH_H,
  parseManifest,
  parseYaml,
  scaleImage,
} from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { composite } from "./draw.ts";
import type { RecipeBook } from "./recipe.ts";

export { WIND_KINDS };
export type { WindKind };

/** What a recipe says of its plant (Recipe.wind, SpriteSpec.wind). */
export interface WindMeta {
  kind: WindKind;
  /**
   * Where the trunk or stem ends, px over the sprite's bottom edge: nothing moves below
   * it. Absent: the kind's share of the drawing's height (wind.yaml `kinds.<kind>.pivot`),
   * which suits grass, reeds and flowers; a tree, a palm, a cactus or a dead tree must say.
   */
  pivot?: number;
  /** Only for a plant unlike its kind: its own stiffness, amplitude (px) or flutter (px). */
  stiffness?: number;
  amplitude?: number;
  flutter?: number;
}

/** The kinds with a trunk: their recipe must say where it ends. */
export const TRUNK_KINDS: readonly WindKind[] = ["tree", "palm", "cactus", "dead_tree"];

/**
 * The wind metadata of a plant recipe, with the defaults of its type: plantWind("reed") is
 * enough for a plant that bends from the ground; one with a trunk gives its pivot.
 */
export function plantWind(
  kind: "tree" | "palm" | "cactus" | "dead_tree",
  opts: Omit<WindMeta, "kind"> & { pivot: number },
): WindMeta;
export function plantWind(
  kind: Exclude<WindKind, "tree" | "palm" | "cactus" | "dead_tree">,
  opts?: Omit<WindMeta, "kind">,
): WindMeta;
export function plantWind(kind: WindKind, opts: Omit<WindMeta, "kind"> = {}): WindMeta {
  return { kind, ...opts };
}

/** The generated file, under the root. */
export const WIND_SPRITES_FILE = "data/livingworld/wind_sprites.yaml";
const WIND_FILE = "data/livingworld/wind.yaml";
const MANIFEST_FILE = "assets/sprites.yaml";

/** The drawing keeps this many clear px at each side of the rows that move. */
export const WIND_SIDE_MARGIN = 1;

/** The lowest rows of a drawing that count as its foot on the ground. */
const ROOT_PX = 3;

const opaqueAt = (img: Image, x: number, y: number): boolean =>
  x >= 0 &&
  y >= 0 &&
  x < img.width &&
  y < img.height &&
  (img.data[(y * img.width + x) * 4 + 3] ?? 0) > 0;

/** The drawn rows of an image, as px over its bottom edge: `base` (lowest) and `top`. */
export function drawnRows(img: Image): { base: number; top: number } | undefined {
  let first = -1;
  let last = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (opaqueAt(img, x, y)) {
        if (first < 0) first = y;
        last = y;
        break;
      }
  return first < 0 ? undefined : { base: img.height - 1 - last, top: img.height - first };
}

/** The first and last drawn column of row y, or undefined for an empty row. */
function rowSpan(img: Image, y: number): [number, number] | undefined {
  let a = -1;
  let b = -1;
  for (let x = 0; x < img.width; x++)
    if (opaqueAt(img, x, y)) {
      if (a < 0) a = x;
      b = x;
    }
  return a < 0 ? undefined : [a, b];
}

/**
 * The pixels of the rows that move which are not joined (8 neighbours) to the planted base:
 * loose bits that would float beside the plant while it sways. Returns the first one.
 */
function detached(img: Image, pivot: number): { x: number; y: number } | undefined {
  const w = img.width;
  const h = img.height;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  // Rooted: everything drawn at or below the pivot row (the rigid part), and the foot of a
  // plant that bends from the ground (its lowest ROOT_PX rows: blades start a row apart).
  const rows = drawnRows(img);
  const rootFrom = h - Math.max(pivot, (rows?.base ?? 0) + ROOT_PX);
  for (let y = rootFrom; y < h; y++)
    for (let x = 0; x < w; x++)
      if (opaqueAt(img, x, y)) {
        seen[y * w + x] = 1;
        stack.push(y * w + x);
      }
  while (stack.length > 0) {
    const at = stack.pop() as number;
    const x = at % w;
    const y = (at - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!opaqueAt(img, nx, ny) || seen[ny * w + nx]) continue;
        seen[ny * w + nx] = 1;
        stack.push(ny * w + nx);
      }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (opaqueAt(img, x, y) && !seen[y * w + x]) return { x, y };
  return undefined;
}

/**
 * What a plant's sprite tells the client (one entry of wind_sprites.yaml), from its
 * metadata and its drawing, and what is wrong with the drawing for the wind (the art
 * guidelines of assets/README.md "Plantas y viento"):
 *   - something is drawn, and the pivot lies inside it, under its top;
 *   - a plant with a trunk has a clear split: the trunk under the pivot is much narrower
 *     than the canopy over it;
 *   - no loose pixels: everything that moves is joined to the planted base;
 *   - the rows that move keep WIND_SIDE_MARGIN clear px at each side of the canvas.
 */
export function spriteWind(
  img: Image,
  meta: WindMeta,
  pivotShare: number,
): { wind: SpriteWind; problems: string[] } {
  const problems: string[] = [];
  const rows = drawnRows(img);
  const base = rows?.base ?? 0;
  const top = rows?.top ?? img.height;
  if (!rows) problems.push("nothing is drawn");
  const pivot = meta.pivot ?? base + Math.round(pivotShare * (top - base));
  if (!Number.isInteger(pivot) || pivot < 0) problems.push("pivot must be a whole number of px");
  else if (pivot >= top)
    problems.push(`pivot ${pivot} is not under the top of the drawing (${top} px): nothing moves`);
  else if (rows) {
    if (TRUNK_KINDS.includes(meta.kind)) {
      if (meta.pivot === undefined)
        problems.push(`a ${meta.kind} must say its pivot (where the trunk ends)`);
      if (pivot <= base) problems.push("the pivot is at the ground: there is no trunk under it");
      // The trunk just under the pivot against the widest moving row.
      let trunk = 0;
      for (
        let y = img.height - pivot + 1;
        y <= Math.min(img.height - 1, img.height - pivot + 2);
        y++
      ) {
        const span = rowSpan(img, y);
        if (span) trunk = Math.max(trunk, span[1] - span[0] + 1);
      }
      let canopy = 0;
      for (let y = img.height - top; y < img.height - pivot; y++) {
        const span = rowSpan(img, y);
        if (span) canopy = Math.max(canopy, span[1] - span[0] + 1);
      }
      if (meta.kind !== "cactus" && meta.kind !== "dead_tree" && trunk > canopy * 0.6)
        problems.push(
          `no clear trunk and canopy split at the pivot (trunk ${trunk} px wide under a canopy of ${canopy})`,
        );
    }
    for (let y = img.height - top; y < img.height - pivot; y++) {
      const span = rowSpan(img, y);
      if (span && (span[0] < WIND_SIDE_MARGIN || span[1] > img.width - 1 - WIND_SIDE_MARGIN)) {
        problems.push(
          `row ${y} touches the side of the canvas: the rows that move need ${WIND_SIDE_MARGIN} clear px at each side`,
        );
        break;
      }
    }
    const loose = detached(img, pivot);
    if (loose)
      problems.push(
        `a loose pixel at (${loose.x}, ${loose.y}) is not joined to the plant: it would float beside it`,
      );
  }
  const wind: SpriteWind = { kind: meta.kind, pivot, top };
  if (meta.stiffness !== undefined) wind.stiffness = meta.stiffness;
  if (meta.amplitude !== undefined) wind.amplitude = meta.amplitude;
  if (meta.flutter !== undefined) wind.flutter = meta.flutter;
  return { wind, problems };
}

/** data/livingworld/wind.yaml under root (the kinds' defaults and the field). */
export function windData(root: string): WindData | undefined {
  const file = join(root, WIND_FILE);
  return existsSync(file) ? parseWind(parseYaml(readFileSync(file, "utf8"))) : undefined;
}

/** A path that is a part of another sprite (a frame, a look, a shadow) carries no wind. */
const PART = /\/(?:var|decal|frame|wall)_[0-9]+$|\/shadow$/;

/**
 * Every plant sprite's wind metadata: the recipes that declare `wind` (drawn with `render`)
 * and the `wind` hints of assets/sprites.yaml (sprites no recipe draws), with the problems
 * of each as "<sprite>: <problem>".
 */
export function windSprites(
  root: string,
  book: RecipeBook,
  render: (path: string) => Image,
  spriteFile: (root: string, path: string) => string,
): { sprites: Record<string, SpriteWind>; problems: string[] } {
  const data = windData(root);
  const share = (kind: WindKind): number => data?.kinds[kind].pivot ?? 0.2;
  const sprites: Record<string, SpriteWind> = {};
  const problems: string[] = [];
  if (!data) problems.push(`${WIND_FILE}: missing (the plant types' defaults)`);
  for (const path of Object.keys(book).sort()) {
    const meta = book[path]?.wind;
    if (!meta) continue;
    if (PART.test(path)) {
      problems.push(`${path}: only the sprite itself declares wind, not its parts`);
      continue;
    }
    const got = spriteWind(render(path), meta, share(meta.kind));
    sprites[path] = got.wind;
    for (const p of got.problems) problems.push(`${path}: ${p}`);
  }
  const manifestFile = join(root, MANIFEST_FILE);
  if (existsSync(manifestFile)) {
    const { manifest } = parseManifest(readFileSync(manifestFile, "utf8"));
    for (const [path, entry] of [...manifest.tiles].sort(([a], [b]) => a.localeCompare(b))) {
      const hint = entry.wind;
      if (!hint) continue;
      if (sprites[path]) {
        problems.push(
          `${path}: its recipe already declares wind: drop the wind hint of ${MANIFEST_FILE}`,
        );
        continue;
      }
      // Art that lives beside ours (Gemini's, hand-made) is measured and checked like ours;
      // a pack sprite cut from a sheet keeps what the hint says.
      const file = spriteFile(root, path);
      if (existsSync(file)) {
        const got = spriteWind(decodePng(readFileSync(file)), hint, share(hint.kind));
        sprites[path] = got.wind;
        for (const p of got.problems) problems.push(`${path}: ${p}`);
      } else {
        const { kind, pivot, stiffness, amplitude, flutter } = hint;
        sprites[path] = { kind, pivot, stiffness, amplitude, flutter };
      }
    }
  }
  return { sprites, problems };
}

/** The text of wind_sprites.yaml: one line per sprite, sorted, the same bytes every time. */
export function windSpritesYaml(sprites: Readonly<Record<string, SpriteWind>>): string {
  const lines = [
    "# GENERATED by `make spritegen` (tools/spritegen/src/wind.ts): do not edit by hand.",
    '# How each plant sprite takes the wind (livingworld/README.md "Viento"): its type (the',
    "# defaults are wind.yaml `kinds`), `pivot` (where its trunk or stem ends) and `top` (its",
    "# highest drawn row), both in px over the sprite's bottom edge. It comes from the `wind`",
    "# of each spritegen recipe and from the `wind` hints of assets/sprites.yaml (tiles).",
    "sprites:",
  ];
  const paths = Object.keys(sprites).sort();
  if (paths.length === 0) lines[lines.length - 1] = "sprites: {}";
  for (const path of paths) {
    const w = sprites[path] as SpriteWind;
    const fields = [`kind: ${w.kind}`];
    for (const key of ["pivot", "top", "stiffness", "amplitude", "flutter"] as const)
      if (w[key] !== undefined) fields.push(`${key}: ${String(w[key])}`);
    lines.push(`  ${path}: { ${fields.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

/** Writes wind_sprites.yaml; returns the problems of the plants' drawings. */
export function writeWindSprites(
  root: string,
  book: RecipeBook,
  render: (path: string) => Image,
  spriteFile: (root: string, path: string) => string,
): string[] {
  const { sprites, problems } = windSprites(root, book, render, spriteFile);
  writeFileSync(join(root, WIND_SPRITES_FILE), windSpritesYaml(sprites));
  return problems;
}

/** The problems of the plants' drawings, and a wind_sprites.yaml that is out of date. */
export function windProblems(
  root: string,
  book: RecipeBook,
  render: (path: string) => Image,
  spriteFile: (root: string, path: string) => string,
): string[] {
  const { sprites, problems } = windSprites(root, book, render, spriteFile);
  const file = join(root, WIND_SPRITES_FILE);
  const want = windSpritesYaml(sprites);
  const have = existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : undefined;
  if (have !== want)
    problems.push(`${WIND_SPRITES_FILE}: out of date with the recipes: run make spritegen`);
  return problems;
}

// ---- the sway preview ---------------------------------------------------------------------

const BACKDROP = [24, 24, 28, 255] as const;
const GRASS_TINT = [58, 92, 46, 255] as const;
const LABEL = [230, 230, 220, 255] as const;

/** One plant drawn as the client draws it: each strip slid by its offset, at `steps` per px. */
export function swayFrame(
  img: Image,
  layoutOffsets: Int16Array,
  edges: Float32Array,
  steps: number,
): Image {
  // Drawn at `steps` x so a half-pixel slide at zoom 2 shows as it does on screen.
  const big = scaleImage(img, steps);
  const pad = 4 * steps;
  const out = createImage(big.width + pad * 2, big.height);
  for (let i = 0; i < layoutOffsets.length; i++) {
    const y0 = Math.round((edges[i] as number) * steps);
    const y1 = Math.round((edges[i + 1] as number) * steps);
    blit(big, 0, y0, big.width, y1 - y0, out, pad + (layoutOffsets[i] as number), y0);
  }
  return out;
}

/**
 * A sheet to look at with Read: each plant sprite of `paths` in a row, swaying over `frames`
 * moments `stepMs` apart, in a steady strong wind on open ground, at zoom `zoom` (2: what
 * the game shows). The first cell of a row is the still sprite. The motion is the client's
 * own (wind.ts): what the sheet shows is what the game draws.
 */
export function swaySheet(
  root: string,
  entries: readonly { path: string; image: Image; wind: SpriteWind }[],
  frames = 8,
  stepMs = 450,
  zoom = 2,
): Image {
  const data = windData(root);
  if (!data) throw new Error(`spritegen: ${WIND_FILE} is missing`);
  const steps = snapSteps(zoom);
  const rows = entries.map(({ path, image, wind }, row) => {
    const w = resolveWind(data, wind, undefined);
    if (!w) throw new Error(`spritegen: ${path} has no wind`);
    const layout = stripLayout(
      image.height,
      w.pivotPx ?? Math.round(w.pivot * image.height),
      w.topPx ?? image.height,
    );
    const offsets = new Int16Array(layout.count);
    const cells = [swayFrame(image, offsets, layout.edges, steps)];
    // Each row on its own tile, so the rows do not move together.
    const x = 12 + row * 5;
    const y = 9 + row * 3;
    for (let f = 0; f < frames; f++) {
      const ms = 4000 + f * stepMs;
      const strength = strengthAt(data.field, Math.max(0.6, gustAt(data.field, x, y, ms)), 1);
      stripOffsets(
        offsets,
        layout,
        swayOf(data.field, w, x, y, ms, strength),
        flutterOf(w, strength),
        flutterPhase(x, y, ms),
        steps,
      );
      cells.push(swayFrame(image, offsets, layout.edges, steps));
    }
    return { path, cells };
  });
  const cellW = Math.max(...rows.flatMap((r) => r.cells.map((c) => c.width))) + 6;
  const rowH = rows.map((r) => Math.max(...r.cells.map((c) => c.height)) + GLYPH_H + 8);
  const sheet = createImage(
    cellW * (frames + 1),
    rowH.reduce((a, b) => a + b, 0),
  );
  fillRect(sheet, 0, 0, sheet.width, sheet.height, BACKDROP);
  let y = 0;
  rows.forEach((r, i) => {
    const h = rowH[i] as number;
    r.cells.forEach((c, f) => {
      const x = f * cellW + 3;
      fillRect(sheet, x, y + 2, cellW - 6, h - GLYPH_H - 6, GRASS_TINT);
      composite(
        sheet,
        c,
        x + Math.floor((cellW - 6 - c.width) / 2),
        y + h - GLYPH_H - 4 - c.height,
      );
    });
    drawText(sheet, r.path.toUpperCase().replace(/_/g, " "), 4, y + h - GLYPH_H - 2, 1, LABEL);
    y += h;
  });
  return sheet;
}

/** The scenes of swayScene: a wood (trees on most tiles, calmed by each other) and a town square. */
export const SWAY_SCENES = {
  forest: { cols: 14, rows: 9, density: 0.6, surface: "grass" },
  town: { cols: 14, rows: 9, density: 0.14, surface: "stone" },
} as const;
export type SwayScene = keyof typeof SWAY_SCENES;

/**
 * One moment of a patch of map with plants on it, as the game shows it at zoom 2: the real
 * wind field over the tiles (gusts travelling across, each plant with its own phase), the
 * exposure of the scene's ground and the shelter of the trees round each plant. Render a
 * few moments (`ms` a few hundred apart) and compare them with Read: neighbours must move
 * one after another, never all together and never like rubber.
 */
export function swayScene(
  root: string,
  entries: readonly { path: string; image: Image; wind: SpriteWind }[],
  scene: SwayScene,
  ms: number,
  zoom = 2,
): Image {
  const data = windData(root);
  if (!data) throw new Error(`spritegen: ${WIND_FILE} is missing`);
  if (entries.length === 0) throw new Error("spritegen: a scene needs plant sprites");
  const { cols, rows, density, surface } = SWAY_SCENES[scene];
  const steps = snapSteps(zoom);
  const T = 32;
  const marginTop = 3;
  const out = createImage(cols * T * steps, (rows + marginTop) * T * steps);
  fillRect(out, 0, 0, out.width, out.height, GRASS_TINT);
  // Which plant stands on each tile (a seeded pick: the same scene every time).
  const pick = (x: number, y: number): number => {
    const h = Math.abs(Math.sin(x * 127.1 + y * 311.7) * 43758.5453) % 1;
    return h < density ? Math.floor((h / density) * entries.length) : -1;
  };
  const isTree = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    const k = entries[pick(x, y)]?.wind.kind;
    return k === "tree" || k === "palm" || k === "dead_tree";
  };
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const e = entries[pick(x, y)];
      if (!e) continue;
      const w = resolveWind(data, e.wind, undefined);
      if (!w) continue;
      let trees = 0;
      for (let oy = -2; oy <= 2; oy++)
        for (let ox = -2; ox <= 2; ox++) if ((ox || oy) && isTree(x + ox, y + oy)) trees++;
      const exposure = exposureOf(data.field, [surface], trees, 24);
      const h = e.image.height;
      const layout = stripLayout(h, w.pivotPx ?? Math.round(w.pivot * h), w.topPx ?? h);
      const offsets = new Int16Array(layout.count);
      const strength = strengthAt(data.field, gustAt(data.field, x, y, ms), exposure);
      stripOffsets(
        offsets,
        layout,
        swayOf(data.field, w, x, y, ms, strength),
        flutterOf(w, strength),
        flutterPhase(x, y, ms),
        steps,
      );
      const cell = swayFrame(e.image, offsets, layout.edges, steps);
      // Bottom centre on its tile, like the renderer's anchor bc.
      composite(
        out,
        cell,
        Math.round((x + 0.5) * T * steps - cell.width / 2),
        (y + 1 + marginTop) * T * steps - cell.height,
      );
    }
  return out;
}
