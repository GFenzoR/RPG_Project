// Resolves every sprite to pixels and packs them into atlas pages + JSON.
//
// Resolution order for a logical sprite path (the `sprite:` value used in data/):
//   1. assets/sprites/<path>.png            original art committed to the repo
//   2. assets/sprites.yaml entry            vendor pack crop or explicit placeholder
//   3. automatic placeholder                for data/ sprites nobody mapped yet (warning)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ANIM_ACTIONS,
  ANIM_DIRS,
  frameName,
  layerOver,
  measureFrames,
  mirrorImage,
  recolorImage,
  specColumns,
} from "./anims.ts";
import type { AnimAction, AnimDir, AnimEntry, AnimMeta } from "./anims.ts";
import { collectSpriteRefs, listFiles } from "./content.ts";
import type { SpriteRef } from "./content.ts";
import { isLicenseFile, registeredPacks } from "./credits.ts";
import { blit, createImage, decodePng, encodePng } from "./image.ts";
import type { Image } from "./image.ts";
import { parseManifest, SPRITE_PATH } from "./manifest.ts";
import type { SpriteEntry } from "./manifest.ts";
import { packSprites } from "./pack.ts";
import { tileMetas } from "./tiles.ts";
import type { TileEntry, TileMeta } from "./tiles.ts";
import { defaultColor, defaultLabel, renderPlaceholder, TILE } from "./placeholder.ts";

export const MANIFEST_FILE = "assets/sprites.yaml";
export const SPRITES_DIR = "assets/sprites";
/**
 * The living world's original art (livingworld/README.md): assets/livingworld/sprites/<rest>
 * is the sprite livingworld/<rest>, packed like any file of SPRITES_DIR.
 */
export const LIVING_SPRITES_DIR = "assets/livingworld/sprites";
export const LIVING_SPRITE_PREFIX = "livingworld/";
export const CREDITS_FILE = "assets/CREDITS.md";
export const DEFAULT_OUT_DIR = "assets/atlas";
export const DEFAULT_MAX_PAGE = 2048;
/**
 * Widest and tallest PNG decoded, read from its header first: a small file can declare a
 * huge image (a map PR's sprites are decoded by the check, docs/04). A page holds no more.
 */
export const MAX_PNG_SIDE = DEFAULT_MAX_PAGE;
/** Pixels decoded from PNGs in one build, all files together (16 full pages). */
export const MAX_TOTAL_PIXELS = 16 * DEFAULT_MAX_PAGE * DEFAULT_MAX_PAGE;

export type Origin = "file" | "vendor" | "placeholder" | "auto";

export interface Diagnostic {
  severity: "error" | "warning";
  /** File (and line) the problem is about, relative to the repo root. */
  where: string;
  message: string;
}

export interface BuildOptions {
  /** MAX_TOTAL_PIXELS (tests lower it). */
  maxPixels?: number;
  /** Treat automatic placeholders (data/ sprites with no mapping) as errors. */
  strict?: boolean;
  maxPageSize?: number;
}

export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  /**
   * A trimmed frame (`trim: true` animations): `frame` holds only the opaque box, which sits
   * at `spriteSourceSize` inside the `sourceSize` frame; PixiJS places it as the whole frame.
   */
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
}

/** PixiJS Spritesheet JSON (hash format), one per page. */
export interface AtlasPageJson {
  frames: Record<string, AtlasFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: "RGBA8888";
    size: { w: number; h: number };
    scale: "1";
    related_multi_packs: string[];
  };
}

/** assets/atlas/atlas.json: entry point for the client and the editor. */
export interface AtlasIndex {
  version: 1;
  tileSize: number;
  pages: string[];
  sprites: Record<string, { page: number; origin: Origin }>;
  /** Animated and hinted creature sprites (assets/sprites.yaml `animations`, docs/17 ANI). */
  anims: Record<string, AnimMeta>;
  /** Map sprites with variants, frames, wall pieces, an anchor or a shadow (tiles.ts). */
  tiles: Record<string, TileMeta>;
  /**
   * The minimap colour of every sprite (docs/02 "Minimapa"): the average of its opaque
   * pixels, "#rrggbb". The client colours a minimap tile by its item's sprite.
   */
  minimap: Record<string, string>;
}

