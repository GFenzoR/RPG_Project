import { describe, expect, it } from "vitest";
import { followCamera, mapLift, pixelScale } from "./viewport.ts";

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

  it("lifts the canvas above the hotbar strip as far as the box allows (playtest m2)", () => {
    // 1280x800: a box of 732 px for a view of 704: 28 px to spare, the strip is 40: the
    // canvas goes to the top (the strip covers 12 px of the last row, not 40).
    expect(mapLift(732, 704, 40)).toBe(28);
    // 1920x1080: room to spare: the gap under the canvas is exactly the strip.
    const lift = mapLift(1012, 704, 40);
    expect((1012 - 704 + lift) / 2).toBe(308 / 2); // centred already clears 40 px
    expect(lift).toBe(0);
    // Room for the strip, but not when centred: the gap under it becomes the strip.
    const m = mapLift(800, 704, 60);
    expect((800 - 704 + m) / 2).toBe(60);
    // No strip, no room, a zoomed-in view that fills the box: nothing moves.
    expect(mapLift(732, 704, 0)).toBe(0);
    expect(mapLift(704, 704, 40)).toBe(0);
    expect(mapLift(700, 704, 40)).toBe(0);
  });
});
