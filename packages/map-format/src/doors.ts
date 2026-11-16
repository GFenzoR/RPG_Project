// Rooms behind locked doors (docs/02-game-design.md "Puertas con llave"). The walks and the
// escape check are the server's (server/internal/session/door.go: doorRoom, initDoors and
// checkEscapes; area.go: the areas), step for step, so make validate refuses every locked
// door the server would not start with and both agree on every room: their tests share
// testdata/door-rooms.json.
import type { ContentIndex } from "./content.ts";
import { isPassable } from "./tiles.ts";
import type { Tile, TileMap } from "./tiles.ts";
import { CHUNK_SIZE } from "./types.ts";
import type { Position } from "./types.ts";

/** Tiles a walk from a door takes per side before it calls that side open ground. */
export const DOOR_ROOM_SEARCH = 4096;

/**
 * Why a locked door is refused. Its own room: walled (no tile around it lets anyone
 * through), open (every tile around it is one side), truncated (two sides or more are
 * bigger than DOOR_ROOM_SEARCH) or tie (every side is closed and the two biggest have the
 * same size). A room it shares with an earlier locked door: key (that door has another
 * key). The escape check, once every door has its room: escape (a side of it reaches no
 * temple and no boat arrival without keys: on foot, out of rooms through their doors, by
 * portals) or bypass (a player with every key but its own gets into its room: a locked
 * door of another key opens onto it from its own room).
 */
export type DoorRoomError = "walled" | "open" | "truncated" | "tie" | "key" | "escape" | "bypass";

/** The room behind a locked door, one list of tiles per side that is not the outside. */
export type DoorRoom = { rooms: Position[][] } | { error: DoorRoomError };

/** What each DoorRoomError means, for diagnostics (the server's words). */
export const DOOR_ROOM_ERRORS: Record<DoorRoomError, string> = {
  walled: "it leads nowhere: no tile around it lets anyone through",
  open: "it keeps nothing apart: every tile around it is one side",
  truncated: `more than one side is bigger than ${DOOR_ROOM_SEARCH} tiles: no room behind it`,
  tie: "its two biggest sides have the same size: which one is the outside is unclear",
  key: "it shares its room with a locked door of another key",
  escape:
    "a side of it reaches no temple and no boat arrival without keys (on foot, out of rooms, by portals): whoever is there could be locked in",
  bypass:
    "a player without its key gets into its room: a locked door of another key opens onto it from a room such a player reaches",
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
  return { rooms: [...index.values()] };
}

/** A chunk by number: (z, cy, cx), each chunk coordinate below 65536 / CHUNK_SIZE. */
const CHUNKS_PER_ROW = 65536 / CHUNK_SIZE;
const chunkNum = (cx: number, cy: number, z: number): number =>
  (z * CHUNKS_PER_ROW + cy) * CHUNKS_PER_ROW + cx;

/**
 * The areas of the escape check (the server's area.go): tiles joined on foot (8 directions,
 * one floor) with every locked door and every house tile as a wall and any other door open
 * when its tile lets creatures through (roomPassable). A room behind a locked door is one
 * area. They are numbered as they are asked for: the first areaOf of a tile walks its
 * whole area. The numbers are not the server's; the areas are.
 */
class Areas {
  /** Chunk → 1 for each tile that belongs to an area. */
  private readonly open = new Map<number, Uint8Array>();
  /** Chunk → the area of each tile, 0 while not walked. */
  private readonly ids = new Map<number, Int32Array>();
  /** Chunk → the indexes of its house tiles. */
  private readonly houses = new Map<number, number[]>();
  private count = 0;
  private readonly tiles: TileMap;
  private readonly content: ContentIndex;

