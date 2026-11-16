import { describe, expect, it } from "vitest";
import {
  disconnectedFloors,
  houseIssues,
  houseTiles,
  onHouseEdge,
  sortTiles,
  tilesToRects,
} from "./houses.ts";
import type { HouseInput } from "./houses.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "./types.ts";
import type { House, Island, Position, World } from "./types.ts";

function island(id: string, x: number, houses: House[] = []): Island {
  const chunk = emptyChunk(x / CHUNK_SIZE, 0, 7);
  // Grass everywhere except column 10..11 of rows 0..1 (no ground).
  for (let ly = 0; ly < CHUNK_SIZE; ly++)
    for (let lx = 0; lx < CHUNK_SIZE; lx++)
      if (!(ly < 2 && lx >= 10 && lx < 12)) chunk.ground[ly * CHUNK_SIZE + lx] = "grass";
  return {
    meta: {
      id,
      name: `island.${id}.name`,
      rect: { x, y: 0, w: CHUNK_SIZE, h: CHUNK_SIZE },
      floors: [7, 8],
      temple: { x: x + 5, y: 6, z: 7 },
      level_hint: [1, 1],
    },
    chunks: new Map([[chunkKey(7, x / CHUNK_SIZE, 0), chunk]]),
    spawns: [],
    npcs: [],
    zones: [],
    portals: [],
    texts: [],
    houses,
  };
}

const existing: House = {
  id: "a_house_old",
  name: "house.a_house_old.name",
  rent: 100,
  rects: [{ x: 20, y: 20, z: 7, w: 3, h: 3 }],
  doors: [{ x: 21, y: 22, z: 7 }],
  exit: { x: 21, y: 23, z: 7 },
};

function world(): World {
  return {
    meta: { format: 1, islands: [] },
    islands: new Map([
      ["a", island("a", 0, [existing])],
      ["b", island("b", 64)],
    ]),
  };
}

const p = (x: number, y: number, z = 7): Position => ({ x, y, z });

/** A valid 4x3 house at (2,2) with its door in the bottom row. */
function house(patch: Partial<HouseInput> = {}): HouseInput {
  return {
    id: "a_house_new",
    name: "house.a_house_new.name",
    rent: 500,
    rects: [{ x: 2, y: 2, z: 7, w: 4, h: 3 }],
    doors: [p(3, 4)],
    exit: p(3, 5),
    ...patch,
  };
}

const codes = (h: HouseInput, replacing?: string): string[] =>
  houseIssues(world(), h, replacing === undefined ? {} : { replacing }).map((i) => i.code);

describe("house tiles and rects", () => {
  it("lists every tile once, sorted by floor, row and column", () => {
    expect(
      houseTiles([
        { x: 1, y: 1, z: 8, w: 1, h: 1 },
        { x: 2, y: 0, z: 7, w: 2, h: 1 },
        { x: 2, y: 0, z: 7, w: 1, h: 2 },
      ]),
    ).toEqual([p(2, 0), p(3, 0), p(2, 1), p(1, 1, 8)]);
    expect(sortTiles([p(5, 5), p(1, 1), p(5, 5)])).toEqual([p(1, 1), p(5, 5)]);
  });

  it("covers tiles with the same rects houses.yaml uses for a room and its doorway", () => {
    // Room 6x5 at (3151, 6396) plus a 2x1 doorway below (puerto_house_net).
    const rects = [
      { x: 3151, y: 6396, z: 7, w: 6, h: 5 },
      { x: 3153, y: 6401, z: 7, w: 2, h: 1 },
    ];
    expect(tilesToRects(houseTiles(rects))).toEqual(rects);
  });

  it("covers any shape exactly, per floor", () => {
    const tiles = [
      p(0, 0),
      p(1, 0),
      p(2, 0),
      p(0, 1),
      p(2, 1),
      p(0, 2),
      p(1, 2),
      p(2, 2),
      p(9, 9, 8),
    ];
    const rects = tilesToRects(tiles);
    expect(houseTiles(rects)).toEqual(sortTiles(tiles));
    expect(rects.reduce((n, r) => n + r.w * r.h, 0)).toBe(tiles.length);
    expect(rects.at(-1)).toEqual({ x: 9, y: 9, z: 8, w: 1, h: 1 });
  });

  it("stops rect sides at 255 tiles", () => {
    const tiles = Array.from({ length: 300 }, (_, i) => p(i, 0));
    expect(tilesToRects(tiles)).toEqual([
      { x: 0, y: 0, z: 7, w: 255, h: 1 },
      { x: 255, y: 0, z: 7, w: 45, h: 1 },
    ]);
  });

  it("knows the edge of a house and whether its tiles are connected", () => {
    const rects = [{ x: 0, y: 0, z: 7, w: 3, h: 3 }];
    expect(onHouseEdge(rects, p(1, 0))).toBe(true);
    expect(onHouseEdge(rects, p(1, 1))).toBe(false);
    expect(disconnectedFloors(rects)).toEqual([]);
    // Diagonal neighbours do not connect; another floor is checked on its own.
    expect(
      disconnectedFloors([
        { x: 0, y: 0, z: 7, w: 1, h: 1 },
        { x: 1, y: 1, z: 7, w: 1, h: 1 },
        { x: 0, y: 0, z: 8, w: 2, h: 1 },
      ]),
    ).toEqual([7]);
  });
});

