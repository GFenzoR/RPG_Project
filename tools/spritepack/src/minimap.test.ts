import { describe, expect, it } from "vitest";
import { averageColor } from "./build.ts";
import { createImage } from "./image.ts";

describe("averageColor (the minimap colour of a sprite)", () => {
  it("averages the opaque pixels only, weighted by alpha", () => {
    const img = createImage(2, 2);
    // A red pixel, a blue one at half alpha and two transparent ones.
    img.data.set([255, 0, 0, 255], 0);
    img.data.set([0, 0, 255, 128], 4);
    img.data.set([0, 255, 0, 0], 8);
    expect(averageColor(img)).toBe("#aa0055");
  });
  it("is black for a fully transparent sprite", () => {
    expect(averageColor(createImage(4, 4))).toBe("#000000");
  });
});
