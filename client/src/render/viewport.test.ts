import { describe, expect, it } from "vitest";
import { followCamera, pixelScale } from "./viewport.ts";

describe("viewport", () => {
  it("scales by whole device pixels per sprite pixel", () => {
    // 15x11 tiles of 32 px = 480x352 sprite pixels.
    expect(pixelScale(1280, 720, 1, 32)).toBe(2);
    expect(pixelScale(1920, 1080, 1, 32)).toBe(3);
    expect(pixelScale(1280, 720, 2, 32)).toBe(4);
    expect(pixelScale(300, 200, 1, 32)).toBe(1);
  });

  it("centres the view on the tile and snaps to sprite pixels", () => {
    expect(followCamera(100, 50, 2, 32)).toEqual({ x: 93, y: 45, zoom: 2 });
    const c = followCamera(100.51, 50, 2, 32);
    expect(c.x * 32).toBe(Math.round(c.x * 32));
  });
});
