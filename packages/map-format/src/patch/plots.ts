// Community plots (docs/03-world-and-maps.md, "Contribuciones de la comunidad"): the
// `community_plot` zones mark the areas anyone may change; a change anywhere else needs a
// maintainer. Given the files a pull request changes (before and after text), this lists
// what falls outside every plot, and the areas worth rendering before/after for review.
//
// Positions: changed chunk tiles count one by one; spawns by the whole square centre ±
// radius (where their monsters roam), NPCs and texts
// by their tile, portals by both ends, zones by every tile of their rects on each floor.
// Changing a `community_plot` zone itself (adding, moving, removing a plot) is always
// maintainer-only, wherever it is. Pure apart from parsePatchFile (schemas).
import { CHUNK_SIZE, rectContains } from "../types.ts";
import type { Chunk, Position, Rect, World, Zone } from "../types.ts";
import { chunkChanges, listKey } from "./merge.ts";
import type { ListEntry } from "./merge.ts";
import { parsePatchFile, patchPath } from "./patch.ts";

/** A community plot zone, from the base world (never from the change under review). */
export interface Plot {
  island: string;
  id: string;
  floors: number[];
  rects: Rect[];
}

/** One changed file: its text before and after (null when it does not exist on that side). */
export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

export type PlotViolation =
  | {
      kind: "tiles";
      path: string;
      /** Changed tiles outside every plot. */
      tiles: number;
      /** First tiles, "x,y,z". */
      at: string[];
    }
  | {
      kind: "entry";
      path: string;
      entry: string;
      change: "added" | "removed" | "changed";
      reason: "outside_plot" | "plot_definition";
    }
  | { kind: "file"; path: string; reason: "not_map_file" | "invalid" | "island_meta" };

/** Files under world/ that anyone may change, outside the plot rules (credits). */
export const PLOT_FREE_FILES: readonly string[] = ["world/CONTRIBUTORS.md"];

const MAX_AT = 20;

/** Every `community_plot` zone of the world. */
export function communityPlots(world: World): Plot[] {
  const out: Plot[] = [];
  for (const [island, isl] of world.islands)
    for (const z of isl.zones)
      if (z.type === "community_plot")
        out.push({
          island,
          id: z.id,
          floors: [...z.floors],
          rects: z.rects.map((r) => ({ ...r })),
        });
  return out;
}

export function inPlot(plots: readonly Plot[], x: number, y: number, z: number): boolean {
  return plots.some((p) => p.floors.includes(z) && p.rects.some((r) => rectContains(r, x, y)));
}

