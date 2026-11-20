import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import type { ContentIndex, ItemInfo } from "./content.ts";
import { doorRoom, doorRooms } from "./doors.ts";
import type { DoorRoomError, DoorWorld } from "./doors.ts";
import { TileMap } from "./tiles.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "./types.ts";
import type { Chunk, Island, Position } from "./types.ts";

// The cases the server reads too (server/internal/session, TestDoorRoomsFixture): both
// sides agree on every room and on every locked door they refuse.
type Row = string | { repeat: number; row?: string; rows?: string[] };
interface Case {
  name: string;
  rows: Row[];
  portals?: { kind: string; from: string; to: string }[];
  houses?: { rect: string; door: string; exit: string }[];
  rooms?: Record<string, number>;
  error?: DoorRoomError;
  door?: string;
}
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "testdata", "door-rooms.json"), "utf8"),
) as { cases: Case[] };

const item = (id: string, info: Partial<ItemInfo>): [string, ItemInfo] => [
  id,
  { id, kind: "decoration", blocksMovement: false, ...info },
];

/** The drawings' items: what the walks look at (ground, blockers, doors and locks). */
const content: ContentIndex = {
  items: new Map([
    item("grass", { kind: "ground", walkable: true }),
    item("wall", { kind: "wall", blocksMovement: true }),
    item("gate", { blocksMovement: true, door: true, lock: "gate" }),
    item("gate_open", { door: true, lock: "gate", doorOpen: true }),
    item("other_gate", { blocksMovement: true, door: true, lock: "other" }),
    item("plain", { blocksMovement: true, door: true }),
    item("plain_open", { door: true, doorOpen: true }),
  ]),
  monsters: new Set(),
  npcs: new Set(),
  i18n: new Map(),
  borders: { ladder: [] },
  routes: [],
};

const STACKS: Record<string, string[]> = {
  ".": [],
  T: [],
  "#": ["wall"],
  D: ["gate"],
  d: ["gate_open"],
  K: ["other_gate"],
  P: ["plain"],
  X: ["wall", "plain"],
  B: ["wall", "gate"],
};

/** The rows of a drawing, its repeats expanded. */
const expand = (rows: Row[]): string[] =>
  rows.flatMap((r) =>
    typeof r === "string"
      ? [r]
      : Array.from({ length: r.repeat }, () => r.rows ?? [r.row ?? ""]).flat(),
  );

/** A tile "x,y" of floor 7 of the fixture. */
function at(xy: string): Position {
  const [x = NaN, y = NaN] = xy.split(",").map(Number);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`bad tile ${xy}`);
  return { x, y, z: 7 };
}

/**
 * The tiles of a drawing on floor 7 from (0,0), its locked doors in map order (chunk by
 * chunk, row by row: the server's order) and what the escape check needs: the temple (its
 * T, else the first tile of . T d P K row by row, as server worldtest draws it), the
 * portals and the house tiles.
 */