export interface BuildResult {
  diagnostics: Diagnostic[];
  /** Undefined when there were errors. */
  atlas?: {
    index: AtlasIndex;
    pages: { json: AtlasPageJson; jsonFile: string; pngFile: string; image: Image }[];
  };
  sprites: Map<string, { origin: Origin; refs: SpriteRef[] }>;
}

interface Resolved {
  origin: Origin;
  image: Image;
}

export function buildAtlas(root: string, opts: BuildOptions = {}): BuildResult {
  const diags: Diagnostic[] = [];
  const resolved = new Map<string, Resolved>();
  const assetsDir = join(root, "assets");
  const budget = { pixels: opts.maxPixels ?? MAX_TOTAL_PIXELS };

  // 1. Original art under assets/sprites/ (and the living world's, under its prefix).
  const originals = [
    { dir: SPRITES_DIR, prefix: "" },
    { dir: LIVING_SPRITES_DIR, prefix: LIVING_SPRITE_PREFIX },
  ];
  for (const { dir, prefix } of originals)
    for (const abs of listFiles(join(root, dir), ".png")) {
      const rel = relative(join(root, dir), abs).split("\\").join("/");
      const where = `${dir}/${rel}`;
      const name = prefix + rel.slice(0, -".png".length);
      if (!SPRITE_PATH.test(name)) {
        diags.push({ severity: "error", where, message: "file name must be lowercase snake_case" });
        continue;
      }
      const image = readPng(abs, where, diags, budget);
      if (image && checkSize(image, where, diags)) resolved.set(name, { origin: "file", image });
    }

  // 2. Manifest entries.
  const manifestPath = join(root, MANIFEST_FILE);
  const entries = new Map<string, SpriteEntry>();
  const lines = new Map<string, number>();
  let animations = new Map<string, AnimEntry>();
  let animLines = new Map<string, number>();
  let palettes = new Map<string, number[]>();
  let tileEntries = new Map<string, TileEntry>();
  let tileLines = new Map<string, number>();
  if (existsSync(manifestPath)) {
    const { manifest, errors } = parseManifest(readFileSync(manifestPath, "utf8"));
    for (const e of errors) {
      const prefix = e.sprite ? `${e.sprite}: ` : "";
      diags.push({
        severity: "error",
        where: at(MANIFEST_FILE, e.line),
        message: prefix + e.message,
      });
    }
    for (const [k, v] of manifest.sprites) entries.set(k, v);
    for (const [k, v] of manifest.lines) lines.set(k, v);
    animations = manifest.animations;
    animLines = manifest.animationLines;
    palettes = manifest.palettes;
    tileEntries = manifest.tiles;
    tileLines = manifest.tileLines;
  }
  const creditsPath = join(root, CREDITS_FILE);
  const packs = registeredPacks(existsSync(creditsPath) ? readFileSync(creditsPath, "utf8") : "");
  const sourceCache = new Map<string, Image | undefined>();
  const checkedPacks = new Map<string, boolean>();

  for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const where = at(MANIFEST_FILE, lines.get(name));
    if (resolved.has(name)) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: also exists as ${SPRITES_DIR}/${name}.png; keep only one`,
      });
      continue;
    }
    if (entry.kind === "placeholder") {
      resolved.set(name, {
        origin: "placeholder",
        image: renderPlaceholder({
          label: entry.label ?? defaultLabel(name),
          color: entry.color ?? defaultColor(name),
          width: entry.width,
          height: entry.height,
        }),
      });
      continue;
    }
    if (!checkPack(entry.pack, assetsDir, packs, checkedPacks, where, diags)) continue;
    let src = sourceCache.get(entry.source);
    if (!sourceCache.has(entry.source)) {
      const abs = join(assetsDir, entry.source);
      src = existsSync(abs) ? readPng(abs, `assets/${entry.source}`, diags, budget) : undefined;
      if (!existsSync(abs)) {
        diags.push({
          severity: "error",
          where,
          message: `${name}: assets/${entry.source} not found`,
        });
      }
      sourceCache.set(entry.source, src);
    }
    if (!src) continue;
    const r = entry.rect ?? { x: 0, y: 0, w: src.width, h: src.height };
    if (r.x + r.w > src.width || r.y + r.h > src.height || r.w === 0 || r.h === 0) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: rect [${r.x}, ${r.y}, ${r.w}, ${r.h}] is outside ${entry.source} (${src.width}x${src.height})`,
      });
      continue;
    }
    const image = createImage(r.w, r.h);
    blit(src, r.x, r.y, r.w, r.h, image, 0, 0);
    if (checkSize(image, `${where} (${name})`, diags))
      resolved.set(name, { origin: "vendor", image });
  }

  // 2b. Animations with layers: frames composed from vendor sheets (anims.ts).
  const anims: Record<string, AnimMeta> = {};
  /** Atlas names that point at another sprite's pixels (alias -> sprite). */
  const aliases = new Map<string, string>();
  const sortedAnims = [...animations].sort(([a], [b]) => (a < b ? -1 : 1));
  const layerCache = new Map<string, Image | undefined>();
  const loadLayer = (name: string, file: string, where: string): Image | undefined => {
    if (!layerCache.has(file)) {
      const abs = join(assetsDir, file);
      if (!existsSync(abs)) {
        diags.push({ severity: "error", where, message: `${name}: assets/${file} not found` });
        layerCache.set(file, undefined);
      } else layerCache.set(file, readPng(abs, `assets/${file}`, diags, budget));
    }
    return layerCache.get(file);
  };
  for (const [name, entry] of sortedAnims) {
    if (entry.layers.length === 0) continue;
    const where = at(MANIFEST_FILE, animLines.get(name));
    const taken = [...resolved.keys(), ...entries.keys()].find(
      (k) => k === name || k.startsWith(`${name}/`),
    );
    if (taken !== undefined) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: the animation's frames would clash with sprite ${taken}; keep only one`,
      });
      continue;
    }
    const packsOk = entry.layers.map((l) =>
      checkPack(l.pack, assetsDir, packs, checkedPacks, where, diags),
    );
    if (packsOk.includes(false)) continue;
    const built = buildLayered(
      name,
      entry,
      palettes,
      (file) => loadLayer(name, file, where),
      where,
      diags,
    );
    if (!built) continue;
    for (const [frame, image] of built.frames) resolved.set(frame, { origin: "vendor", image });
    aliases.set(name, built.base);
    anims[name] = built.meta;
  }

  // 2c. Frames by name (docs/17 ANI-4): files <sprite>/<action>_<dir>_<n> (own art, such as
  // a spritegen walk cycle) animate <sprite>; and hints-only entries for a sprite that exists.
  const fileFrames = new Map<string, Map<string, Image>>();
  for (const [name, r] of resolved) {
    const m = FRAME_NAME.exec(name);
    if (!m?.[1] || r.origin !== "file" || anims[m[1]]) continue;
    const list = fileFrames.get(m[1]) ?? new Map<string, Image>();
    list.set(name, r.image);
    fileFrames.set(m[1], list);
  }
  const hinted = new Map<string, AnimEntry>();
  /** Frames packed cropped to their opaque box (trim: true). */
  const trimmedNames = new Set<string>();
  for (const [name, entry] of sortedAnims) if (entry.layers.length === 0) hinted.set(name, entry);
  const bases = [...new Set([...fileFrames.keys(), ...hinted.keys()])].sort();
  for (const name of bases) {
    const entry = hinted.get(name);
    const where = at(MANIFEST_FILE, animLines.get(name));
    const frames = fileFrames.get(name);
    const r = resolved.get(name);
    if (entry && (!r || r.origin === "auto") && !frames) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: hints need a sprite of that name (a file in ${SPRITES_DIR} or a sprites entry)`,
      });
      continue;
    }
    const fileHints =
      entry &&
      (entry.mirror || entry.anchor || entry.ms || entry.perTile || entry.perTileNS || entry.trim);
    if (fileHints && !frames) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: mirror, anchor, ms, per_tile, per_tile_ns and trim need frames from files (${SPRITES_DIR}/${name}/<action>_<dir>_<n>.png)`,
      });
      continue;
    }
    if (frames && entry?.trim) for (const frame of frames.keys()) trimmedNames.add(frame);
    if (frames && entry?.mirror) {
      for (const [frame, image] of mirroredFrames(name, frames)) {
        frames.set(frame, image);
        resolved.set(frame, { origin: "file", image });
      }
    }
    const found = frames ? framesByName(name, frames) : undefined;
    const image = found?.first ?? r?.image;
    if (!image) continue;
    if (found && entry?.ms) {
      for (const [action, ms] of Object.entries(entry.ms) as [AnimAction, number][]) {
        const clip = found.actions[action];
        if (clip) clip.ms = ms;
        else
          diags.push({
            severity: "error",
            where,
            message: `${name}: ms.${action} but no ${action} frames`,
          });
      }
    }
    if (found && (entry?.perTile !== undefined || entry?.perTileNS !== undefined)) {
      const walk = found.actions.walk;
      if (walk) {
        if (entry.perTile !== undefined) walk.perTile = entry.perTile;
        if (entry.perTileNS !== undefined) walk.perTileNS = entry.perTileNS;
      } else
        diags.push({ severity: "error", where, message: `${name}: per_tile but no walk frames` });
    }
    const m = measureFrames(found?.walk.length ? found.walk : [image]);
    anims[name] = {
      w: image.width,
      h: image.height,
      anchor: entry?.anchor ?? "br",
      foot: m.foot,
      top: m.top,
      shadow: entry?.shadow ?? "baked",
      ...(entry?.facing ? { facing: entry.facing } : {}),
      ...(entry?.flying ? { flying: true } : {}),
      actions: found?.actions ?? {},
    };
    if (!r && found) aliases.set(name, found.base);
  }

  // 3. Sprites used by data/ that nothing provides.
  const refs = collectSpriteRefs(root);
  const refsBySprite = new Map<string, SpriteRef[]>();
  for (const ref of refs) {
    const list = refsBySprite.get(ref.sprite) ?? [];
    list.push(ref);
    refsBySprite.set(ref.sprite, list);
  }
  for (const [name, list] of [...refsBySprite].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (resolved.has(name) || entries.has(name) || aliases.has(name) || !SPRITE_PATH.test(name))
      continue;
    // A legacy outfit frame (outfits/<id>/<dir>_<n>, T0.5) of an animated outfit.
    const legacy = legacyFrame(name, anims);
    if (legacy && resolved.has(legacy)) {
      aliases.set(name, legacy);
      continue;
    }
    const first = list[0];
    diags.push({
      severity: opts.strict ? "error" : "warning",
      where: first?.file ?? "data/",
      message: `sprite ${name}${first?.id ? ` (${first.id})` : ""} has no art and no entry in ${MANIFEST_FILE}; using an automatic placeholder`,
    });
    resolved.set(name, {
      origin: "auto",
      image: renderPlaceholder({
        label: defaultLabel(name),
        color: defaultColor(name),
        width: TILE,
        height: TILE,
      }),
    });
  }

  // 3b. Map tile art (tiles.ts): variants, frames, wall pieces and shadows by name, plus the
  // tiles entries of the manifest. Automatic placeholders do not count as art.
  const tileNames = [...resolved].filter(([, r]) => r.origin !== "auto").map(([k]) => k);
  const { tiles, problems } = tileMetas([...tileNames, ...aliases.keys()], tileEntries);
  for (const p of problems)
    diags.push({
      severity: "error",
      where: at(MANIFEST_FILE, tileLines.get(p.sprite)),
      message: `${p.sprite}: ${p.message}`,
    });

  const sprites = new Map<string, { origin: Origin; refs: SpriteRef[] }>();
  for (const [name, r] of resolved)
    sprites.set(name, { origin: r.origin, refs: refsBySprite.get(name) ?? [] });
  for (const [alias, target] of aliases)
    sprites.set(alias, {
      origin: resolved.get(target)?.origin ?? "vendor",
      refs: refsBySprite.get(alias) ?? [],
    });
  if (diags.some((d) => d.severity === "error")) return { diagnostics: diags, sprites };

  // 4. Pack and render.
  const maxSize = opts.maxPageSize ?? DEFAULT_MAX_PAGE;
  // Trimmed frames go in as their opaque box (at least 1x1: an empty frame stays a frame).
  const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const name of trimmedNames) {
    const r = resolved.get(name);
    if (r) boxes.set(name, opaqueBox(r.image));
  }
  let packed;
  try {
    packed = packSprites(
      [...resolved].map(([name, r]) => {
        const b = boxes.get(name);
        return { name, width: b?.w ?? r.image.width, height: b?.h ?? r.image.height };
      }),
      maxSize,
    );
  } catch (err) {
    diags.push({ severity: "error", where: SPRITES_DIR, message: (err as Error).message });
    return { diagnostics: diags, sprites };
  }
  const jsonFiles = packed.pages.map((_, i) => `atlas-${i}.json`);
  const pages = packed.pages.map((size, i) => ({
    jsonFile: jsonFiles[i] ?? "",
    pngFile: `atlas-${i}.png`,
    image: createImage(size.width, size.height),
    json: {
      frames: {},
      meta: {
        app: "@rpg/spritepack",
        version: "1",
        image: `atlas-${i}.png`,
        format: "RGBA8888",
        size: { w: size.width, h: size.height },
        scale: "1",
        related_multi_packs: jsonFiles.filter((_, j) => j !== i),
      },
    } as AtlasPageJson,
  }));
  const index: AtlasIndex = {
    version: 1,
    tileSize: TILE,
    pages: jsonFiles,
    sprites: {},
    anims: {},
    tiles: {},
    minimap: {},
  };
  const byName = [...packed.placements].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const p of byName) {
    const r = resolved.get(p.name);
    const page = pages[p.page];
    if (!r || !page) continue;
    const b = boxes.get(p.name);
    blit(r.image, b?.x ?? 0, b?.y ?? 0, p.width, p.height, page.image, p.x, p.y);
    page.json.frames[p.name] = {
      frame: { x: p.x, y: p.y, w: p.width, h: p.height },
      rotated: false,
      trimmed: b !== undefined,
      spriteSourceSize: { x: b?.x ?? 0, y: b?.y ?? 0, w: p.width, h: p.height },
      sourceSize: { w: r.image.width, h: r.image.height },
    };
    index.sprites[p.name] = { page: p.page, origin: r.origin };
  }
  // Aliases share their sprite's rectangle: an animation's base name and legacy frames.
  for (const [alias, target] of [...aliases].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const t = index.sprites[target];
    const page = t && pages[t.page];
    const frame = page?.json.frames[target];
    if (!t || !page || !frame) continue;
    page.json.frames[alias] = frame;
    index.sprites[alias] = t;
  }
  index.sprites = sortedRecord(index.sprites);
  for (const page of pages) page.json.frames = sortedRecord(page.json.frames);
  index.anims = anims;
  index.tiles = tiles;
  const colours: Record<string, string> = {};
  for (const [name, r] of resolved) colours[name] = averageColor(r.image);
  for (const [alias, target] of aliases) {
    const col = colours[target];
    if (col) colours[alias] = col;
  }
  index.minimap = sortedRecord(colours);
  return { diagnostics: diags, atlas: { index, pages }, sprites };
}

