// Tile effects: short frame strips effects/<name>/<frame> (0, 1, ...), 32x32, transparent,
// drawn over the creatures of their tile. The client plays the frames in order over a
// fixed time (client/src/render/effects.ts, which also maps each protocol effect id to its
// folder). Every frame of a strip shares the strip's seed, so particles keep their paths
// from one frame to the next; only lightning re-rolls its bolts on purpose (flicker).
//
// Original pixel art: bursts, sparkles and particles built from the draw.ts primitives,
// no sprite of any other game used as reference for shapes or timing.
import type { Image, Rgba } from "@rpg/spritepack";
import {
  canvas,
  clear,
  composite,
  disc,
  domeLight,
  eachInEllipse,
  eachInPolygon,
  hash2,
  line,
  opaque,
  outline,
  px,
  rng,
  seedOf,
  shadeOf,
  tileNoise,
} from "../draw.ts";
import type { Point, Rng } from "../draw.ts";
import { hex, material, PALETTE } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

/** Frames of every strip: the client spreads them evenly over its effect time. */
export const EFFECT_FRAMES = 6;

/** Centre of the tile, in pixel-edge coordinates. */
const C = 16;

const WHITE = hex("#ffffff");

// ---- materials -----------------------------------------------------------------------------

const BLOOD = material("#e0574a", "#b3241f", "#7d1714", "#4d0d0c");
const STEEL = material("#eef4ff", "#b6c8e2", "#7c92b6", "#4c5b7a");
const PUFF = material("#d9dbdf", "#acb0b6", "#80848b", "#585b61");
const HEAL = material("#e2ffd6", "#8fe878", "#46b04e", "#26723a");
const ARCANE = material("#f2e6ff", "#b994ff", "#7c56d4", "#4a2f8c");
const { gold: GOLD, rock: ROCK } = PALETTE;
const DUST = material("#cfc5b2", "#a39985", "#776e5f", "#4f4940");
const MINT = material("#e4fff2", "#93f0c8", "#45bf8d", "#237a5b");
const IMPACT = material("#fffaf0", "#e6dcc4", "#b4a688", "#786c56");
const SMOKE = material("#8a8280", "#666060", "#4a4544", "#302d2c");
const ICE = material("#e6f8ff", "#a6defa", "#5fa8d6", "#2f6896");
const VOLT = material("#f4ecff", "#cf9cff", "#9358e6", "#55309c");
const TOXIC = material("#dcf27e", "#93d24c", "#519c2e", "#2b5c1b");
const HOLY = material("#fffbe2", "#ffeb8f", "#e2bb4c", "#a47c26");
const DEATH = material("#b98ad6", "#6e4590", "#432a5c", "#22122e");
const DEATH_GLINT = hex("#ecd4ff");

/** Hottest first: a field value at or above `at` takes colour `c`. */
const FLAME: readonly { at: number; c: Rgba }[] = [
  { at: 0.8, c: hex("#fff4c2") },
  { at: 0.64, c: hex("#ffd36b") },
  { at: 0.47, c: hex("#f39a35") },
  { at: 0.3, c: hex("#c4581f") },
  { at: 0.17, c: hex("#7e2e12") },
];

// ---- helpers -------------------------------------------------------------------------------

type DrawFrame = (img: Image, f: number, t: number, seed: number) => void;

/**
 * The recipes of one strip: effects/<name>/0 .. <frames-1>. draw gets the frame, its time
 * t in [0, 1] (first frame 0, last 1) and the strip's seed.
 */
function strip(name: string, draw: DrawFrame, frames = EFFECT_FRAMES): RecipeBook {
  const out: RecipeBook = {};
  const seed = seedOf(`effects/${name}`);
  for (let f = 0; f < frames; f++) {
    out[`effects/${name}/${f}`] = {
      kind: "effect",
      draw: (img) => draw(img, f, frames > 1 ? f / (frames - 1) : 0, seed),
    };
  }
  return out;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** A particle: direction, speed (pixels over the whole strip), size and a free parameter. */
interface Mote {
  a: number;
  v: number;
  s: number;
  p: number;
}

/** n particles spread around the circle (jittered), reproducible from the seed. */
function motes(seed: number, n: number, speed: [number, number], size: [number, number]): Mote[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    a: ((i + r() * 0.8) / n) * Math.PI * 2,
    v: lerp(speed[0], speed[1], r()),
    s: lerp(size[0], size[1], r()),
    p: r(),
  }));
}

