// Reading and writing world/ on disk. Loading never throws on bad content: problems become
// diagnostics, and whatever parsed is still returned so validation can report everything.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  yaml<T>(file: string, schema: MapSchemaName, required: boolean, fallback: T): T {
    const abs = join(this.root, file);
    if (!existsSync(abs)) {
      if (required) this.r.error(file, [], "required file is missing");
      return fallback;
    }
    const text = readFileSync(abs, "utf8");
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
    const known = new Set(["island.yaml", "chunks", ...AUX_FILES.map((a) => `${a}.yaml`)]);
    for (const entry of readdirSync(join(this.root, dir)).sort()) {
      if (!known.has(entry))
        this.r.error(`${dir}/${entry}`, [], "unexpected file in an island directory");
    }
    const chunksDir = join(this.root, dir, "chunks");
    if (!existsSync(chunksDir)) return island;
    for (const floor of readdirSync(chunksDir).sort()) {
      const floorPath = join(chunksDir, floor);
      if (!/^z\d{2}$/.test(floor)) {
        this.r.error(`${dir}/chunks/${floor}`, [], "expected floor directories named z00..z15");
        continue;
      }
      for (const entry of readdirSync(floorPath).sort()) {
        const rel = `${floor}/${entry}`;
        const file = `${dir}/chunks/${rel}`;
        const name = parseChunkPath(rel);
        if (!name) {
          this.r.error(
            file,
            [],
            "chunk files are named cXXXX_YYYY.json (4-digit chunk coordinates)",
          );
          continue;
        }
        const text = readFileSync(join(floorPath, entry), "utf8");
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
  const islandsRoot = join(root, "world", "islands");
  const onDisk = existsSync(islandsRoot) ? readdirSync(islandsRoot).sort() : [];
  const listed = new Set(meta.islands.map((i) => i.id));
  for (const [i, entry] of meta.islands.entries()) {
    if (islands.has(entry.id)) {
      r.error(worldFile, ["islands", i, "id"], `island "${entry.id}" is listed twice`);
      continue;
    }
    if (!onDisk.includes(entry.id)) {
      r.error(worldFile, ["islands", i, "id"], `no directory ${islandDir(entry.id)}/`);
      continue;
    }
    const island = l.island(entry.id);
    if (island) islands.set(entry.id, island);
  }
  for (const dir of onDisk) {
    if (!listed.has(dir)) r.error(`${islandDir(dir)}/`, [], `island is not listed in ${worldFile}`);
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