/**
 * The minimap colour of an image (docs/02 "Minimapa"): the average of its opaque pixels,
 * each weighted by its alpha, as "#rrggbb"; black for an image with none.
 */
export function averageColor(img: Image): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3] ?? 0;
    if (a === 0) continue;
    r += (img.data[i * 4] ?? 0) * a;
    g += (img.data[i * 4 + 1] ?? 0) * a;
    b += (img.data[i * 4 + 2] ?? 0) * a;
    w += a;
  }
  if (w === 0) return "#000000";
  const hex = (v: number): string =>
    Math.round(v / w)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** The opaque box of an image ([x, y, w, h]; a 1x1 corner when it is all transparent). */
export function opaqueBox(img: Image): { x: number; y: number; w: number; h: number } {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) !== 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Writes atlas.json + atlas-N.json/png into outDir, removing stale pages. */
export function writeAtlas(atlas: NonNullable<BuildResult["atlas"]>, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) {
    if (/^atlas(-\d+)?\.(png|json)$/.test(f)) rmSync(join(outDir, f));
  }
  const written: string[] = [];
  const write = (file: string, data: string | Buffer): void => {
    writeFileSync(join(outDir, file), data);
    written.push(file);
  };
  for (const page of atlas.pages) {
    write(page.pngFile, encodePng(page.image));
    write(page.jsonFile, JSON.stringify(page.json, null, 2) + "\n");
  }
  write("atlas.json", JSON.stringify(atlas.index, null, 2) + "\n");
  return written;
}

