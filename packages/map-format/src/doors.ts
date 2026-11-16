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
 * Why a locked door is refused. Its own tile: blocked (something on it besides the door
 * blocks the way, so nobody gets through it even open) or portal (a portal leaves from it
 * or arrives on it). Its own room: walled (no tile
 * around it lets anyone through), open (every tile around it is one side), truncated (two
 * sides or more are bigger than DOOR_ROOM_SEARCH) or tie (every side is closed and the two
 * biggest have the same size). A room it shares with an earlier locked door: key (that
 * door has another key). The escape check, once every door has its room: escape (a side
 * of it reaches no temple without keys or tools: on foot, out of rooms through their
 * doors, by stairs, ladders, holes and teleports) or bypass (a player with every key but
 * its own gets into its room: a locked door of another key opens onto it from its own
 * room).
 */
export type DoorRoomError =
  "blocked" | "portal" | "walled" | "open" | "truncated" | "tie" | "key" | "escape" | "bypass";

/** The room behind a locked door, one list of tiles per side that is not the outside. */
export type DoorRoom = { rooms: Position[][] } | { error: DoorRoomError };

/** What each DoorRoomError means, for diagnostics (the server's words). */
export const DOOR_ROOM_ERRORS: Record<DoorRoomError, string> = {
  blocked:
    "it lets nobody through, even open: something on its tile besides the door blocks the way",
  portal:
    "a portal leaves from its tile or arrives on it: a door is no place to change floor or to land",
  walled: "it leads nowhere: no tile around it lets anyone through",
  open: "it keeps nothing apart: every tile around it is one side",
  truncated: `more than one side is bigger than ${DOOR_ROOM_SEARCH} tiles: no room behind it`,
  tie: "its two biggest sides have the same size: which one is the outside is unclear",
  key: "it shares its room with a locked door of another key",
  escape:
    "a side of it reaches no temple without keys (on foot, out of rooms, by stairs, ladders, holes and teleports): whoever is there could be locked in",
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
 * one floor) with every locked door, every house tile and every entrance of stairs, a hole
 * or a teleport as a wall (nobody stands on one: stepping onto it moves the player, so it
 * joins nothing on foot), and any other door open when its tile lets creatures through
 * (roomPassable). A room behind a locked door is one area. They are numbered as they are
 * asked for: the first areaOf of a tile walks its whole area. The numbers are not the
 * server's; the areas are.
 */
class Areas {
  /** Chunk → 1 for each tile that belongs to an area. */
  private readonly open = new Map<number, Uint8Array>();
  /** Chunk → the area of each tile, 0 while not walked. */
  private readonly ids = new Map<number, Int32Array>();
  /** Chunk → the indexes of its house tiles and portal entrances stepped onto. */
  private readonly walls = new Map<number, number[]>();
  private count = 0;
  private readonly tiles: TileMap;
  private readonly content: ContentIndex;

  /** walls: the house tiles and the entrances of stairs, holes and teleports, by x,y,z. */
  constructor(tiles: TileMap, content: ContentIndex, walls: Iterable<string>) {
    this.tiles = tiles;
    this.content = content;
    for (const h of walls) {
      const [x = -1, y = -1, z = -1] = h.split(",").map(Number);
      if (x < 0 || y < 0 || z < 0) continue;
      const c = chunkNum(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE), z);
      const list = this.walls.get(c) ?? [];
      list.push((y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE));
      this.walls.set(c, list);
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
    for (const i of this.walls.get(c) ?? []) open[i] = 0;
    this.open.set(c, open);
    this.ids.set(c, new Int32Array(CHUNK_SIZE * CHUNK_SIZE));
    return open;
  }

  /**
   * The area of tile (x, y, z), 0 for none: a wall, a locked door, a house tile, the
   * entrance of stairs, a hole or a teleport, no tile.
   */
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
  /**
   * The house tiles by x,y,z: walls of the areas (a house is no street), where an owner or
   * a guest stands (next to a locked door, it opens it with its key).
   */
  houses?: ReadonlySet<string>;
  /**
   * The world: the temples. A boat arrival is no part of it: it is a way in, not out
   * (leaving by boat takes a captain and whatever the route asks).
   */
  temples?: readonly Position[];
  /**
   * The portals of the map. The entrances of those of ON_STEP_KINDS are walls of the areas,
   * and those of ESCAPE_WAYS lead from the areas a player takes them from (a ladder: the
   * area of its tile; the others: the areas next to it and the rooms of a locked door next
   * to it) to the area of to.
   */
  portals?: readonly { kind: string; from: Position; to: Position }[];
}

