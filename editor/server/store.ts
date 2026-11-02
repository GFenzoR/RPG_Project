// Node side of the editor: reads world/ and data/ with @rpg/map-format, saves in the
// canonical layout (the same bytes `mapcli fmt` writes) and runs the shared validator.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUX_FILES,
  chunkFileName,
  floorDir,
  formatChunk,
  formatDiagnostic,
  formatYaml,
  islandDir,
  loadWorld,
  validateWorld,
  writeIsland,
  writeWorldMeta,
} from "@rpg/map-format";
import type { ContentIndex, World } from "@rpg/map-format";
import { parse } from "yaml";
import type { Bootstrap, PaletteItem, SaveResult, ValidateResult } from "../src/io/wire.ts";
import { toWire } from "../src/io/wire.ts";

export const LANGUAGES = ["es", "en"] as const;

/** Every map file the editor owns for a world, with its canonical text. */
export function canonicalFiles(world: World): Map<string, string> {
  const out = new Map<string, string>();
  for (const island of world.islands.values()) {
    const dir = islandDir(island.meta.id);
    out.set(`${dir}/island.yaml`, formatYaml(island.meta));
    for (const aux of AUX_FILES) {
      const list = island[aux];
      if (list.length > 0) out.set(`${dir}/${aux}.yaml`, formatYaml(list));
    }
    for (const c of island.chunks.values())
      out.set(`${dir}/chunks/${floorDir(c.z)}/${chunkFileName(c.cx, c.cy)}`, formatChunk(c));
  }
  return out;
}

export class SaveRefused extends Error {}

/**
 * Saves the islands of `world` under `root`, like `mapcli fmt` would leave them: writes
 * every file whose canonical text differs from disk and removes the chunk/aux files that
 * are on disk but no longer in memory. world.yaml is not touched (the editor does not
 * change it). Refuses to save while world/ has files that do not load, so a file the
 * editor could not read is never overwritten or deleted.
 */
export function saveWorld(root: string, world: World): SaveResult {
  const disk = loadWorld(root);
  const broken = disk.diagnostics.filter((d) => d.severity === "error");
  if (broken.length > 0)
    throw new SaveRefused(
      `world/ has files that do not load; fix them first: ${broken.map(formatDiagnostic).join("; ")}`,
    );
  const want = canonicalFiles(world);
  const written: string[] = [];
  const removed: string[] = [];
  for (const [file, text] of want) {
    const abs = join(root, file);
    if (existsSync(abs) && readFileSync(abs, "utf8") === text) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(file);
  }
  const owned = [...world.islands.keys()].map((id) => `${islandDir(id)}/`);
  for (const { file } of disk.files) {
    if (want.has(file) || !owned.some((p) => file.startsWith(p))) continue;
    if (file.endsWith("/island.yaml")) continue;
    rmSync(join(root, file));
    removed.push(file);
  }
  return { written: written.sort(), removed: removed.sort() };
}

/**
 * Validates an in-memory world with the shared validator (`mapcli validate`): writes it in
 * canonical form to a scratch directory and validates that, against the repo's content.
 * The result is exactly what `mapcli validate` would say after saving.
 */
export function validateInMemory(world: World, content: ContentIndex): ValidateResult {
  const scratch = mkdtempSync(join(tmpdir(), "rpg-editor-validate-"));
  try {
    writeWorldMeta(scratch, world.meta);
    for (const island of world.islands.values()) writeIsland(scratch, island);
    // Paths in the scratch copy are the repo's (world/...), so diagnostics need no mapping.
    return validateWorld(scratch, { content });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined; // the content validator reports it
  }
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => join(dir, f));
}

/** data/items entries with the fields the palette and the renderer need. */
export function loadPaletteItems(root: string): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const file of yamlFiles(join(root, "data", "items"))) {
    const list = readYaml(file);
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!isObj(raw) || typeof raw["id"] !== "string") continue;
      items.push({
        id: raw["id"],
        kind: typeof raw["kind"] === "string" ? raw["kind"] : "",
        sprite: typeof raw["sprite"] === "string" ? raw["sprite"] : "",
        name: typeof raw["name"] === "string" ? raw["name"] : "",
      });
    }
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** editor.* and item.* texts of every language. */
export function loadTexts(root: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const lang of LANGUAGES) {
    const texts: Record<string, string> = {};
    for (const name of ["editor.yaml", "items.yaml"]) {
      const cat = readYaml(join(root, "i18n", lang, name));
      if (isObj(cat))
        for (const [k, v] of Object.entries(cat)) if (typeof v === "string") texts[k] = v;
    }
    out[lang] = texts;
  }
  return out;
}

export function bootstrap(root: string): Bootstrap {
  const loaded = loadWorld(root);
  return {
    world: toWire(loaded.world),
    items: loadPaletteItems(root),
    i18n: loadTexts(root),
    loadErrors: loaded.diagnostics.filter((d) => d.severity === "error"),
  };
}
