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

export interface Island {
  meta: IslandMeta;
  /** Keyed by chunkKey(z, cx, cy). */
  chunks: Map<string, Chunk>;
  spawns: Spawn[];
  npcs: NpcPlacement[];
  zones: Zone[];
  portals: Portal[];
  texts: MapText[];
}

export interface WorldIslandEntry {
  id: string;
  rect: Rect;
  level_hint: [number, number];
}

export interface WorldMeta {
  format: 1;
  islands: WorldIslandEntry[];
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
