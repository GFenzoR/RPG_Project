import { describe, expect, it } from "vitest";
import type { TileArt } from "./tile-art.ts";
import {
  CELL_OPEN,
  CELL_UNKNOWN,
  CELL_WALL,
  MAX_INDOOR_AREA,
  GLINT_MIN_MS,
  GLINT_SPREAD_MS,
  MAX_ELEVATION,
  TILE_PART,
  WALL_E,
  WALL_N,
  WALL_S,
  WALL_W,
  frameAt,
  groundSplit,
  splitHalf,
  framePhase,
  framesOfLook,
  indoorTiles,
  lookOf,
  pickVariant,
  resolveTileArt,
  stackElevation,
  tileHash,
  wallMask,
  wallTiles,
} from "./tile-art.ts";

describe("tileHash", () => {
  it("is deterministic, in [0, 1) and differs between neighbours", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++) {
        const h = tileHash(3000 + x, 6000 + y, 7);
        expect(h).toBe(tileHash(3000 + x, 6000 + y, 7));
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
        seen.add(h);
      }
    expect(seen.size).toBe(400);
    expect(tileHash(1, 2, 7)).not.toBe(tileHash(1, 2, 8));
  });
});

describe("pickVariant", () => {
  it("keeps the main look for the weight and spreads the others evenly", () => {
    expect(pickVariant(0.69, 4)).toBe(0);
    expect(pickVariant(0.71, 4)).toBe(1);
    expect(pickVariant(0.81, 4)).toBe(2);
    expect(pickVariant(0.99, 4)).toBe(3);
    expect(pickVariant(0.99, 1)).toBe(0);
    expect(pickVariant(0.5, 3, 0.4)).toBe(1);
    // About 70 % of a big field keeps look 0.
    let main = 0;
    const counts = [0, 0, 0, 0];
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const v = pickVariant(tileHash(x, y, 7), 4);
        counts[v] = (counts[v] ?? 0) + 1;
        if (v === 0) main++;
      }
    expect(main / 10000).toBeGreaterThan(0.66);
    expect(main / 10000).toBeLessThan(0.74);
    for (const c of counts.slice(1)) expect(c).toBeGreaterThan(800);
  });
});

describe("lookOf (ART-4)", () => {
  const art = (weight?: number): TileArt<string> => ({
    base: "b",
    variants: ["b", "b/var_1", "b/var_2", "b/var_3"],
    ...(weight === undefined ? {} : { weight }),
    ms: 250,
    sync: "world",
    anchorX: 1,
    joinsWalls: false,
    light: 0,
  });
  const share = (a: TileArt<string>, ground: boolean): number[] => {
    const counts = [0, 0, 0, 0];
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const v = lookOf(a, tileHash(x, y, 7), ground);
        counts[v] = (counts[v] ?? 0) + 1;
      }
    return counts.map((c) => c / 10000);
  };

  it("keeps a ground's main look on most tiles and spreads a border piece's looks evenly", () => {
    const ground = share(art(), true);
    expect(ground[0]).toBeGreaterThan(0.66);
    expect(ground[0]).toBeLessThan(0.74);
    // A border piece: every look on about a quarter of the tiles, so no shape repeats.
    for (const s of share(art(), false)) {
      expect(s).toBeGreaterThan(0.22);
      expect(s).toBeLessThan(0.28);
    }
    // A weight the atlas sets wins for both.
    expect(share(art(0.4), false)[0]).toBeCloseTo(0.4, 1);
    // The same tile, the same look: every piece of a tile keeps one shape.
    const h = tileHash(12, 34, 7);
    expect(lookOf(art(), h, false)).toBe(lookOf(art(), h, false));
    expect(lookOf({ ...art(), variants: ["b"] }, 0.99, false)).toBe(0);
    expect(
      lookOf({ ...art(), variants: undefined } as unknown as TileArt<string>, 0.99, false),
    ).toBe(0);
  });
});

