import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { outfitDir, outfitFrame, outfitKey, outfitKeys, stepProgress } from "./outfit.ts";

describe("outfit frames", () => {
  it("maps 8 directions to n/e/s/w, diagonals to their horizontal half", () => {
    expect(outfitDir(Direction.NORTH)).toBe("n");
    expect(outfitDir(Direction.SOUTH)).toBe("s");
    expect(outfitDir(Direction.EAST)).toBe("e");
    expect(outfitDir(Direction.WEST)).toBe("w");
    expect(outfitDir(Direction.NORTH_EAST)).toBe("e");
    expect(outfitDir(Direction.SOUTH_EAST)).toBe("e");
    expect(outfitDir(Direction.NORTH_WEST)).toBe("w");
    expect(outfitDir(Direction.SOUTH_WEST)).toBe("w");
    expect(outfitDir(Direction.UNSPECIFIED)).toBe("s");
  });

  it("measures the progress through the current step", () => {
    const walk = {
      from: { x: 0, y: 0, z: 7 },
      to: { x: 1, y: 0, z: 7 },
      start: 1000,
      duration: 400,
    };
    expect(stepProgress(undefined, 1000)).toBeUndefined();
    expect(stepProgress(walk, 1000)).toBe(0);
    expect(stepProgress(walk, 1100)).toBe(0.25);
    expect(stepProgress(walk, 1399)).toBeCloseTo(0.9975);
    expect(stepProgress(walk, 1400)).toBeUndefined(); // the step is over
    expect(stepProgress(walk, 900)).toBe(0); // clock skew: not before the start
    expect(stepProgress({ ...walk, duration: 0 }, 1000)).toBeUndefined();
  });

  it("stands on frame 0 and alternates the walking frames through a step", () => {
    expect(outfitFrame(undefined, 3)).toBe(0);
    expect(outfitFrame(0, 3)).toBe(1);
    expect(outfitFrame(0.49, 3)).toBe(1);
    expect(outfitFrame(0.5, 3)).toBe(2);
    expect(outfitFrame(0.99, 3)).toBe(2);
    expect(outfitFrame(1, 3)).toBe(2);
    expect(outfitFrame(0.7, 2)).toBe(1); // one walking frame
    expect(outfitFrame(0.7, 1)).toBe(0); // no walking frames
  });

  it("names the frames in the atlas", () => {
    expect(outfitKey("outfits/citizen", "s", 0)).toBe("outfits/citizen/s_0");
    const keys = outfitKeys({ id: "citizen", sprite: "outfits/citizen", frames: 3 });
    expect(keys).toHaveLength(12);
    expect(keys.slice(0, 3)).toEqual([
      "outfits/citizen/n_0",
      "outfits/citizen/n_1",
      "outfits/citizen/n_2",
    ]);
    expect(keys).toContain("outfits/citizen/w_2");
  });
});