/** An animation frame's name: <sprite>/<action>_<dir>_<n> (docs/17 ANI-4). */
const FRAME_NAME = /^(.+)\/(idle|walk|attack|shoot|cast|death)_(ne|se|sw|nw|[nesw])_([0-9]+)$/;

/** Default ms per frame of an action whose frames are files (walk plays by distance). */
const FILE_FRAME_MS: Record<AnimAction, number> = {
  idle: 500,
  walk: 0,
  attack: 60,
  shoot: 50,
  cast: 60,
  death: 100,
};

/**
 * The clips that files named <sprite>/<action>_<dir>_<n> make: per action, the facings
 * that have frame 0, and as many frames as every one of them has from 0 without a gap.
 */
function framesByName(
  sprite: string,
  frames: Map<string, Image>,
): { actions: AnimMeta["actions"]; base: string; first: Image | undefined; walk: Image[] } {
  const actions: AnimMeta["actions"] = {};
  for (const action of ANIM_ACTIONS) {
    const dirs = ANIM_DIRS.filter((d) => frames.has(frameName(sprite, action, d, 0)));
    if (dirs.length === 0) continue;
    let count = Infinity;
    for (const d of dirs) {
      let n = 0;
      while (frames.has(frameName(sprite, action, d, n))) n++;
      count = Math.min(count, n);
    }
    actions[action] = {
      frames: count,
      ms: FILE_FRAME_MS[action],
      ...(action === "walk" ? { perTile: Math.max(1, Math.floor(count / 2)) } : {}),
      dirs,
    };
  }
  const order = ["idle", "walk", "attack", "death"] as const;
  let base = "";
  for (const action of order) {
    const a = actions[action];
    if (!a) continue;
    base = frameName(sprite, action, a.dirs.includes("s") ? "s" : (a.dirs[0] ?? "s"), 0);
    break;
  }
  const walk = actions.walk
    ? [...frames].filter(([k]) => k.startsWith(`${sprite}/walk_`)).map(([, v]) => v)
    : [];
  return { actions, base, first: frames.get(base), walk };
}

