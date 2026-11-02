// Edit operations (docs/04-map-editor-and-ai.md, "Operaciones"). Plain JSON, so the editor,
// mapcli and the MCP server can exchange, store and replay them.
import type { Position, Rect } from "../types.ts";

/** A tile of one floor, in global coordinates. */
export interface Cell {
  x: number;
  y: number;
}

export type EraseLayer = "ground" | "items" | "all";

/** Sets the ground of every cell (rect and/or cells) on `floor` to `item`. */
export interface PaintGroundOp {
  op: "paint_ground";
  floor: number;
  rect?: Rect;
  cells?: Cell[];
  item: string;
}

/** Clears the ground, the item stacks, or both, of every cell (rect and/or cells). */
export interface EraseOp {
  op: "erase";
  floor: number;
  rect?: Rect;
  cells?: Cell[];
  layer: EraseLayer;
}

/** Inserts `item` in the tile's stack at `index` (0 = bottom), or on top when omitted. */
export interface PlaceItemOp {
  op: "place_item";
  pos: Position;
  item: string;
  index?: number;
}

/**
 * Removes `item` from the tile's stack: the one at `index` when given (it must be that
 * item), otherwise the topmost occurrence.
 */
export interface RemoveItemOp {
  op: "remove_item";
  pos: Position;
  item: string;
  index?: number;
}

export type MapOp = PaintGroundOp | EraseOp | PlaceItemOp | RemoveItemOp;
export type MapOpName = MapOp["op"];

export const MAP_OP_NAMES: readonly MapOpName[] = [
  "paint_ground",
  "erase",
  "place_item",
  "remove_item",
];

export interface OpOptions {
  /**
   * Item kind lookup (`kind` in data/items). When given, unknown items are rejected,
   * paint_ground only takes `kind: ground` items and place_item never does.
   */
  itemKind?: (id: string) => string | undefined;
}

/** Why an op list could not be applied; nothing was applied. */
export class OpError extends Error {
  /** Index of the failing op in the list. */
  readonly index: number;
  constructor(index: number, message: string) {
    super(`op ${index}: ${message}`);
    this.name = "OpError";
    this.index = index;
  }
}