/** Pixels whose centre is between r - w/2 and r + w/2 from (cx, cy); keep(angle) cuts gaps. */
function ring(
  img: Image,
  cx: number,
  cy: number,
  r: number,
  w: number,
  c: Rgba,
  keep: (a: number) => boolean = () => true,
): void {
  const reach = r + w;
  for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
    for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (Math.abs(Math.hypot(dx, dy) - r) <= w / 2 && keep(Math.atan2(dy, dx))) px(img, x, y, c);
    }
  }
}

/** A one-pixel ellipse outline (rx, ry); keep(angle) cuts gaps (angle 0 = east, +pi/2 = south). */
function ellipseRing(
  img: Image,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: Rgba,
  keep: (a: number) => boolean = () => true,
): void {
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => {
    const ix = (x + 0.5 - cx) / Math.max(0.5, rx - 1);
    const iy = (y + 0.5 - cy) / Math.max(0.5, ry - 1);
    if (ix * ix + iy * iy > 1 && keep(Math.atan2(ny, nx))) px(img, x, y, c);
  });
}

/** A four-point twinkle at pixel (x, y): arms of length r, core pixel `core`. */
function twinkle(img: Image, x: number, y: number, r: number, arm: Rgba, core: Rgba): void {
  x = Math.round(x);
  y = Math.round(y);
  for (let d = 1; d <= r; d++) {
    px(img, x + d, y, arm);
    px(img, x - d, y, arm);
    px(img, x, y + d, arm);
    px(img, x, y - d, arm);
  }
  if (r >= 3) {
    for (const [dx, dy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const)
      px(img, x + dx, y + dy, arm);
  }
  px(img, x, y, core);
}

/** Corners of an n-point star around (cx, cy), alternating outer and inner radius. */
function starPoints(
  cx: number,
  cy: number,
  n: number,
  outer: number,
  inner: number,
  rot: number,
  jitter: readonly number[] = [],
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const r = i % 2 === 0 ? outer * (jitter[i / 2] ?? 1) : inner;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** Keeps each opaque pixel with probability `keep` (by a seeded hash): smoke thinning out. */
function dissolve(img: Image, keep: number, seed: number): void {
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (opaque(img, x, y) && hash2(x, y, seed) >= keep) clear(img, x, y);
}

/** A shaded ball of material m (lit from the top-left). */
function ball(img: Image, cx: number, cy: number, rx: number, ry: number, m: Material): void {
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => px(img, x, y, shadeOf(m, domeLight(nx, ny))));
}

/**
 * A puff of smoke or dust: four overlapping shaded balls around (cx, cy), outlined, then
 * thinned to `keep` of its pixels.
 */
function puff(
  img: Image,
  cx: number,
  cy: number,
  r: number,
  m: Material,
  seed: number,
  keep = 1,
): void {
  const layer = canvas(img.width, img.height);
  const rand = rng(seed);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rand();
    const d = r * 0.45 * rand();
    const br = r * (0.55 + 0.25 * rand());
    ball(layer, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, br, br * 0.85, m);
  }
  outline(layer, { color: m.deep });
  if (keep < 1) dissolve(layer, keep, seed ^ 0x5bd1e995);
  composite(img, layer);
}

/** Colours every pixel by a field in [0, 1] through a ramp (hottest first); below it: none. */
function fieldFill(
  img: Image,
  field: (x: number, y: number) => number,
  ramp: readonly { at: number; c: Rgba }[],
): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const v = field(x, y);
      const step = ramp.find((s) => v >= s.at);
      if (step) px(img, x, y, step.c);
    }
  }
}

/** A thick (glow) line under a thin bright core line. */
function glowLine(
  img: Image,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  glow: Rgba,
  core: Rgba,
): void {
  const [a, b, c, d] = [x0, y0, x1, y1].map(Math.round) as [number, number, number, number];
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const)
    line(img, a + dx, b + dy, c + dx, d + dy, glow);
  line(img, a, b, c, d, core);
}

// ---- strips --------------------------------------------------------------------------------

