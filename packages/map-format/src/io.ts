// Reading and writing world/ on disk. Loading never throws on bad content: problems become
// diagnostics, and whatever parsed is still returned so validation can report everything.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { chunkFileName, floorDir, formatChunk, parseChunk, parseChunkPath } from "./chunk.ts";
import { Reporter } from "./diagnostics.ts";
import type { Diagnostic, PathSegment } from "./diagnostics.ts";
import { checkSchema } from "./schemas.ts";
import type { MapSchemaName } from "./schemas.ts";
import { chunkKey } from "./types.ts";
import type { Island, IslandMeta, World, WorldMeta } from "./types.ts";
import { formatYaml, parseYamlText } from "./yaml.ts";

export const AUX_FILES = ["spawns", "npcs", "zones", "portals", "texts"] as const;
export type AuxFile = (typeof AUX_FILES)[number];

export const worldFile = "world/world.yaml";
export const islandDir = (id: string): string => `world/islands/${id}`;

/** A file as read from disk, with the canonical text it should have. */
export interface FileState {
  file: string;
  text: string;
  canonical: string;
}

export interface LoadResult {
  world: World;
  /** Line lookup for each YAML file that parsed, to point diagnostics at file:line. */
  lines: Map<string, (path: PathSegment[]) => number | undefined>;
  /** Every map file that parsed, so `fmt` can rewrite it and `validate` can check layout. */
  files: FileState[];
  diagnostics: Diagnostic[];
}