function parse(path: string, text: string | null): { ok: boolean; value: unknown } {
  if (text === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: parsePatchFile(path, text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** Tiles an entry stands on, for the plot check (zones: every tile of every rect). */
function entryTiles(e: ListEntry): (Position | { rect: Rect; floors: number[] })[] {
  if ("center" in e) {
    // A spawn's monsters roam the whole square centre ± radius on its floor.
    const { x, y, z } = e.center;
    const r = e.radius;
    return [{ rect: { x: x - r, y: y - r, w: 2 * r + 1, h: 2 * r + 1 }, floors: [z] }];
  }
  if ("from" in e) return [e.from, e.to];
  if ("pos" in e) return [e.pos];
  return e.rects.map((rect) => ({ rect, floors: e.floors }));
}

function entryInside(plots: readonly Plot[], e: ListEntry): boolean {
  for (const t of entryTiles(e)) {
    if ("rect" in t) {
      const { rect: r, floors } = t;
      for (const z of floors)
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) if (!inPlot(plots, x, y, z)) return false;
    } else if (!inPlot(plots, t.x, t.y, t.z)) return false;
  }
  return true;
}

const isPlot = (e: ListEntry | undefined): boolean =>
  e !== undefined && "type" in e && (e as Zone).type === "community_plot";

/** What a change touches outside the plots, file by file, in input order. */
export function checkPlots(plots: readonly Plot[], files: readonly FileChange[]): PlotViolation[] {
  const out: PlotViolation[] = [];
  for (const f of files) {
    if (f.before === f.after || PLOT_FREE_FILES.includes(f.path)) continue;
    const p = patchPath(f.path);
    if (!p) {
      out.push({ kind: "file", path: f.path, reason: "not_map_file" });
      continue;
    }
    if (p.kind === "island" || p.kind === "world" || p.kind === "prefab") {
      out.push({ kind: "file", path: f.path, reason: "island_meta" });
      continue;
    }
    const a = parse(f.path, f.before);
    const b = parse(f.path, f.after);
    if (!a.ok || !b.ok) {
      out.push({ kind: "file", path: f.path, reason: "invalid" });
      continue;
    }
    if (p.kind === "chunk") {
      const at: string[] = [];
      let tiles = 0;
      for (const i of chunkChanges(a.value as Chunk | undefined, b.value as Chunk | undefined)) {
        const x = p.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const y = p.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        if (inPlot(plots, x, y, p.z)) continue;
        tiles++;
        if (at.length < MAX_AT) at.push(`${x},${y},${p.z}`);
      }
      if (tiles > 0) out.push({ kind: "tiles", path: f.path, tiles, at });
      continue;
    }
    const before = new Map(((a.value ?? []) as ListEntry[]).map((e) => [listKey(e), e]));
    const after = new Map(((b.value ?? []) as ListEntry[]).map((e) => [listKey(e), e]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const eb = before.get(key);
      const ea = after.get(key);
      if (eb !== undefined && ea !== undefined && JSON.stringify(eb) === JSON.stringify(ea))
        continue;
      const change = eb === undefined ? "added" : ea === undefined ? "removed" : "changed";
      if (isPlot(eb) || isPlot(ea))
        out.push({ kind: "entry", path: f.path, entry: key, change, reason: "plot_definition" });
      else if ((eb && !entryInside(plots, eb)) || (ea && !entryInside(plots, ea)))
        out.push({ kind: "entry", path: f.path, entry: key, change, reason: "outside_plot" });
    }
  }
  return out;
}

/** An area of one floor, in absolute tiles. */
export type FloorRect = Rect & { z: number };

/**
 * Boxes around what changed: per chunk, the bbox of its changed tiles; per changed list
 * entry, its tiles before and after (a spawn with its radius, both portal ends, zone rects).
 */
export function changeBoxes(files: readonly FileChange[]): FloorRect[] {
  const out: FloorRect[] = [];
  const entryBoxes = (e: ListEntry): FloorRect[] => {
    if ("center" in e) {
      const r = e.radius;
      return [{ x: e.center.x - r, y: e.center.y - r, w: 2 * r + 1, h: 2 * r + 1, z: e.center.z }];
    }
    if ("from" in e) return [e.from, e.to].map((q) => ({ x: q.x, y: q.y, w: 1, h: 1, z: q.z }));
    if ("pos" in e) return [{ x: e.pos.x, y: e.pos.y, w: 1, h: 1, z: e.pos.z }];
    return e.floors.flatMap((z) => e.rects.map((r) => ({ ...r, z })));
  };
  for (const f of files) {
    if (f.before === f.after) continue;
    const p = patchPath(f.path);
    if (!p || (p.kind !== "chunk" && p.kind !== "list")) continue;
    const a = parse(f.path, f.before).value;
    const b = parse(f.path, f.after).value;
    if (p.kind === "chunk") {
      const changed = chunkChanges(a as Chunk | undefined, b as Chunk | undefined);
      if (changed.length === 0) continue;
      const xs = changed.map((i) => i % CHUNK_SIZE);
      const ys = changed.map((i) => Math.floor(i / CHUNK_SIZE));
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      out.push({
        x: p.cx * CHUNK_SIZE + x0,
        y: p.cy * CHUNK_SIZE + y0,
        w: Math.max(...xs) - x0 + 1,
        h: Math.max(...ys) - y0 + 1,
        z: p.z,
      });
      continue;
    }
    const before = new Map(((a ?? []) as ListEntry[]).map((e) => [listKey(e), e]));
    const after = new Map(((b ?? []) as ListEntry[]).map((e) => [listKey(e), e]));
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const eb = before.get(key);
      const ea = after.get(key);
      if (eb !== undefined && ea !== undefined && JSON.stringify(eb) === JSON.stringify(ea))
        continue;
      for (const e of [eb, ea]) if (e) out.push(...entryBoxes(e));
    }
  }
  return out;
}

export interface RenderAreaOptions {
  /** Tiles added around each box. Default 4. */
  margin?: number;
  /** Largest side of an area, in tiles; bigger boxes are split. Default 64. */
  maxSide?: number;
  /** Most areas returned; the rest are counted in `omitted`. Default 6. */
  maxAreas?: number;
}

/** Same floor and overlapping or touching. */
const overlaps = (a: FloorRect, b: FloorRect): boolean =>
  a.z === b.z && a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

function union(a: FloorRect, b: FloorRect): FloorRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
    z: a.z,
  };
}

/**
 * The areas to render for review: every box grown by `margin` (and clipped at 0), boxes
 * that overlap or touch on the same floor merged, areas larger than `maxSide` split into tiles of
 * at most `maxSide`, sorted by floor, y and x, and capped at `maxAreas`.
 */
export function renderAreas(
  boxes: readonly FloorRect[],
  opts: RenderAreaOptions = {},
): { areas: FloorRect[]; omitted: number } {
  const margin = opts.margin ?? 4;
  const maxSide = opts.maxSide ?? 64;
  const maxAreas = opts.maxAreas ?? 6;
  let rects = boxes.map((b) => {
    const x = Math.max(0, b.x - margin);
    const y = Math.max(0, b.y - margin);
    return { x, y, w: b.x + b.w + margin - x, h: b.y + b.h + margin - y, z: b.z };
  });
  for (let merged = true; merged;) {
    merged = false;
    const next: FloorRect[] = [];
    for (const r of rects) {
      const i = next.findIndex((n) => overlaps(n, r));
      if (i < 0) next.push(r);
      else {
        next[i] = union(next[i] as FloorRect, r);
        merged = true;
      }
    }
    rects = next;
  }
  const split: FloorRect[] = [];
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y += maxSide)
      for (let x = r.x; x < r.x + r.w; x += maxSide)
        split.push({
          x,
          y,
          w: Math.min(maxSide, r.x + r.w - x),
          h: Math.min(maxSide, r.y + r.h - y),
          z: r.z,
        });
  split.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
  return { areas: split.slice(0, maxAreas), omitted: Math.max(0, split.length - maxAreas) };
}