/** Effect 1: a hit that drew blood: a splash whose drops fly out and fall. */
const hit: DrawFrame = (img, f, t, seed) => {
  const core = [4, 4.5, 3.4, 2.2, 0, 0][f] ?? 0;
  if (core > 0) ball(img, C, C, core, core * 0.85, BLOOD);
  const k = easeOut(0.15 + 0.85 * t);
  for (const m of motes(seed, 14, [6, 13], [1, 2.3])) {
    const d = 2 + m.v * k;
    const x = C + Math.cos(m.a) * d;
    const y = C + Math.sin(m.a) * d * 0.8 + 7 * t * t;
    const shade = t < 0.3 ? BLOOD.base : t < 0.7 ? BLOOD.shadow : BLOOD.deep;
    if (f >= 1 && f <= 2) {
      // A streak behind the drop while it flies.
      const back = 2 + m.v * easeOut(0.15 + 0.85 * (t - 0.2));
      line(
        img,
        Math.floor(C + Math.cos(m.a) * back),
        Math.floor(C + Math.sin(m.a) * back * 0.8 + 7 * (t - 0.2) * (t - 0.2)),
        Math.floor(x),
        Math.floor(y),
        BLOOD.shadow,
      );
    }
    const r = m.s * (1 - 0.45 * t);
    if (r >= 1.4) {
      ball(img, x, y, r, r, BLOOD);
    } else {
      px(img, x, y, shade);
      px(img, x + 1, y, shade); // at least a two-pixel smear
    }
    if (t < 0.5 && r >= 1.4) px(img, x - 0.5, y - 0.5, BLOOD.light);
  }
};

/** Effect 2: blocked or missed: a steel spark that bursts into a small grey puff. */
const block: DrawFrame = (img, f, _t, seed) => {
  const sparks = motes(seed, 8, [0, 0], [0, 0]);
  if (f === 0) {
    twinkle(img, C, C, 4, STEEL.light, WHITE);
    twinkle(img, C, C, 1, WHITE, WHITE);
    return;
  }
  if (f === 1) {
    twinkle(img, C, C, 7, STEEL.base, WHITE);
    twinkle(img, C, C, 3, STEEL.light, WHITE);
    for (let d = 1; d <= 4; d++)
      for (const [sx, sy] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const)
        px(img, C + sx * d - (sx < 0 ? 1 : 0), C + sy * d - (sy < 0 ? 1 : 0), STEEL.shadow);
    return;
  }
  const puffR = [0, 0, 3, 4, 5, 6][f] ?? 6;
  const keep = [1, 1, 1, 0.85, 0.55, 0.35][f] ?? 0.35;
  puff(img, C, C + 1, puffR, PUFF, seed, keep);
  const r0 = [0, 0, 6, 10, 13, 14][f] ?? 14;
  const len = [0, 0, 3, 2, 1, 0][f] ?? 0;
  const c = f <= 2 ? STEEL.light : f <= 3 ? STEEL.base : STEEL.shadow;
  for (const s of sparks) {
    const ux = Math.cos(s.a);
    const uy = Math.sin(s.a);
    line(
      img,
      Math.floor(C + ux * r0),
      Math.floor(C + uy * r0),
      Math.floor(C + ux * (r0 + len)),
      Math.floor(C + uy * (r0 + len)),
      c,
    );
  }
};

/** Effect 3: healing: a soft ring on the ground and green sparkles rising. */
const heal: DrawFrame = (img, f, t, seed) => {
  const ringR = [7, 11, 13][f];
  if (ringR !== undefined) {
    const c = [HEAL.light, HEAL.base, HEAL.shadow][f] ?? HEAL.shadow;
    ellipseRing(img, C, 25, ringR, ringR * 0.4, c, (a) => f < 2 || Math.sin(a * 5) > -0.2);
  }
  const rand = rng(seed);
  for (let i = 0; i < 9; i++) {
    const x = 5 + rand() * 22;
    const y0 = 20 + rand() * 9;
    const rise = 9 + rand() * 9;
    const phase = rand() < 0.5 ? 0 : 1;
    const y = y0 - rise * t;
    const big = (f + phase) % 2 === 0 && f < 5;
    if (big) twinkle(img, x, y, 2, f < 3 ? HEAL.base : HEAL.shadow, HEAL.light);
    else twinkle(img, x, y, 1, f < 4 ? HEAL.light : HEAL.base, f < 3 ? WHITE : HEAL.light);
  }
};

