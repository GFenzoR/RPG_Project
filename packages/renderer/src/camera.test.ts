import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  centerOn,
  pan,
  screenToTile,
  tileToScreen,
  visibleChunks,
  zoomAt,
} from "./camera.ts";

const T = 32;

describe("camera", () => {
  it("maps screen points to tiles and back", () => {
    const cam = { x: 100, y: 200, zoom: 2 };
    expect(screenToTile(cam, 0, 0, T)).toEqual({ x: 100, y: 200 });
    expect(screenToTile(cam, 63, 64, T)).toEqual({ x: 100, y: 201 });
    expect(tileToScreen(cam, 101, 202, T)).toEqual({ x: 64, y: 128 });
  });

  it("zooms around the cursor", () => {
    const cam = { x: 10, y: 10, zoom: 1 };
    const z = zoomAt(cam, 2, 160, 96, T);
    expect(z.zoom).toBe(2);
    // The world point under the cursor stays under the cursor.
    expect(screenToTile(z, 160, 96, T)).toEqual(screenToTile(cam, 160, 96, T));
    expect(z.x).toBeCloseTo(12.5);
    expect(zoomAt(cam, 1000, 0, 0, T).zoom).toBe(MAX_ZOOM);
  });

  it("pans by screen pixels", () => {
    expect(pan({ x: 10, y: 10, zoom: 0.5 }, 32, -16, T)).toEqual({ x: 8, y: 11, zoom: 0.5 });
  });

  it("centres a tile", () => {
    const c = centerOn({ x: 0, y: 0, zoom: 1 }, 1056, 1056, { width: 640, height: 480 }, T);
    expect(screenToTile(c, 320, 240, T)).toEqual({ x: 1056, y: 1056 });
  });

  it("lists the chunks in view with a margin", () => {
    const cam = { x: 1024, y: 1024, zoom: 1 };
    expect(visibleChunks(cam, { width: 32 * 40, height: 32 * 10 }, T)).toEqual({
      cx0: 31,
      cy0: 31,
      cx1: 33,
      cy1: 32,
    });
    expect(visibleChunks(cam, { width: 32 * 40, height: 32 * 10 }, T, 0)).toEqual({
      cx0: 32,
      cy0: 32,
      cx1: 33,
      cy1: 32,
    });
  });
});