  constructor(tiles: TileMap, content: ContentIndex, houses: ReadonlySet<string>) {
    this.tiles = tiles;
    this.content = content;
    for (const h of houses) {
      const [x = -1, y = -1, z = -1] = h.split(",").map(Number);
      if (x < 0 || y < 0 || z < 0) continue;
      const c = chunkNum(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), z);
      const list = this.houses.get(c) ?? [];
      list.push((y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE));
      this.houses.set(c, list);
    }
  }

  /** The tiles of chunk (cx, cy, z) that belong to an area, or undefined for no chunk. */
  private openOf(cx: number, cy: number, z: number): Uint8Array | undefined {
    const c = chunkNum(cx, cy, z);
    const known = this.open.get(c);
    if (known) return known;
    const chunk = this.tiles.chunkAt(cx * CHUNK_SIZE, cy * CHUNK_SIZE, z);
    if (!chunk) return undefined;
    const open = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    for (let i = 0; i < open.length; i++) {
      const g = chunk.ground[i];
      open[i] = g != null && this.content.items.get(g)?.walkable === true ? 1 : 0;
    }
    for (const s of chunk.items) {
      const shut = s.stack.some((id) => {
        const info = this.content.items.get(id);
        // roomPassable: a locked door is a wall, any other blocker but a door too.
        return info?.lock !== undefined || (info?.blocksMovement === true && info.door !== true);
      });
      if (shut) open[s.y * CHUNK_SIZE + s.x] = 0;
    }
    for (const i of this.houses.get(c) ?? []) open[i] = 0;
    this.open.set(c, open);
    this.ids.set(c, new Int32Array(CHUNK_SIZE * CHUNK_SIZE));
    return open;
  }

  /** The area of tile (x, y, z), 0 for none: a wall, a locked door, a house tile, no tile. */
  areaOf(x: number, y: number, z: number): number {
    const at = this.slot(x, y, z);
    if (!at) return 0;
    const [ids, i] = at;
    const known = ids[i] ?? 0;
    if (known !== 0) return known;
    const id = ++this.count;
    ids[i] = id;
    const stack: number[] = [x, y];
    while (stack.length > 0) {
      const ty = stack.pop() as number;
      const tx = stack.pop() as number;
      for (const [dx, dy] of STEPS) {
        const q = this.slot(tx + dx, ty + dy, z);
        if (q && (q[0][q[1]] ?? 0) === 0) {
          q[0][q[1]] = id;
          stack.push(tx + dx, ty + dy);
        }
      }
    }
    return id;
  }

  /** The area array and index of tile (x, y, z) when it belongs to an area. */
  private slot(x: number, y: number, z: number): [Int32Array, number] | undefined {
    if (x < 0 || y < 0 || x > MAX || y > MAX) return undefined;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const open = this.openOf(cx, cy, z);
    const i = (y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE);
    const ids = this.ids.get(chunkNum(cx, cy, z));
    return open?.[i] === 1 && ids ? [ids, i] : undefined;
  }
}

