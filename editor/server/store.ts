// Node side of the editor: reads world/ and data/ with @rpg/map-format, saves the chunks the
// editor changed in the canonical layout (the same bytes `mapcli fmt` writes) and runs the
// shared validator on the in-memory world.
//
// Saving is checked against what the editor loaded: every changed file carries the hash it
// had then, and if the file on disk is different now (git pull, mapcli, another tab) the
// save is refused with a conflict instead of overwriting it. Files the editor did not
// change are never written or removed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  chunkKey,
  formatChunk,
  loadWorld,
  parseChunk,
  validateLoaded,
} from "@rpg/map-format";
import type { ContentIndex, Diagnostic, World } from "@rpg/map-format";
import { parse } from "yaml";
import type {
  Bootstrap,
  FileChange,
  PaletteItem,
  SaveResult,
  ValidateResult,
} from "../src/io/wire.ts";
import { toWire } from "../src/io/wire.ts";

export const LANGUAGES = ["es", "en"] as const;

/** A save that would overwrite changes made on disk after the editor loaded them. */
export class SaveConflict extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(`changed on disk since the editor loaded them: ${conflicts.join(", ")}`);
    this.conflicts = conflicts;
  }
}

/** A request the editor UI would never send (bad path, unknown island, malformed chunk). */
export class BadRequest extends Error {}

export const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const ID = /^[a-z][a-z0-9_]*$/;
const CHUNK_PATH = /^world\/islands\/([a-z][a-z0-9_]*)\/chunks\/z(\d{2})\/c(\d{4})_(\d{4})\.json$/;

function readIfExists(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Resolves a repo-relative path and checks it stays inside `dir` (both under root). */
function inside(root: string, file: string, dir: string): string {
  const abs = resolve(root, file);
  const base = resolve(root, dir) + sep;
  if (!abs.startsWith(base)) throw new BadRequest(`${file} is outside ${dir}/`);
  return abs;
}

interface PlannedWrite {
  file: string;
  abs: string;
  /** Canonical text to write, or null to remove the file. */
  text: string | null;
}

/** Checks one change and works out what to write; throws BadRequest if it is not legit. */
function plan(root: string, world: World, islands: Set<string>, change: FileChange): PlannedWrite {
  if (typeof change?.file !== "string") throw new BadRequest("change without a file");
  if (change.base !== null && (typeof change.base !== "string" || !/^[0-9a-f]{64}$/.test(change.base)))
    throw new BadRequest(`${change.file}: invalid base hash`);
  const m = CHUNK_PATH.exec(change.file);
  if (!m) throw new BadRequest(`${change.file} is not a chunk file path`);
  const [, id = "", zs, cxs, cys] = m;
  const z = Number(zs);
  const cx = Number(cxs);
  const cy = Number(cys);
  if (!islands.has(id)) throw new BadRequest(`island "${id}" is not in world/world.yaml`);
  if (z > 15) throw new BadRequest(`${change.file}: floor ${z} is out of range`);
  const abs = inside(root, change.file, `world/islands/${id}`);
  const island = world.islands.get(id);
  if (!island) throw new BadRequest(`island "${id}" is missing from the request`);
  const chunk = island.chunks.get(chunkKey(z, cx, cy));
  if (!chunk) return { file: change.file, abs, text: null };
  if (chunk.cx !== cx || chunk.cy !== cy || chunk.z !== z)
    throw new BadRequest(`${change.file}: chunk says cx=${chunk.cx} cy=${chunk.cy} z=${chunk.z}`);
  if (!Array.isArray(chunk.ground) || chunk.ground.length !== 32 * 32 || !Array.isArray(chunk.items))
    throw new BadRequest(`${change.file}: malformed chunk`);
  let text: string;
  try {
    text = formatChunk(chunk);
  } catch {
    throw new BadRequest(`${change.file}: malformed chunk`);
  }
  // The written text must be a valid chunk: schema (ID patterns, ranges) and palette.
  const diags: Diagnostic[] = [];
  if (!parseChunk(text, change.file, diags))
    throw new BadRequest(`${change.file}: ${diags.map((d) => d.message).join("; ")}`);
  return { file: change.file, abs, text };
}

/**
 * Saves the chunk files in `changes` from `world`. All changes are checked first (paths,
 * islands listed in world.yaml on disk, chunk contents, conflicts with disk); only then is
 * anything written, so a refused save changes nothing.
 */
export function saveChanges(root: string, world: World, changes: FileChange[]): SaveResult {
  if (!Array.isArray(changes)) throw new BadRequest("changes must be a list");
  const islands = new Set(loadWorld(root).world.meta.islands.map((i) => i.id).filter((id) => ID.test(id)));
  const seen = new Set<string>();
  const planned: PlannedWrite[] = [];
  const conflicts: string[] = [];
  for (const change of changes) {
    if (seen.has(change.file)) throw new BadRequest(`${change.file} is listed twice`);
    seen.add(change.file);
    const p = plan(root, world, islands, change);
    const disk = readIfExists(p.abs);
    if (disk === p.text) continue; // already as wanted (e.g. someone saved the same edit)
    const now = disk === null ? null : hashText(disk);
    if (now !== change.base) conflicts.push(p.file);
    planned.push(p);
  }
  if (conflicts.length > 0) throw new SaveConflict(conflicts);
  const written: string[] = [];
  const removed: string[] = [];
  for (const p of planned) {
    if (p.text === null) {
      rmSync(p.abs, { force: true });
      removed.push(p.file);
    } else {
      mkdirSync(dirname(p.abs), { recursive: true });
      writeFileSync(p.abs, p.text);
      written.push(p.file);
    }
  }
  const base: Record<string, string | null> = {};
  for (const file of seen) {
    const text = readIfExists(join(root, file));
    base[file] = text === null ? null : hashText(text);
  }
  return { written: written.sort(), removed: removed.sort(), base };
}

/** The shared validator on the in-memory world, with YAML lines from the files on disk. */
export function validateInMemory(root: string, world: World, content: ContentIndex): ValidateResult {
  return validateLoaded(world, content, { lines: loadWorld(root).lines });
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

/** editor.*, item.* and island.* texts of every language. */
export function loadTexts(root: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const lang of LANGUAGES) {
    const texts: Record<string, string> = {};
    for (const name of ["editor.yaml", "items.yaml", "world.yaml"]) {
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
  const base: Record<string, string> = {};
  for (const f of loaded.files) if (CHUNK_PATH.test(f.file)) base[f.file] = hashText(f.text);
  return {
    world: toWire(loaded.world),
    items: loadPaletteItems(root),
    i18n: loadTexts(root),
    loadErrors: loaded.diagnostics.filter((d) => d.severity === "error"),
    base,
  };
}
