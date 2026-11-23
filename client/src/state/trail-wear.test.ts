import { create, TrailWearSchema } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { TrailWearState } from "./trail-wear.ts";

const wear = (z: number, tiles: [number, number, number][]) =>
  create(TrailWearSchema, {
    z,
    tiles: tiles.map(([x, y]) => (x << 16) | y),
    levels: Uint8Array.from(tiles.map(([, , l]) => l)),
  });

describe("TrailWearState", () => {
  it("unpacks tiles, applies deltas and forgets recovered grass", () => {
    const s = new TrailWearState();
    s.apply(
      wear(7, [
        [3000, 6000, 2],
        [3001, 6000, 3],
      ]),
    );
    expect(s.level(3000, 6000, 7)).toBe(2);
    expect(s.level(3001, 6000, 7)).toBe(3);
    const v = s.version;
    s.apply(wear(7, [[3000, 6000, 2]])); // the same level: nothing changes
    expect(s.version).toBe(v);
    s.apply(wear(7, [[3000, 6000, 0]]));
    expect(s.level(3000, 6000, 7)).toBe(0);
    expect(s.size).toBe(1);
    expect(s.version).toBeGreaterThan(v);
  });

  it("an area replaces what was worn inside it, on every floor, and keeps the rest", () => {
    const s = new TrailWearState();
    s.apply(
      wear(7, [
        [10, 10, 1],
        [20, 10, 3],
      ]),
    );
    s.apply(wear(6, [[11, 10, 2]]));
    // A slice of x 10..12, y 0..20 that comes with one worn tile.
    s.applyArea(10, 0, 3, 21, [wear(7, [[12, 5, 2]])]);
    expect(s.level(10, 10, 7)).toBe(0);
    expect(s.level(11, 10, 6)).toBe(0);
    expect(s.level(12, 5, 7)).toBe(2);
    expect(s.level(20, 10, 7)).toBe(3);
    s.keepInside(0, 0, 15, 15);
    expect(s.list()).toEqual([{ x: 12, y: 5, z: 7, level: 2 }]);
    s.clear();
    expect(s.size).toBe(0);
  });
});
