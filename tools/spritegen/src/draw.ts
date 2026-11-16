// Pixel-art primitives for the recipes. Everything draws opaque pixels (alpha 255) or
// clears them (alpha 0): sprites never have partial transparency. Coordinates are integer
// pixels; shapes use pixel centres (x + 0.5, y + 0.5) for their inside test.
// Randomness only from rng()/hash2() with a seed: same seed, same pixels.
import { createImage } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { darken, lighten } from "./palette.ts";
import type { Material } from "./palette.ts";

export type Rng = () => number;
export type Point = readonly [number, number];

// ---- randomness ------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG returning floats in [0, 1). */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string: the seed of a recipe is seedOf(its path). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hash of an integer lattice point to [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

/**
 * Smooth value noise in [0, 1) with cells of cellW x cellH pixels. It wraps every
 * `period` pixels (both axes), so a ground tile filled with period = tile size is seamless.
 * period must be a multiple of cellW and cellH.
 */
export function tileNoise(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  seed: number,
  period = 32,
): number {
  const gw = period / cellW;
  const gh = period / cellH;
  const fx = x / cellW;
  const fy = y / cellH;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = smooth(fx - x0);
  const ty = smooth(fy - y0);
  const v = (ix: number, iy: number): number => hash2(mod(ix, gw), mod(iy, gh), seed);
  const top = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * tx;
  const bottom = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * tx;
  return top + (bottom - top) * ty;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

// ---- pixels ----------------------------------------------------------------------------

/** A new transparent image (use as a layer, then composite()). */
export function canvas(width: number, height: number): Image {
  return createImage(width, height);
}

const inside = (img: Image, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < img.width && y < img.height;

/** Sets one opaque pixel; out-of-bounds writes are ignored. */
export function px(img: Image, x: number, y: number, c: Rgba): void {
  x = Math.floor(x);
  y = Math.floor(y);
  if (!inside(img, x, y)) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
  img.data[i + 3] = 255;
}

/** Makes one pixel transparent. */
export function clear(img: Image, x: number, y: number): void {
  if (!inside(img, x, y)) return;
  img.data.fill(0, (y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
}

/** The colour at (x, y), or undefined when transparent or out of bounds. */
export function get(img: Image, x: number, y: number): Rgba | undefined {
  if (!inside(img, x, y)) return undefined;
  const i = (y * img.width + x) * 4;
  if (img.data[i + 3] === 0) return undefined;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0, 255];
}

export function opaque(img: Image, x: number, y: number): boolean {
  return inside(img, x, y) && img.data[(y * img.width + x) * 4 + 3] !== 0;
}

/** Recolours an existing opaque pixel through f; transparent pixels stay transparent. */
export function tint(img: Image, x: number, y: number, f: (c: Rgba) => Rgba): void {
  const c = get(img, x, y);
  if (c) px(img, x, y, f(c));
}

// ---- shapes ----------------------------------------------------------------------------

export function rect(img: Image, x: number, y: number, w: number, h: number, c: Rgba): void {
  for (let py = y; py < y + h; py++) for (let qx = x; qx < x + w; qx++) px(img, qx, py, c);
}

/** Bresenham line, both ends included. */
export function line(img: Image, x0: number, y0: number, x1: number, y1: number, c: Rgba): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    px(img, x0, y0, c);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Calls fn for every pixel whose centre lies in the ellipse centred at (cx, cy) with radii
 * rx, ry (half-pixel centres allowed: cx = 16 centres on the seam between 15 and 16).
 * fn gets the normalised offsets nx, ny in [-1, 1].
 */
export function eachInEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fn: (x: number, y: number, nx: number, ny: number) => void,
): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) fn(x, y, nx, ny);
    }
  }
}

/** Filled ellipse (a disc when rx = ry). */
export function disc(img: Image, cx: number, cy: number, rx: number, ry: number, c: Rgba): void {
  eachInEllipse(cx, cy, rx, ry, (x, y) => px(img, x, y, c));
}

