// Collects the sprite paths that data/**/*.yaml refers to (items, monsters, NPCs...).
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

/**
 * Every `sprite: <path>` string in data/. Unparseable files are skipped: reporting them is
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
      refs.push({ sprite, file, ...(typeof id === "string" ? { id } : {}) });
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