describe("frameAt", () => {
  it("loops world and tile animations, a tile one shifted by its phase", () => {
    expect([0, 249, 250, 999, 1000].map((t) => frameAt(t, "world", 4, 250, 0, 0.3))).toEqual([
      0, 0, 1, 3, 0,
    ]);
    const phase = framePhase("tile", 0.5, 4, 250);
    expect(phase).toBe(500);
    expect(frameAt(0, "tile", 4, 250, phase, 0.5)).toBe(2);
    expect(framePhase("world", 0.5, 4, 250)).toBe(0);
    expect(frameAt(1234, "world", 1, 250, 0, 0)).toBe(0);
  });

  it("plays a random glint once per period and shows the base the rest of the time", () => {
    const hash = 0.42;
    const phase = framePhase("random", hash, 3, 80);
    let glints = 0;
    let prev = 0;
    for (let t = 0; t < 60_000; t += 10) {
      const f = frameAt(t, "random", 3, 80, phase, hash);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(3);
      if (f === 1 && prev === 0) glints++;
      prev = f;
    }
    expect(glints).toBeGreaterThanOrEqual(Math.floor(60_000 / (GLINT_MIN_MS + GLINT_SPREAD_MS)));
    expect(glints).toBeLessThanOrEqual(Math.ceil(60_000 / GLINT_MIN_MS));
  });
});

describe("walls", () => {
  it("packs the four neighbours into a piece mask", () => {
    expect(wallMask(false, false, false, false)).toBe(0);
    expect(wallMask(true, false, false, false)).toBe(WALL_N);
    expect(wallMask(false, true, false, true)).toBe(WALL_E | WALL_W);
    expect(wallMask(true, true, true, true)).toBe(15);
    expect(WALL_S).toBe(4);
  });

  it("finds the wall tiles of a chunk", () => {
    const walls = wallTiles(
      [
        { x: 1, y: 0, stack: ["stone_wall"] },
        { x: 2, y: 3, stack: ["coin", "door"] },
        { x: 3, y: 3, stack: ["coin"] },
      ],
      4,
      (id) => id === "stone_wall" || id === "door",
    );
    expect([...walls]).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  });
});

