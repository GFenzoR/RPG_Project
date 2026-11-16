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
// refuse the same boat arrivals, dialog teleports, temples and house exits (docs/03
// "Validación").
interface FixtureHouse {
  rect: string;
  door: string;
}
interface Case {
  name: string;
  by: "boat" | "dialog" | "exit" | "temple";
  to: string;
  house?: FixtureHouse;
  error?: "house" | "door" | "plain" | "walkable";
}
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "testdata", "arrivals.json"), "utf8"),
) as {
  origin: string;
  rows: string[];
  houses: (FixtureHouse & { exit: string })[];
  cases: Case[];
};

/** How many cases arrivals.json has (TestArrivalsFixture checks the same). */
const ARRIVAL_CASES = 25;

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// The items of data/ plus the door pair plain_door, without a lock (the p of the drawing).
const data = loadContent(repo);
const content: ContentIndex = {
  ...data,
  items: new Map([
    ...data.items,
    ["plain_door", { id: "plain_door", kind: "decoration", blocksMovement: true, door: true }],
    [
      "plain_door_open",
      {
        id: "plain_door_open",
        kind: "decoration",
        blocksMovement: false,
        door: true,
        doorOpen: true,
      },
    ],
  ]),
};
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
  p: ["plain_door_open"],
};

/**
 * The world of the fixture: island "test", a 64x64 field of grass on floor 7 with its
 * temple at (0,0) (or at temple) and the captain harbor_master at (8,10), the drawing over
 * it from its origin and its houses, then the more ones. A protection zone covers the
 * island, so a temple anywhere is protected.
 */
function fixtureWorld(
  more: (FixtureHouse & { exit: string })[] = [],
  temple: Position = { x: 0, y: 0, z: 7 },
): World {
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
      temple,
      level_hint: [1, 5],
    },
    chunks,
    spawns: [],
    npcs: [{ npc: "harbor_master", pos: { x: 8, y: 10, z: 7 } }],
    zones: [{ id: "everywhere", type: "protection", floors: [7], rects: [rect] }],
    portals: [],
    texts: [],
    houses: [...fixture.houses, ...more].map((h, i) => {
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
        : c.by === "dialog"
          ? {
              ...content,
              routes: [],
              teleports: [{ npc: "puerto_priest", file: priestFile, node: "start", to }],
            }
          : { ...content, routes: [], teleports: [] };
    const more = c.house ? [{ ...c.house, exit: c.to }] : [];
    if (c.by === "exit" && more.length === 0) throw new Error(`${c.name}: no house`);
    const exitOf = fixture.houses.length; // the index of the case's house, h1
    const temple = c.by === "temple" ? to : undefined;
    const found = validateLoaded(fixtureWorld(more, temple), index).diagnostics.filter(
      (d) =>
        d.severity === "error" &&
        (c.by === "boat"
          ? d.file === routesFile && d.path[1] === "to"
          : c.by === "dialog"
            ? d.file === priestFile && d.path[0] === "dialog"
            : c.by === "temple"
              ? d.file.endsWith("/island.yaml") && d.path[0] === "temple"
              : d.file.endsWith("/houses.yaml") && d.path[0] === exitOf && d.path[1] === "exit"),
    );
    if (!c.error) {
      expect(found).toEqual([]);
      return;
    }
    const why = {
      house: 'lies in house "h0"',
      door: "lies on a locked door",
      plain: "lies on a door anyone may close",
      walkable:
        c.by === "exit"
          ? "house exit is not on a walkable tile"
          : c.by === "temple"
            ? "temple is not on a walkable tile"
            : "not a walkable tile",
    }[c.error];
    // A house exit or a temple can break other rules of its own too (out of reach of the
    // temple, on a closed gate not walkable): the one of the case is among them.
    if (c.by === "boat" || c.by === "dialog") expect(found).toHaveLength(1);
    const hit = found.find((d) => d.message.includes(why));
    expect(hit, `${why} in ${found.map((d) => d.message).join(" | ")}`).toBeDefined();
    expect(hit?.pos).toEqual(to);
    // The new refusals name the island and the tile (the walkability of a boat arrival, of a
    // house exit and of a temple is an older message, by route, house or file).
    if (c.error !== "walkable") expect(hit?.message).toContain(`island "test"`);
    if (c.error !== "walkable" || c.by === "dialog") expect(hit?.message).toContain(formatPos(to));
    if (c.by === "exit" && c.error !== "walkable") expect(hit?.message).toContain('house "h1"');
  });
});
