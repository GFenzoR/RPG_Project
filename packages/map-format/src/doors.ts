// Rooms behind locked doors (docs/02-game-design.md "Puertas con llave"). The walk is the
// server's (server/internal/session/door.go, doorRoom), step for step, so make validate
// refuses every locked door the server would not start with and both agree on every room:
// their tests share testdata/door-rooms.json.
import type { ContentIndex } from "./content.ts";
import { isPassable } from "./tiles.ts";
import type { Tile, TileMap } from "./tiles.ts";
import type { Position } from "./types.ts";

/** Tiles a walk from a door takes per side before it calls that side open ground. */
export const DOOR_ROOM_SEARCH = 4096;

/**
 * Why a locked door has no room: open (every tile around it is one side), truncated (two
 * sides or more are bigger than DOOR_ROOM_SEARCH) or tie (every side is closed and the two
 * biggest have the same size, so neither is clearly the outside).
 */
export type DoorRoomError = "open" | "truncated" | "tie";

/** The room behind a locked door, one list of tiles per side that is not the outside. */
export type DoorRoom = { rooms: Position[][] } | { error: DoorRoomError };

/** What each DoorRoomError means, for diagnostics. */
export const DOOR_ROOM_ERRORS: Record<DoorRoomError, string> = {
  open: "it keeps nothing apart: every tile around it is one side",
  truncated: `more than one side is bigger than ${DOOR_ROOM_SEARCH} tiles: no room behind it`,
  tie: "its two biggest sides have the same size: which one is the outside is unclear",
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

/**
 * The room behind the locked door at door: it walks the map from each passable tile next
 * to it (8 directions, same floor, never through a locked door, every other door open when
 * its tile lets creatures through: isPassable) to find the sides the door keeps apart, up
 * to DOOR_ROOM_SEARCH tiles each. A side the walk cannot finish is open ground, the
 * outside; when every side finishes, the biggest one is. The other sides are the room.
 */
export function doorRoom(tiles: TileMap, content: ContentIndex, door: Position): DoorRoom {
  const z = door.z;
  const passable = (x: number, y: number): boolean => {
    const t = tiles.tile(x, y, z);
    return !hasLockedDoor(t, content) && isPassable(t, content);
  };
  const doorKey = key(door.x, door.y, z);
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
  if (sides.length < 2) return { error: "open" };
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
  return { rooms: [...index.values()] };
}