describe("resolveTileArt", () => {
  const atlas = new Set([
    "ground/grass",
    "ground/grass/var_1",
    "ground/grass/var_2",
    "ground/water",
    "ground/water/frame_1",
    "ground/water/frame_2",
    "decor/tree",
    "decor/tree/shadow",
    ...Array.from({ length: 16 }, (_, m) => `walls/stone/wall_${m}`),
    "walls/stone",
    "walls/broken",
    "walls/broken/wall_0",
    // The surf: 3 looks of 3 frames each, but look 2 lacks a frame.
    "borders/surf/n",
    "borders/surf/n/frame_1",
    "borders/surf/n/frame_2",
    "borders/surf/n/var_1",
    "borders/surf/n/var_1/frame_1",
    "borders/surf/n/var_1/frame_2",
    "borders/surf/n/var_2",
    "borders/surf/n/var_2/frame_1",
  ]);
  const lookup = (name: string): string | undefined => (atlas.has(name) ? name : undefined);

  it("carries the particles a sprite gives off (A13)", () => {
    expect(resolveTileArt("decor/tree", { particles: "pollen" }, lookup)?.particles).toBe("pollen");
    expect(resolveTileArt("decor/tree", { anchor: "bc" }, lookup)?.particles).toBeUndefined();
  });

  it("marks a border piece flat, drawn with the grounds (ART-4)", () => {
    expect(resolveTileArt("borders/surf/n", { flat: true }, lookup)?.flat).toBe(true);
    expect(resolveTileArt("decor/tree", { anchor: "bc" }, lookup)?.flat).toBeUndefined();
  });

  it("lists variants, frames, wall pieces and the shadow the atlas has", () => {
    const grass = resolveTileArt("ground/grass", { variants: 3 }, lookup);
    // var_3 is missing: the looks stop at the first gap.
    expect(grass?.variants).toEqual(["ground/grass", "ground/grass/var_1", "ground/grass/var_2"]);
    expect(grass?.weight).toBeUndefined(); // lookOf's default
    expect(resolveTileArt("ground/grass", { variants: 2, weight: 0.5 }, lookup)?.weight).toBe(0.5);
    const water = resolveTileArt("ground/water", { frames: 3, ms: 200, sync: "world" }, lookup);
    expect(water?.frames).toHaveLength(3);
    expect(water?.ms).toBe(200);
    const tree = resolveTileArt("decor/tree", { anchor: "bc", shadow: true }, lookup);
    expect(tree?.anchorX).toBe(0.5);
    expect(tree?.shadow).toBe("decor/tree/shadow");
    const wall = resolveTileArt("walls/stone", { wall: true }, lookup);
    expect(wall?.wall?.[WALL_N | WALL_S]).toBe("walls/stone/wall_5");
    expect(wall?.joinsWalls).toBe(true);
    expect(wall?.anchorX).toBe(1);
  });

  it("gives each look of an animated sprite its own frames (the surf, ART-4)", () => {
    const surf = resolveTileArt("borders/surf/n", { variants: 2, frames: 3 }, lookup);
    expect(surf?.variants).toEqual([
      "borders/surf/n",
      "borders/surf/n/var_1",
      "borders/surf/n/var_2",
    ]);
    expect(surf?.variantFrames).toEqual([
      ["borders/surf/n", "borders/surf/n/frame_1", "borders/surf/n/frame_2"],
      ["borders/surf/n/var_1", "borders/surf/n/var_1/frame_1", "borders/surf/n/var_1/frame_2"],
      // Without all its frames a look stays still: the base frames are another shape.
      ["borders/surf/n/var_2"],
    ]);
    if (!surf) return;
    expect(framesOfLook(surf, 1)?.[2]).toBe("borders/surf/n/var_1/frame_2");
    expect(framesOfLook(surf, 2)).toEqual(["borders/surf/n/var_2"]);
    // A sprite with looks and no frames, or frames and no looks, has no per-look frames.
    expect(resolveTileArt("ground/grass", { variants: 2 }, lookup)?.variantFrames).toBeUndefined();
    const water = resolveTileArt("ground/water", { frames: 3 }, lookup);
    expect(water?.variantFrames).toBeUndefined();
    if (water) expect(framesOfLook(water, 0)).toBe(water.frames);
  });

  it("ignores a wall without all 16 pieces, but it still joins its neighbours", () => {
    const broken = resolveTileArt("walls/broken", { wall: true }, lookup);
    expect(broken?.wall).toBeUndefined();
    expect(broken?.joinsWalls).toBe(true);
    expect(resolveTileArt("ground/grass", undefined, lookup)).toBeUndefined();
    expect(resolveTileArt("ground/none", { variants: 1 }, lookup)).toBeUndefined();
  });

  it("names the parts TILE_PART recognises", () => {
    for (const p of [
      "ground/grass/var_1",
      "ground/water/frame_12",
      "walls/stone/wall_15",
      "decor/tree/shadow",
    ])
      expect(TILE_PART.exec(p)?.[1], p).toBeDefined();
    for (const p of ["walls/stone/wall_16", "ground/grass/var_0", "effects/hit/0"])
      expect(TILE_PART.test(p), p).toBe(false);
  });
});

describe("stackElevation (ART-8)", () => {
  const elev = (id: string): number => (id === "table" ? 8 : id === "pit" ? -5 : 0);
  it("sums the items under an index, ignores negatives and caps at MAX_ELEVATION", () => {
    expect(stackElevation(["table", "coin"], 0, elev)).toBe(0);
    expect(stackElevation(["table", "coin"], 1, elev)).toBe(8);
    expect(stackElevation(["table", "coin"], 2, elev)).toBe(8);
    expect(stackElevation(["pit", "table"], 2, elev)).toBe(8);
    expect(stackElevation(["table", "table", "table", "table"], 9, elev)).toBe(MAX_ELEVATION);
    expect(MAX_ELEVATION).toBe(24);
  });
});