describe("houseIssues", () => {
  it("accepts a valid house", () => {
    expect(houseIssues(world(), house())).toEqual([]);
  });

  it("checks the id, its uniqueness and the rent", () => {
    expect(codes(house({ id: "Bad id" }))).toContain("id");
    expect(codes(house({ id: "a_house_old" }))).toContain("duplicate");
    // An edit of a_house_old may keep its id and its tiles.
    expect(
      codes(
        house({
          id: "a_house_old",
          rects: existing.rects,
          doors: existing.doors,
          exit: existing.exit,
        }),
        "a_house_old",
      ),
    ).toEqual([]);
    expect(codes(house({ rent: 0 }))).toContain("rent");
    expect(codes(house({ rent: 1.5 }))).toContain("rent");
  });

  it("checks the tiles: some, inside one island, not in another house", () => {
    expect(codes(house({ rects: [], doors: [] }))).toEqual(
      expect.arrayContaining(["no_tiles", "no_doors"]),
    );
    const out = houseIssues(world(), house({ rects: [{ x: 30, y: 2, z: 7, w: 4, h: 3 }] }));
    expect(out.find((i) => i.code === "outside_island")?.pos).toEqual(p(32, 2));
    expect(codes(house({ rects: [{ x: 2, y: 2, z: 9, w: 1, h: 1 }] }))).toContain("outside_island");
    expect(
      codes(
        house({
          rects: [
            { x: 2, y: 2, z: 7, w: 4, h: 3 },
            { x: 70, y: 2, z: 7, w: 1, h: 1 },
          ],
        }),
      ),
    ).toContain("two_islands");
    const overlap = houseIssues(world(), house({ rects: [{ x: 19, y: 19, z: 7, w: 2, h: 2 }] }));
    expect(overlap.find((i) => i.code === "overlap")).toEqual({
      code: "overlap",
      severity: "error",
      pos: p(20, 20),
      other: "a_house_old",
    });
    expect(
      codes(
        house({
          rects: [
            { x: 2, y: 2, z: 7, w: 4, h: 3 },
            { x: 3, y: 3, z: 7, w: 1, h: 1 },
          ],
        }),
      ),
    ).toContain("rects_overlap");
    expect(
      codes(
        house({ rects: Array.from({ length: 17 }, (_, i) => ({ x: i, y: 9, z: 7, w: 1, h: 1 })) }),
      ),
    ).toContain("too_many_rects");
  });

  it("wants doors on the edge and the exit outside, next to a door", () => {
    expect(codes(house({ doors: [p(3, 3)] }))).toContain("door_not_on_edge");
    expect(codes(house({ doors: [p(9, 9)] }))).toContain("door_outside");
    expect(
      codes(house({ doors: Array.from({ length: 9 }, (_, i) => p(2 + (i % 4), 2)) })),
    ).toContain("too_many_doors");
    expect(codes(house({ exit: undefined }))).toContain("no_exit");
    expect(codes(house({ exit: p(3, 4) }))).toContain("exit_in_house");
    expect(codes(house({ exit: p(21, 21) }))).toContain("exit_in_house");
    expect(codes(house({ exit: p(3, 8) }))).toEqual(["exit_far"]);
    expect(codes(house({ exit: p(4, 5) }))).toEqual([]); // diagonal to the door is next to it
    expect(codes(house({ exit: p(70, 5) }))).toEqual(
      expect.arrayContaining(["exit_outside_island", "exit_far"]),
    );
  });

  it("warns about split houses and tiles without ground", () => {
    const split = houseIssues(
      world(),
      house({
        rects: [
          { x: 2, y: 2, z: 7, w: 4, h: 3 },
          { x: 8, y: 2, z: 7, w: 1, h: 1 },
        ],
      }),
    );
    expect(split).toEqual([{ code: "not_contiguous", severity: "warning", other: "7" }]);
    const bare = houseIssues(
      world(),
      house({ rects: [{ x: 9, y: 1, z: 7, w: 4, h: 3 }], doors: [p(10, 3)], exit: p(10, 4) }),
    );
    expect(bare).toEqual([{ code: "no_ground", severity: "warning", pos: p(10, 1) }]);
  });
});