/**
 * The portal kinds that lead out of an area for the escape check (the server's escapeWay):
 * those every player takes without keys, tools, money or a level. A rope spot needs a rope;
 * a boat portal moves nobody (the captain's routes need gold, a level, a quest or a ticket).
 */
export const ESCAPE_WAYS: ReadonlySet<string> = new Set(["stairs", "ladder", "hole", "teleport"]);

/**
 * Portals that move whoever steps onto their tile (docs/02 "Cambiar de piso", the server's
 * PortalKind.OnStep): nobody walks across them (a step there lands on `to`), nobody stands
 * on them.
 */
export const ON_STEP_KINDS: ReadonlySet<string> = new Set(["stairs", "hole", "teleport"]);

const posKey = (p: Position): string => `${p.x},${p.y},${p.z}`;

/**
 * The rooms behind the locked doors given in map order (chunk by chunk, row by row, like
 * the server), and the server's checks of them. First, door by door: a door nobody gets
 * through even open is refused (blocked: its room could only be left by a way the escape
 * check does not see), and so is one on an end of a portal (portal: a door placed open is
 * walkable, and stepping onto it could move a player past it from the outside once
 * someone locked it), then doorRoom, and a room shared with an earlier door of another
 * lock is refused (key). Then, when every door has
 * its room, the escape check (the server's checkEscapes) on the areas of the map: every
 * side of every door reaches a temple (world.temples) the ways a player without keys or
 * tools has (escape), and no player with every key but one gets into a room of that key
 * (bypass).
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
  const ends = new Set<string>(); // the tiles portals leave from or arrive on
  for (const p of world.portals ?? []) ends.add(posKey(p.from)).add(posKey(p.to));
  for (const { pos, lock } of doors) {
    roomsOf.push([]);
    // The server's door.through: walkable ground and no blocker on it but a door.
    if (!isPassable(tiles.tileAt(pos), content)) {
      out.findings.push({ door: pos, error: "blocked" });
      continue;
    }
    if (ends.has(posKey(pos))) {
      out.findings.push({ door: pos, error: "portal" });
      continue;
    }
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
  const areaOf = areasOf(tiles, content, world);
  const roomArea = rooms.map((r) => areaOf(r.at));
  const areaRoom = new Map<number, number>(); // area → room id, for the areas that are rooms
  for (const [i, a] of roomArea.entries()) areaRoom.set(a, i);
  const houses = world.houses ?? new Set<string>();
  const sides: { area: number; at: Position }[][] = []; // the sides of each door
  const bySide = new Map<number, number[]>(); // area → the doors (indexes) it is a side of
  const byHouse: boolean[] = []; // whether a house tile someone stands on is next to each door
  for (const [i, { pos }] of doors.entries()) {
    const list: { area: number; at: Position }[] = [];
    let house = false;
    for (const [dx, dy] of STEPS) {
      const at = { x: pos.x + dx, y: pos.y + dy, z: pos.z };
      if (at.x < 0 || at.y < 0 || at.x > MAX || at.y > MAX) continue;
      if (houses.has(posKey(at)) && roomPassable(tiles, content, at.x, at.y, at.z)) house = true;
      const a = areaOf(at);
      if (a === 0 || list.some((s) => s.area === a)) continue;
      list.push({ area: a, at });
      const by = bySide.get(a);
      if (by) by.push(i);
      else bySide.set(a, [i]);
    }
    sides.push(list);
    byHouse.push(house);
  }
  const doorAt = new Map<string, number>(); // x,y,z → the door (index) on that tile
  for (const [i, { pos }] of doors.entries()) doorAt.set(posKey(pos), i);
  const escapes = templeAreas(areaOf, world, { doorAt, roomsOf, roomArea, sides });
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
    for (const [i, list] of sides.entries()) {
      for (const s of list) if (!areaRoom.has(s.area)) push(s.area); // anywhere outside the rooms
      // From a house next to it into its room, with its key.
      if (byHouse[i] === true && doors[i]?.lock !== k)
        for (const r of roomsOf[i] ?? []) push(roomArea[r] ?? 0);
    }
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

/**
 * The area of a tile in the areas of the escape check (Areas) on world: its house tiles and
 * the entrances of its stairs, holes and teleports are walls.
 */
function areasOf(tiles: TileMap, content: ContentIndex, world: DoorWorld): (p: Position) => number {
  const stepped = (world.portals ?? [])
    .filter((p) => ON_STEP_KINDS.has(p.kind))
    .map((p) => posKey(p.from));
  const areas = new Areas(tiles, content, [...(world.houses ?? []), ...stepped]);
  return (p) => areas.areaOf(p.x, p.y, p.z);
}