describe("indoorTiles (docs/17 ART-5: no sun under a roof)", () => {
  /** A map drawn in text: # wall, . open, ? unknown; outside it, `beyond`. */
  const grid =
    (rows: string[], beyond: number) =>
    (x: number, y: number): number => {
      const c = x < 0 ? undefined : rows[y]?.[x];
      if (c === undefined) return beyond;
      return c === "#" ? CELL_WALL : c === "?" ? CELL_UNKNOWN : CELL_OPEN;
    };
  const inside = (mask: Uint8Array | null, size: number): string[] => {
    const out: string[] = [];
    mask?.forEach((v, i) => {
      if (v === 1) out.push(`${i % size},${Math.floor(i / size)}`);
    });
    return out;
  };

  it("finds the tiles walls close in, by their four sides", () => {
    const rows = ["......", ".####.", ".#..#.", ".#..#.", ".####.", "......"];
    expect(inside(indoorTiles(6, 2, grid(rows, CELL_OPEN)), 6)).toEqual([
      "2,2",
      "3,2",
      "2,3",
      "3,3",
    ]);
  });

  it("closes a room at its doorway: a gap of up to three tiles in one wall", () => {
    // Most buildings have a doorway with no door in it (a temple, a shop).
    const rows = [
      "..........",
      ".#######..",
      ".#.....#..",
      ".#.....#..",
      ".##...##..",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ];
    const got = inside(indoorTiles(10, 2, grid(rows, CELL_OPEN)), 10);
    // The 5 x 2 room and the three tiles of its doorway.
    expect(got).toHaveLength(13);
    expect(got).toContain("4,4");
    expect(got).not.toContain("4,5");
    // A doorway in a side wall, next to the corner.
    const side = ["......", ".####.", ".#....", ".#..#.", ".####.", "......"];
    expect(inside(indoorTiles(6, 2, grid(side, CELL_OPEN)), 6)).toEqual([
      "2,2",
      "3,2",
      "4,2",
      "2,3",
      "3,3",
    ]);
  });

  it("is outdoors through a gap wider than a doorway, and with no wall at all", () => {
    const rows = [
      "..........",
      ".#######..",
      ".#.....#..",
      ".#.....#..",
      ".#....##..",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ];
    expect(indoorTiles(10, 2, grid(rows, CELL_OPEN))).toBeNull();
    expect(indoorTiles(6, 2, () => CELL_OPEN)).toBeNull();
  });

  it("leaves the alley between two buildings under the sky: both walls go on beside it", () => {
    const rows = [
      "..........",
      ".###..###.",
      ".#.#..#.#.",
      ".#.#..#.#.",
      ".###..###.",
      "..........",
      "..........",
      "..........",
      "..........",
      "..........",
    ];
    // Only the two rooms: the two tiles between the houses are not a doorway.
    expect(inside(indoorTiles(10, 2, grid(rows, CELL_OPEN)), 10)).toEqual([
      "2,2",
      "7,2",
      "2,3",
      "7,3",
    ]);
  });

  it("takes walled ground bigger than a room for a courtyard under the sky", () => {
    // 22 x 22 open tiles inside a ring of walls: more than MAX_INDOOR_AREA.
    const yard = (x: number, y: number): number =>
      x >= 0 && x <= 23 && y >= 0 && y <= 23 && (x === 0 || y === 0 || x === 23 || y === 23)
        ? CELL_WALL
        : CELL_OPEN;
    expect(22 * 22).toBeGreaterThan(MAX_INDOOR_AREA);
    expect(indoorTiles(24, 2, yard)).toBeNull();
    // A hall of 18 x 18 is a room.
    const hall = (x: number, y: number): number =>
      x >= 0 && x <= 19 && y >= 0 && y <= 19 && (x === 0 || y === 0 || x === 19 || y === 19)
        ? CELL_WALL
        : CELL_OPEN;
    expect(inside(indoorTiles(24, 2, hall), 24)).toHaveLength(18 * 18);
  });

  it("counts a room next to what is not known as outdoors until its wall is seen", () => {
    const rows = ["######", "#....?", "#....?", "######", "......", "......"];
    expect(indoorTiles(6, 2, grid(rows, CELL_OPEN))).toBeNull();
    const seen = rows.map((r) => r.replace("?", "#"));
    expect(inside(indoorTiles(6, 2, grid(seen, CELL_OPEN)), 6)).toHaveLength(8);
  });

  it("looks beyond the chunk's edge for the way out, as far as its reach", () => {
    // The chunk is all open, the walls are in its neighbours, 2 tiles out on every side.
    const ring = (x: number, y: number): number =>
      x === -2 || y === -2 || x === 5 || y === 5 ? CELL_WALL : CELL_OPEN;
    expect(inside(indoorTiles(4, 3, ring), 4)).toHaveLength(16);
    // A town inside ramparts wider than the window is outdoors.
    expect(indoorTiles(4, 1, ring)).toBeNull();
  });
});

