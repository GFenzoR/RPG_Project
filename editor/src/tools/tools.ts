// Editor tools as functions from (tool, settings, tile) to map-format ops. The tools only
// build ops; applying them, undo and validation are the same for every tool.
import { CHUNK_SIZE, chunkKey, rectContains } from "@rpg/map-format/ops";
import type { Cell, EraseLayer, MapOp, World } from "@rpg/map-format/ops";

export type ToolName = "brush" | "item" | "eraser";
export const TOOLS: readonly ToolName[] = ["brush", "item", "eraser"];
export const BRUSH_SIZES = [1, 3, 5] as const;
export type BrushSize = (typeof BRUSH_SIZES)[number];
export const ERASE_LAYERS: readonly EraseLayer[] = ["all", "items", "ground"];

export interface ToolSettings {
  tool: ToolName;
  floor: number;
  /** Ground item painted by the brush. */
  ground: string;
  /** Item placed by the item tool. */
  item: string;
  brushSize: BrushSize;
  eraseLayer: EraseLayer;
}

/** i18n key of the history label for an edit made with `tool`. */
export function historyLabel(tool: ToolName, secondary: boolean): string {
  if (tool === "brush") return "editor.history.paint";
  if (tool === "eraser") return "editor.history.erase";
  return secondary ? "editor.history.remove" : "editor.history.place";
}

/** The square of cells a brush of `size` covers around (x, y). */
export function brushCells(x: number, y: number, size: number): Cell[] {
  const r = Math.floor(size / 2);
  const out: Cell[] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) out.push({ x: x + dx, y: y + dy });
  return out;
}

/** Whether (x, y, z) is inside an island rectangle and on one of its floors. */
export function inIsland(world: World, x: number, y: number, z: number): boolean {
  for (const isl of world.islands.values())
    if (rectContains(isl.meta.rect, x, y) && isl.meta.floors.includes(z)) return true;
  return false;
}

export interface TileView {
  ground: string | null;
  stack: string[];
}

export function tileAt(world: World, x: number, y: number, z: number): TileView | undefined {
  if (x < 0 || y < 0) return undefined;
  const key = chunkKey(z, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
  for (const isl of world.islands.values()) {
    const c = isl.chunks.get(key);
    if (!c) continue;
    const lx = x % CHUNK_SIZE;
    const ly = y % CHUNK_SIZE;
    return {
      ground: c.ground[ly * CHUNK_SIZE + lx] ?? null,
      stack: c.items.find((s) => s.x === lx && s.y === ly)?.stack ?? [],
    };
  }
  return undefined;
}

/**
 * Ops for using the tool on tile (x, y). `secondary` is right-click / Shift+click: with the
 * item tool it removes the top item. Cells outside the islands are dropped, so a brush at
 * the coast paints what it can instead of failing. Returns [] when there is nothing to do.
 */
export function toolOps(
  world: World,
  s: ToolSettings,
  x: number,
  y: number,
  secondary: boolean,
): MapOp[] {
  const z = s.floor;
  if (s.tool === "item") {
    if (!inIsland(world, x, y, z)) return [];
    if (!secondary) return s.item ? [{ op: "place_item", pos: { x, y, z }, item: s.item }] : [];
    const top = tileAt(world, x, y, z)?.stack.at(-1);
    return top ? [{ op: "remove_item", pos: { x, y, z }, item: top }] : [];
  }
  const cells = brushCells(x, y, s.brushSize).filter((c) => inIsland(world, c.x, c.y, z));
  if (cells.length === 0) return [];
  if (s.tool === "brush") {
    if (!s.ground) return [];
    const todo = cells.filter((c) => tileAt(world, c.x, c.y, z)?.ground !== s.ground);
    return todo.length > 0 ? [{ op: "paint_ground", floor: z, cells: todo, item: s.ground }] : [];
  }
  const todo = cells.filter((c) => {
    const t = tileAt(world, c.x, c.y, z);
    if (!t) return false;
    if (s.eraseLayer === "ground") return t.ground !== null;
    if (s.eraseLayer === "items") return t.stack.length > 0;
    return t.ground !== null || t.stack.length > 0;
  });
  return todo.length > 0 ? [{ op: "erase", floor: z, cells: todo, layer: s.eraseLayer }] : [];
}

/** Tiles on the line from a to b (Bresenham), so a fast drag does not skip tiles. */
export function line(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push({ x, y });
    if (x === b.x && y === b.y) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}