/** The locked doors and their rooms, for templeAreas (escapeCheck's indexes). */
interface RoomExits {
  /** x,y,z → the door (index) on that tile. */
  doorAt: ReadonlyMap<string, number>;
  /** The room ids of each door. */
  roomsOf: readonly number[][];
  /** The area of each room, by room id. */
  roomArea: readonly number[];
  /** The areas next to each door (its sides), by door. */
  sides: readonly (readonly { area: number }[])[];
}

/**
 * The areas from which a player without keys or tools reaches a temple of world.temples
 * (the walk of the server's checkEscapes): on foot within an area, out of a room through
 * its door (rooms: a player in one opens its door without the key; without rooms, no area
 * is left that way), and by the portals of ESCAPE_WAYS, from the areas a player takes them
 * from (portalSources) to the area of their destination. It walks back from the areas of
 * the temples.
 */
function templeAreas(
  areaOf: (p: Position) => number,
  world: DoorWorld,
  rooms?: RoomExits,
): Set<number> {
  const doorAt = rooms?.doorAt ?? new Map<string, number>();
  const roomsOf = rooms?.roomsOf ?? [];
  const roomArea = rooms?.roomArea ?? [];
  // back: area → the areas a player without keys goes to it from.
  const back = new Map<number, number[]>();
  const edge = (from: number, to: number): void => {
    if (from === 0 || to === 0 || from === to) return;
    const list = back.get(to);
    if (list) list.push(from);
    else back.set(to, [from]);
  };
  for (const [i, own] of roomsOf.entries())
    for (const r of own) for (const s of rooms?.sides[i] ?? []) edge(roomArea[r] ?? 0, s.area);
  for (const p of world.portals ?? []) {
    if (!ESCAPE_WAYS.has(p.kind)) continue;
    const to = areaOf(p.to);
    for (const from of portalSources(p, areaOf, doorAt, roomsOf, roomArea)) edge(from, to);
  }
  const escapes = new Set<number>();
  const queue: number[] = [];
  for (const p of world.temples ?? []) {
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
  return escapes;
}

/** Where a player without keys or tools reaches a temple from (templeReach). */
export interface TempleReach {
  /**
   * The area of a tile in the areas of the escape check, 0 when it lies in none: a wall, a
   * locked door, a house tile, the entrance of stairs, a hole or a teleport, no tile.
   */
  areaOf(p: Position): number;
  /** The areas from which a player without keys or tools reaches a temple. */
  escapes: ReadonlySet<number>;
}

/**
 * The areas of the escape check on world, and those from which a player without keys or
 * tools reaches a temple: on foot within an area and by stairs, ladders, holes and
 * teleports (ESCAPE_WAYS; not a rope spot, not a boat). It is the escape check's walk
 * (templeAreas) without the rooms behind locked doors, which only a player already in one
 * leaves through its door: outside the rooms it finds the same areas as long as no portal
 * leads into a room (validateWorld and the server refuse one that does). make validate
 * warns of a hole or a teleport from whose destination no temple is reached
 * (checkPortalExits).
 */
export function templeReach(tiles: TileMap, content: ContentIndex, world: DoorWorld): TempleReach {
  const areaOf = areasOf(tiles, content, world);
  return { areaOf, escapes: templeAreas(areaOf, world) };
}

/**
 * The areas a player takes the portal p from (the server's portalSources): for a ladder, the
 * area of its tile (the player stands there to climb); for stairs, a hole or a teleport,
 * whose tile lies in no area (stepping onto it moves the player), the areas of the tiles
 * next to it and the rooms of a locked door next to it (a player in its room opens it
 * without the key and steps on from the door's tile; doorRooms refused every locked door
 * nobody gets through and every one on a portal's tile).
 */
function portalSources(
  p: { kind: string; from: Position },
  areaOf: (p: Position) => number,
  doorAt: ReadonlyMap<string, number>,
  roomsOf: readonly number[][],
  roomArea: readonly number[],
): number[] {
  if (!ON_STEP_KINDS.has(p.kind)) {
    const a = areaOf(p.from);
    return a === 0 ? [] : [a];
  }
  const out: number[] = [];
  const add = (a: number): void => {
    if (a !== 0 && !out.includes(a)) out.push(a);
  };
  for (const [dx, dy] of STEPS) {
    const q = { x: p.from.x + dx, y: p.from.y + dy, z: p.from.z };
    if (q.x < 0 || q.y < 0 || q.x > MAX || q.y > MAX) continue;
    add(areaOf(q));
    const d = doorAt.get(posKey(q));
    if (d !== undefined) for (const r of roomsOf[d] ?? []) add(roomArea[r] ?? 0);
  }
  return out;
}