/**
 * The frames `mirror: true` adds (docs/17 ANI-1): for every action with west frames and
 * no east ones, each west frame flipped left to right as the east one of its number, and
 * the other way round. A facing the files already have is never replaced.
 */
export function mirroredFrames(sprite: string, frames: Map<string, Image>): Map<string, Image> {
  const out = new Map<string, Image>();
  const pairs: [AnimDir, AnimDir][] = [
    ["w", "e"],
    ["e", "w"],
  ];
  for (const action of ANIM_ACTIONS) {
    for (const [from, to] of pairs) {
      if (!frames.has(frameName(sprite, action, from, 0))) continue;
      if (frames.has(frameName(sprite, action, to, 0))) continue;
      for (let n = 0; ; n++) {
        const src = frames.get(frameName(sprite, action, from, n));
        if (!src) break;
        out.set(frameName(sprite, action, to, n), mirrorImage(src));
      }
    }
  }
  return out;
}

const sortedRecord = <T>(r: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));

/**
 * Composes an animation's frames: for every action and facing, each frame is its layers
 * (recoloured) drawn in order. Undefined (with diagnostics) when a sheet is missing or
 * too small.
 */
function buildLayered(
  name: string,
  entry: AnimEntry,
  palettes: Map<string, number[]>,
  load: (file: string) => Image | undefined,
  where: string,
  diags: Diagnostic[],
): { frames: Map<string, Image>; base: string; meta: AnimMeta } | undefined {
  const frames = new Map<string, Image>();
  const meta: AnimMeta = {
    w: 0,
    h: 0,
    anchor: "bc",
    foot: 0,
    top: 0,
    shadow: entry.shadow,
    ...(entry.facing ? { facing: entry.facing } : {}),
    ...(entry.flying ? { flying: true } : {}),
    actions: {},
  };
  const recolored = new Map<string, Image>();
  let ok = true;
  for (const action of ANIM_ACTIONS) {
    const spec = entry.actions.get(action);
    if (!spec) continue;
    const { w, h } = spec.frame;
    if (meta.w === 0) {
      meta.w = w;
      meta.h = h;
    } else if (meta.w !== w || meta.h !== h) {
      diags.push({
        severity: "error",
        where,
        message: `${name}: every action needs the same frame size`,
      });
      return undefined;
    }
    const dirs = ANIM_DIRS.filter((d) => spec.rows[d] !== undefined);
    const maxRow = Math.max(...dirs.map((d) => spec.rows[d] ?? 0));
    const layers: Image[] = [];
    for (const layer of entry.layers) {
      const file = layer.file.split("<sheet>").join(spec.sheet);
      const key = `${file}|${layer.recolor.map(([a, b]) => `${a}>${b}`).join(",")}`;
      let img = recolored.get(key);
      if (!img) {
        const src = load(file);
        if (!src) {
          ok = false;
          continue;
        }
        const swaps = layer.recolor.map(
          ([a, b]) => [palettes.get(a) ?? [], palettes.get(b) ?? []] as [number[], number[]],
        );
        img = recolorImage(src, swaps);
        recolored.set(key, img);
      }
      const cols = specColumns(spec);
      if (cols * w > img.width || (maxRow + 1) * h > img.height) {
        diags.push({
          severity: "error",
          where,
          message: `${name}: ${action} needs ${cols * w}x${(maxRow + 1) * h} px but assets/${file} is ${img.width}x${img.height}`,
        });
        ok = false;
        continue;
      }
      layers.push(img);
    }
    if (!ok) continue;
    for (const dir of dirs) {
      for (let n = 0; n < spec.count; n++) {
        const frame = createImage(w, h);
        const row = spec.rows[dir] ?? 0;
        for (const img of layers) layerOver(img, (spec.col + n * spec.step) * w, row * h, frame);
        frames.set(frameName(name, action, dir, n), frame);
      }
    }
    meta.actions[action] = {
      frames: spec.count,
      ms: spec.ms,
      ...(action === "walk" ? { perTile: spec.perTile } : {}),
      dirs,
    };
  }
  if (!ok || frames.size === 0) return undefined;
  // Feet and height from the walk (the pose drawn most), else from every frame.
  const walk = [...frames].filter(([k]) => k.startsWith(`${name}/walk_`)).map(([, v]) => v);
  const m = measureFrames(walk.length > 0 ? walk : [...frames.values()]);
  meta.foot = m.foot;
  meta.top = m.top;
  const base =
    [frameName(name, "idle", "s", 0), frameName(name, "walk", "s", 0)].find((k) => frames.has(k)) ??
    [...frames.keys()][0] ??
    "";
  return { frames, base, meta };
}

