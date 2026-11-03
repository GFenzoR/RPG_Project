// Node side of the editor: reads world/ and data/ with @rpg/map-format, saves the chunks and
// auxiliary lists (spawns/npcs/zones/portals.yaml) the editor changed in the canonical layout
// (the same bytes `mapcli fmt` writes) and runs the shared validator on the in-memory world.
//
// Saving is checked against what the editor loaded: every changed file carries the hash it
// had then, and if the file on disk is different now (git pull, mapcli, another tab) the
// save is refused with a conflict instead of overwriting it. Files the editor did not
// change are never written or removed.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  checkSchema,
  chunkKey,
  formatChunk,
  formatYaml,
  loadContent,
  loadWorld,
  parseChunk,
  parseYamlText,
  validateLoaded,
} from "@rpg/map-format";
import type { ContentIndex, Diagnostic, World } from "@rpg/map-format";
import type { EntityList } from "@rpg/map-format/ops";
import { parse } from "yaml";
import type {
  Bootstrap,
  FileChange,
  PaletteItem,
  SaveResult,
  ValidateResult,
} from "../src/io/wire.ts";
import { EDITABLE_AUX, toWire } from "../src/io/wire.ts";

export const LANGUAGES = ["es", "en"] as const;

/** A save that would overwrite changes made on disk after the editor loaded them. */
export class SaveConflict extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(`changed on disk since the editor loaded them: ${conflicts.join(", ")}`);
    this.conflicts = conflicts;
  }
}

/**
 * A save that failed after some files were already on disk (a rename failed). `result`
 * says what was written and the files' hashes now, so the client can move its bases
 * forward instead of conflicting with its own writes on the next save.
 */