// The floor of a room never shows past its wall: the tile of a wall is split between the
// grounds of its two sides.
describe("groundSplit", () => {
  // A room of boards (b) with walls (#) on its edge tiles, on grass (.); the south wall has
  // a doorway at x = 3 and the tile (7, 2) is a spill past the east wall.
  const rows = ["........", ".bbbbbb.", ".bbbbbbb", ".bbbbbb.", ".bbbbbb.", "........"];
  const walls = new Set<string>();
  for (let y = 1; y <= 4; y++)
    for (let x = 1; x <= 6; x++)
      if ((x === 1 || x === 6 || y === 1 || y === 4) && !(x === 3 && y === 4))
        walls.add(`${x},${y}`);
  const groundAt = (x: number, y: number): string | null | undefined => {
    const c = rows[y]?.[x];
    return c === undefined ? undefined : c === "b" ? "boards" : "grass";
  };
  const wallAt = (x: number, y: number): boolean => walls.has(`${x},${y}`);
  const split = (x: number, y: number): number => groundSplit(x, y, groundAt, wallAt);

  it("gives the outer half of a wall's tile to the ground outside", () => {
    expect(split(1, 2)).toBe(WALL_W);
    expect(split(6, 3)).toBe(WALL_E);
    expect(split(4, 1)).toBe(WALL_N);
    expect(split(4, 4)).toBe(WALL_S);
    expect(split(1, 1)).toBe(WALL_N | WALL_W);
    expect(split(6, 4)).toBe(WALL_E | WALL_S);
  });

  it("splits the threshold of a doorway across the gap, and no other open tile", () => {
    expect(split(3, 4)).toBe(WALL_S);
    // Inside the room, on the grass, and on a floor tile that is in no gap.
    expect(split(3, 3)).toBe(0);
    expect(split(0, 2)).toBe(0);
    expect(split(7, 2)).toBe(0);
    // Grass in a gap between two walls with the same grass on both sides: nothing to show.
    expect(
      groundSplit(
        1,
        0,
        () => "grass",
        (x) => x !== 1,
      ),
    ).toBe(0);
  });

  it("leaves a wall between two tiles of its own ground whole", () => {
    expect(
      groundSplit(
        5,
        5,
        () => "boards",
        (x, y) => x === 5 && y === 5,
      ),
    ).toBe(0);
    // A wall next to another wall: that side is not split, whatever lies under it.
    expect(split(6, 2)).toBe(0);
  });

  it("knows nothing of a tile without ground, and never shows a neighbour without one", () => {
    expect(
      groundSplit(
        0,
        0,
        () => null,
        () => true,
      ),
    ).toBe(0);
    expect(
      groundSplit(
        0,
        0,
        (x, y) => (x === 0 && y === 0 ? "boards" : undefined),
        (x, y) => x === 0 && y === 0,
      ),
    ).toBe(0);
  });

  it("halves the tile towards each side", () => {
    expect(splitHalf(WALL_N)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(splitHalf(WALL_E)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(splitHalf(WALL_S)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(splitHalf(WALL_W)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });
});
