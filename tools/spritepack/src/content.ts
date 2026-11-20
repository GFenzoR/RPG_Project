// Collects the sprite paths that data/**/*.yaml refers to (items, monsters, NPCs...).
// An outfit of data/outfits.yaml (T0.5) names a sprite folder: it refers to each of its
// frames, "<sprite>/<dir>_<frame>" for dir in n|e|s|w and frame below `frames`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

/** YAML text to data (for the tools that read data/ next to spritepack: spritegen). */
export const parseYaml = (text: string): unknown => parse(text) as unknown;

export interface SpriteRef {
  sprite: string;
  /** File relative to the repo root, forward slashes. */
  file: string;
  /** The "id" of the object that holds the sprite field, when it has one. */
  id?: string;
}

export function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

/** The file whose `sprite` fields are outfit folders, not sprites. */
export const OUTFITS_FILE = "data/outfits.yaml";
/** Facings of an outfit, as its frame files name them (client/src/render/outfit.ts). */
export const OUTFIT_DIRS = ["n", "e", "s", "w"] as const;

/** The frame sprites of an outfit folder: n_0, n_1, ..., w_<frames-1>. */
export function outfitFrames(sprite: string, frames: number): string[] {
  const n = Number.isInteger(frames) && frames > 0 ? frames : 1;
  return OUTFIT_DIRS.flatMap((d) => Array.from({ length: n }, (_, f) => `${sprite}/${d}_${f}`));
}

/** The file that lists the engine humanoids' layers (docs/06 "Looks"). */
export const LOOKS_FILE = "data/looks.yaml";

/**
 * The paper-doll layers data/looks.yaml names (docs/17 "Humanoides del motor"): a body per
 * sex and build, a layer per hair style and beard (bald and none draw nothing), a worn
 * shape per slot, the torso per sex and build (a woman's end in _female). The same paths
 * as packages/renderer look.ts layerSprite.
 */
export function lookSprites(looks: unknown): string[] {
  if (typeof looks !== "object" || looks === null) return [];
  const l = looks as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const builds = list(l["builds"]);
  // A man's paths have no suffix (they predate the sex); a woman's end in _female.
  const sexes = list(l["sexes"]).map((s) => (s === "female" ? "_female" : ""));
  if (sexes.length === 0) sexes.push("");
  const out: string[] = sexes.flatMap((her) => builds.map((b) => `humans/body_${b}${her}`));
  for (const h of list(l["hair_styles"])) if (h !== "bald") out.push(`humans/hair_${h}`);
  for (const b of list(l["beards"])) if (b !== "none") out.push(`humans/beard_${b}`);
  const shapes = l["shapes"];
  if (typeof shapes === "object" && shapes !== null)
    for (const [slot, names] of Object.entries(shapes as Record<string, unknown>))
      for (const shape of list(names)) {
        if (slot === "torso")
          for (const her of sexes)
            for (const b of builds) out.push(`worn/torso_${shape}_${b}${her}`);
        else out.push(`worn/${slot}_${shape}`);
      }
  return out;
}

/**
 * Every `sprite: <path>` string in data/ (an outfit adds its frames instead), and the layers
 * of data/looks.yaml. Unparseable files are skipped: reporting them is the content
 * validator's job (make validate).
 */
export function collectSpriteRefs(root: string): SpriteRef[] {
  const refs: SpriteRef[] = [];
  const dataDir = join(root, "data");
  for (const abs of [...listFiles(dataDir, ".yaml"), ...listFiles(dataDir, ".yml")].sort()) {
    const file = relative(root, abs).split("\\").join("/");
    let doc: unknown;
    try {
      doc = parse(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    if (file === LOOKS_FILE) {
      for (const sprite of lookSprites(doc)) refs.push({ sprite, file });
      continue;
    }
    walk(doc, (obj) => {
      const sprite = obj["sprite"];
      if (typeof sprite !== "string") return;
      const id = obj["id"];
      const extra = typeof id === "string" ? { id } : {};
      if (file === OUTFITS_FILE) {
        const frames = typeof obj["frames"] === "number" ? obj["frames"] : 1;
        for (const frame of outfitFrames(sprite, frames))
          refs.push({ sprite: frame, file, ...extra });
        return;
      }
      refs.push({ sprite, file, ...extra });
    });
  }
  return refs;
}

function walk(v: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, visit);
  } else if (typeof v === "object" && v !== null) {
    const obj = v as Record<string, unknown>;
    visit(obj);
    for (const x of Object.values(obj)) walk(x, visit);
  }
}