function draw(c: Case): {
  tiles: TileMap;
  locked: { pos: Position; lock: string }[];
  world: DoorWorld;
} {
  const chunks = new Map<string, Chunk>();
  const locked: { pos: Position; lock: string }[] = [];
  let temple: Position | undefined;
  let first: Position | undefined;
  for (const [y, row] of expand(c.rows).entries())
    for (const [x, ch] of [...row].entries()) {
      if (ch === " ") continue;
      if (ch === "T") temple ??= { x, y, z: 7 };
      if (".TdPK".includes(ch)) first ??= { x, y, z: 7 };
      const stack = STACKS[ch];
      if (!stack) throw new Error(`unknown tile ${ch}`);
      const [cx, cy] = [Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)];
      const k = chunkKey(7, cx, cy);
      const chunk = chunks.get(k) ?? emptyChunk(cx, cy, 7);
      chunks.set(k, chunk);
      setGround(chunk, x % CHUNK_SIZE, y % CHUNK_SIZE, "grass");
      for (const id of stack) pushItem(chunk, x % CHUNK_SIZE, y % CHUNK_SIZE, id);
      const lock = content.items.get(stack.at(-1) ?? "")?.lock;
      if (lock !== undefined) locked.push({ pos: { x, y, z: 7 }, lock });
    }
  const chunkOf = (p: Position): number[] => [
    Math.floor(p.y / CHUNK_SIZE),
    Math.floor(p.x / CHUNK_SIZE),
    p.y,
    p.x,
  ];
  locked.sort((a, b) => {
    const [ka, kb] = [chunkOf(a.pos), chunkOf(b.pos)];
    return ka.reduce((d, v, i) => d || v - (kb[i] ?? 0), 0);
  });
  const island = { chunks } as unknown as Island;
  const start = temple ?? first;
  const houses = new Set<string>();
  for (const h of c.houses ?? []) {
    const [x = NaN, y = NaN, w = NaN, hh = NaN] = h.rect.split(",").map(Number);
    if (![x, y, w, hh].every(Number.isInteger)) throw new Error(`bad rect ${h.rect}`);
    for (let ty = y; ty < y + hh; ty++)
      for (let tx = x; tx < x + w; tx++) houses.add(`${tx},${ty},7`);
  }
  const world: DoorWorld = {
    temples: start ? [start] : [],
    portals: (c.portals ?? []).map((p) => ({ kind: p.kind, from: at(p.from), to: at(p.to) })),
    houses,
  };
  return { tiles: new TileMap([island]), locked, world };
}

/** How many cases door-rooms.json has (TestDoorRoomsFixture checks the same). */
const DOOR_ROOM_CASES = 39;