/** Effect 4: conjuring: violet motes spiral in and flash. */
const conjure: DrawFrame = (img, f, _t, seed) => {
  const r = [13, 10, 7, 4][f];
  if (r !== undefined) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + f * 0.55;
      for (const [back, c] of [
        [0.5, ARCANE.deep],
        [0.25, ARCANE.shadow],
      ] as const) {
        const rb = r + 1.5;
        px(img, C + Math.cos(a - back) * rb, C + Math.sin(a - back) * rb, c);
      }
      const x = Math.floor(C + Math.cos(a) * r);
      const y = Math.floor(C + Math.sin(a) * r);
      px(img, x, y, ARCANE.light);
      px(img, x + 1, y, ARCANE.base);
      px(img, x, y + 1, ARCANE.base);
      px(img, x + 1, y + 1, ARCANE.shadow);
    }
    if (f === 3) twinkle(img, C, C, 2, ARCANE.base, WHITE);
    return;
  }
  if (f === 4) {
    ring(img, C, C, 6, 1, ARCANE.shadow, (a) => Math.cos(a * 8) > 0);
    twinkle(img, C, C, 9, ARCANE.base, WHITE);
    twinkle(img, C, C, 4, ARCANE.light, WHITE);
    return;
  }
  const rand = rng(seed);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand();
    const d = 8 + rand() * 4;
    twinkle(img, C + Math.cos(a) * d, C + Math.sin(a) * d, 1, ARCANE.base, ARCANE.light);
  }
  twinkle(img, C, C, 2, ARCANE.shadow, ARCANE.base);
};

/** Effect 5: a harvest: a golden glint and a ring of sparkles. */
const gather: DrawFrame = (img, f) => {
  const sparkleAt = (r: number, size: number, arm: Rgba, core: Rgba): void => {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 + Math.PI / 8;
      if (size === 0) px(img, C + Math.cos(a) * r, C + Math.sin(a) * r, arm);
      else twinkle(img, C + Math.cos(a) * r, C + Math.sin(a) * r, size, arm, core);
    }
  };
  switch (f) {
    case 0:
      twinkle(img, C, C, 4, GOLD.base, WHITE);
      twinkle(img, C, C, 2, GOLD.light, WHITE);
      sparkleAt(3, 0, GOLD.shadow, GOLD.shadow);
      break;
    case 1:
      ring(img, C, C, 4.5, 1, GOLD.shadow, (a) => Math.cos(a * 8) > 0);
      twinkle(img, C, C, 6, GOLD.base, WHITE);
      twinkle(img, C, C, 3, GOLD.light, WHITE);
      break;
    case 2:
      ring(img, C, C, 8, 1, GOLD.base, (a) => Math.sin(a * 6) > -0.3);
      twinkle(img, C, C, 4, GOLD.light, WHITE);
      sparkleAt(9.5, 1, GOLD.light, WHITE);
      break;
    case 3:
      ring(img, C, C, 11, 1, GOLD.shadow, (a) => Math.sin(a * 6 + 1) > 0.2);
      twinkle(img, C, C, 1, GOLD.base, GOLD.light);
      sparkleAt(12, 1, GOLD.light, GOLD.light);
      break;
    case 4:
      sparkleAt(13, 1, GOLD.base, GOLD.light);
      break;
    default:
      sparkleAt(14, 1, GOLD.shadow, GOLD.base);
  }
};

/** Effect 6: an attempt that got nothing: a puff of dust and two pebbles. */
const gatherMiss: DrawFrame = (img, f, t, seed) => {
  const keep = [1, 1, 0.9, 0.7, 0.45, 0.28][f] ?? 0.28;
  const spread = [0, 6, 8, 10, 11, 12][f] ?? 12;
  const cy = 24 - f * 0.8;
  puff(img, C, cy, 4 + f, DUST, seed, keep);
  if (f >= 1) {
    const side = 2.4 + f * 0.6;
    puff(img, C - spread, cy + 1.5, side, DUST, seed + 1, keep);
    puff(img, C + spread, cy + 1.5, side, DUST, seed + 2, keep);
  }
  if (f <= 3) {
    for (const dir of [-1, 1]) {
      const x = C + dir * (2 + 9 * t);
      const y = 22 - 14 * t + 22 * t * t;
      px(img, x, y, ROCK.light);
      px(img, x + 1, y, ROCK.base);
      px(img, x, y + 1, ROCK.shadow);
      px(img, x + 1, y + 1, ROCK.deep);
    }
  }
};

