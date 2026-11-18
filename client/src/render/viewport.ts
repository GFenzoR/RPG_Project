// Pixel-perfect viewport math (pure, unit-tested): how big the game view is and where the
// camera sits.
import type { Camera } from "@rpg/renderer/camera";
import { CLASSIC_VIEW } from "../state/view.ts";
import type { ViewTiles } from "../state/view.ts";

/**
 * The largest whole scale (device pixels per sprite pixel) at which a box of cssWidth x
 * cssHeight CSS px shows all of `view`; 0 when not even 1 does.
 */
export function wholeScale(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  tileSize: number,
  view: ViewTiles,
): number {
  const sx = (cssWidth * dpr) / (view.width * tileSize);
  const sy = (cssHeight * dpr) / (view.height * tileSize);
  return Math.max(0, Math.floor(Math.min(sx, sy)));
}

/**
 * Device pixels per sprite pixel of the fitted view: the largest whole number that shows
 * the classic 15x11 tiles, at least 1. The canvas fills the map's box with as much of
 * the server's window (31x21) as fits at that scale (render/zoom.ts viewPixels).
 */
export function pixelScale(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  tileSize: number,
): number {
  return Math.max(1, wholeScale(cssWidth, cssHeight, dpr, tileSize, CLASSIC_VIEW));
}

/**
 * Camera that centres a view of `view` tiles (the whole window, or fewer and fractional
 * when cut to the map's box: render/zoom.ts) on a (fractional) tile, snapped to whole
 * device pixels (a sprite pixel is `zoom` of them): the map scrolls one device pixel at a
 * time, not one sprite pixel (a jolt of `zoom` pixels every few frames). Sprites stay
 * whole: they are scaled by whole numbers and only moved by whole device pixels. The tile
 * is snapped first (devicePixels) and the half view after, so whoever the camera follows,
 * drawn with devicePixels, keeps the very same place on screen.
 */
export function followCamera(
  x: number,
  y: number,
  zoom: number,
  tileSize: number,
  view: ViewTiles = CLASSIC_VIEW,
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
