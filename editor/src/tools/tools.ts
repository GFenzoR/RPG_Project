// Editor tools as functions from (tool, settings, tile) to map-format ops. The tools only
// build ops; applying them, undo and validation are the same for every tool.
import { CHUNK_SIZE, chunkKey, rectContains } from "@rpg/map-format/ops";
import type { Cell, EraseLayer, MapOp, Rect, World } from "@rpg/map-format/ops";

export type ToolName = "brush" | "item" | "eraser" | "fill" | "rect" | "select";
export const TOOLS: readonly ToolName[] = ["brush", "item", "eraser", "fill", "rect", "select"];
/** Keyboard shortcut of each tool (docs/04-map-editor-and-ai.md, "Experiencia de usuario"). */
export const TOOL_KEYS: Readonly<Record<string, ToolName>> = {
  b: "brush",
  i: "item",
  e: "eraser",
  g: "fill",
  r: "rect",
  v: "select",
};
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
  if (tool === "fill") return "editor.history.fill";
  if (tool === "rect") return secondary ? "editor.history.erase" : "editor.history.rect";
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
  if (s.tool === "select" || s.tool === "rect") return []; // they act on a dragged rect
  if (s.tool === "fill") {
    if (!s.ground || !inIsland(world, x, y, z)) return [];
    return tileAt(world, x, y, z)?.ground === s.ground
      ? []
      : [{ op: "fill", pos: { x, y, z }, item: s.ground }];
  }
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

// ---- rectangles, selection and clipboard ------------------------------------------------

/** The rect spanned by two corner tiles (in any order). */
export function rectOf(a: Cell, b: Cell): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

/** Parts of `rect` inside the islands that list floor z (one rect per island). */
export function clipToIslands(world: World, rect: Rect, z: number): Rect[] {
  const out: Rect[] = [];
  for (const isl of world.islands.values()) {
    if (!isl.meta.floors.includes(z)) continue;
    const r = isl.meta.rect;
    const x0 = Math.max(rect.x, r.x);
    const y0 = Math.max(rect.y, r.y);
    const x1 = Math.min(rect.x + rect.w, r.x + r.w);
    const y1 = Math.min(rect.y + rect.h, r.y + r.h);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

/**
 * Ops for the rectangle tool over `rect`: paint the selected ground, or (secondary) erase
 * the chosen layer. The parts outside the islands are dropped.
 */
export function rectOps(world: World, s: ToolSettings, rect: Rect, secondary: boolean): MapOp[] {
  const z = s.floor;
  const parts = clipToIslands(world, rect, z);
  if (secondary) return parts.map((r) => ({ op: "erase", floor: z, rect: r, layer: s.eraseLayer }));
  if (!s.ground) return [];
  return parts.map((r) => ({ op: "paint_ground", floor: z, rect: r, item: s.ground }));
}

/** Copied tiles: row-major, `null` for a tile with no ground and no items (not pasted). */
export interface Clipboard {
  w: number;
  h: number;
  tiles: (TileView | null)[];
}

export function copyRect(world: World, z: number, rect: Rect): Clipboard {
  const tiles: (TileView | null)[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const t = tileAt(world, x, y, z);
      tiles.push(
        t && (t.ground !== null || t.stack.length > 0)
          ? { ground: t.ground, stack: [...t.stack] }
          : null,
      );
    }
  return { w: rect.w, h: rect.h, tiles };
}

/**
 * Ops that paste `clip` with its top-left at (x, y) on floor z. Each copied tile replaces
 * the ground (when it has one) and the whole item stack of its target; empty copied tiles
 * and targets outside the islands are skipped. Works on any floor.
 */
export function pasteOps(world: World, clip: Clipboard, x: number, y: number, z: number): MapOp[] {
  const grounds = new Map<string, Cell[]>();
  const clear: Cell[] = [];
  const place: MapOp[] = [];
  for (let dy = 0; dy < clip.h; dy++)
    for (let dx = 0; dx < clip.w; dx++) {
      const src = clip.tiles[dy * clip.w + dx];
      const c = { x: x + dx, y: y + dy };
      if (!src || !inIsland(world, c.x, c.y, z)) continue;
      const dst = tileAt(world, c.x, c.y, z);
      if (src.ground !== null && dst?.ground !== src.ground) {
        const list = grounds.get(src.ground);
        if (list) list.push(c);
        else grounds.set(src.ground, [c]);
      }
      const prev = dst?.stack ?? [];
      if (prev.length === src.stack.length && prev.every((v, i) => v === src.stack[i])) continue;
      if (prev.length > 0) clear.push(c);
      for (const [index, item] of src.stack.entries())
        place.push({ op: "place_item", pos: { x: c.x, y: c.y, z }, item, index });
    }
  const ops: MapOp[] = [];
  for (const [item, cells] of grounds) ops.push({ op: "paint_ground", floor: z, cells, item });
  if (clear.length > 0) ops.push({ op: "erase", floor: z, cells: clear, layer: "items" });
  return [...ops, ...place];
}

// ---- automatic autoborder ---------------------------------------------------------------

/**
 * Autoborder ops for a change whose inverse is `inverse`: the inverse lists exactly the
 * cells whose ground changed (paint_ground / erase), so the bounding box of those cells,
 * grown by one tile (the neighbours' borders depend on them) and clipped to the islands,
 * is recomputed. [] when no ground changed.
 */
export function autoborderAfter(world: World, inverse: readonly MapOp[]): MapOp[] {
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  const grow = (z: number, x0: number, y0: number, x1: number, y1: number): void => {
    const b = boxes.get(z);
    if (!b) boxes.set(z, { x0, y0, x1, y1 });
    else {
      b.x0 = Math.min(b.x0, x0);
      b.y0 = Math.min(b.y0, y0);
      b.x1 = Math.max(b.x1, x1);
      b.y1 = Math.max(b.y1, y1);
    }
  };
  for (const op of inverse) {
    if (op.op !== "paint_ground" && !(op.op === "erase" && op.layer !== "items")) continue;
    if (op.rect)
      grow(op.floor, op.rect.x, op.rect.y, op.rect.x + op.rect.w - 1, op.rect.y + op.rect.h - 1);
    for (const c of op.cells ?? []) grow(op.floor, c.x, c.y, c.x, c.y);
  }
  const out: MapOp[] = [];
  for (const [z, b] of [...boxes].sort((a, b) => a[0] - b[0])) {
    const rect = { x: b.x0 - 1, y: b.y0 - 1, w: b.x1 - b.x0 + 3, h: b.y1 - b.y0 + 3 };
    for (const r of clipToIslands(world, rect, z))
      out.push({ op: "autoborder", floor: z, rect: r });
  }
  return out;
}
