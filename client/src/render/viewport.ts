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

/**
 * Camera that centres a view of `view` tiles (the whole 15x11, or fewer and fractional when
 * zoomed in: render/zoom.ts) on a (fractional) tile, snapped to whole device pixels (a
 * sprite pixel is `zoom` of them): the map scrolls one device pixel at a time, not one
 * sprite pixel (a jolt of `zoom` pixels every few frames). Sprites stay whole: they are
 * scaled by whole numbers and only moved by whole device pixels. The tile is snapped
 * first (devicePixels) and the half view after, so whoever the camera follows, drawn with
 * devicePixels, keeps the very same place on screen.
 */
export function followCamera(
  x: number,
  y: number,
  zoom: number,
  tileSize: number,
  view: { width: number; height: number } = VIEW_TILES,
): Camera {
  const unit = tileSize * zoom; // device pixels per tile
  const half = (n: number): number => Math.round((0.5 - n / 2) * unit);
  return {
    x: (Math.round(x * unit) + half(view.width)) / unit,
    y: (Math.round(y * unit) + half(view.height)) / unit,
    zoom,
  };
}

/** A position in tiles as sprite pixels (what Pixi takes), snapped to whole device pixels. */
export const devicePixels = (v: number, tileSize: number, zoom: number): number =>
  Math.round(v * tileSize * zoom) / zoom;

/**
 * Bottom margin of the canvas in a box `boxHeight` CSS px tall for a view `viewHeight`
 * tall, so a strip of `reserve` px at the bottom of the box (the desktop hotbar) covers
 * no map when the box has room for it, and as little as it can when not: the canvas,
 * centred, moves up (at most to the top). The fitted view never shrinks for the strip.
 */
export function mapLift(boxHeight: number, viewHeight: number, reserve: number): number {
  const free = boxHeight - viewHeight;
  if (!(free > 0) || !(reserve > 0)) return 0;
  // Centred with a bottom margin m, the gap under the canvas is (free + m) / 2.
  return Math.min(free, Math.max(0, 2 * reserve - free));
}
