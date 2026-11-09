// In-memory model of world/ (docs/03-world-and-maps.md). Item references are text IDs.

export const CHUNK_SIZE = 32;
export const MAX_COORD = 65535;
export const MAX_FLOOR = 15;
export const SEA_LEVEL = 7;

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Items on one tile, bottom to top (borders, decoration, objects). Local coordinates 0–31. */
export interface ItemStack {
  x: number;
  y: number;
  stack: string[];
}

/** One 32x32 chunk of a floor. */
export interface Chunk {
  cx: number;
  cy: number;
  z: number;
  /** Row-major, CHUNK_SIZE * CHUNK_SIZE entries: ground item ID or null (no tile). */
  ground: (string | null)[];
  /** Sparse stacks, sorted by y then x, one entry per tile, never empty. */
  items: ItemStack[];
}

export interface IslandMeta {
  id: string;
  /** i18n key. */
  name: string;
  rect: Rect;
  floors: number[];
  temple: Position;
  level_hint: [number, number];
  notes?: string;
}

export interface SpawnMonster {
  monster: string;
  count: number;
}

export interface Spawn {
  id: string;
  center: Position;
  radius: number;
  monsters: SpawnMonster[];
  respawn_seconds: number;
  notes?: string;
}

export interface NpcPlacement {
  npc: string;
  pos: Position;
  notes?: string;
}

export const ZONE_TYPES = ["protection", "no_logout", "pvp", "no_pvp", "community_plot"] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export interface Zone {
  id: string;
  type: ZoneType;
  floors: number[];
  rects: Rect[];
  notes?: string;
}

export const PORTAL_KINDS = ["stairs", "ladder", "hole", "rope_spot", "teleport", "boat"] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

export interface Portal {
  id: string;
  from: Position;
  to: Position;
  kind: PortalKind;
  notes?: string;
}

export interface MapText {
  id: string;
  pos: Position;
  kind: "sign" | "book";
  /** i18n key. */
  text: string;
  notes?: string;
}

/** One rectangle of house tiles on floor z (T5.4). */
export interface HouseRect {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

/**
 * A player house (T5.4, docs/03 "Casas"): tiles a character rents. Doors are tiles of the
 * house where the outside meets it; exit is the tile outside, next to a door, where
 * whoever may not stay is put. rent is the price of one period in the smallest coin.
 */
export interface House {
  id: string;
  /** i18n key. */
  name: string;
  rent: number;
  rects: HouseRect[];
  doors: Position[];
  exit: Position;
  notes?: string;
}

/** Largest rect side, rects and doors per house (the server's world.bin limits). */
export const MAX_HOUSE_SIDE = 255;
export const MAX_HOUSE_RECTS = 16;
export const MAX_HOUSE_DOORS = 8;

export const houseContains = (h: House, p: Position): boolean =>
  h.rects.some((r) => r.z === p.z && rectContains(r, p.x, p.y));

/** Number of tiles of a house (its size). No tile is in two rects (validated). */
export const houseSize = (h: House): number => h.rects.reduce((n, r) => n + r.w * r.h, 0);

export interface Island {
  meta: IslandMeta;
  /** Keyed by chunkKey(z, cx, cy). */
  chunks: Map<string, Chunk>;
  spawns: Spawn[];
  npcs: NpcPlacement[];
  zones: Zone[];
  portals: Portal[];
  texts: MapText[];
  /** Player houses (T5.4); not editable by ops or patches: edit houses.yaml. */
  houses: House[];
}

export interface WorldIslandEntry {
  id: string;
  rect: Rect;
  level_hint: [number, number];
}

export interface WorldMeta {
  format: 1;
  islands: WorldIslandEntry[];
  /** Deprecated (T3.5): always empty; routes live in data/boat_routes.yaml. */
  boat_routes?: [];
}

export interface World {
  meta: WorldMeta;
  /** Keyed by island ID, in world.yaml order. */
  islands: Map<string, Island>;
}

export const chunkKey = (z: number, cx: number, cy: number): string => `${z}/${cx}/${cy}`;

export function emptyChunk(cx: number, cy: number, z: number): Chunk {
  return {
    cx,
    cy,
    z,
    ground: new Array<string | null>(CHUNK_SIZE * CHUNK_SIZE).fill(null),
    items: [],
  };
}

export const rectContains = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const samePos = (a: Position, b: Position): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;

export const formatPos = (p: Position): string => `${p.x},${p.y},${p.z}`;
