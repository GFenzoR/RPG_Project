import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import { loadContent, routesFile } from "./content.ts";
import type { ContentIndex } from "./content.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk, formatPos } from "./types.ts";
import type { Chunk, Island, Position, World } from "./types.ts";
import { validateLoaded } from "./validate.ts";

// The cases the server reads too (server/internal/session, TestArrivalsFixture): both
// refuse the same boat arrivals and dialog teleports (docs/03 "Validación").
interface Case {
  name: string;
  by: "boat" | "dialog";
  to: string;
  error?: "house" | "door" | "walkable";
}
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "testdata", "arrivals.json"), "utf8"),
) as {
  origin: string;
  rows: string[];
  houses: { rect: string; door: string; exit: string }[];
  cases: Case[];
};

/** How many cases arrivals.json has (TestArrivalsFixture checks the same). */
const ARRIVAL_CASES = 13;

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const content = loadContent(repo);
const priestFile = "data/npcs/puerto_priest.yaml";

/** The numbers of "x,y" (or "x,y,w,h"). */
function nums(s: string, n: number): number[] {
  const out = s.split(",").map(Number);
  if (out.length !== n || !out.every(Number.isInteger)) throw new Error(`bad tile ${s}`);
  return out;
}

/** A tile "x,y" of floor 7. */
function at(xy: string): Position {
  const [x = 0, y = 0] = nums(xy, 2);
  return { x, y, z: 7 };
}

const STACKS: Record<string, string[]> = {
  ".": [],
  "#": ["stone_wall"],
  D: ["forge_gate"],
  d: ["forge_gate_open"],
};

/**
 * The world of the fixture: island "test", a 64x64 field of grass on floor 7 with its
 * temple at (0,0) and the captain harbor_master at (8,10), the drawing over it from its
 * origin and its houses.
 */
function fixtureWorld(): World {
  const chunks = new Map<string, Chunk>();
  for (let cy = 0; cy < 2; cy++)
    for (let cx = 0; cx < 2; cx++) {
      const c = emptyChunk(cx, cy, 7);
      for (let y = 0; y < CHUNK_SIZE; y++)
        for (let x = 0; x < CHUNK_SIZE; x++) setGround(c, x, y, "grass");
      chunks.set(chunkKey(7, cx, cy), c);
    }
  const [ox = 0, oy = 0] = nums(fixture.origin, 2);
  for (const [dy, row] of fixture.rows.entries())
    for (const [dx, ch] of [...row].entries()) {
      const stack = STACKS[ch];
      if (!stack) throw new Error(`unknown tile ${ch}`);
      const [x, y] = [ox + dx, oy + dy];
      const c = chunks.get(chunkKey(7, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)));
      if (!c) throw new Error(`no chunk at ${x},${y}`);
      for (const id of stack) pushItem(c, x % CHUNK_SIZE, y % CHUNK_SIZE, id);
    }
  const rect = { x: 0, y: 0, w: 64, h: 64 };
  const island: Island = {
    meta: {
      id: "test",
      name: "island.testisle.name",
      rect,
      floors: [7],
      temple: { x: 0, y: 0, z: 7 },
      level_hint: [1, 5],
    },
    chunks,
    spawns: [],
    npcs: [{ npc: "harbor_master", pos: { x: 8, y: 10, z: 7 } }],
    zones: [],
    portals: [],
    texts: [],
    houses: fixture.houses.map((h, i) => {
      const [x = 0, y = 0, w = 0, hh = 0] = nums(h.rect, 4);
      return {
        id: `h${i}`,
        name: `house.h${i}.name`,
        rent: 10,
        rects: [{ x, y, z: 7, w, h: hh }],
        doors: [at(h.door)],
        exit: at(h.exit),
      };
    }),
  };
  return {
    meta: { format: 1, islands: [{ id: "test", rect, level_hint: [1, 5] }] },
    islands: new Map([["test", island]]),
  };
}

describe("arrivals", () => {
  it("reads the shared cases", () => {
    expect(fixture.cases).toHaveLength(ARRIVAL_CASES);
  });

  it.each(fixture.cases)("$name", (c) => {
    const to = at(c.to);
    const index: ContentIndex =
      c.by === "boat"
        ? {
            ...content,
            routes: [
              { index: 0, id: "r", captain: "harbor_master", from: { x: 8, y: 11, z: 7 }, to },
            ],
            teleports: [],
          }
        : {
            ...content,
            routes: [],
            teleports: [{ npc: "puerto_priest", file: priestFile, node: "start", to }],
          };
    const found = validateLoaded(fixtureWorld(), index).diagnostics.filter(
      (d) =>
        d.severity === "error" &&
        (c.by === "boat"
          ? d.file === routesFile && d.path[1] === "to"
          : d.file === priestFile && d.path[0] === "dialog"),
    );
    if (!c.error) {
      expect(found).toEqual([]);
      return;
    }
    const why = {
      house: 'lies in house "h0"',
      door: "lies on a locked door",
      walkable: "not a walkable tile",
    }[c.error];
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(why);
    expect(found[0]?.pos).toEqual(to);
    // The new refusals name the island and the tile (a boat arrival's walkability is
    // checkRouteTile's older message).
    if (c.error !== "walkable") expect(found[0]?.message).toContain(`island "test"`);
    if (c.error !== "walkable" || c.by === "dialog")
      expect(found[0]?.message).toContain(formatPos(to));
  });
});
