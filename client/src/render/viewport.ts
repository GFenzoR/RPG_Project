// Pixel-perfect viewport math (pure, unit-tested): how big the game view is and where the
// camera sits.
import type { Camera } from "@rpg/renderer/camera";

/** Visible tiles (client/CLAUDE.md). The server sends one more tile on every side. */
export const VIEW_TILES = { width: 15, height: 11 } as const;

/** Device pixels per sprite pixel: the largest whole number that fits, at least 1. */
export function pixelScale(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  tileSize: number,
): number {
  const sx = (cssWidth * dpr) / (VIEW_TILES.width * tileSize);
  const sy = (cssHeight * dpr) / (VIEW_TILES.height * tileSize);
  return Math.max(1, Math.floor(Math.min(sx, sy)));
}

/** Camera that centres the view on a (fractional) tile, snapped to whole sprite pixels. */
export function followCamera(x: number, y: number, zoom: number, tileSize: number): Camera {
  const snap = (v: number): number => Math.round(v * tileSize) / tileSize;
  return {
    x: snap(x + 0.5 - VIEW_TILES.width / 2),
    y: snap(y + 0.5 - VIEW_TILES.height / 2),
    zoom,
  };
}