/** Effect 7: a condition spell or a cure: mint rings rising around the body, arrows up. */
const buff: DrawFrame = (img, _f, t) => {
  for (let k = 0; k < 3; k++) {
    const p = t * 1.4 - k * 0.3;
    if (p < 0 || p > 1) continue;
    const y = 27 - p * 20;
    const rx = 10 - p * 3;
    const ry = Math.max(1.5, 3 - p * 1.2);
    const c = p < 0.3 ? MINT.light : p < 0.7 ? MINT.base : MINT.shadow;
    // Front half solid, back half dotted: a ring around the body, not a flat line.
    ellipseRing(img, C, y, rx, ry, c, (a) => Math.sin(a) > 0 || Math.cos(a * 6) > 0.3);
  }
  for (const x of [5, 27]) {
    const y = Math.round(26 - t * 18 + (x > C ? 3 : 0));
    const c = t < 0.6 ? MINT.light : MINT.base;
    for (let d = 0; d < 3; d++) {
      px(img, x - d, y + d, c);
      px(img, x + d, y + d, c);
    }
    px(img, x, y + 1, MINT.shadow);
    px(img, x, y + 2, MINT.shadow);
  }
};

/** Effect 10: a physical blow (element 0): a pale star that shatters into debris and dust. */
const physical: DrawFrame = (img, f, _t, seed) => {
  const rand = rng(seed);
  const jitter = Array.from({ length: 8 }, () => 0.8 + rand() * 0.35);
  const debris = motes(seed + 7, 10, [11, 15], [1, 2]);
  if (f <= 2) {
    const outer = [6, 12, 13][f] ?? 13;
    const inner = [2.5, 4, 5][f] ?? 5;
    const layer = canvas(32, 32);
    eachInPolygon(starPoints(C, C, 8, outer, inner, -Math.PI / 2, jitter), (x, y) => {
      const d = Math.hypot(x + 0.5 - C, y + 0.5 - C);
      if (f === 2 && d < 4.5) return; // hollow: the burst breaks apart
      px(layer, x, y, d < 2.5 ? WHITE : d < outer * 0.5 ? IMPACT.light : IMPACT.base);
    });
    outline(layer, { color: IMPACT.deep });
    composite(img, layer);
    return;
  }
  const keep = [1, 1, 1, 0.85, 0.55, 0.3][f] ?? 0.3;
  puff(img, C, C + 1, f, SMOKE, seed, keep);
  for (const m of debris) {
    const d = m.v + (f - 3) * 1.5;
    const x = C + Math.cos(m.a) * d;
    const y = C + Math.sin(m.a) * d + (f - 3);
    const c = f === 3 ? IMPACT.shadow : IMPACT.deep;
    px(img, x, y, c);
    if (m.s > 1.5 && f < 5) px(img, x + 1, y, c);
  }
};

/** Effect 11: fire: flames leap up from the tile and die down to embers and smoke. */
const fire: DrawFrame = (img, f, t, seed) => {
  const H = [9, 17, 22, 21, 15, 8][f] ?? 8;
  const W = [5, 9, 11, 11, 9, 6][f] ?? 6;
  const B = 28;
  if (f === 5) puff(img, C, 12, 5, SMOKE, seed + 3, 0.5);
  fieldFill(
    img,
    (x, y) => {
      const h = B - (y + 0.5);
      // Nothing below the base or above the tallest tongue (no loose blobs of noise).
      if (h < -1 || h > H) return 0;
      const v = clamp01(h / H);
      const u = (x + 0.5 - C) / (W * (1 - 0.55 * v));
      if (Math.abs(u) > 1.2) return 0;
      const n = tileNoise(x, y + f * 6, 4, 4, seed);
      return (1 - u * u) * (1 - Math.pow(v, 1.3)) + (n - 0.5) * 0.55 * (0.35 + 0.8 * v);
    },
    FLAME,
  );
  const embers = motes(seed + 11, 7, [14, 24], [0, 1]);
  if (f >= 2) {
    for (const m of embers) {
      const x = C + (m.p - 0.5) * 22 + Math.sin(t * 6 + m.a) * 1.5;
      const y = B - 6 - m.v * (t - 0.2);
      px(img, x, y, m.s > 0.5 ? (FLAME[1]?.c ?? WHITE) : (FLAME[2]?.c ?? WHITE));
    }
  }
};

