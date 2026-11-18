import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { outfitDir, outfitKey, outfitKeys } from "./outfit.ts";

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