/** Calls fn for every pixel whose centre is inside the polygon (even-odd rule). */
export function eachInPolygon(pts: readonly Point[], fn: (x: number, y: number) => void): void {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.floor(Math.min(...ys));
  const y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i] ?? [0, 0];
      const [bx, by] = pts[(i + 1) % pts.length] ?? [0, 0];
      if (ay <= cy === by <= cy) continue;
      xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = xs[i] ?? 0;
      const to = xs[i + 1] ?? 0;
      for (let x = Math.ceil(from - 0.5); x + 0.5 < to; x++) fn(x, y);
    }
  }
}

/** Filled polygon; points are in pixel-edge coordinates ([0,0]-[32,32] covers a tile). */
export function polygon(img: Image, pts: readonly Point[], c: Rgba): void {
  eachInPolygon(pts, (x, y) => px(img, x, y, c));
}

/** Calls fn for every pixel of a rectangle. */
export function eachInRect(
  x: number,
  y: number,
  w: number,
  h: number,
  fn: (x: number, y: number) => void,
): void {
  for (let py = y; py < y + h; py++) for (let qx = x; qx < x + w; qx++) fn(qx, py);
}

/**
 * A box in 3/4 view: the top face (rows y .. y+top-1) lit, the front (south) face
 * (rows y+top .. y+top+front-1) in shadow. The top row and left column of the top face
 * get the light shade, the right column and the bottom row the deep shade.
 * Outline it afterwards with outline().
 */
export function box(
  img: Image,
  x: number,
  y: number,
  w: number,
  top: number,
  front: number,
  m: Material,
): void {
  rect(img, x, y, w, top, m.base);
  rect(img, x, y, w, 1, m.light);
  rect(img, x, y, 1, top, m.light);
  rect(img, x, y + top, w, front, m.shadow);
  rect(img, x, y + top, w, 1, m.deep); // the lip between top and front faces
  rect(img, x + w - 1, y, 1, top + front, m.deep);
  rect(img, x, y + top + front - 1, w, 1, m.deep);
}

// ---- shading ---------------------------------------------------------------------------

/** One of the four shades by light level in [0, 1]: >= .75 light, >= .45 base, ... */
export function shadeOf(m: Material, level: number): Rgba {
  if (level >= 0.75) return m.light;
  if (level >= 0.45) return m.base;
  if (level >= 0.2) return m.shadow;
  return m.deep;
}

/**
 * Light level in [0, 1] of a dome (sphere/ellipsoid) at normalised offset nx, ny from its
 * centre, lit from the top-left and above. Feed it to shadeOf().
 */
export function domeLight(nx: number, ny: number): number {
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const l = -0.55 * nx - 0.6 * ny + 0.58 * nz; // light from (-x, -y, +z)
  return Math.min(1, Math.max(0, (l + 0.35) / 1.25));
}

/**
 * Light level of a vertical cylinder across its width (u in [-1, 1], left to right):
 * lit on the left, dark on the right. Feed it to shadeOf().
 */
export function cylinderLight(u: number): number {
  return Math.min(1, Math.max(0, 0.62 - 0.55 * u - 0.35 * u * u));
}

/** Fills the rectangle with shades of m chosen by tileNoise (seamless over `period`). */
export function noiseFill(
  img: Image,
  x: number,
  y: number,
  w: number,
  h: number,
  m: Material,
  seed: number,
  opts: { cellW?: number; cellH?: number; period?: number; bias?: number } = {},
): void {
  const { cellW = 4, cellH = 4, period = 32, bias = 0 } = opts;
  eachInRect(x, y, w, h, (qx, qy) => {
    px(img, qx, qy, shadeOf(m, tileNoise(qx, qy, cellW, cellH, seed, period) + bias));
  });
}

/** 4-neighbour edge test: opaque with a transparent (or out-of-bounds) neighbour. */
function isEdge(img: Image, x: number, y: number): boolean {
  return (
    opaque(img, x, y) &&
    (!opaque(img, x - 1, y) ||
      !opaque(img, x + 1, y) ||
      !opaque(img, x, y - 1) ||
      !opaque(img, x, y + 1))
  );
}

/**
 * The auto outline: every opaque pixel that touches transparency (4-neighbour) is replaced
 * by a darker version of its own colour (amount 0.5 = half as bright), or by `color`.
 * Run it on a layer holding one object, before compositing it over the ground.
 * `edges: false` ignores the image border (only transparency inside the image counts).
 */
