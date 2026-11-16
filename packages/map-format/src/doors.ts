// Rooms behind locked doors (docs/02-game-design.md "Puertas con llave"). The walks are the
// server's (server/internal/session/door.go: doorRoom, sameOutside and initDoors), step
// for step, so make validate refuses every locked door the server would not start with
// and both agree on every room: their tests share testdata/door-rooms.json.
import type { ContentIndex } from "./content.ts";
import { isPassable } from "./tiles.ts";
import type { Tile, TileMap } from "./tiles.ts";
import type { Position } from "./types.ts";

/** Tiles a walk from a door takes per side before it calls that side open ground. */
export const DOOR_ROOM_SEARCH = 4096;

/**
 * Tiles the walk between the outsides of two doors that share a room explores at most
 * (not steps: in open ground it explores this many within some 60 to 90 tiles).
 */
export const SAME_OUTSIDE_SEARCH = 4 * DOOR_ROOM_SEARCH;

/**
 * Why a locked door is refused. Its own room: walled (no tile around it lets anyone
 * through), open (every tile around it is one side), truncated (two sides or more are
 * bigger than DOOR_ROOM_SEARCH) or tie (every side is closed and the two biggest have the
 * same size). A room it shares with an earlier locked door: key (that door has another
 * key), outside (the walk from that door's outside explored all it could reach without
 * finding its own: they meet only through another locked door, a vault no door guards or
 * a cycle of locked doors, or not at all) or far (the walk stopped at
 * SAME_OUTSIDE_SEARCH explored tiles).
 */
export type DoorRoomError = "walled" | "open" | "truncated" | "tie" | "key" | "outside" | "far";

/**
 * The room behind a locked door, one list of tiles per side that is not the outside, and
 * the tiles next to the door on its outside (in the server's direction order).
 */
export type DoorRoom = { rooms: Position[][]; outside: Position[] } | { error: DoorRoomError };

/** What each DoorRoomError means, for diagnostics (the server's words). */
export const DOOR_ROOM_ERRORS: Record<DoorRoomError, string> = {
  walled: "it leads nowhere: no tile around it lets anyone through",
  open: "it keeps nothing apart: every tile around it is one side",
  truncated: `more than one side is bigger than ${DOOR_ROOM_SEARCH} tiles: no room behind it`,
  tie: "its two biggest sides have the same size: which one is the outside is unclear",
  key: "it shares its room with a locked door of another key",
  outside:
    "it shares its room with a locked door whose outside meets its own only through another locked door, if at all (a vault no door guards, or a cycle of locked doors, refused for now)",
  far: `it shares its room with a locked door whose outside a walk of ${SAME_OUTSIDE_SEARCH} explored tiles (some 60 to 90 tiles away in open ground) does not reach`,
};

/** The 8 steps in the server's order (world.North, clockwise; y grows southwards). */
const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** The door items of a tile (items with a door block), bottom to top. */
export function doorsOn(tile: Pick<Tile, "stack"> | undefined, content: ContentIndex): string[] {
  return (tile?.stack ?? []).filter((id) => content.items.get(id)?.door === true);
}

/** Whether the tile holds a locked door, closed or open. */
export function hasLockedDoor(
  tile: Pick<Tile, "stack"> | undefined,
  content: ContentIndex,
): boolean {
  return (tile?.stack ?? []).some((id) => content.items.get(id)?.lock !== undefined);
}

const MAX = 0xffff;
const key = (x: number, y: number, z: number): number => (z * 65536 + y) * 65536 + x;
const keyOf = (p: Position): number => key(p.x, p.y, p.z);

/**
 * Whether the walks of the rooms go through tile (x, y, z): never through a locked door;
 * any other door is open if its tile lets creatures through (isPassable).
 */
function roomPassable(tiles: TileMap, content: ContentIndex, x: number, y: number, z: number) {
  const t = tiles.tile(x, y, z);
  return !hasLockedDoor(t, content) && isPassable(t, content);
}

/**
 * The room behind the locked door at door: it walks the map from each passable tile next
 * to it (8 directions, same floor, roomPassable) to find the sides the door keeps apart, up
 * to DOOR_ROOM_SEARCH tiles each. A side the walk cannot finish is open ground, the
 * outside; when every side finishes, the biggest one is. The other sides are the room.
 */