/** One ice crystal from (cx, cy) along angle a, length L, half-width w, lit on its top-left side. */
function crystal(img: Image, cx: number, cy: number, a: number, L: number, w: number): void {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const px_ = -uy;
  const py_ = ux;
  const tip: Point = [cx + ux * L, cy + uy * L];
  const mid = (s: number): Point => [
    cx + ux * L * 0.45 + px_ * w * s,
    cy + uy * L * 0.45 + py_ * w * s,
  ];
  const root = (s: number): Point => [cx + px_ * w * 0.4 * s, cy + py_ * w * 0.4 * s];
  // The side whose normal points to the top-left catches the light.
  const lit = px_ * -1 + py_ * -1 > 0 ? 1 : -1;
  eachInPolygon([root(lit), mid(lit), tip, [cx, cy]], (x, y) => px(img, x, y, ICE.light));
  eachInPolygon([root(-lit), mid(-lit), tip, [cx, cy]], (x, y) => px(img, x, y, ICE.base));
}

/** Effect 12: ice: crystals burst out of the tile, crack and shatter into frost. */
const ice: DrawFrame = (img, f, _t, seed) => {
  const rand = rng(seed);
  const shards = Array.from({ length: 6 }, (_, i) => ({
    a: -Math.PI / 2 + (i * Math.PI) / 3 + (rand() - 0.5) * 0.5,
    l: 0.75 + 0.35 * rand(),
  }));
  if (f <= 3) {
    const L = [5, 10, 13, 14][f] ?? 14;
    const layer = canvas(32, 32);
    for (const s of shards) crystal(layer, C, C, s.a, L * s.l, 2.6);
    if (f < 3) disc(layer, C, C, 3, 3, ICE.light);
    outline(layer, { color: ICE.deep });
    composite(img, layer);
    if (f >= 2) {
      for (const s of shards) {
        const tip = L * s.l - 2;
        px(img, C + Math.cos(s.a) * tip, C + Math.sin(s.a) * tip, WHITE);
      }
    }
    if (f === 3) {
      // Cracks across the crystals, and the first frost.
      for (const s of shards) {
        const d = L * s.l * 0.5;
        const x = C + Math.cos(s.a) * d;
        const y = C + Math.sin(s.a) * d;
        line(
          img,
          Math.round(x - Math.sin(s.a) * 2),
          Math.round(y + Math.cos(s.a) * 2),
          Math.round(x + Math.sin(s.a) * 2),
          Math.round(y - Math.cos(s.a) * 2),
          ICE.shadow,
        );
      }
      ring(img, C, C, 10, 1, ICE.base, (a) => Math.cos(a * 10) > 0.6);
    }
    return;
  }
  const layer = canvas(32, 32);
  for (const s of shards) {
    for (const [k, r] of [
      [0.55, 1.6],
      [1.05, 1.3],
    ] as const) {
      const d = 14 * s.l * k + (f - 3) * 3;
      if (f === 5 && k < 1) continue;
      ball(layer, C + Math.cos(s.a) * d, C + Math.sin(s.a) * d, r, r, ICE);
    }
  }
  outline(layer, { color: ICE.shadow, edges: false });
  composite(img, layer);
  const frost = motes(seed + 5, 8, [9, 13], [0, 0]);
  for (const m of frost) {
    const x = C + Math.cos(m.a) * m.v;
    const y = C + Math.sin(m.a) * m.v;
    twinkle(img, x, y, 1, f === 4 ? ICE.light : ICE.base, WHITE);
  }
};

/** A jagged bolt from (x, y) along angle a for `length` pixels; returns its points. */
function boltPoints(rand: Rng, x: number, y: number, a: number, length: number): Point[] {
  const steps = Math.max(2, Math.round(length / 3));
  const pts: Point[] = [[x, y]];
  for (let i = 1; i <= steps; i++) {
    const along = (length * i) / steps;
    const wobble = (rand() - 0.5) * 4.5;
    pts.push([
      x + Math.cos(a) * along - Math.sin(a) * wobble,
      y + Math.sin(a) * along + Math.cos(a) * wobble,
    ]);
  }
  return pts;
}

function drawBolt(img: Image, pts: readonly Point[], glow: Rgba, core: Rgba): void {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1] ?? [0, 0];
    const [bx, by] = pts[i] ?? [0, 0];
    glowLine(img, ax, ay, bx, by, glow, core);
  }
}

