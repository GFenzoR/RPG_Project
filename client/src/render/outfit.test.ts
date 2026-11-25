import { describe, expect, it } from "vitest";
import { outfitKey, outfitKeys } from "./outfit.ts";

describe("outfit frames", () => {
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