export class PartialSave extends Error {
  readonly result: SaveResult;
  constructor(cause: unknown, result: SaveResult) {
    super(`save stopped half-way: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.result = result;
  }
}

/** File operations saveChanges uses; tests inject failures through them. */
export interface SaveIo {
  writeFile(abs: string, text: string): void;
  rename(from: string, to: string): void;
  remove(abs: string): void;
}

export const nodeIo: SaveIo = {
  writeFile: (abs, text) => writeFileSync(abs, text),
  rename: (from, to) => renameSync(from, to),
  remove: (abs) => rmSync(abs, { force: true }),
};

/** A request the editor UI would never send (bad path, unknown island, malformed chunk). */
export class BadRequest extends Error {}

export const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const ID = /^[a-z][a-z0-9_]*$/;
const CHUNK_PATH = /^world\/islands\/([a-z][a-z0-9_]*)\/chunks\/z(\d{2})\/c(\d{4})_(\d{4})\.json$/;
/** Auxiliary lists the editor may write (EDITABLE_AUX); texts.yaml and island.yaml are not. */
const AUX_PATH = new RegExp(
  `^world/islands/([a-z][a-z0-9_]*)/(${EDITABLE_AUX.join("|")})\\.yaml$`,
);

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
  const aux = AUX_PATH.exec(change.file);
  if (aux) return planAux(root, world, islands, change.file, aux[1] ?? "", aux[2] as EntityList);
  const m = CHUNK_PATH.exec(change.file);
  if (!m) throw new BadRequest(`${change.file} is not a chunk or auxiliary file path`);
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
 * An auxiliary list (spawns/npcs/zones/portals.yaml): written as `formatYaml(list)`, the
 * canonical text `mapcli fmt` writes; removed when the list is empty (as saveApplied does).
 * The text must parse back and pass the file's schema before anything is written.
 */
function planAux(
  root: string,
  world: World,
  islands: Set<string>,
  file: string,
  id: string,
  list: EntityList,
): PlannedWrite {
  if (!islands.has(id)) throw new BadRequest(`island "${id}" is not in world/world.yaml`);
  const abs = inside(root, file, `world/islands/${id}`);
  const island = world.islands.get(id);
  if (!island) throw new BadRequest(`island "${id}" is missing from the request`);
  const entries: unknown = island[list];
  if (!Array.isArray(entries)) throw new BadRequest(`${file}: expected a list`);
  if (entries.length === 0) return { file, abs, text: null };
  let text: string;
  try {
    text = formatYaml(entries);
  } catch {
    throw new BadRequest(`${file}: malformed ${list}`);
  }
  const diags: Diagnostic[] = [];
  const parsed = parseYamlText(text, file, diags);
  if (!parsed) throw new BadRequest(`${file}: ${diags.map((d) => d.message).join("; ")}`);
  const errors = checkSchema(list, parsed.data);
  if (errors.length > 0)
    throw new BadRequest(
      `${file}: ${errors.map((e) => `${e.path.join(".") || "/"} ${e.message}`).join("; ")}`,
    );
  return { file, abs, text };
}

/**
 * Saves the chunk and auxiliary files in `changes` from `world`. All changes are checked first (paths,
 * islands listed in world.yaml on disk, chunk contents, conflicts with disk); only then is
 * anything written, so a refused save changes nothing.
 */
export function saveChanges(
  root: string,
  world: World,
  changes: FileChange[],
  io: SaveIo = nodeIo,
): SaveResult {
  if (!Array.isArray(changes)) throw new BadRequest("changes must be a list");
  const islands = new Set(
    loadWorld(root)
      .world.meta.islands.map((i) => i.id)
      .filter((id) => ID.test(id)),
  );
  const seen = new Set<string>();
  const planned: PlannedWrite[] = [];
  const conflicts: string[] = [];
  for (const change of changes as unknown[]) {
    if (!isObj(change) || typeof change["file"] !== "string")
      throw new BadRequest("each change needs a file path");
    const c = change as unknown as FileChange;
    if (seen.has(c.file)) throw new BadRequest(`${c.file} is listed twice`);
    seen.add(c.file);
    const p = plan(root, world, islands, c);
    const disk = readIfExists(p.abs);
    if (disk === p.text) continue; // already as wanted (e.g. someone saved the same edit)
    const now = disk === null ? null : hashText(disk);
    if (now !== c.base) conflicts.push(p.file);
    planned.push(p);
  }
  if (conflicts.length > 0) throw new SaveConflict(conflicts);

  // 1. Stage every new text next to its target. If any write fails, remove what was
  //    staged and stop: nothing in world/ has changed.
  const staged: { p: PlannedWrite; tmp: string }[] = [];
  try {
    for (const p of planned) {
      if (p.text === null) continue;
      mkdirSync(dirname(p.abs), { recursive: true });
      const tmp = `${p.abs}.${process.pid}.${staged.length}.saving`;
      staged.push({ p, tmp });
      io.writeFile(tmp, p.text);
    }
  } catch (e) {
    for (const s of staged) {
      try {
        io.remove(s.tmp);
      } catch {
        // best effort: a leftover *.saving file is reported by mapcli validate
      }
    }
    throw e;
  }

  // 2. Commit: renames (atomic per file) and removals. A failure here is rare; report
  //    what is on disk so the client stays in sync.
  const written: string[] = [];
  const removed: string[] = [];
  const result = (): SaveResult => {
    const base: Record<string, string | null> = {};
    for (const file of seen) {
      const text = readIfExists(join(root, file));
      base[file] = text === null ? null : hashText(text);
    }
    return { written: [...written].sort(), removed: [...removed].sort(), base };
  };
  try {
    for (const s of staged) {
      io.rename(s.tmp, s.p.abs);
      written.push(s.p.file);
    }
    for (const p of planned) {
      if (p.text !== null) continue;
      io.remove(p.abs);
      removed.push(p.file);
    }
  } catch (e) {
    for (const s of staged)
      if (!written.includes(s.p.file))
        try {
          io.remove(s.tmp);
        } catch {
          // best effort, as above
        }
    throw new PartialSave(e, result());
  }
  return result();
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
  for (const f of loaded.files)
    if (CHUNK_PATH.test(f.file) || AUX_PATH.test(f.file)) base[f.file] = hashText(f.text);
  const content = loadContent(root);
  return {
    world: toWire(loaded.world),
    items: loadPaletteItems(root),
    i18n: loadTexts(root),
    loadErrors: loaded.diagnostics.filter((d) => d.severity === "error"),
    base,
    borders: content.borders,
    monsters: [...content.monsters].sort(),
    npcs: [...content.npcs].sort(),
  };
}
