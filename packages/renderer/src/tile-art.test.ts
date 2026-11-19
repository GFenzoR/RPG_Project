import { describe, expect, it } from "vitest";
import type { TileArt } from "./tile-art.ts";
import {
  GLINT_MIN_MS,
  GLINT_SPREAD_MS,
  MAX_ELEVATION,
  TILE_PART,
  WALL_E,
  WALL_N,
  WALL_S,
  WALL_W,
  frameAt,
  framePhase,
  framesOfLook,
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
