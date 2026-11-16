// Map zoom (pure, unit-tested): pinch, the +/- buttons on touch screens and Ctrl+wheel on
// a PC. Only whole device pixels per sprite pixel (pixel-perfect, like the fitted view):
// from the scale that fits the whole 15x11 view (never less) up to the largest one that
// still shows MIN_VIEW tiles around the player. Zoomed in, the canvas is cropped to the
// map's box and stays centred on the player. The choice is remembered per device
// (localStorage) as a scale; none = fit the view, so it follows the window again.
import { VIEW_TILES, pixelScale } from "./viewport.ts";

/** Fewest tiles a zoomed-in view keeps showing (the player and 3 or 2 tiles around). */
export const MIN_VIEW = { width: 7, height: 5 } as const;

/** Scales a player may choose: device pixels per sprite pixel, from `min` to `max`. */
export interface ZoomRange {
  min: number;
  max: number;
}

/** The scale drawn now and its limits (the +/- buttons grey out at the ends). */
export interface ZoomView extends ZoomRange {
  scale: number;
}

/**
 * The scales that fit a map box of cssWidth x cssHeight CSS px: `min` shows the whole
 * view (the zoom of the client before zooming existed), `max` still shows MIN_VIEW.
 */
export function zoomRange(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  tileSize: number,
): ZoomRange {
  const min = pixelScale(cssWidth, cssHeight, dpr, tileSize);
  const max = Math.floor(
    Math.min(
      (cssWidth * dpr) / (MIN_VIEW.width * tileSize),
      (cssHeight * dpr) / (MIN_VIEW.height * tileSize),
    ),
  );
  return { min, max: Math.max(min, max) };
}

/** The scale to draw for the remembered choice (undefined = fit the view). */
export function zoomScale(pref: number | undefined, range: ZoomRange): number {
  if (pref === undefined || !Number.isFinite(pref)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(pref)));
}

/** What to remember for a scale: undefined at the fitted one (it follows the window). */
export function zoomPref(scale: number, range: ZoomRange): number | undefined {
  const s = zoomScale(scale, range);
  return s <= range.min ? undefined : s;
}

/** The choice after `steps` whole steps from `scale` (+ zooms in), within the range. */
export function stepZoom(scale: number, steps: number, range: ZoomRange): number | undefined {
  return zoomPref(scale + Math.trunc(steps), range);
}

/**
 * The scale while two fingers pinch: the scale when the pinch started times how much
 * the fingers spread (`ratio`), rounded to a whole scale within the range.
 */
export function pinchZoom(start: number, ratio: number, range: ZoomRange): number {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return zoomScale(start, range);
  return zoomScale(start * ratio, range);
}

/**
 * Canvas size in device pixels at `scale` in a box of devWidth x devHeight device pixels:
 * the whole view when it fits, else the box cut to whole sprite pixels (the camera keeps
 * the player in the middle).
 */
export function viewPixels(
  devWidth: number,
  devHeight: number,
  scale: number,
  tileSize: number,
): { width: number; height: number } {
  const cut = (box: number, tiles: number): number =>
    Math.max(scale, Math.min(tiles * tileSize * scale, Math.floor(box / scale) * scale));
  return { width: cut(devWidth, VIEW_TILES.width), height: cut(devHeight, VIEW_TILES.height) };
}

/** Wheel travel (px) per zoom step: one mouse notch, or a short trackpad pinch. */
export const WHEEL_STEP_PX = 50;
/** A pause this long (ms) between wheel events starts a new gesture. */
export const WHEEL_IDLE_MS = 250;
/** Pixels per wheel line and per page (WheelEvent.deltaMode 1 and 2, e.g. Firefox). */
const LINE_PX = 40;
const PAGE_PX = 800;

/**
 * Ctrl+wheel on the map: adds up the wheel travel and turns it into whole zoom steps,
 * one at a time, so a mouse notch is one step and a trackpad pinch (many small Ctrl+wheel
 * events) is not a dozen. Wheel up (negative deltaY) zooms in.
 */
export class WheelZoom {
  private travel = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** Feeds one wheel event (time in ms); returns the zoom steps to take now (-1, 0 or 1). */
  add(deltaY: number, deltaMode: number, t: number): number {
    if (t - this.last > WHEEL_IDLE_MS) this.travel = 0;
    this.last = t;
    const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * PAGE_PX : deltaY;
    if (!Number.isFinite(px)) return 0;
    this.travel += px;
    if (Math.abs(this.travel) < WHEEL_STEP_PX) return 0;
    const steps = this.travel < 0 ? 1 : -1;
    this.travel = 0;
    return steps;
  }
}

const ZOOM_KEY = "rpg.zoom";
/** A remembered scale above this is junk (no screen is that dense). */
const MAX_REMEMBERED = 32;

/** The remembered zoom of this device, or undefined (fit the view). */
export function loadZoom(storage: Pick<Storage, "getItem"> | undefined): number | undefined {
  try {
    const v = Number(storage?.getItem(ZOOM_KEY) ?? "");
    return Number.isInteger(v) && v >= 1 && v <= MAX_REMEMBERED ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveZoom(
  pref: number | undefined,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
): void {
  try {
    if (pref === undefined) storage?.removeItem(ZOOM_KEY);
    else storage?.setItem(ZOOM_KEY, String(pref));
  } catch {
    // Private mode or full storage: the zoom still works for this session.
  }
}
