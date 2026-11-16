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

  it("centres a cropped (zoomed-in) view on the tile too", () => {
    // 11.25 x 8.25 tiles shown: the tile's centre is in the middle of the view.
    const c = followCamera(100, 50, 3, 32, { width: 11.25, height: 8.25 });
    expect(c).toEqual({ x: 100.5 - 11.25 / 2, y: 50.5 - 8.25 / 2, zoom: 3 });
    const odd = followCamera(100, 50, 3, 32, { width: 361 / 32, height: 8 });
    expect(odd.x * 32).toBe(Math.round(odd.x * 32));
  });
});