describe("doorRooms", () => {
  it("reads the shared cases", () =>
    expect(fixture.cases.length).toBeGreaterThanOrEqual(DOOR_ROOM_CASES));

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { tiles, locked, world } = draw(c);
    const r = doorRooms(tiles, content, locked, world);
    if (c.error !== undefined) {
      // The server stops at the first refused door, in the same order.
      expect(r.findings[0]?.error).toBe(c.error);
      expect(r.findings[0]?.door).toEqual(at(must(c.door)));
      return;
    }
    expect(r.findings).toEqual([]);
    const got: Record<string, number> = {};
    for (const [k, n] of r.sizes) got[k.replace(/,7$/, "")] = n;
    expect(got).toEqual(c.rooms);
  });

  it("gives the tiles of the room, never the door's nor the outside's", () => {
    const { tiles, locked } = draw(must(fixture.cases[0]));
    const r = doorRoom(tiles, content, must(locked[0]).pos);
    if ("error" in r) throw new Error(r.error);
    const keys = r.rooms.flat().map((p) => `${p.x},${p.y},${p.z}`);
    expect(keys).toContain("1,1,7");
    expect(keys).toContain("3,3,7");
    expect(keys).not.toContain("4,2,7");
    expect(keys).not.toContain("5,2,7");
    expect(keys).toHaveLength(9);
  });

  it("names the side that leads nowhere, and the door that lets a player round a key", () => {
    const named = (name: string): ReturnType<typeof draw> =>
      draw(must(fixture.cases.find((c) => c.name === name)));
    const vault = named("a vault bigger than the room before it");
    expect(doorRooms(vault.tiles, content, vault.locked, vault.world).findings).toEqual([
      { door: { x: 10, y: 2, z: 7 }, error: "escape", side: { x: 11, y: 1, z: 7 } },
    ]);
    const cycle = named("a cycle of locked doors of different keys");
    expect(doorRooms(cycle.tiles, content, cycle.locked, cycle.world).findings).toEqual([
      { door: { x: 9, y: 3, z: 7 }, error: "bypass", other: { x: 4, y: 5, z: 7 } },
    ]);
  });

  // The world is the temples, and only the portals a player takes without anything lead out
  // of an area (the server's TestEscapeReachesTemplesByPortals and TestEscapeNeedsNoRope).
  it("reaches the temples by the portals a player takes without keys or tools", () => {
    const { tiles, locked, world } = draw(
      must(fixture.cases.find((c) => c.name === "a vault bigger than the room before it")),
    );
    const temples = world.temples ?? [];
    const findings = (w: DoorWorld): DoorRoomError[] =>
      doorRooms(tiles, content, locked, w).findings.map((f) => f.error);
    expect(findings({ temples })).toEqual(["escape"]);
    // A way out of the vault to the field by each kind of portal.
    const out = (kind: string): DoorWorld => ({
      temples,
      portals: [{ kind, from: { x: 13, y: 2, z: 7 }, to: { x: 2, y: 2, z: 7 } }],
    });
    for (const kind of ["stairs", "ladder", "hole", "teleport"])
      expect(findings(out(kind)), kind).toEqual([]);
    // A rope spot needs a rope; a boat portal moves nobody.
    for (const kind of ["rope_spot", "boat"]) expect(findings(out(kind)), kind).toEqual(["escape"]);
    // No temple at all: every side leads nowhere.
    expect(findings({})).toEqual(["escape", "escape"]);
  });

  // A ladder is used, not stepped onto: its tile stays ground of its area, so a corridor
  // that holds one still joins the vault with the field; a teleport there splits them (the
  // server's TestEscapeWalksAcrossALadder).
  it("walks across a ladder but not across a teleport", () => {
    const { tiles, locked, world } = draw(
      must(
        fixture.cases.find(
          (c) => c.name === "a vault joined to the field only across a teleport to a sealed pocket",
        ),
      ),
    );
    const across = (kind: string): DoorRoomError[] =>
      doorRooms(tiles, content, locked, {
        ...world,
        portals: (world.portals ?? []).map((p) => ({ ...p, kind })),
      }).findings.map((f) => f.error);
    expect(across("teleport")).toEqual(["escape"]);
    expect(across("ladder")).toEqual([]);
  });

  // Two gates of one hall whose outsides meet only through a house (the server's
  // TestSharedRoomOutsidesDoNotCrossHouses): a house is no street.
  it("takes houses for walls of the areas", () => {
    const { tiles, locked, world } = draw({
      name: "a hall over a street",
      rows: [
        "#############",
        "#...#...#...#",
        "#.T.D...D...#",
        "#...#...#...#",
        "#...#####...#",
        "#...........#",
        "#############",
      ],
    });
    expect(doorRooms(tiles, content, locked, world).findings).toEqual([]);
    const houses = new Set(["6,5,7"]);
    expect(doorRooms(tiles, content, locked, { ...world, houses }).findings).toEqual([
      { door: { x: 8, y: 2, z: 7 }, error: "escape", side: { x: 9, y: 1, z: 7 } },
    ]);
  });

  // A door refused on a later side leaves the new room of an earlier side unindexed: the
  // server stops at that door, so the room must not refuse a later door either. In this
  // order the gate of another key comes first; the gate's south-east room is new, its
  // south-west room is the other gate's.
  it("indexes the rooms of a door only when all its sides pass", () => {
    const { tiles, locked, world } = draw({
      name: "a gate with two rooms, one behind a gate of another key",
      rows: [
        "###########",
        "#....T....#",
        "#.........#",
        "######D####",
        "#..##.#.###",
        "#..K..#..##",
        "###########",
      ],
    });
    const r = doorRooms(tiles, content, [...locked].reverse(), world);
    expect(r.findings).toEqual([
      { door: { x: 6, y: 3, z: 7 }, error: "key", other: { x: 3, y: 5, z: 7 } },
    ]);
    expect(r.behind.has("5,4,7")).toBe(true);
    expect(r.behind.has("7,4,7")).toBe(false);
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture value missing");
  return v;
}
