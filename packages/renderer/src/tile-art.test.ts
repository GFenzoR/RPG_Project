import { describe, expect, it } from "vitest";
import {
  GLINT_MIN_MS,
  GLINT_SPREAD_MS,
  TILE_PART,
  WALL_E,
  WALL_N,
  WALL_S,
  WALL_W,
  frameAt,
  framePhase,
  pickVariant,
  resolveTileArt,
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
  ]);
  const lookup = (name: string): string | undefined => (atlas.has(name) ? name : undefined);

  it("lists variants, frames, wall pieces and the shadow the atlas has", () => {
    const grass = resolveTileArt("ground/grass", { variants: 3 }, lookup);
    // var_3 is missing: the looks stop at the first gap.
    expect(grass?.variants).toEqual(["ground/grass", "ground/grass/var_1", "ground/grass/var_2"]);
    expect(grass?.weight).toBe(0.7);
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