class Loader {
  readonly diags: Diagnostic[] = [];
  readonly files: FileState[] = [];
  readonly lines = new Map<string, (path: PathSegment[]) => number | undefined>();
  private readonly r = new Reporter(this.diags);
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Entries of a directory, sorted, without dotfiles (.DS_Store, .gitkeep...). */
  list(rel: string): Dirent[] {
    try {
      return readdirSync(join(this.root, rel), { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      this.r.error(`${rel}/`, [], `cannot read directory: ${errorMessage(err)}`);
      return [];
    }
  }

  /** What is at rel: "file", "dir", undefined when missing; reports a read error as such. */
  kind(rel: string): "file" | "dir" | "other" | undefined {
    try {
      const st = statSync(join(this.root, rel));
      return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    } catch {
      return undefined;
    }
  }

  read(rel: string): string | undefined {
    try {
      return readFileSync(join(this.root, rel), "utf8");
    } catch (err) {
      this.r.error(rel, [], `cannot read file: ${errorMessage(err)}`);
      return undefined;
    }
  }

  yaml<T>(file: string, schema: MapSchemaName, required: boolean, fallback: T): T {
    const kind = this.kind(file);
    if (kind === undefined) {
      if (required) this.r.error(file, [], "required file is missing");
      return fallback;
    }
    if (kind !== "file") {
      this.r.error(file, [], "expected a file");
      return fallback;
    }
    const text = this.read(file);
    if (text === undefined) return fallback;
    const parsed = parseYamlText(text, file, this.diags);
    if (!parsed) return fallback;
    this.lines.set(file, parsed.lineOf);
    const errors = checkSchema(schema, parsed.data);
    for (const e of errors) this.r.error(file, e.path, e.message, undefined, parsed.lineOf(e.path));
    if (errors.length > 0) return fallback;
    this.files.push({ file, text, canonical: formatYaml(parsed.data) });
    return parsed.data as T;
  }

  island(id: string): Island | undefined {
    const dir = islandDir(id);
    const meta = this.yaml<IslandMeta | undefined>(`${dir}/island.yaml`, "island", true, undefined);
    if (!meta) return undefined;
    const island: Island = {
      meta,
      chunks: new Map(),
      spawns: this.yaml(`${dir}/spawns.yaml`, "spawns", false, []),
      npcs: this.yaml(`${dir}/npcs.yaml`, "npcs", false, []),
      zones: this.yaml(`${dir}/zones.yaml`, "zones", false, []),
      portals: this.yaml(`${dir}/portals.yaml`, "portals", false, []),
      texts: this.yaml(`${dir}/texts.yaml`, "texts", false, []),
    };
    const known = new Set(["island.yaml", ...AUX_FILES.map((a) => `${a}.yaml`)]);
    let hasChunks = false;
    for (const entry of this.list(dir)) {
      if (entry.name === "chunks") {
        if (entry.isDirectory()) hasChunks = true;
        else this.r.error(`${dir}/chunks`, [], "expected a directory");
      } else if (!known.has(entry.name)) {
        this.r.error(`${dir}/${entry.name}`, [], "unexpected entry in an island directory");
      }
    }
    if (!hasChunks) return island;
    for (const floor of this.list(`${dir}/chunks`)) {
      const floorRel = `${dir}/chunks/${floor.name}`;
      if (!/^z\d{2}$/.test(floor.name)) {
        this.r.error(floorRel, [], "expected floor directories named z00..z15");
        continue;
      }
      if (!floor.isDirectory()) {
        this.r.error(floorRel, [], "expected a directory");
        continue;
      }
      for (const entry of this.list(floorRel)) {
        const file = `${floorRel}/${entry.name}`;
        const name = parseChunkPath(`${floor.name}/${entry.name}`);
        if (!name) {
          this.r.error(
            file,
            [],
            "chunk files are named cXXXX_YYYY.json (4-digit chunk coordinates)",
          );
          continue;
        }
        if (!entry.isFile()) {
          this.r.error(file, [], "expected a file");
          continue;
        }
        const text = this.read(file);
        if (text === undefined) continue;
        const chunk = parseChunk(text, file, this.diags);
        if (!chunk) continue;
        if (chunk.cx !== name.cx || chunk.cy !== name.cy || chunk.z !== name.z) {
          this.r.error(
            file,
            ["chunk"],
            `says cx=${chunk.cx} cy=${chunk.cy} z=${chunk.z} but the file name says cx=${name.cx} cy=${name.cy} z=${name.z}`,
          );
          continue;
        }
        this.files.push({ file, text, canonical: formatChunk(chunk) });
        island.chunks.set(chunkKey(chunk.z, chunk.cx, chunk.cy), chunk);
      }
    }
    return island;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Loads world/world.yaml and every island under world/islands/. */
export function loadWorld(root: string): LoadResult {
  const l = new Loader(root);
  const r = new Reporter(l.diags);
  const meta = l.yaml<WorldMeta>(worldFile, "world", true, {
    format: 1,
    islands: [],
    boat_routes: [],
  });
  const islands = new Map<string, Island>();
  const islandsRel = "world/islands";
  const onDisk = new Map<string, Dirent>();
  if (l.kind(islandsRel) === "dir") for (const e of l.list(islandsRel)) onDisk.set(e.name, e);
  const seen = new Set<string>();
  for (const [i, entry] of meta.islands.entries()) {
    if (seen.has(entry.id)) {
      r.error(worldFile, ["islands", i, "id"], `island "${entry.id}" is listed twice`);
      continue;
    }
    seen.add(entry.id);
    const d = onDisk.get(entry.id);
    if (!d) {
      r.error(worldFile, ["islands", i, "id"], `no directory ${islandDir(entry.id)}/`);
      continue;
    }
    if (!d.isDirectory()) {
      r.error(islandDir(entry.id), [], "expected a directory");
      continue;
    }
    const island = l.island(entry.id);
    if (island) islands.set(entry.id, island);
  }
  for (const name of onDisk.keys()) {
    if (!seen.has(name)) r.error(`${islandDir(name)}/`, [], `island is not listed in ${worldFile}`);
  }
  return { world: { meta, islands }, files: l.files, lines: l.lines, diagnostics: l.diags };
}

function write(root: string, file: string, text: string): void {
  const abs = join(root, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

/** Writes world.yaml in canonical form. */
export function writeWorldMeta(root: string, meta: WorldMeta): void {
  write(root, worldFile, formatYaml(meta));
}

/**
 * Writes an island in canonical form. The chunks directory is replaced, so chunks removed
 * from memory disappear from disk. Empty auxiliary lists are not written.
 */
export function writeIsland(root: string, island: Island): void {
  const dir = islandDir(island.meta.id);
  write(root, `${dir}/island.yaml`, formatYaml(island.meta));
  for (const aux of AUX_FILES) {
    const list = island[aux];
    const file = `${dir}/${aux}.yaml`;
    if (list.length > 0) write(root, file, formatYaml(list));
    else rmSync(join(root, file), { force: true });
  }
  rmSync(join(root, dir, "chunks"), { recursive: true, force: true });
  const sorted = [...island.chunks.values()].sort(
    (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
  );
  for (const c of sorted)
    write(root, `${dir}/chunks/${floorDir(c.z)}/${chunkFileName(c.cx, c.cy)}`, formatChunk(c));
}