export function doorRoom(tiles: TileMap, content: ContentIndex, door: Position): DoorRoom {
  const z = door.z;
  const passable = (x: number, y: number): boolean => roomPassable(tiles, content, x, y, z);
  const doorKey = keyOf(door);
  const side = new Map<number, number>(); // walked tile → the walk that reached it first
  const size: number[] = []; // tiles of each walk; -1 when it could not finish
  const parent: number[] = []; // union-find over walks that met (the same side)
  const root = (i: number): number => {
    let r = i;
    let p = parent[r] ?? r;
    while (p !== r) {
      const up = parent[p] ?? p; // path halving, like the server
      parent[r] = up;
      r = up;
      p = parent[r] ?? r;
    }
    return r;
  };
  for (const [dx, dy] of STEPS) {
    const sx = door.x + dx;
    const sy = door.y + dy;
    if (sx < 0 || sy < 0 || sx > MAX || sy > MAX) continue;
    const start = key(sx, sy, z);
    if (side.has(start) || !passable(sx, sy)) continue;
    const id = size.length;
    parent.push(id);
    side.set(start, id);
    let n = 0;
    const queue: [number, number][] = [[sx, sy]];
    while (queue.length > 0 && n < DOOR_ROOM_SEARCH) {
      const [tx, ty] = queue.pop() as [number, number];
      n++;
      for (const [ex, ey] of STEPS) {
        const qx = tx + ex;
        const qy = ty + ey;
        if (qx < 0 || qy < 0 || qx > MAX || qy > MAX) continue;
        const q = key(qx, qy, z);
        if (q === doorKey) continue;
        const other = side.get(q);
        if (other !== undefined) {
          const a = root(id);
          const b = root(other);
          if (a !== b) parent[b] = a; // an earlier walk of this same side
          continue;
        }
        if (passable(qx, qy)) {
          side.set(q, id);
          queue.push([qx, qy]);
        }
      }
    }
    size.push(queue.length > 0 ? -1 : n);
  }
  // Merge the walks into sides: open if any walk of it could not finish.
  const total = new Map<number, number>();
  const sides: number[] = []; // roots, in the order of the first walk of each side
  for (const [i, n] of size.entries()) {
    const r = root(i);
    const t = total.get(r);
    if (t === undefined) sides.push(r);
    total.set(r, n < 0 || (t ?? 0) < 0 ? -1 : (t ?? 0) + n);
  }
  const tilesOf = (r: number): number => total.get(r) ?? 0;
  if (sides.length === 0) return { error: "walled" };
  if (sides.length === 1) return { error: "open" };
  let outside = -1;
  let open = 0;
  for (const r of sides)
    if (tilesOf(r) < 0) {
      outside = r;
      open++;
    }
  if (open > 1) return { error: "truncated" };
  if (open === 0) {
    outside = sides[0] ?? -1;
    for (const r of sides.slice(1)) if (tilesOf(r) > tilesOf(outside)) outside = r;
    for (const r of sides)
      if (r !== outside && tilesOf(r) === tilesOf(outside)) return { error: "tie" };
  }
  const index = new Map<number, Position[]>();
  for (const r of sides) if (r !== outside) index.set(r, []);
  for (const [k, s] of side) {
    const list = index.get(root(s));
    if (list) list.push({ x: k % 65536, y: Math.floor(k / 65536) % 65536, z });
  }
  const out: Position[] = [];
  for (const [dx, dy] of STEPS) {
    const x = door.x + dx;
    const y = door.y + dy;
    if (x < 0 || y < 0 || x > MAX || y > MAX) continue;
    const s = side.get(key(x, y, z));
    if (s !== undefined && root(s) === outside) out.push({ x, y, z });
  }
  return { rooms: [...index.values()], outside: out };
}

/**
 * Whether the outsides of two locked doors that share a room are one area: a walk from
 * the tiles next to the first door on its outside (a; breadth first, 8 directions,
 * roomPassable, never through a house tile of houses, by x,y,z: a house is no street)
 * reaches one next to the second door on its outside (b) within SAME_OUTSIDE_SEARCH
 * explored tiles. "ok", or why not: outside (the walk explored all it could reach) or far
 * (it stopped at its bound).
 */
