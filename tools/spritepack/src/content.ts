// Collects the sprite paths that data/**/*.yaml refers to (items, monsters, NPCs...).
// An outfit of data/outfits.yaml (T0.5) names a sprite folder: it refers to each of its
// frames, "<sprite>/<dir>_<frame>" for dir in n|e|s|w and frame below `frames`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

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

/**
 * Every `sprite: <path>` string in data/ (an outfit adds its frames instead). Unparseable files are skipped: reporting them is
 * the content validator's job (make validate).
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
