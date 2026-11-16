import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import type { ContentIndex, ItemInfo } from "./content.ts";
import { doorRoom } from "./doors.ts";
import type { DoorRoomError } from "./doors.ts";
import { TileMap } from "./tiles.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "./types.ts";
import type { Chunk, Island, Position } from "./types.ts";

// The cases the server reads too (server/internal/session, TestDoorRoomsFixture): both
// sides agree on every room and on every locked door without one.
interface Case {
  name: string;
  rows: (string | { repeat: number; row: string })[];
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

/** The drawings' items: what the walk looks at (ground, blockers, doors and locks). */
const content: ContentIndex = {
  items: new Map([
    item("grass", { kind: "ground", walkable: true }),
    item("wall", { kind: "wall", blocksMovement: true }),
    item("gate", { blocksMovement: true, door: true, lock: "gate" }),
    item("gate_open", { door: true, lock: "gate", doorOpen: true }),
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
  P: ["plain"],
  X: ["wall", "plain"],
};

/** The tiles of a drawing on floor 7 from (0,0), and its locked doors in map order. */
function draw(c: Case): { tiles: TileMap; locked: Position[] } {
  const rows = c.rows.flatMap((r) =>
    typeof r === "string" ? [r] : Array.from({ length: r.repeat }, () => r.row),
  );
  const chunks = new Map<string, Chunk>();
  const locked: Position[] = [];
  for (const [y, row] of rows.entries())
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
      if (ch === "D" || ch === "d") locked.push({ x, y, z: 7 });
    }
  const island = { chunks } as unknown as Island;
  return { tiles: new TileMap([island]), locked };
}

describe("doorRoom", () => {
  it("reads the shared cases", () => expect(fixture.cases.length).toBeGreaterThanOrEqual(8));

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { tiles, locked } = draw(c);
    if (c.error !== undefined) {
      expect(locked).toHaveLength(1); // the server reports the first one it meets
      expect(doorRoom(tiles, content, locked[0] as Position)).toEqual({ error: c.error });
      return;
    }
    const got: Record<string, number> = {};
    for (const p of locked) {
      const r = doorRoom(tiles, content, p);
      if ("error" in r) throw new Error(`${p.x},${p.y}: ${r.error}`);
      got[`${p.x},${p.y}`] = r.rooms.flat().length;
    }
    expect(got).toEqual(c.rooms);
  });

  it("gives the tiles of the room, never the door's", () => {
    const { tiles, locked } = draw(must(fixture.cases[0]));
    const r = doorRoom(tiles, content, locked[0] as Position);
    if ("error" in r) throw new Error(r.error);
    const keys = r.rooms.flat().map((p) => `${p.x},${p.y},${p.z}`);
    expect(keys).toContain("1,1,7");
    expect(keys).toContain("3,3,7");
    expect(keys).not.toContain("4,2,7");
    expect(keys).not.toContain("5,2,7");
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture value missing");
  return v;
}