/** Effect 13: energy: an orb that throws crackling bolts (re-rolled every frame: flicker). */
const energy: DrawFrame = (img, f, _t, seed) => {
  const rand = rng(seed + f * 7919);
  const orb = [3, 4, 3, 2, 1.5, 0][f] ?? 0;
  const bolts = [3, 5, 6, 4, 3, 4][f] ?? 3;
  const length = [7, 13, 15, 11, 6, 4][f] ?? 4;
  const glow = f <= 2 ? VOLT.shadow : VOLT.deep;
  const core = f <= 2 ? VOLT.light : VOLT.base;
  for (let i = 0; i < bolts; i++) {
    const a = ((i + rand() * 0.6) / bolts) * Math.PI * 2;
    // Late frames: loose crackles around the tile instead of bolts from the centre.
    const from = f >= 4 ? 6 + rand() * 4 : 0;
    const pts = boltPoints(
      rand,
      C + Math.cos(a) * from,
      C + Math.sin(a) * from,
      a,
      length * (0.8 + rand() * 0.3),
    );
    drawBolt(img, pts, glow, core);
    if (f >= 1 && f <= 2) {
      const at = pts[Math.floor(pts.length / 2)] ?? [C, C];
      drawBolt(img, boltPoints(rand, at[0], at[1], a + (rand() < 0.5 ? 0.8 : -0.8), 5), glow, core);
    }
  }
  if (orb > 0) {
    ball(img, C, C, orb + 1, orb + 1, VOLT);
    disc(img, C, C, orb * 0.6, orb * 0.6, WHITE);
  }
  if (f === 5) {
    for (let i = 0; i < 6; i++) px(img, 4 + rand() * 24, 4 + rand() * 24, VOLT.light);
  }
};

/** Effect 14: earth (poison): a toxic splash, pebbles thrown up and bubbles that pop. */
const earth: DrawFrame = (img, f, t, seed) => {
  // A toxic puddle that soaks away, then bubbles rise from it and pop.
  const puddle = [7, 7.5, 6, 4][f];
  if (puddle !== undefined) {
    const layer = canvas(32, 32);
    ball(layer, C, 26, puddle, puddle * 0.38, TOXIC);
    outline(layer, { color: TOXIC.deep });
    if (f === 3) dissolve(layer, 0.6, seed);
    composite(img, layer);
  }
  if (f <= 3) {
    for (const m of motes(seed + 3, 4, [6, 11], [0, 0])) {
      const dir = Math.cos(m.a) >= 0 ? 1 : -1;
      const x = C + dir * (2 + m.v * t);
      const y = 24 - 18 * t + 26 * t * t - m.p * 4;
      px(img, x, y, ROCK.light);
      px(img, x + 1, y, ROCK.base);
      px(img, x, y + 1, ROCK.shadow);
      px(img, x + 1, y + 1, ROCK.deep);
    }
  }
  const rand = rng(seed);
  const pops: Point[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    // Spread across the tile so the bubbles never merge into one blob.
    const x = 6 + ((i + 0.5) * 20) / n + (rand() - 0.5) * 2;
    const y0 = 27 - rand() * 6;
    const rise = 10 + rand() * 10;
    const r0 = 1.3 + rand() * 0.9;
    const born = rand() * 0.3;
    const pop = 0.55 + rand() * 0.4;
    if (t < born) continue;
    const y = y0 - rise * (t - born);
    if (t >= pop) {
      if (t - pop < 0.2) pops.push([x, y]);
      continue;
    }
    const r = r0 * (0.8 + (t - born));
    const layer = canvas(32, 32);
    disc(layer, x, y, r, r, TOXIC.base);
    px(layer, x - r * 0.4, y - r * 0.4, TOXIC.light);
    outline(layer, { color: TOXIC.deep });
    composite(img, layer);
  }
  for (const [x, y] of pops)
    for (const [dx, dy] of [
      [-2, 0],
      [2, 0],
      [0, -2],
      [-1, 1],
      [1, 1],
    ] as const)
      px(img, x + dx, y + dy, TOXIC.shadow);
  if (f >= 3) {
    for (const m of motes(seed + 9, 8, [5, 12], [0, 0])) {
      px(img, C + Math.cos(m.a) * m.v, C - 2 + Math.sin(m.a) * m.v * 0.7 - t * 4, TOXIC.shadow);
    }
  }
};

