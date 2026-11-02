// Canonical chunk JSON (format 1). The writer is the single source of the on-disk layout:
//   - fixed key order: format, chunk, palette, ground, items
//   - one ground row per line, one item stack per line, 2-space indentation, final newline
//   - palette = IDs in order of first use (ground row-major, then stacks), no unused entries
//   - items sorted by y then x, one entry per tile, no empty stacks
// The same tiles therefore always produce the same bytes, whoever saves them.
import { Reporter } from "./diagnostics.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { checkSchema } from "./schemas.ts";
import { CHUNK_SIZE } from "./types.ts";
import type { Chunk, ItemStack } from "./types.ts";

export const CHUNK_FORMAT = 1;

export function floorDir(z: number): string {
  return `z${String(z).padStart(2, "0")}`;
}

export function chunkFileName(cx: number, cy: number): string {
  return `c${String(cx).padStart(4, "0")}_${String(cy).padStart(4, "0")}.json`;
}

/** Parses "zNN/cXXXX_YYYY.json"; undefined when the path does not follow the naming rule. */
export function parseChunkPath(rel: string): { z: number; cx: number; cy: number } | undefined {
  const m = /^z(\d{2})\/c(\d{4})_(\d{4})\.json$/.exec(rel);
  if (!m) return undefined;
  return { z: Number(m[1]), cx: Number(m[2]), cy: Number(m[3]) };
}

const tileIndex = (x: number, y: number): number => y * CHUNK_SIZE + x;

/** Returns a copy with items sorted by (y, x), empty stacks dropped. */
export function normalizeChunk(chunk: Chunk): Chunk {
  const items = chunk.items
    .filter((s) => s.stack.length > 0)
    .map((s) => ({ x: s.x, y: s.y, stack: [...s.stack] }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { cx: chunk.cx, cy: chunk.cy, z: chunk.z, ground: [...chunk.ground], items };
}

export function formatChunk(input: Chunk): string {
  const chunk = normalizeChunk(input);
  const palette: string[] = [];
  const index = new Map<string, number>();
  const ref = (id: string): number => {
    let i = index.get(id);
    if (i === undefined) {
      i = palette.length;
      palette.push(id);
      index.set(id, i);
    }
    return i;
  };
  const rows: string[] = [];
  for (let y = 0; y < CHUNK_SIZE; y++) {
    const row: number[] = [];
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const g = chunk.ground[tileIndex(x, y)];
      row.push(g === null || g === undefined ? -1 : ref(g));
    }
    rows.push(`    [${row.join(",")}]`);
  }
  const items = chunk.items.map(
    (s) => `    { "x": ${s.x}, "y": ${s.y}, "stack": [${s.stack.map(ref).join(", ")}] }`,
  );
  const lines = [
    "{",
    `  "format": ${CHUNK_FORMAT},`,
    `  "chunk": { "cx": ${chunk.cx}, "cy": ${chunk.cy}, "z": ${chunk.z} },`,
    `  "palette": [${palette.map((p) => JSON.stringify(p)).join(", ")}],`,
    `  "ground": [`,
    rows.join(",\n"),
    `  ],`,
    items.length === 0 ? `  "items": []` : `  "items": [\n${items.join(",\n")}\n  ]`,
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

interface RawChunk {
  chunk: { cx: number; cy: number; z: number };
  palette: string[];
  ground: number[][];
  items: { x: number; y: number; stack: number[] }[];
}

/**
 * Parses chunk JSON. Structural problems are reported against `file`; the chunk is
 * returned only when it could be fully resolved (every index points into the palette).
 */
export function parseChunk(
  text: string,
  file: string,
  diags: Diagnostic[] = [],
): Chunk | undefined {
  const r = new Reporter(diags);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    r.error(file, [], `invalid JSON: ${(err as Error).message}`);
    return undefined;
  }
  const schemaErrors = checkSchema("chunk", data);
  for (const e of schemaErrors) r.error(file, e.path, e.message);
  if (schemaErrors.length > 0) return undefined;
  const raw = data as RawChunk;
  const before = diags.length;
  const resolve = (i: number, path: (string | number)[]): string | undefined => {
    const id = raw.palette[i];
    if (id === undefined)
      r.error(file, path, `palette index ${i} out of range (palette has ${raw.palette.length})`);
    return id;
  };
  const chunk: Chunk = {
    cx: raw.chunk.cx,
    cy: raw.chunk.cy,
    z: raw.chunk.z,
    ground: [],
    items: [],
  };
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const v = raw.ground[y]?.[x] ?? -1;
      chunk.ground.push(v === -1 ? null : (resolve(v, ["ground", y, x]) ?? null));
    }
  }
  const seen = new Map<number, number>();
  for (const [i, s] of raw.items.entries()) {
    const prev = seen.get(tileIndex(s.x, s.y));
    if (prev !== undefined)
      r.error(file, ["items", i], `tile ${s.x},${s.y} already has a stack at items[${prev}]`);
    seen.set(tileIndex(s.x, s.y), i);
    const stack: ItemStack = { x: s.x, y: s.y, stack: [] };
    for (const [j, v] of s.stack.entries()) {
      const id = resolve(v, ["items", i, "stack", j]);
      if (id !== undefined) stack.stack.push(id);
    }
    chunk.items.push(stack);
  }
  return diags.length > before ? undefined : chunk;
}

export function groundAt(chunk: Chunk, lx: number, ly: number): string | null {
  return chunk.ground[tileIndex(lx, ly)] ?? null;
}

export function setGround(chunk: Chunk, lx: number, ly: number, id: string | null): void {
  chunk.ground[tileIndex(lx, ly)] = id;
}

export function stackAt(chunk: Chunk, lx: number, ly: number): string[] {
  return chunk.items.find((s) => s.x === lx && s.y === ly)?.stack ?? [];
}

/** Appends an item on top of the tile's stack. */
export function pushItem(chunk: Chunk, lx: number, ly: number, id: string): void {
  const s = chunk.items.find((e) => e.x === lx && e.y === ly);
  if (s) s.stack.push(id);
  else chunk.items.push({ x: lx, y: ly, stack: [id] });
}