export function sameOutside(
  tiles: TileMap,
  content: ContentIndex,
  a: Position[],
  b: Position[],
  houses: ReadonlySet<string> = new Set(),
): "ok" | "outside" | "far" {
  const seen = new Set(a.map(keyOf));
  const targets = new Set(b.map(keyOf));
  for (const t of targets) if (seen.has(t)) return "ok";
  const queue = [...a];
  let i = 0;
  for (; i < queue.length && i < SAME_OUTSIDE_SEARCH; i++) {
    const t = queue[i] as Position;
    for (const [dx, dy] of STEPS) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (x < 0 || y < 0 || x > MAX || y > MAX) continue;
      const q = key(x, y, t.z);
      if (seen.has(q) || !roomPassable(tiles, content, x, y, t.z)) continue;
      if (houses.has(`${x},${y},${t.z}`)) continue;
      if (targets.has(q)) return "ok";
      seen.add(q);
      queue.push({ x, y, z: t.z });
    }
  }
  return i < queue.length ? "far" : "outside";
}

/** A locked door refused by doorRooms, and the earlier door whose room it shares. */
export interface DoorRoomFinding {
  door: Position;
  error: DoorRoomError;
  other?: Position;
}

/** The rooms behind a list of locked doors (doorRooms). */
export interface DoorRooms {
  /** Room tile (x,y,z) → the first locked door, in the given order, the room is behind. */
  behind: Map<string, Position>;
  /** Tiles behind each accepted door, by its x,y,z. */
  sizes: Map<string, number>;
  /** The refused doors, in the given order: one finding each. */
  findings: DoorRoomFinding[];
}

const posKey = (p: Position): string => `${p.x},${p.y},${p.z}`;

/**
 * The rooms behind the locked doors given in map order (chunk by chunk, row by row, like
 * the server): doorRoom for each, and a room shared with an earlier door is refused when
 * that door has another lock or another outside (sameOutside, with houses: the house
 * tiles by x,y,z). The server stops at its first refused door; this goes on and reports
 * every one, and indexes a door's rooms only when every side of it passed, so a refused
 * door leaves no room behind that would refuse a later one the server never sees.
 */
export function doorRooms(
  tiles: TileMap,
  content: ContentIndex,
  doors: { pos: Position; lock: string }[],
  houses: ReadonlySet<string> = new Set(),
): DoorRooms {
  const roomOf = new Map<number, number>(); // tile → room id
  const rooms: { door: Position; lock: string }[] = [];
  const outsides = new Map<string, Position[]>();
  const out: DoorRooms = { behind: new Map(), sizes: new Map(), findings: [] };
  for (const { pos, lock } of doors) {
    const r = doorRoom(tiles, content, pos);
    if ("error" in r) {
      out.findings.push({ door: pos, error: r.error });
      continue;
    }
    outsides.set(posKey(pos), r.outside);
    let finding: DoorRoomFinding | undefined;
    for (const tilesOfSide of r.rooms) {
      const first = tilesOfSide[0];
      const id = first ? roomOf.get(keyOf(first)) : undefined;
      const owner = id === undefined ? undefined : rooms[id];
      if (!owner) continue; // a new room: indexed below, once every side passed
      const error =
        owner.lock !== lock
          ? "key"
          : sameOutside(tiles, content, outsides.get(posKey(owner.door)) ?? [], r.outside, houses);
      if (error !== "ok") {
        finding = { door: pos, error, other: owner.door };
        break;
      }
    }
    if (finding) {
      out.findings.push(finding);
      continue;
    }
    for (const tilesOfSide of r.rooms) {
      const first = tilesOfSide[0];
      if (!first || roomOf.has(keyOf(first))) continue;
      const room = rooms.length;
      rooms.push({ door: pos, lock });
      for (const t of tilesOfSide) {
        roomOf.set(keyOf(t), room);
        out.behind.set(posKey(t), pos);
      }
    }
    out.sizes.set(
      posKey(pos),
      r.rooms.reduce((n, side) => n + side.length, 0),
    );
  }
  return out;
}