/** Effect 15: holy: a beam of light comes down and opens into rays and sparkles. */
const holy: DrawFrame = (img, f, _t, seed) => {
  if (f <= 1) {
    const bottom = f === 0 ? 13 : 18;
    for (let y = 0; y <= bottom; y++) {
      const tip = y > bottom - 3;
      px(img, 14, y, tip ? HOLY.shadow : HOLY.base);
      px(img, 15, y, tip ? HOLY.base : HOLY.light);
      px(img, 16, y, tip ? HOLY.base : WHITE);
      px(img, 17, y, tip ? HOLY.shadow : HOLY.base);
      if (y % 4 === f * 2) {
        px(img, 12, y, HOLY.shadow);
        px(img, 19, y, HOLY.shadow);
      }
    }
    if (f === 1) twinkle(img, C, 18, 4, HOLY.light, WHITE);
    return;
  }
  const ray = (from: number, to: number, a: number, c: Rgba): void => {
    line(
      img,
      Math.round(C + Math.cos(a) * from),
      Math.round(C + Math.sin(a) * from),
      Math.round(C + Math.cos(a) * to),
      Math.round(C + Math.sin(a) * to),
      c,
    );
  };
  if (f === 2) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const len = i % 2 === 0 ? 12 : 9;
      ray(2, len, a, HOLY.base);
      ray(2, len * 0.45, a, HOLY.light);
    }
    ball(img, C, C, 3.5, 3.5, HOLY);
    disc(img, C, C, 1.8, 1.8, WHITE);
    return;
  }
  if (f === 3) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ray(4, i % 2 === 0 ? 14 : 11, a, HOLY.base);
    }
    disc(img, C, C, 2.2, 2.2, HOLY.light);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 2;
      twinkle(img, C + Math.cos(a) * 7, C + Math.sin(a) * 7, 1, HOLY.light, WHITE);
    }
    return;
  }
  if (f === 4) {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ray(i % 2 === 0 ? 10 : 8, i % 2 === 0 ? 15 : 12, a, HOLY.shadow);
    }
  }
  const sparkles = motes(seed, 8, [6, 12], [0, 0]);
  for (const m of sparkles) {
    const rise = f === 5 ? 3 : 0;
    twinkle(
      img,
      C + Math.cos(m.a) * m.v,
      C + Math.sin(m.a) * m.v - rise,
      m.p > 0.5 && f === 4 ? 2 : 1,
      f === 4 ? HOLY.base : HOLY.shadow,
      HOLY.light,
    );
  }
};

/** Effect 16: death: dark wisps spiral in and rise as a cloud with pale glints. */
const death: DrawFrame = (img, f, t, seed) => {
  const layer = canvas(32, 32);
  if (f >= 2) {
    const r = 2 + t * 4.5;
    ball(layer, C, C + 2 - t * 7, r, r * 0.85, DEATH);
  }
  // Four wisps on a tightening spiral, each a head with a thinning tail behind it.
  const rand = rng(seed);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + rand() * 0.6 + t * 2.4;
    const R = (9 + rand() * 4) * (1 - t * 0.75);
    const y = C + 3 - t * (5 + rand() * 3);
    for (const [back, size] of [
      [0.75, 1],
      [0.5, 1.4],
      [0.25, 1.9],
      [0, 2.5 - t],
    ] as const) {
      if (size < 1) continue;
      ball(layer, C + Math.cos(a - back) * R, y + Math.sin(a - back) * R * 0.6, size, size, DEATH);
    }
  }
  outline(layer, { color: DEATH.deep });
  if (f >= 4) dissolve(layer, f === 4 ? 0.7 : 0.45, seed);
  composite(img, layer);
  if (f >= 2) {
    const rand = rng(seed + f);
    for (let i = 0; i < 4; i++)
      px(img, C - 5 + rand() * 10, C - 2 - t * 7 + rand() * 8, DEATH_GLINT);
  }
};

/** Every effect strip, by folder name (client/src/render/effects.ts maps ids to these). */
export const EFFECTS: RecipeBook = {
  ...strip("hit", hit),
  ...strip("block", block),
  ...strip("heal", heal),
  ...strip("conjure", conjure),
  ...strip("gather", gather),
  ...strip("gather_miss", gatherMiss),
  ...strip("buff", buff),
  ...strip("physical", physical),
  ...strip("fire", fire),
  ...strip("ice", ice),
  ...strip("energy", energy),
  ...strip("earth", earth),
  ...strip("holy", holy),
  ...strip("death", death),
};