/** A locked door refused by doorRooms. */
export interface DoorRoomFinding {
  door: Position;
  error: DoorRoomError;
  /**
   * key: the earlier door whose room it shares. bypass: the locked door of another key
   * that opens onto its room from its own room.
   */
  other?: Position;
  /** escape: the first tile next to the door (direction order) on the side that leads nowhere. */
  side?: Position;
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

/** What the escape check needs of the world besides its tiles (doorRooms). */
export interface DoorWorld {
  /** The house tiles by x,y,z: walls of the areas (a house is no street). */
  houses?: ReadonlySet<string>;
  /** The world: where a player always gets to, the temples and the boat arrivals. */
  starts?: readonly Position[];
  /** The portals that move a player (no boats): from the area of from to that of to. */
  portals?: readonly { from: Position; to: Position }[];
}

const posKey = (p: Position): string => `${p.x},${p.y},${p.z}`;

/**
 * The rooms behind the locked doors given in map order (chunk by chunk, row by row, like
 * the server), and the server's checks of them. First, door by door: doorRoom, and a room
 * shared with an earlier door of another lock is refused (key). Then, when every door has
 * its room, the escape check (the server's checkEscapes) on the areas of the map: every
 * side of every door reaches the world (world.starts) the ways a player without keys has
 * (escape), and no player with every key but one gets into a room of that key (bypass).
 * The server stops at its first refused door; this goes on and reports every door refused
 * by the same step (the first step that refuses one), and indexes a door's rooms only when
 * every side of it passed, so a refused door leaves no room behind that would refuse a
 * later one the server never sees.
 */
export function doorRooms(
  tiles: TileMap,
  content: ContentIndex,
  doors: { pos: Position; lock: string }[],
  world: DoorWorld = {},
): DoorRooms {
  const roomOf = new Map<number, number>(); // tile → room id
  const rooms: { door: Position; lock: string; at: Position }[] = [];
  const roomsOf: number[][] = []; // the room ids of each door, in the order given
  const out: DoorRooms = { behind: new Map(), sizes: new Map(), findings: [] };
  for (const { pos, lock } of doors) {
    roomsOf.push([]);
    const r = doorRoom(tiles, content, pos);
    if ("error" in r) {
      out.findings.push({ door: pos, error: r.error });
      continue;
    }
    let finding: DoorRoomFinding | undefined;
    for (const tilesOfSide of r.rooms) {
      const first = tilesOfSide[0];
      const id = first ? roomOf.get(keyOf(first)) : undefined;
      const owner = id === undefined ? undefined : rooms[id];
      if (owner && owner.lock !== lock) {
        finding = { door: pos, error: "key", other: owner.door };
        break;
      }
    }
    if (finding) {
      out.findings.push(finding);
      continue;
    }
    const own = roomsOf.at(-1) as number[];
    for (const tilesOfSide of r.rooms) {
      const first = tilesOfSide[0];
      if (!first) continue;
      const known = roomOf.get(keyOf(first));
      if (known !== undefined) {
        own.push(known);
        continue;
      }
      const room = rooms.length;
      rooms.push({ door: pos, lock, at: first });
      own.push(room);
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
  if (out.findings.length === 0 && doors.length > 0)
    out.findings.push(...escapeCheck(tiles, content, doors, rooms, roomsOf, world));
  return out;
}

/**
 * The server's checkEscapes on the doors of doorRooms (all with their rooms): the escape
 * findings, door by door (the first side that leads nowhere), or else the bypass ones.
 */
function escapeCheck(
  tiles: TileMap,
  content: ContentIndex,
  doors: { pos: Position; lock: string }[],
  rooms: { door: Position; lock: string; at: Position }[],
  roomsOf: number[][],
  world: DoorWorld,
): DoorRoomFinding[] {
  const areas = new Areas(tiles, content, world.houses ?? new Set());
  const areaOf = (p: Position): number => areas.areaOf(p.x, p.y, p.z);
  const roomArea = rooms.map((r) => areaOf(r.at));
  const areaRoom = new Map<number, number>(); // area → room id, for the areas that are rooms
  for (const [i, a] of roomArea.entries()) areaRoom.set(a, i);
  const sides: { area: number; at: Position }[][] = []; // the sides of each door
  const bySide = new Map<number, number[]>(); // area → the doors (indexes) it is a side of
  for (const [i, { pos }] of doors.entries()) {
    const list: { area: number; at: Position }[] = [];
    for (const [dx, dy] of STEPS) {
      const at = { x: pos.x + dx, y: pos.y + dy, z: pos.z };
      const a = areaOf(at);
      if (a === 0 || list.some((s) => s.area === a)) continue;
      list.push({ area: a, at });
      bySide.set(a, [...(bySide.get(a) ?? []), i]);
    }
    sides.push(list);
  }
  // back: area → the areas a player without keys goes to it from.
  const back = new Map<number, number[]>();
  const edge = (from: number, to: number): void => {
    if (from !== 0 && to !== 0 && from !== to) back.set(to, [...(back.get(to) ?? []), from]);
  };
  for (const [i, own] of roomsOf.entries())
    for (const r of own) for (const s of sides[i] ?? []) edge(roomArea[r] ?? 0, s.area);
  for (const p of world.portals ?? []) edge(areaOf(p.from), areaOf(p.to));
  const escapes = new Set<number>();
  const queue: number[] = [];
  for (const p of world.starts ?? []) {
    const a = areaOf(p);
    if (a !== 0 && !escapes.has(a)) {
      escapes.add(a);
      queue.push(a);
    }
  }
  for (let n = 0; n < queue.length; n++)
    for (const a of back.get(queue[n] ?? 0) ?? [])
      if (!escapes.has(a)) {
        escapes.add(a);
        queue.push(a);
      }
  const findings: DoorRoomFinding[] = [];
  for (const [i, { pos }] of doors.entries()) {
    const stuck = sides[i]?.find((s) => !escapes.has(s.area));
    if (stuck) findings.push({ door: pos, error: "escape", side: stuck.at });
  }
  if (findings.length > 0) return findings;

  // without(k): the areas a player with every key but k reaches (cached by key).
  const cache = new Map<string, Set<number>>();
  const without = (k: string): Set<number> => {
    const known = cache.get(k);
    if (known) return known;
    const seen = new Set<number>();
    const todo: number[] = [];
    const push = (a: number): void => {
      if (!seen.has(a)) {
        seen.add(a);
        todo.push(a);
      }
    };
    for (const list of sides) for (const s of list) if (!areaRoom.has(s.area)) push(s.area);
    for (let n = 0; n < todo.length; n++) {
      const a = todo[n] ?? 0;
      for (const i of bySide.get(a) ?? []) {
        const own = roomsOf[i] ?? [];
        const room = areaRoom.get(a);
        if (room !== undefined && own.includes(room))
          for (const s of sides[i] ?? []) push(s.area); // out of its room, without the key
        else if (doors[i]?.lock !== k) for (const r of own) push(roomArea[r] ?? 0); // with its key
      }
    }
    cache.set(k, seen);
    return seen;
  };
  for (const [i, g] of doors.entries()) {
    const own = roomsOf[i] ?? [];
    for (const s of sides[i] ?? []) {
      const r = areaRoom.get(s.area);
      if (r === undefined || own.includes(r)) continue;
      const room = rooms[r];
      if (!room || room.lock === g.lock) continue;
      const seen = without(room.lock);
      if (own.some((o) => seen.has(roomArea[o] ?? 0))) {
        findings.push({ door: room.door, error: "bypass", other: g.pos });
        break;
      }
    }
  }
  return findings;
}
