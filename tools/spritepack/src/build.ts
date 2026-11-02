// Resolves every sprite to pixels and packs them into atlas pages + JSON.
//
// Resolution order for a logical sprite path (the `sprite:` value used in data/):
//   1. assets/sprites/<path>.png            original art committed to the repo
//   2. assets/sprites.yaml entry            vendor pack crop or explicit placeholder
//   3. automatic placeholder                for data/ sprites nobody mapped yet (warning)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectSpriteRefs, listFiles } from "./content.ts";
import type { SpriteRef } from "./content.ts";
import { isLicenseFile, registeredPacks } from "./credits.ts";
import { blit, createImage, decodePng, encodePng } from "./image.ts";
import type { Image } from "./image.ts";
import { parseManifest, SPRITE_PATH } from "./manifest.ts";
import type { SpriteEntry } from "./manifest.ts";
import { packSprites } from "./pack.ts";
import { defaultColor, defaultLabel, renderPlaceholder, TILE } from "./placeholder.ts";

export const MANIFEST_FILE = "assets/sprites.yaml";
export const SPRITES_DIR = "assets/sprites";
export const CREDITS_FILE = "assets/CREDITS.md";
export const DEFAULT_OUT_DIR = "assets/atlas";
export const DEFAULT_MAX_PAGE = 2048;

export type Origin = "file" | "vendor" | "placeholder" | "auto";

export interface Diagnostic {
  severity: "error" | "warning";
  /** File (and line) the problem is about, relative to the repo root. */
  where: string;
  message: string;
}

export interface BuildOptions {
  /** Treat automatic placeholders (data/ sprites with no mapping) as errors. */
  strict?: boolean;
  maxPageSize?: number;
}

export interface AtlasFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: false;
  spriteSourceSize: { x: 0; y: 0; w: number; h: number };
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

  // 1. Original art under assets/sprites/.
  const spritesDir = join(root, SPRITES_DIR);
  for (const abs of listFiles(spritesDir, ".png")) {
    const rel = relative(spritesDir, abs).split("\\").join("/");
    const where = `${SPRITES_DIR}/${rel}`;
    const name = rel.slice(0, -".png".length);
    if (!SPRITE_PATH.test(name)) {
      diags.push({ severity: "error", where, message: "file name must be lowercase snake_case" });
      continue;
    }
    const image = readPng(abs, where, diags);
    if (image && checkSize(image, where, diags)) resolved.set(name, { origin: "file", image });
  }

  // 2. Manifest entries.
  const manifestPath = join(root, MANIFEST_FILE);
  const entries = new Map<string, SpriteEntry>();
  const lines = new Map<string, number>();
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
      src = existsSync(abs) ? readPng(abs, `assets/${entry.source}`, diags) : undefined;
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

  // 3. Sprites used by data/ that nothing provides.
  const refs = collectSpriteRefs(root);
  const refsBySprite = new Map<string, SpriteRef[]>();
  for (const ref of refs) {
    const list = refsBySprite.get(ref.sprite) ?? [];
    list.push(ref);
    refsBySprite.set(ref.sprite, list);
  }
  for (const [name, list] of [...refsBySprite].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (resolved.has(name) || entries.has(name) || !SPRITE_PATH.test(name)) continue;
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

  const sprites = new Map<string, { origin: Origin; refs: SpriteRef[] }>();
  for (const [name, r] of resolved)
    sprites.set(name, { origin: r.origin, refs: refsBySprite.get(name) ?? [] });
  if (diags.some((d) => d.severity === "error")) return { diagnostics: diags, sprites };

  // 4. Pack and render.
  const maxSize = opts.maxPageSize ?? DEFAULT_MAX_PAGE;
  let packed;
  try {
    packed = packSprites(
      [...resolved].map(([name, r]) => ({ name, width: r.image.width, height: r.image.height })),
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
  const index: AtlasIndex = { version: 1, tileSize: TILE, pages: jsonFiles, sprites: {} };
  const byName = [...packed.placements].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const p of byName) {
    const r = resolved.get(p.name);
    const page = pages[p.page];
    if (!r || !page) continue;
    blit(r.image, 0, 0, p.width, p.height, page.image, p.x, p.y);
    page.json.frames[p.name] = {
      frame: { x: p.x, y: p.y, w: p.width, h: p.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: p.width, h: p.height },
      sourceSize: { w: p.width, h: p.height },
    };
    index.sprites[p.name] = { page: p.page, origin: r.origin };
  }
  return { diagnostics: diags, atlas: { index, pages }, sprites };
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

function at(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`;
}

function readPng(abs: string, where: string, diags: Diagnostic[]): Image | undefined {
  try {
    return decodePng(readFileSync(abs));
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