export function outline(
  img: Image,
  opts: { amount?: number; color?: Rgba; edges?: boolean } = {},
): void {
  const { amount = 0.5, color, edges = true } = opts;
  const marks: [number, number, Rgba][] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!isEdge(img, x, y)) continue;
      if (!edges) {
        // Only transparency inside the image counts, not the image border.
        const t = (qx: number, qy: number): boolean => inside(img, qx, qy) && !opaque(img, qx, qy);
        if (!t(x - 1, y) && !t(x + 1, y) && !t(x, y - 1) && !t(x, y + 1)) continue;
      }
      const c = get(img, x, y);
      if (c) marks.push([x, y, color ?? darken(c, amount)]);
    }
  }
  for (const [x, y, c] of marks) px(img, x, y, c);
}

/**
 * Top-left lighting of a shape's rim: the pixels just inside the outline get lighter on
 * the top and left sides and darker on the bottom and right sides. Run after outline().
 */
export function rimLight(img: Image, amount = 0.18): void {
  const innerAt = (x: number, y: number): boolean => opaque(img, x, y) && !isEdge(img, x, y);
  const marks: [number, number, Rgba][] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!innerAt(x, y)) continue;
      const c = get(img, x, y);
      if (!c) continue;
      if (!innerAt(x - 1, y) || !innerAt(x, y - 1)) marks.push([x, y, lighten(c, amount)]);
      else if (!innerAt(x + 1, y) || !innerAt(x, y + 1)) marks.push([x, y, darken(c, amount)]);
    }
  }
  for (const [x, y, c] of marks) px(img, x, y, c);
}

/** The colour of cast shadows: the near-black of the Dungeon Crawl creature shadows. */
export const SHADOW: Rgba = [8, 8, 10, 255];

/** The rows [top, bottom] that hold opaque pixels, or undefined for an empty image. */
export function opaqueRows(img: Image): [number, number] | undefined {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!opaque(img, x, y)) continue;
      if (top < 0) top = y;
      bottom = y;
      break;
    }
  }
  return top < 0 ? undefined : [top, bottom];
}

/** Default castShadow() offset toward the bottom-right, px, and where it starts (0..1). */
export const SHADOW_DX = 3;
export const SHADOW_DY = 1;
export const SHADOW_FROM = 0.4;

/**
 * The cast shadow of a figure lit from the top-left, as the Dungeon Crawl monsters have
 * it: the silhouette pushed up to (dx, dy) toward the bottom-right (every step between,
 * so the shadow always touches what casts it, even a thin quiver or a raised arm), drawn
 * only where the image is transparent (behind the figure) and only from `from` (a fraction
 * of the figure's height, 0 = its top row) down, so it falls from the shoulders and the
 * flanks onto the ground. Opaque, like everything else in a sprite. Run it last, after
 * outline().
 */
export function castShadow(
  img: Image,
  opts: { dx?: number; dy?: number; from?: number; color?: Rgba } = {},
): void {
  const { dx = SHADOW_DX, dy = SHADOW_DY, from = SHADOW_FROM, color = SHADOW } = opts;
  const rows = opaqueRows(img);
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (!rows || steps === 0) return;
  const startY = rows[0] + Math.round((rows[1] - rows[0]) * from);
  const shifts = Array.from({ length: steps }, (_, i): [number, number] => [
    Math.round(((i + 1) * dx) / steps),
    Math.round(((i + 1) * dy) / steps),
  ]);
  const marks: [number, number][] = [];
  for (let y = startY; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (opaque(img, x, y)) continue;
      if (shifts.some(([sx, sy]) => y - sy >= startY && opaque(img, x - sx, y - sy)))
        marks.push([x, y]);
    }
  for (const [x, y] of marks) px(img, x, y, color);
}

/** Copies the opaque pixels of src onto dst with src's top-left at (dx, dy). */
export function composite(dst: Image, src: Image, dx = 0, dy = 0): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const c = get(src, x, y);
      if (c) px(dst, x + dx, y + dy, c);
    }
  }
}

/** A horizontally mirrored copy. */
export function flipX(img: Image): Image {
  const out = canvas(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = get(img, x, y);
      if (c) px(out, img.width - 1 - x, y, c);
    }
  }
  return out;
}
