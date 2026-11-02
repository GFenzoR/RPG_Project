// Edit operations (docs/04-map-editor-and-ai.md, "Operaciones"). Plain JSON, so the editor,
// mapcli and the MCP server can exchange, store and replay them.
import type { PortalKind, Position, Rect, SpawnMonster, ZoneType } from "../types.ts";
import type { BorderRule } from "./borders.ts";
import type { Prefab } from "./prefab.ts";

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

/** Flood fill: repaints the 4-connected ground equal to the one at `pos` (same island). */
export interface FillOp {
  op: "fill";
  pos: Position;
  item: string;
}

/**
 * Recomputes the border pieces of every tile in `rect` from the ground around it and the
 * rules of data/borders.yaml (passed in OpOptions.borders).
 */
export interface AutoborderOp {
  op: "autoborder";
  floor: number;
  rect: Rect;
}

/**
 * Reproducible decoration: each cell of `rect` whose ground is in `on_ground` (any ground
 * when omitted) and whose stack is empty gets one of `items` with probability `density`.
 * Same seed, same map → same result.
 */
export interface ScatterOp {
  op: "scatter";
  floor: number;
  rect: Rect;
  items: string[];
  density: number;
  seed: number;
  on_ground?: string[];
}

/**
 * Entity ops take the fields of their file (spawns.yaml, zones.yaml, portals.yaml,
 * npcs.yaml). `index` places the entry at that position of the list (default: last); the
 * inverse of a remove uses it so undo restores the file byte for byte.
 */
export interface AddSpawnOp {
  op: "add_spawn";
  id: string;
  center: Position;
  radius: number;
  monsters: SpawnMonster[];
  respawn_seconds: number;
  notes?: string;
  index?: number;
}

export interface RemoveSpawnOp {
  op: "remove_spawn";
  id: string;
}

export interface AddZoneOp {
  op: "add_zone";
  id: string;
  type: ZoneType;
  floors: number[];
  rects: Rect[];
  notes?: string;
  index?: number;
}

export interface RemoveZoneOp {
  op: "remove_zone";
  id: string;
}

export interface AddPortalOp {
  op: "add_portal";
  id: string;
  kind: PortalKind;
  from: Position;
  to: Position;
  notes?: string;
  index?: number;
}

export interface RemovePortalOp {
  op: "remove_portal";
  id: string;
}

export interface PlaceNpcOp {
  op: "place_npc";
  npc: string;
  pos: Position;
  notes?: string;
  index?: number;
}

/** Removes the placement of `npc` (each NPC is placed once); `pos`, if given, must match. */
export interface RemoveNpcOp {
  op: "remove_npc";
  npc: string;
  pos?: Position;
}

/** Stamps prefab `prefab` (world/prefabs/, passed in OpOptions.prefab) with its top-left at `pos`. */
export interface StampOp {
  op: "stamp";
  pos: Position;
  prefab: string;
}

export type MapOp =
  | PaintGroundOp
  | EraseOp
  | PlaceItemOp
  | RemoveItemOp
  | FillOp
  | AutoborderOp
  | ScatterOp
  | AddSpawnOp
  | RemoveSpawnOp
  | AddZoneOp
  | RemoveZoneOp
  | AddPortalOp
  | RemovePortalOp
  | PlaceNpcOp
  | RemoveNpcOp
  | StampOp;
export type MapOpName = MapOp["op"];

export const MAP_OP_NAMES: readonly MapOpName[] = [
  "paint_ground",
  "erase",
  "place_item",
  "remove_item",
  "fill",
  "autoborder",
  "scatter",
  "add_spawn",
  "remove_spawn",
  "add_zone",
  "remove_zone",
  "add_portal",
  "remove_portal",
  "place_npc",
  "remove_npc",
  "stamp",
];

export interface OpOptions {
  /**
   * Item kind lookup (`kind` in data/items). When given, unknown items are rejected,
   * paint_ground only takes `kind: ground` items and place_item never does.
   */
  itemKind?: (id: string) => string | undefined;
  /** When given, add_spawn rejects monsters it does not know. */
  monsterKnown?: (id: string) => boolean;
  /** When given, place_npc rejects NPCs it does not know. */
  npcKnown?: (id: string) => boolean;
  /** Rules of data/borders.yaml; autoborder needs them. */
  borders?: readonly BorderRule[];
  /** Prefab lookup (world/prefabs/); stamp needs it. */
  prefab?: (id: string) => Prefab | undefined;
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
