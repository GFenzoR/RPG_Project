import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import type { ContentIndex, ItemInfo } from "./content.ts";
import { doorRoom, doorRooms } from "./doors.ts";
import type { DoorRoomError } from "./doors.ts";
import { TileMap } from "./tiles.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "./types.ts";
import type { Chunk, Island, Position } from "./types.ts";

// The cases the server reads too (server/internal/session, TestDoorRoomsFixture): both
// sides agree on every room and on every locked door they refuse.
type Row = string | { repeat: number; row?: string; rows?: string[] };
interface Case {
  name: string;
  rows: Row[];
  rooms?: Record<string, number>;
  error?: DoorRoomError;
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
  borders: [],
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
};

/** The rows of a drawing, its repeats expanded. */
const expand = (rows: Row[]): string[] =>
  rows.flatMap((r) =>
    typeof r === "string"
      ? [r]
      : Array.from({ length: r.repeat }, () => r.rows ?? [r.row ?? ""]).flat(),
  );

/**
 * The tiles of a drawing on floor 7 from (0,0), and its locked doors in map order (chunk
 * by chunk, row by row: the server's order).
 */
function draw(c: Case): { tiles: TileMap; locked: { pos: Position; lock: string }[] } {
  const chunks = new Map<string, Chunk>();
  const locked: { pos: Position; lock: string }[] = [];
  for (const [y, row] of expand(c.rows).entries())
    for (const [x, ch] of [...row].entries()) {
      if (ch === " ") continue;
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
  return { tiles: new TileMap([island]), locked };
}

/** How many cases door-rooms.json has (TestDoorRoomsFixture checks the same). */
const DOOR_ROOM_CASES = 21;

describe("doorRooms", () => {
  it("reads the shared cases", () =>
    expect(fixture.cases.length).toBeGreaterThanOrEqual(DOOR_ROOM_CASES));

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { tiles, locked } = draw(c);
    const r = doorRooms(tiles, content, locked);
    if (c.error !== undefined) {
      // The server stops at the first refused door, in the same order.
      expect(r.findings[0]?.error).toBe(c.error);
      return;
    }
    expect(r.findings).toEqual([]);
    const got: Record<string, number> = {};
    for (const [k, n] of r.sizes) got[k.replace(/,7$/, "")] = n;
    expect(got).toEqual(c.rooms);
  });

  it("gives the tiles of the room, never the door's, and the outside next to it", () => {
    const { tiles, locked } = draw(must(fixture.cases[0]));
    const r = doorRoom(tiles, content, must(locked[0]).pos);
    if ("error" in r) throw new Error(r.error);
    const keys = r.rooms.flat().map((p) => `${p.x},${p.y},${p.z}`);
    expect(keys).toContain("1,1,7");
    expect(keys).toContain("3,3,7");
    expect(keys).not.toContain("4,2,7");
    expect(keys).not.toContain("5,2,7");
    expect(r.outside.map((p) => `${p.x},${p.y}`)).toEqual(["5,1", "5,2", "5,3"]);
  });

  it("names the earlier door a refused one shares its room with", () => {
    const vault = must(
      fixture.cases.find((c) => c.name === "a vault bigger than the room before it"),
    );
    const { tiles, locked } = draw(vault);
    expect(doorRooms(tiles, content, locked).findings).toEqual([
      { door: { x: 10, y: 2, z: 7 }, error: "outside", other: { x: 6, y: 2, z: 7 } },
    ]);
  });

  // Two gates of one hall whose outsides meet only through a house (the server's
  // TestSharedRoomOutsidesDoNotCrossHouses): a house is no street.
  it("does not walk through houses between the outsides of two doors", () => {
    const { tiles, locked } = draw({
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
    expect(doorRooms(tiles, content, locked).findings).toEqual([]);
    expect(doorRooms(tiles, content, locked, new Set(["6,5,7"])).findings).toEqual([
      { door: { x: 8, y: 2, z: 7 }, error: "outside", other: { x: 4, y: 2, z: 7 } },
    ]);
  });

  // A door refused on a later side leaves the new room of an earlier side unindexed: the
  // server stops at that door, so the room must not refuse a later door either. In this
  // order the gate of another key comes first; the gate's south-east room is new, its
  // south-west room is the other gate's.
  it("indexes the rooms of a door only when all its sides pass", () => {
    const { tiles, locked } = draw({
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
    const r = doorRooms(tiles, content, [...locked].reverse());
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
