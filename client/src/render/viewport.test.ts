import { describe, expect, it } from "vitest";
import { devicePixels, followCamera, pixelScale, wholeScale } from "./viewport.ts";

describe("viewport", () => {
  it("scales by whole device pixels per sprite pixel", () => {
    // 15x11 tiles of 32 px = 480x352 sprite pixels.
    expect(pixelScale(1280, 720, 1, 32)).toBe(2);
    expect(pixelScale(1920, 1080, 1, 32)).toBe(3);
    expect(pixelScale(1280, 720, 2, 32)).toBe(4);
    expect(pixelScale(300, 200, 1, 32)).toBe(1);
  });

  it("finds the largest scale that shows a whole window", () => {
    const wide = { width: 31, height: 21 };
    // 31x21 tiles of 32 px = 992x672 sprite pixels.
    expect(wholeScale(1680, 1043, 1, 32, wide)).toBe(1);
    expect(wholeScale(2330, 1352, 1, 32, wide)).toBe(2);
    expect(wholeScale(1216, 780, 2, 32, wide)).toBe(2);
    expect(wholeScale(900, 600, 1, 32, wide)).toBe(0);
  });

  it("centres the view on the tile and snaps to device pixels", () => {
    expect(followCamera(100, 50, 2, 32)).toEqual({ x: 93, y: 45, zoom: 2 });
    const c = followCamera(100.51, 50, 2, 32);
    expect(c.x * 64).toBeCloseTo(Math.round(c.x * 64), 9);
  });

  it("scrolls a device pixel at a time and keeps the followed creature still on screen", () => {
    // Walking a tile in 30 frames at zoom 3: 96 device pixels, 3 or 4 a frame (never 0 or
    // 6, the sprite-pixel jolt), and the walker stays on the same device pixel.
    const view = { width: 361 / 32, height: 8 };
    const onScreen = (x: number): number =>
      (devicePixels(x, 32, 3) - followCamera(x, 50, 3, 32, view).x * 32) * 3;
    const still = onScreen(100);
    let last = Math.round(followCamera(100, 50, 3, 32, view).x * 96);
    for (let f = 1; f <= 30; f++) {
      const x = 100 + f / 30;
      expect(onScreen(x)).toBeCloseTo(still, 9);
      const at = Math.round(followCamera(x, 50, 3, 32, view).x * 96);
      expect([3, 4]).toContain(at - last);
      last = at;
    }
  });

  it("centres a cropped (zoomed-in) view on the tile too", () => {
    // 11.25 x 8.25 tiles shown: the tile's centre is in the middle of the view.
    const c = followCamera(100, 50, 3, 32, { width: 11.25, height: 8.25 });
    expect(c).toEqual({ x: 100.5 - 11.25 / 2, y: 50.5 - 8.25 / 2, zoom: 3 });
    const odd = followCamera(100, 50, 3, 32, { width: 361 / 32, height: 8 });
    expect(odd.x * 96).toBeCloseTo(Math.round(odd.x * 96), 9);
  });
});