/**
 * The frame a legacy outfit frame name stands for when its outfit is animated (T0.5 names,
 * outfits/<id>/<dir>_<n>: 0 standing, 1.. walking): 0 is the idle (or walk) pose, 1 and up
 * the walk cycle half a cycle apart.
 */
export function legacyFrame(name: string, anims: Record<string, AnimMeta>): string | undefined {
  const m = /^(.+)\/([nesw])_([0-9]+)$/.exec(name);
  const sprite = m?.[1];
  const meta = sprite === undefined ? undefined : anims[sprite];
  if (!m || sprite === undefined || !meta) return undefined;
  const dir = m[2] as AnimDir;
  const k = Number(m[3]);
  const pick = (action: "idle" | "walk", n: number): string | undefined => {
    const a = meta.actions[action];
    if (!a) return undefined;
    const d = a.dirs.includes(dir) ? dir : (a.dirs[0] ?? "s");
    return frameName(sprite, action, d, n % a.frames);
  };
  const walk = meta.actions.walk;
  if (k === 0) return pick("idle", 0) ?? pick("walk", 0);
  return walk ? pick("walk", (k - 1) * Math.max(1, Math.floor(walk.frames / 2))) : pick("idle", 0);
}

function at(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`;
}

/** Width and height from a PNG's IHDR (undefined: not a PNG header, decodePng reports it). */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Decodes a PNG within the limits: its side, and the pixels left in the build's budget. */
function readPng(
  abs: string,
  where: string,
  diags: Diagnostic[],
  budget: { pixels: number },
): Image | undefined {
  try {
    const buf = readFileSync(abs);
    const size = pngSize(buf);
    const fail = (message: string): undefined => {
      diags.push({ severity: "error", where, message });
      return undefined;
    };
    if (size && (size.width > MAX_PNG_SIDE || size.height > MAX_PNG_SIDE))
      return fail(`PNG is ${size.width}x${size.height}; at most ${MAX_PNG_SIDE} per side`);
    if (size && size.width * size.height > budget.pixels)
      return fail("over the pixel budget of a build (MAX_TOTAL_PIXELS of PNGs in total)");
    const image = decodePng(buf);
    budget.pixels -= image.width * image.height;
    return image;
  } catch (err) {
    diags.push({
      severity: "error",
      where,
      message: `cannot decode PNG: ${(err as Error).message}`,
    });
    return undefined;
  }
}

function checkSize(img: Image, where: string, diags: Diagnostic[]): boolean {
  if (img.width > 0 && img.height > 0 && img.width % TILE === 0 && img.height % TILE === 0)
    return true;
  diags.push({
    severity: "error",
    where,
    message: `sprite is ${img.width}x${img.height}; width and height must be multiples of ${TILE}`,
  });
  return false;
}

/** A vendor pack is usable only with a licence file and a row in assets/CREDITS.md. */
function checkPack(
  pack: string,
  assetsDir: string,
  registered: Set<string>,
  cache: Map<string, boolean>,
  where: string,
  diags: Diagnostic[],
): boolean {
  const cached = cache.get(pack);
  if (cached !== undefined) return cached;
  let ok = true;
  if (!registered.has(pack)) {
    ok = false;
    diags.push({
      severity: "error",
      where,
      message: `pack "${pack}" is not registered in ${CREDITS_FILE} (add a row with folder assets/vendor/${pack})`,
    });
  }
  const dir = join(assetsDir, "vendor", pack);
  if (!existsSync(dir)) {
    ok = false;
    diags.push({ severity: "error", where, message: `assets/vendor/${pack}/ does not exist` });
  } else if (!readdirSync(dir).some(isLicenseFile)) {
    ok = false;
    diags.push({
      severity: "error",
      where,
      message: `assets/vendor/${pack}/ has no LICENSE file; keep the pack's licence text next to it`,
    });
  }
  cache.set(pack, ok);
  return ok;
}
