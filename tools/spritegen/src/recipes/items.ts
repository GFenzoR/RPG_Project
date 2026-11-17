// Inventory and ground item icons: 32x32, centred, transparent background, a single
// readable silhouette lit from the top-left. Long things (rods, logs, tools) lie on the
// bottom-left to top-right diagonal, like the Dungeon Crawl weapons and tools.
import type { Image, Rgba } from "@rpg/spritepack";
import {
  cylinderLight,
  domeLight,
  eachInEllipse,
  eachInPolygon,
  eachInRect,
  get,
  hash2,
  line,
  opaque,
  outline,
  px,
  rect,
  shadeOf,
  tileNoise,
  tint,
} from "../draw.ts";
import type { Point, Rng } from "../draw.ts";
import { darken, hex, lighten, material, mix, PALETTE } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

const { wood, darkWood, iron, darkIron, silver, leather, cloth, rope, bone } = PALETTE;

// One-off materials for single items.
const BIRCH_BARK = material("#ece8dc", "#d2cdbd", "#a8a291", "#6f6a5c");
const ELM_BARK = material("#8a7b62", "#685a45", "#4b4031", "#2f281e");
const END_GRAIN = material("#e2c48e", "#c9a46c", "#a37f4d", "#735634");
const THORNWOOD = material("#8a4e4a", "#653434", "#472323", "#2d1515");
const CANVAS = material("#c2b58c", "#9f9269", "#776c4c", "#504833");
const STAG_LEATHER = material("#c09466", "#9a6e45", "#704e2f", "#4a321d");
const ANTLER = material("#ddcda8", "#b8a077", "#8c7553", "#5e4d35");
const IVORY = material("#f5eedb", "#ddd1b0", "#b3a27c", "#7e6f50");
const CRAB = material("#ec8a5a", "#c75a34", "#923a22", "#5e2215");
/** The membrane of a bat wing, warm and light enough to read on dark ground. */
const BAT = material("#a8897d", "#7d6058", "#5a4440", "#3c2c2a");
const BAT_BONE = material("#efe2cc", "#cdb89a", "#9d8a6e", "#6c5c47");
const BEETLE = material("#5d9a8a", "#3a675f", "#264540", "#162a28");
const CHITIN = material("#f4efdf", "#d9cfb2", "#ab9d7c", "#73654a");
/** Coin copper: brighter than the copper material so a small pile reads on dark ground. */
const COIN_COPPER = material("#f2b37c", "#cf7f45", "#9a552b", "#62321a");
/** Seaweed poultice: bright fronds, the pale linen pad and the dark twine that ties it. */
const FROND = material("#a3c45e", "#739a3c", "#4e702b", "#30481b");
const LINEN = material("#f3ecd6", "#d8ccaa", "#ab9e7c", "#776c52");
const TWINE = material("#a57a4c", "#7d5733", "#5a3d22", "#3b2614");
const TOAD = material("#b4be66", "#879441", "#5f6a2a", "#3c4319");
const GLOW = material("#e4fff0", "#9ff0c4", "#56b993", "#2f7462");
const QUARTZ = material("#f6fdff", "#d3eaf2", "#a0c3d0", "#6a8f9f");
const FISH = material("#b4ccd4", "#86a6b4", "#5d7d90", "#3d5466");
const FISH_BELLY = material("#f4ebe0", "#e0d0c2", "#bba796", "#87735f");
const GRILLED = material("#e0ae68", "#b07a40", "#7e5026", "#523116");
const KELP = material("#7c9a52", "#56763a", "#3d5629", "#273a1a");
const STEW = material("#b88250", "#8f5f35", "#664124", "#442a16");
const BROTH = material("#f6f1a6", "#dccd5c", "#ad9c37", "#716521");
const GLAZE = material("#93a7b4", "#6e8291", "#50616e", "#35424c");
const SLAG = material("#6a625e", "#4a4441", "#332f2d", "#211e1d");
const ORE_ROCK = material("#5e5856", "#433f3e", "#2f2c2b", "#1d1b1b");

// ---- shape helpers -----------------------------------------------------------------------

/**
 * Pixels within distance r of the segment (x0,y0)-(x1,y1), r tapering from r0 to r1.
 * fn gets u in [-1, 1] across the stroke (-1 on the side facing the top-left light) and
 * t in [0, 1] along it. Feed u to cylinderLight().
 */
function eachInCapsule(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r0: number,
  r1: number,
  fn: (x: number, y: number, u: number, t: number) => void,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  const len = Math.sqrt(len2);
  let nx = -dy / len;
  let ny = dx / len;
  if (nx + ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const r = Math.max(r0, r1);
  const xa = Math.floor(Math.min(x0, x1) - r - 1);
  const xb = Math.ceil(Math.max(x0, x1) + r + 1);
  const ya = Math.floor(Math.min(y0, y1) - r - 1);
  const yb = Math.ceil(Math.max(y0, y1) + r + 1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const px0 = x + 0.5 - x0;
      const py0 = y + 0.5 - y0;
      const t = Math.min(1, Math.max(0, (px0 * dx + py0 * dy) / len2));
      const ex = px0 - t * dx;
      const ey = py0 - t * dy;
      const rr = r0 + (r1 - r0) * t;
      if (ex * ex + ey * ey > rr * rr) continue;
      fn(x, y, -(ex * nx + ey * ny) / rr, t);
    }
  }
}

/**
 * Calls fn for the pixels within `reach` of (cx, cy) with coordinates in a frame rotated
 * by angle degrees (clockwise on screen): lx runs along (cos a, sin a), ly across it.
 */
function eachRotated(
  cx: number,
  cy: number,
  angle: number,
  reach: number,
  fn: (x: number, y: number, lx: number, ly: number) => void,
): void {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let y = Math.floor(cy - reach); y <= Math.ceil(cy + reach); y++) {
    for (let x = Math.floor(cx - reach); x <= Math.ceil(cx + reach); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      fn(x, y, dx * c + dy * s, -dx * s + dy * c);
    }
  }
}

/** A tapered stroke shaded as a round rod (light on the top-left side). */
function rod(img: Image, a: Point, b: Point, r0: number, r1: number, m: Material, bias = 0): void {
  eachInCapsule(a[0], a[1], b[0], b[1], r0, r1, (x, y, u) =>
    px(img, x, y, shadeOf(m, cylinderLight(u) + bias)),
  );
}

/** A shaded ellipse (dome light) with a texture offset per pixel from noise(x, y). */
function blob(
  img: Image,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  m: Material,
  bias = 0,
  noise: (x: number, y: number) => number = () => 0,
): void {
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) =>
    px(img, x, y, shadeOf(m, domeLight(nx, ny) + bias + noise(x, y))),
  );
}

// ---- currency ----------------------------------------------------------------------------

/**
 * One coin lying flat in 3/4 view: a 2 px edge under an elliptic face with a raised rim,
 * lit from the top-left, and an embossed ring in the middle (shadow above, light below).
 */
function coin(img: Image, cx: number, cy: number, m: Material): void {
  eachInEllipse(cx, cy + 2, 6.5, 3.6, (x, y, nx) => px(img, x, y, nx < -0.4 ? m.shadow : m.deep));
  eachInEllipse(cx, cy, 6.5, 3.6, (x, y, nx, ny) => {
    const d = nx * nx + ny * ny;
    const side = -(nx + ny * 0.8); // > 0 toward the top-left
    let c: Rgba = m.base;
    if (d > 0.62)
      c = side > 0.2 ? m.light : side < -0.3 ? m.shadow : m.base; // the rim
    else if (d > 0.14 && d < 0.34) c = ny < 0 ? m.shadow : m.light; // the embossed ring
    px(img, x, y, c);
  });
  const glint = lighten(m.light, 0.5);
  px(img, Math.floor(cx) - 3, Math.floor(cy) - 2, glint);
  px(img, Math.floor(cx) - 2, Math.floor(cy) - 2, glint);
}

/** A small pile of three coins (the gold coin icon's layout), dark-rimmed to read at 1x. */
function coinPile(m: Material): (img: Image) => void {
  return (img) => {
    coin(img, 10.5, 11.5, m);
    coin(img, 21.5, 14.5, m);
    coin(img, 13, 21.5, m);
    outline(img, { amount: 0.65 });
  };
}

// ---- materials: wood ---------------------------------------------------------------------

/**
 * A log lying on the diagonal, cut end (rings) toward the viewer at the bottom-left.
 * bark(x, y, u, s) returns a light-level offset for the bark texture (s = px along it).
 */
function log(
  img: Image,
  barkM: Material,
  endM: Material,
  bark: (x: number, y: number, u: number, s: number) => number,
  a: Point = [9, 22],
  b: Point = [24, 9],
  r = 5,
): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  eachInCapsule(a[0], a[1], b[0], b[1], r, r, (x, y, u, t) =>
    px(img, x, y, shadeOf(barkM, cylinderLight(u) + bark(x, y, u, t * len))),
  );
  // The sawn end: an ellipse perpendicular to the log axis, with growth rings.
  eachRotated(a[0], a[1], -41, r + 1, (x, y, lx, ly) => {
    const nx = lx / 2.6;
    const ny = ly / (r - 0.3);
    const d = Math.sqrt(nx * nx + ny * ny);
    if (d > 1) return;
    let c: Rgba;
    if (d > 0.82) c = barkM.deep;
    else if (Math.abs(d - 0.55) < 0.09 || Math.abs(d - 0.28) < 0.08) c = endM.shadow;
    else c = ly < -0.5 && d > 0.4 ? endM.light : endM.base;
    if (d < 0.12) c = endM.deep;
    px(img, x, y, c);
  });
}

function birchLog(img: Image, _rand: Rng, seed: number): void {
  // White bark with short dark horizontal marks (lenticels) across the log.
  log(img, BIRCH_BARK, END_GRAIN, (x, y, u, s) => {
    const band = Math.floor(s / 3);
    const lane = Math.floor((u + 1) * 2.2);
    if (s % 3 < 1.1 && hash2(band, lane, seed) > 0.55) return -0.75;
    return (hash2(x, y, seed) - 0.5) * 0.12;
  });
  outline(img, { amount: 0.55 });
}

function elmLog(img: Image, _rand: Rng, seed: number): void {
  // Brown-grey bark in deep ridges running along the log.
  log(img, ELM_BARK, END_GRAIN, (_x, _y, u, s) => {
    const ridge = ((u + 1) * 5 + tileNoise(s, 0, 4, 1, seed) * 1.2) % 2;
    return ridge < 0.65 ? -0.32 : (tileNoise(s * 2, u * 8, 3, 2, seed) - 0.5) * 0.2;
  });
  outline(img, { amount: 0.5 });
}

/** A short split billet of dark red heartwood with a couple of thorns left on its bark. */
function thornHeartwood(img: Image, _rand: Rng, seed: number): void {
  const heart = material("#c0605a", "#9a4038", "#702a26", "#4a1a18");
  for (const [tx, ty, ex, ey] of [
    [13, 13, 10, 8],
    [20, 9, 21, 4],
    [22, 15, 27, 14],
  ] as const) {
    line(img, tx, ty, ex, ey, THORNWOOD.shadow);
    line(img, tx + 1, ty, ex, ey, THORNWOOD.base);
  }
  log(
    img,
    THORNWOOD,
    heart,
    (x, y) => (tileNoise(x * 2, y, 2, 4, seed) - 0.5) * 0.3,
    [10, 22],
    [22, 11],
    5,
  );
  outline(img, { amount: 0.5 });
}

// ---- materials: metal and stone ----------------------------------------------------------

/**
 * One small trapezoid bar with its top-left corner at (x, y): lit top face, sloped front
 * in shadow, a maker's stamp. glow (embersteel) paints the edges with that material.
 */
function ingot(img: Image, x: number, y: number, m: Material, glow?: Material): void {
  eachInPolygon(
    [
      [x + 2, y],
      [x + 11, y],
      [x + 13, y + 7],
      [x, y + 7],
    ],
    (qx, qy) => px(img, qx, qy, qx > x + 10 + (qy - y) * 0.25 ? m.deep : m.shadow),
  );
  eachInPolygon(
    [
      [x + 2, y],
      [x + 11, y],
      [x + 12, y + 4],
      [x + 1, y + 4],
    ],
    (qx, qy) => px(img, qx, qy, qy === y || qx <= x + 2 ? m.light : m.base),
  );
  line(img, x + 1, y + 4, x + 11, y + 4, m.light); // the edge between top and front
  line(img, x + 1, y + 6, x + 12, y + 6, m.deep);
  rect(img, x + 5, y + 1, 3, 2, m.shadow); // stamp
  if (!glow) return;
  line(img, x + 1, y + 4, x + 11, y + 4, glow.base);
  line(img, x + 1, y + 6, x + 12, y + 6, glow.shadow);
  line(img, x + 2, y, x + 10, y, glow.deep);
  px(img, x + 2, y + 4, glow.light);
  rect(img, x + 5, y + 1, 3, 2, glow.deep);
}

/** A stack of three bars: two below, one on top. */
function ingotStack(m: Material, glow?: Material): (img: Image) => void {
  return (img) => {
    ingot(img, 3, 19, m, glow);
    ingot(img, 16, 19, m, glow);
    ingot(img, 9, 12, m, glow);
    if (glow) outline(img, { amount: 0.5, color: darken(glow.deep, 0.5) });
    else outline(img, { amount: 0.5 });
  };
}

/** A faceted lump: dome light broken into flat facets by a coarse cell hash. */
function lump(img: Image, pts: Point[], m: Material, seed: number, cx: number, cy: number): void {
  const rx = Math.max(...pts.map((p) => Math.abs(p[0] - cx)));
  const ry = Math.max(...pts.map((p) => Math.abs(p[1] - cy)));
  eachInPolygon(pts, (x, y) => {
    const fx = Math.floor((x + y * 0.5) / 5);
    const fy = Math.floor((y - x * 0.3) / 5);
    const facet = (hash2(fx, fy, seed) - 0.5) * 0.3;
    const l = domeLight((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
    px(img, x, y, shadeOf(m, Math.round((l + facet) * 4) / 4));
  });
}

function emberOre(img: Image, _rand: Rng, seed: number): void {
  lump(
    img,
    [
      [9, 12],
      [15, 7],
      [23, 9],
      [27, 17],
      [24, 25],
      [12, 26],
      [6, 20],
    ],
    ORE_ROCK,
    seed,
    16,
    17,
  );
  const vein = material("#e0704a", "#b34a32", "#7e2e22", "#4e1a14");
  // Threads of reddish metal through the black stone.
  const veins: [number, number, number, number][] = [
    [9, 15, 15, 18],
    [15, 18, 22, 15],
    [22, 15, 25, 19],
    [13, 23, 18, 20],
    [18, 20, 20, 24],
    [16, 10, 19, 13],
  ];
  for (const [a, b, c, d] of veins) line(img, a, b, c, d, vein.shadow);
  for (const [x, y] of [
    [11, 16],
    [17, 17],
    [17, 11],
    [15, 21],
    [23, 16],
  ] as const)
    px(img, x, y, vein.light);
  px(img, 18, 17, vein.base);
  outline(img, { amount: 0.4 });
}

/** A heavy round slag lump with glowing cracks: the still-hot heart of a golem. */
function slagCore(img: Image, _rand: Rng, seed: number): void {
  blob(img, 16, 17, 10, 9.5, SLAG, 0, (x, y) => (tileNoise(x, y, 3, 3, seed) - 0.5) * 0.35);
  const { ember } = PALETTE;
  const cracks: [number, number, number, number][] = [
    [16, 9, 14, 14],
    [14, 14, 17, 18],
    [17, 18, 13, 23],
    [17, 18, 23, 19],
    [23, 19, 25, 15],
    [14, 14, 9, 15],
    [13, 23, 15, 26],
  ];
  for (const [a, b, c, d] of cracks) line(img, a, b, c, d, ember.shadow);
  for (const [a, b, c, d] of cracks.slice(1, 4)) line(img, a + 1, b, c + 1, d, ember.base);
  rect(img, 15, 16, 3, 3, ember.light); // the molten centre
  px(img, 16, 17, lighten(ember.light, 0.5));
  outline(img, { amount: 0.4 });
}

/** A cluster of clear hexagonal prisms on a little rock base. */
function quartzCrystal(img: Image, _rand: Rng, seed: number): void {
  lump(
    img,
    [
      [8, 23],
      [13, 21],
      [21, 21],
      [25, 24],
      [22, 27],
      [10, 27],
    ],
    PALETTE.rock,
    seed,
    16,
    24,
  );
  // [base x, base y, tip x, tip y, half width]
  const prisms: [number, number, number, number, number][] = [
    [11, 24, 6, 13, 2.2],
    [21, 24, 26, 12, 2.2],
    [16, 24, 16, 5, 3.4],
  ];
  for (const [bx, by, tx, ty, hw] of prisms) {
    const ang = Math.atan2(ty - by, tx - bx);
    const len = Math.hypot(tx - bx, ty - by);
    eachRotated(bx, by, (ang * 180) / Math.PI, len + 1, (x, y, lx, ly) => {
      if (lx < 0 || lx > len) return;
      const tipStart = len - hw * 1.6;
      const w = lx > tipStart ? hw * (1 - (lx - tipStart) / (hw * 1.6)) : hw;
      if (Math.abs(ly) > w) return;
      // Faces: lit left face, base middle, shadowed right; the tip facets are lighter.
      const f = ly / hw; // -1 .. 1 across, the sign depends on the lean
      const lit = ang < -Math.PI / 2 ? f > 0.15 : f < -0.15;
      const dark = ang < -Math.PI / 2 ? f < -0.5 : f > 0.5;
      let c = lit ? QUARTZ.light : dark ? QUARTZ.shadow : QUARTZ.base;
      if (lx > tipStart && !dark) c = lit ? lighten(QUARTZ.light, 0.5) : QUARTZ.light;
      px(img, x, y, c);
    });
  }
  px(img, 15, 11, [255, 255, 255, 255]);
  px(img, 15, 12, [255, 255, 255, 255]);
  outline(img, { amount: 0.45 });
}

// ---- materials: creature parts -----------------------------------------------------------

function gullFeather(img: Image): void {
  const { feather } = PALETTE;
  const dark = material("#8f9394", "#6a6e70", "#4d5052", "#333638");
  // Vane along a curved shaft from the quill (bottom-left) to the tip (top-right).
  eachRotated(16, 16, -48, 16, (x, y, lx, ly) => {
    if (lx < -9 || lx > 13) return;
    const t = (lx + 9) / 22; // 0 at the quill end of the vane, 1 at the tip
    const bend = 0.012 * (lx - 2) * (lx - 2) - 1.2; // the shaft curves
    const off = ly - bend;
    const wTop = 4.2 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.95) + 0.3;
    const wBot = 3 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.95) + 0.2;
    if (off < -wTop || off > wBot) return;
    // Barb notches along the edges.
    if ((off < -wTop + 1 || off > wBot - 1) && Math.floor(lx + 20) % 4 === 0) return;
    const m = t > 0.78 ? dark : feather;
    const lvl = off < 0 ? 0.8 - (off / -wTop) * 0.15 : 0.55 - (off / wBot) * 0.3;
    px(img, x, y, Math.abs(off) < 0.6 ? bone.base : shadeOf(m, lvl));
  });
  line(img, 6, 26, 9, 23, bone.shadow); // the bare quill
  line(img, 7, 26, 10, 23, bone.base);
  outline(img, { amount: 0.4 });
}

function crabClaw(img: Image): void {
  // Wrist joint, palm, then the two fingers (the movable one on top) with a gap between.
  rod(img, [6, 26], [11, 22], 2.6, 3, CRAB, -0.05);
  blob(img, 14, 19, 7, 5.5, CRAB);
  rod(img, [15, 14], [22, 6], 3, 1.2, CRAB, 0.1);
  rod(img, [19, 19], [27, 13], 2.6, 1, CRAB, -0.05);
  // Pale teeth along the inner edges and lit tips.
  for (const [x, y] of [
    [20, 11],
    [22, 9],
    [21, 16],
    [23, 15],
  ] as const)
    px(img, x, y, IVORY.base);
  px(img, 22, 6, IVORY.light);
  px(img, 26, 13, IVORY.light);
  // Speckles on the shell.
  for (const [x, y] of [
    [11, 18],
    [14, 21],
    [16, 17],
    [9, 21],
  ] as const)
    px(img, x, y, CRAB.deep);
  outline(img, { amount: 0.5 });
}

/**
 * A spread bat wing, seen flat: the forearm rising from the torn-off shoulder (bottom-left)
 * to the wrist with its hooked thumb claw, three long finger bones fanning out to the right
 * and the dark leathery membrane between them cut into deep scallops, so it reads as a wing
 * (not a leaf) even at 1x.
 */
function batWing(img: Image): void {
  const shoulder: Point = [5, 25];
  const wrist: Point = [13, 9];
  const tips: Point[] = [
    [30, 6],
    [29, 17],
    [21, 27],
  ];
  // Membrane: shoulder, along the forearm to the wrist, out to the tips; between two tips
  // (and from the last tip back to the shoulder) the edge bends in toward the wrist.
  const edge: Point[] = [shoulder, wrist];
  let prev: Point = tips[0] ?? wrist;
  edge.push(prev);
  for (const b of [...tips.slice(1), [8, 28] as Point]) {
    const mx = (prev[0] + b[0]) / 2;
    const my = (prev[1] + b[1]) / 2;
    edge.push([mx + (wrist[0] - mx) * 0.38, my + (wrist[1] - my) * 0.38], b);
    prev = b;
  }
  eachInPolygon(edge, (x, y) => {
    const d = Math.hypot(x - wrist[0], y - wrist[1]) / 22;
    // Lighter by the arm, darker toward the trailing edge, a little mottling.
    px(img, x, y, shadeOf(BAT, 0.66 - d * 0.5 + (hash2(x >> 1, y >> 1, 7) - 0.5) * 0.1));
  });
  // Finger bones from the wrist, thinning out.
  for (const t of tips) rod(img, wrist, t, 0.9, 0.4, BAT_BONE, -0.12);
  // The forearm: thick, lit on top, a knuckle at the wrist.
  rod(img, shoulder, wrist, 1.5, 1.1, BAT_BONE, -0.05);
  eachInEllipse(wrist[0] + 0.5, wrist[1] + 0.5, 2.1, 2.1, (x, y, nx, ny) =>
    px(img, x, y, shadeOf(BAT_BONE, domeLight(nx, ny) + 0.1)),
  );
  // The thumb claw, hooked over the wrist.
  px(img, 12, 6, BAT_BONE.base);
  px(img, 11, 5, BAT_BONE.light);
  px(img, 10, 5, BAT_BONE.shadow);
  // The torn shoulder end.
  px(img, 4, 26, hex("#7a2e2a"));
  px(img, 5, 27, hex("#4f1d1a"));
  outline(img, { amount: 0.62 });
}

/** Thick discs along a path: a curved horn or tusk, shaded per disc from the top-left. */
function curvedHorn(
  img: Image,
  path: (t: number) => Point,
  radius: (t: number) => number,
  colour: (t: number, level: number) => Rgba,
): void {
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const [cx, cy] = path(t);
    const r = radius(t);
    eachInEllipse(cx, cy, r, r, (x, y, nx, ny) => px(img, x, y, colour(t, domeLight(nx, ny))));
  }
}

function boarTusk(img: Image): void {
  curvedHorn(
    img,
    (t) => {
      const a = Math.PI * (1.12 - 0.72 * t);
      return [17 + Math.cos(a) * 10, 23 - Math.sin(a) * 11];
    },
    (t) => 3.6 * (1 - t) + 0.6,
    (t, l) => (t < 0.14 ? shadeOf(ANTLER, l - 0.25) : shadeOf(IVORY, l + 0.05)),
  );
  // Growth lines near the root.
  line(img, 7, 19, 10, 21, ANTLER.shadow);
  outline(img, { amount: 0.5 });
}

function stagAntler(img: Image): void {
  const beam = (t: number): Point => [9 + t * 11 + Math.sin(t * Math.PI) * -3, 26 - t * 21];
  curvedHorn(
    img,
    beam,
    (t) => 2.9 - t * 1.7,
    (_t, l) => shadeOf(ANTLER, l),
  );
  // Tines branching up and to the right.
  for (const [s, ex, ey] of [
    [0.28, 19, 15],
    [0.52, 22, 8],
    [0.76, 26, 5],
  ] as const) {
    const [sx, sy] = beam(s);
    curvedHorn(
      img,
      (t) => [sx + (ex - sx) * t, sy + (ey - sy) * t - Math.sin(t * Math.PI) * 2.5],
      (t) => 2 - t * 1.3,
      (t, l) => shadeOf(t > 0.75 ? IVORY : ANTLER, l),
    );
  }
  px(img, 20, 5, IVORY.light);
  // The burr at the base.
  eachInEllipse(9, 26, 3.2, 2.2, (x, y, nx, ny) =>
    px(img, x, y, (x + y) % 2 === 0 ? ANTLER.deep : shadeOf(ANTLER, domeLight(nx, ny) - 0.3)),
  );
  outline(img, { amount: 0.5 });
}

function beetleCarapace(img: Image): void {
  // Two wing cases meeting down the middle, each a glossy dome.
  for (const [cx, sign] of [
    [12.5, -1],
    [19.5, 1],
  ] as const) {
    eachInEllipse(cx, 17, 5.2, 10, (x, y, nx, ny) => {
      if (sign < 0 ? x > 15 : x < 16) return;
      px(img, x, y, shadeOf(BEETLE, domeLight(nx, ny) + (sign > 0 ? -0.08 : 0)));
    });
  }
  line(img, 16, 8, 16, 26, BEETLE.deep); // the seam
  line(img, 15, 8, 15, 26, BEETLE.shadow);
  // Pronotum (the shield at the front) and the glossy highlights.
  eachInEllipse(16, 7.5, 5, 2.6, (x, y, nx, ny) =>
    px(img, x, y, shadeOf(BEETLE, domeLight(nx, ny) - 0.12)),
  );
  const shine = lighten(BEETLE.light, 0.45);
  line(img, 10, 12, 10, 15, shine);
  px(img, 11, 11, shine);
  line(img, 18, 12, 18, 14, BEETLE.light);
  // Fine grooves along the wing cases.
  line(img, 12, 14, 12, 22, BEETLE.shadow);
  line(img, 21, 14, 21, 22, BEETLE.deep);
  outline(img, { amount: 0.45 });
}

/**
 * A pale curved shell plate, like a piece of the crawler's back: an arch that ends in two
 * hooked points, split by dark grooves into four segments, each with a spine on its outer
 * edge and a lit ridge, so the silhouette (a spiked crescent) reads at 1x.
 */
function crawlerChitin(img: Image): void {
  const CX = 16;
  const CY = 22;
  const OUT_X = 14;
  const OUT_Y = 14;
  const IN_X = 8;
  const IN_Y = 6.5;
  // The arch: inside the outer ellipse, outside the inner one, above the centre line.
  eachInEllipse(CX, CY, OUT_X, OUT_Y, (x, y, nx, ny) => {
    const ix = (x + 0.5 - CX) / IN_X;
    const iy = (y + 0.5 - (CY + 1.5)) / IN_Y;
    if (ix * ix + iy * iy <= 1 || ny > 0.12) return;
    const rad = Math.sqrt(nx * nx + ny * ny);
    const ang = Math.atan2(-ny, nx) / Math.PI; // 1 at the left end, 0 at the right end
    const seg = ang * 4;
    const inSeg = seg - Math.floor(seg); // 0 .. 1 across a segment
    // Across the band: lit outer rim, darker inner edge; lit toward the top-left.
    let lvl = 0.5 + (rad - 0.75) * 1.1 + (ang - 0.5) * 0.3;
    if (inSeg < 0.12)
      lvl = 0.02; // the groove between two segments
    else if (inSeg < 0.25) lvl += 0.3; // the lit edge of the next segment
    if (Math.abs(rad - 0.86) < 0.05 && inSeg > 0.3) lvl += 0.2; // a ridge along the arch
    px(img, x, y, shadeOf(CHITIN, lvl));
  });
  // A spine on the outer edge of each segment, and the hooked points at both ends.
  for (const t of [0.125, 0.375, 0.625, 0.875]) {
    const ang = t * Math.PI;
    const x = Math.round(CX + Math.cos(ang) * (OUT_X + 1));
    const y = Math.round(CY - Math.sin(ang) * (OUT_Y + 1));
    px(img, x, y, t > 0.5 ? CHITIN.light : CHITIN.base);
    px(img, x + (t > 0.5 ? -1 : 1), y - 1, t > 0.5 ? CHITIN.light : CHITIN.shadow);
  }
  for (const [x, y, c] of [
    [3, 24, CHITIN.light],
    [3, 25, CHITIN.base],
    [28, 24, CHITIN.shadow],
    [28, 25, CHITIN.shadow],
  ] as const)
    px(img, x, y, c);
  outline(img, { amount: 0.6 });
}

function toadGland(img: Image, rand: Rng): void {
  // A lumpy, kidney-shaped sac with a pink duct, warts and a wet highlight.
  rod(img, [23, 21], [28, 24], 1.8, 1.3, material("#e2a49a", "#c07a70", "#8e544c", "#5e3530"));
  blob(img, 12.5, 17.5, 7, 6.5, TOAD);
  blob(img, 19.5, 19.5, 6, 5.5, TOAD, -0.06);
  line(img, 16, 14, 17, 17, TOAD.shadow); // the crease between the lobes
  for (let i = 0; i < 10; i++) {
    const x = 8 + Math.floor(rand() * 17);
    const y = 13 + Math.floor(rand() * 11);
    if (!opaque(img, x, y) || !opaque(img, x + 1, y + 1)) continue;
    px(img, x, y, TOAD.light);
    px(img, x + 1, y + 1, TOAD.deep);
  }
  const wet: Rgba = [250, 250, 225, 255];
  px(img, 9, 14, wet);
  px(img, 10, 13, wet);
  px(img, 11, 13, wet);
  outline(img, { amount: 0.5 });
}

/** A mushroom: stem then dome cap with a lit rim, and a dark gill line under the cap. */
function mushroom(img: Image, cx: number, capY: number, size: number, cap: Material): void {
  const stem = material("#efe8d4", "#d3c9ae", "#a69c80", "#706853");
  rod(img, [cx, capY + 1], [cx + 0.5, capY + size * 1.3], size * 0.38, size * 0.45, stem);
  eachInEllipse(cx, capY, size, size * 0.7, (x, y, nx, ny) => {
    if (ny > 0.35) return;
    px(img, x, y, shadeOf(cap, domeLight(nx, ny * 1.4) + 0.08));
  });
  line(
    img,
    Math.ceil(cx - size * 0.85),
    Math.floor(capY + size * 0.25),
    Math.floor(cx + size * 0.85),
    Math.floor(capY + size * 0.25),
    cap.deep,
  );
}

function glowcap(img: Image): void {
  mushroom(img, 20, 13, 6.5, GLOW);
  mushroom(img, 11, 19, 4.2, GLOW);
  // Glowing spots on the caps.
  const spot = lighten(GLOW.light, 0.6);
  for (const [x, y] of [
    [18, 9],
    [22, 11],
    [15, 12],
    [10, 17],
  ] as const)
    px(img, x, y, spot);
  outline(img, { amount: 0.5, color: GLOW.outline });
  // A faint ring of glow specks around them (single pixels, no outline).
  for (const [x, y] of [
    [27, 8],
    [14, 6],
    [5, 15],
    [26, 20],
  ] as const)
    px(img, x, y, GLOW.base);
}

// ---- food --------------------------------------------------------------------------------

/** A fish on the diagonal, head at the bottom-left. back and belly are its two materials. */
function fish(img: Image, back: Material, belly: Material, eye: Rgba): void {
  eachRotated(16, 16, -30, 15, (x, y, lx, ly) => {
    // Body from lx -10 (snout) to 7, tail fin 6..12, dorsal fin on top.
    const h = lx >= -10 && lx <= 7.5 ? 4.6 * Math.sqrt(Math.max(0, 1 - ((lx + 1.5) / 9) ** 2)) : 0;
    const inBody = Math.abs(ly) <= h;
    const tail =
      lx > 5.5 && lx < 12.5 && Math.abs(ly) < (lx - 5) * 0.75 && !(lx > 11 && Math.abs(ly) < 1.8);
    const dorsal = lx > -4 && lx < 3 && ly < 0 && ly > -h - 2.2 + (lx + 4) * 0.25;
    if (!inBody && !tail && !dorsal) return;
    if (!inBody) {
      px(img, x, y, (Math.floor(lx) + Math.floor(ly)) % 2 === 0 ? back.shadow : back.base);
      return;
    }
    const v = ly / Math.max(h, 0.1); // -1 back .. 1 belly
    const c = v < 0.1 ? shadeOf(back, 0.85 - (v + 1) * 0.35) : shadeOf(belly, 0.8 - v * 0.5);
    px(img, x, y, c);
  });
  // Gill arc and eye.
  eachRotated(16, 16, -30, 15, (x, y, lx, ly) => {
    if (Math.abs(lx + 5.5 - ly * ly * 0.06) < 0.5 && Math.abs(ly) < 3.4) px(img, x, y, back.deep);
  });
  px(img, 8, 22, eye);
  px(img, 7, 21, back.deep);
}

function rawFish(img: Image): void {
  fish(img, FISH, FISH_BELLY, [30, 34, 40, 255]);
  // A pink blush along the gills.
  tint(img, 10, 22, (c) => mix(c, hex("#d98a8a"), 0.5));
  outline(img, { amount: 0.5 });
}

function grilledFish(img: Image): void {
  fish(img, GRILLED, material("#ecc488", "#c9984e", "#99672c", "#634018"), [240, 232, 210, 255]);
  // Char marks from the grill, diagonal across the body.
  for (const x0 of [10, 14, 18, 22]) {
    for (let i = 0; i < 9; i++) {
      const x = x0 - 3 + i;
      const y = 24 - i * 1.15 - (x0 - 10) * 0.5;
      tint(img, x, Math.round(y), (c) => darken(c, 0.55));
    }
  }
  outline(img, { amount: 0.5 });
}

/** A bowl in 3/4 view: rounded body, lit rim, the contents filling the opening. */
function bowl(img: Image, m: Material, contents: (x: number, y: number, nx: number) => void): void {
  eachInEllipse(16, 16, 11, 10.5, (x, y, nx) => {
    if (y < 16) return;
    px(img, x, y, shadeOf(m, cylinderLight(nx) - 0.05));
  });
  rect(img, 12, 26, 9, 2, m.deep); // the foot
  eachInEllipse(16, 16, 11, 4.5, (x, y, nx, ny) =>
    px(img, x, y, ny < 0 || nx < -0.4 ? m.light : m.base),
  );
  eachInEllipse(16, 16, 9.2, 3.2, (x, y) => px(img, x, y, m.shadow)); // inner wall
  eachInEllipse(16, 16.7, 8.6, 2.7, (x, y, nx) => contents(x, y, nx));
}

function harbourStew(img: Image, rand: Rng, seed: number): void {
  bowl(img, wood, (x, y) =>
    px(img, x, y, shadeOf(STEW, 0.55 + (tileNoise(x, y, 2, 2, seed) - 0.5) * 0.5)),
  );
  // Chunks of fish, meat and seaweed.
  const bits: Rgba[] = [hex("#eadcc4"), hex("#8e3b2c"), KELP.base, hex("#eadcc4"), hex("#8e3b2c")];
  bits.forEach((c, i) => {
    const x = 10 + Math.floor(rand() * 12);
    const y = 15 + Math.floor(rand() * 3);
    if (!opaque(img, x, y) || !opaque(img, x + 1, y)) return;
    px(img, x, y, c);
    px(img, x + 1, y, i % 2 === 0 ? darken(c, 0.25) : c);
  });
  outline(img, { amount: 0.5 });
  // Steam.
  const steam = hex("#d8d8d0");
  for (const [x, y] of [
    [13, 10],
    [12, 9],
    [13, 8],
    [14, 7],
    [19, 9],
    [20, 8],
    [19, 7],
    [19, 6],
  ] as const)
    px(img, x, y, steam);
}

function glowcapBroth(img: Image): void {
  bowl(img, GLAZE, (x, y, nx) => px(img, x, y, nx < -0.3 && y < 17 ? BROTH.light : BROTH.base));
  // Slices of glowcap floating, and the bright glow in the middle.
  for (const [x, y] of [
    [11, 16],
    [19, 15],
    [21, 17],
  ] as const) {
    px(img, x, y, GLOW.light);
    px(img, x + 1, y, GLOW.base);
  }
  rect(img, 15, 16, 2, 1, lighten(BROTH.light, 0.5));
  line(img, 8, 20, 24, 20, GLAZE.base); // a glazed band
  outline(img, { amount: 0.5 });
}

/**
 * A healing compress: a folded pale linen pad (3/4 view: lit top, shaded front) with a broad
 * wavy kelp frond laid across it on the diagonal, tied down with dark twine, salt crystals
 * on the frond. The pale cloth under the green reads at 1x on grass and in a dark slot.
 */
function seaweedPoultice(img: Image, rand: Rng): void {
  // The pad: its top face (a soft rectangle with a fold), then its front in shade.
  eachInRect(6, 10, 20, 12, (x, y) => {
    const corner = (x === 6 || x === 25) && (y === 10 || y === 21);
    if (corner) return;
    let lvl = 0.62 - (x - 6) * 0.012 - (y - 10) * 0.01;
    if (y === 10 || x === 6) lvl += 0.25;
    if (y === 15) lvl -= 0.25; // the fold
    if (y === 16) lvl += 0.12;
    px(img, x, y, shadeOf(LINEN, lvl));
  });
  eachInRect(6, 22, 20, 3, (x, y) => {
    if ((x === 6 || x === 25) && y === 24) return;
    px(
      img,
      x,
      y,
      y === 22 ? LINEN.shadow : x > 22 ? LINEN.deep : mix(LINEN.shadow, LINEN.deep, 0.4),
    );
  });
  // The frond: a broad leaf with wavy edges from bottom-left to top-right, past the pad.
  eachRotated(16, 16.5, -33, 17, (x, y, lx, ly) => {
    if (lx < -14 || lx > 14) return;
    const t = (lx + 14) / 28;
    const off = ly - Math.sin(lx * 0.55) * 0.9;
    const w = 3.6 * Math.sin(Math.min(1, t * 1.1 + 0.05) * Math.PI) + 0.4;
    if (Math.abs(off) > w) return;
    let lvl = 0.62 - (off / w) * 0.28;
    if (Math.abs(off) < 0.55) lvl += 0.25; // the midrib
    if (Math.floor(lx + 20) % 5 === 0 && Math.abs(off) > 1) lvl -= 0.2; // ribs
    px(img, x, y, shadeOf(FROND, lvl));
  });
  // Green stains where the wet frond soaks through the cloth.
  for (const [x, y] of [
    [8, 21],
    [9, 22],
    [23, 11],
    [24, 12],
    [20, 20],
  ] as const)
    px(img, x, y, mix(LINEN.shadow, FROND.shadow, 0.6));
  // Twine: one band across the pad and down its front, knotted on the frond.
  line(img, 16, 10, 16, 24, TWINE.base);
  line(img, 17, 22, 17, 24, TWINE.shadow);
  rect(img, 15, 15, 3, 3, TWINE.shadow);
  px(img, 15, 15, TWINE.light);
  px(img, 16, 15, TWINE.base);
  line(img, 14, 18, 12, 20, TWINE.base); // the loose ends
  line(img, 18, 18, 19, 20, TWINE.shadow);
  // Salt crystals on the frond.
  for (let i = 0; i < 7; i++) {
    const x = 7 + Math.floor(rand() * 19);
    const y = 9 + Math.floor(rand() * 14);
    const onFrond = get(img, x, y)?.[1] === FROND.base[1] || get(img, x, y)?.[1] === FROND.light[1];
    if (Math.abs(x - 16) > 1 && onFrond) px(img, x, y, hex("#fbfbf4"));
  }
  outline(img, { amount: 0.62 });
}

// ---- tools -------------------------------------------------------------------------------

function fishingRod(img: Image): void {
  // Line from the tip to a red and white float.
  line(img, 27, 4, 27, 16, hex("#cfd3d6"));
  rod(img, [7, 26], [27, 4], 1.4, 0.6, wood, 0.05);
  rod(img, [5, 28], [10, 22], 2, 1.9, leather, 0); // the grip
  // The reel.
  eachInEllipse(13.5, 21.5, 2.2, 2.2, (x, y, nx, ny) =>
    px(img, x, y, shadeOf(iron, domeLight(nx, ny))),
  );
  px(img, 13, 21, darkIron.deep);
  // The float.
  eachInEllipse(27, 19, 2, 2.4, (x, y, _nx, ny) =>
    px(img, x, y, ny < 0 ? hex("#c84a3c") : hex("#ece6d8")),
  );
  outline(img, { amount: 0.5 });
}

/**
 * A coil of thick twisted rope in 3/4 view: three stacked turns, each with a dark seam where
 * it rests on the one below, the hole in the middle in shadow, diagonal strands along the
 * rope and the loose end lying on the ground at the bottom-right, whipped with twine.
 */
function ropeCoil(img: Image): void {
  const RX = 12;
  const RY = 6.6;
  const HOLE_X = 5;
  const HOLE_Y = 2.5;
  // The loose end first: it leaves the bottom turn and lies on the ground.
  rod(img, [20, 24], [27, 28], 2.2, 2, rope, -0.05);
  for (const [x, y] of [
    [22, 25],
    [24, 26],
  ] as const)
    px(img, x, y, rope.deep);
  rect(img, 26, 27, 2, 2, TWINE.shadow);
  px(img, 26, 27, TWINE.light);
  // From the bottom turn up: each one is drawn over the one below it, 3 px higher.
  for (const cy of [21, 18, 15]) {
    eachInEllipse(16, cy, RX, RY, (x, y, nx, ny) => {
      const ix = (x + 0.5 - 16) / HOLE_X;
      const iy = (y + 0.5 - cy) / HOLE_Y;
      if (ix * ix + iy * iy <= 1) return; // the hole
      const rad = Math.sqrt(nx * nx + ny * ny);
      const inner = 0.42;
      const across = Math.min(1, Math.max(0, (rad - inner) / (1 - inner))); // 0 in .. 1 out
      // A tube: lit on its top-left, dark toward the hole and the outer bottom.
      let lvl = 0.5 + (1 - Math.abs(across - 0.45) * 2) * 0.28 - ny * 0.2 - nx * 0.06;
      // Strands: a dark diagonal every few pixels along the rope.
      const ang = Math.atan2(ny, nx);
      if (Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 40 + across * 2.2) % 3 === 0) lvl -= 0.28;
      if (rad > 0.86 && ny > 0.35) lvl = 0.05; // the seam on the turn below
      px(img, x, y, shadeOf(rope, lvl));
    });
  }
  // The hole: looking down into the coil, in shadow.
  eachInEllipse(16, 15, HOLE_X, HOLE_Y, (x, y, _nx, ny) =>
    px(img, x, y, ny < -0.2 ? rope.deep : darken(rope.deep, 0.35)),
  );
  outline(img, { amount: 0.6 });
}

function pickaxe(img: Image): void {
  rod(img, [7, 27], [21, 9], 1.8, 1.6, wood, 0.05);
  // The head: curved, pointed at both ends, across the top of the handle.
  eachRotated(20, 10, 40, 14, (x, y, lx, ly) => {
    if (Math.abs(lx) > 12) return;
    const centre = 0.055 * lx * lx - 1;
    const half = 2.3 * (1 - (lx / 12.5) ** 2) + 0.35;
    const off = ly - centre;
    if (Math.abs(off) > half) return;
    px(img, x, y, shadeOf(iron, 0.62 - (off / half) * 0.45 - (lx > 0 ? 0.12 : 0)));
  });
  // The eye, a collar around the handle.
  rect(img, 19, 9, 3, 3, darkIron.base);
  px(img, 19, 9, darkIron.light);
  outline(img, { amount: 0.5 });
}

function shovel(img: Image): void {
  rod(img, [11, 21], [26, 6], 1.5, 1.5, wood, 0.05);
  // The T grip at the top.
  rod(img, [24, 3], [29, 8], 1.4, 1.4, darkWood, 0.1);
  // The blade, pointing down-left.
  eachRotated(9, 23, 135, 10, (x, y, lx, ly) => {
    if (lx < -4.5 || lx > 7) return;
    const w = lx < 1.5 ? 4.6 : 4.6 * Math.sqrt(Math.max(0, 1 - ((lx - 1.5) / 5.5) ** 2));
    if (Math.abs(ly) > w) return;
    const dish = -ly / 4.6; // lit on the side facing the top-left
    px(img, x, y, shadeOf(iron, 0.55 + dish * 0.32 - (lx > 4 ? 0.1 : 0)));
  });
  // The socket where the blade meets the handle.
  rod(img, [11, 21], [13, 19], 1.8, 1.6, darkIron);
  outline(img, { amount: 0.5 });
}

// ---- containers --------------------------------------------------------------------------

function backpack(img: Image): void {
  // Carry loop.
  line(img, 14, 6, 14, 4, leather.shadow);
  line(img, 18, 6, 18, 4, leather.shadow);
  line(img, 15, 3, 17, 3, leather.base);
  // Body: a rounded canvas sack, lit on the left.
  eachInRect(7, 7, 18, 21, (x, y) => {
    const corner =
      (x === 7 || x === 24) && (y === 7 || y === 27) ? true : (x === 7 || x === 24) && y === 8;
    if (corner) return;
    const u = (x + 0.5 - 16) / 9;
    px(img, x, y, shadeOf(CANVAS, cylinderLight(u) + (y < 10 ? 0.15 : 0) - (y > 25 ? 0.25 : 0)));
  });
  // Front pocket.
  rect(img, 10, 20, 12, 6, CANVAS.base);
  rect(img, 10, 20, 12, 1, CANVAS.light);
  rect(img, 10, 25, 12, 1, CANVAS.deep);
  rect(img, 21, 20, 1, 6, CANVAS.shadow);
  // Leather flap over the top with a rounded lower edge, and its shadow.
  eachInRect(8, 7, 16, 11, (x, y) => {
    const u = (x + 0.5 - 16) / 8;
    if (y > 15 && Math.abs(u) > 0.75) return;
    if (y > 16 && Math.abs(u) > 0.45) return;
    px(img, x, y, shadeOf(leather, cylinderLight(u) + (y === 7 ? 0.3 : 0)));
  });
  line(img, 11, 17, 20, 17, leather.deep);
  line(img, 9, 16, 22, 16, leather.shadow);
  // Two straps from the flap down over the pocket, with iron buckles at the flap's edge.
  for (const x of [11, 19]) {
    rect(img, x, 9, 2, 17, leather.shadow);
    rect(img, x, 9, 1, 17, leather.base);
    rect(img, x - 1, 15, 4, 3, iron.base);
    px(img, x - 1, 15, iron.light);
    rect(img, x, 16, 2, 1, darkIron.deep);
  }
  outline(img, { amount: 0.5 });
}

// ---- armor -------------------------------------------------------------------------------

/**
 * Trousers seen from the front: a waistband, hips, two legs that part below the crotch.
 * legW is the half-width of a leg at the cuff; flare widens the hips.
 */
function trousers(img: Image, m: Material, legTop: number, legW: number): void {
  for (let y = 8; y <= 27; y++) {
    if (y < legTop) {
      const half = 7.5 + Math.min(1, (y - 8) * 0.25);
      for (let x = Math.ceil(16 - half); x < 16 + half; x++) {
        const u = (x + 0.5 - 16) / half;
        px(img, x, y, shadeOf(m, cylinderLight(u) + 0.08));
      }
      continue;
    }
    const k = (y - legTop) / (27 - legTop);
    const gap = 0.5 + k * 1.2;
    const outer = 8.5 - k * (8.5 - gap - legW * 2);
    for (const side of [-1, 1]) {
      const a = 16 + side * gap;
      const b = 16 + side * outer;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let x = Math.ceil(lo); x < hi; x++) {
        const u = ((x + 0.5 - (lo + hi) / 2) / (hi - lo)) * 2;
        px(img, x, y, shadeOf(m, cylinderLight(u) - (side > 0 ? 0.1 : 0)));
      }
    }
  }
  // Crotch shadow.
  line(img, 16, legTop - 2, 16, legTop, m.deep);
  // Waistband.
  rect(img, 8, 5, 16, 3, m.base);
  rect(img, 8, 5, 16, 1, m.light);
  rect(img, 8, 7, 16, 1, m.shadow);
}

function canvasTrousers(img: Image): void {
  trousers(img, cloth, 15, 3.4);
  // Drawstring through the waistband, tied in front.
  line(img, 8, 6, 23, 6, rope.shadow);
  px(img, 16, 6, rope.light);
  line(img, 15, 8, 14, 11, rope.base);
  line(img, 17, 8, 18, 11, rope.base);
  // A patch on the left knee and rolled cuffs.
  rect(img, 9, 19, 4, 4, CANVAS.shadow);
  rect(img, 9, 19, 4, 1, CANVAS.base);
  for (const [x, y] of [
    [9, 19],
    [12, 22],
    [9, 22],
    [12, 19],
  ] as const)
    px(img, x, y, CANVAS.deep);
  for (const x of [6, 7, 8, 9, 10, 11, 12, 13, 14, 18, 19, 20, 21, 22, 23, 24, 25])
    tint(img, x, 26, (c) => lighten(c, 0.25));
  outline(img, { amount: 0.5 });
}

function stagleatherLeggings(img: Image): void {
  trousers(img, STAG_LEATHER, 14, 2.6);
  // Belt with a buckle.
  rect(img, 8, 6, 16, 2, darkWood.base);
  rect(img, 8, 6, 16, 1, darkWood.light);
  rect(img, 14, 5, 4, 3, iron.base);
  px(img, 15, 6, darkIron.deep);
  px(img, 16, 6, darkIron.deep);
  // Lacing down the front.
  for (let y = 9; y <= 13; y += 2) {
    px(img, 15, y, leather.light);
    px(img, 16, y + 1, leather.light);
  }
  // Stitched seams down the outer sides and darker knee guards.
  for (let y = 10; y <= 25; y += 2) {
    const k = Math.max(0, (y - 14) / 13);
    px(img, Math.ceil(16 - 8.5 + k * 3.2) + 1, y, STAG_LEATHER.light);
    px(img, Math.floor(16 + 8.5 - k * 3.2) - 2, y, STAG_LEATHER.base);
  }
  for (const cx of [11.5, 20.5]) {
    eachInEllipse(cx, 20, 2.4, 2, (x, y, nx, ny) =>
      px(img, x, y, shadeOf(leather, domeLight(nx, ny) - 0.15)),
    );
  }
  outline(img, { amount: 0.5 });
}

/**
 * Embersteel greaves (content audit M3): dark plates over ash-hound leather, a plate on
 * each thigh and knee, the plate edges glowing like the ingots they came from.
 */
function embersteelGreaves(img: Image): void {
  const { darkIron, ember } = PALETTE;
  const houndLeather = material("#8d8478", "#6a6259", "#4b453f", "#302c28");
  trousers(img, houndLeather, 14, 2.9);
  // Belt with an embersteel buckle.
  rect(img, 8, 5, 16, 3, darkWood.base);
  rect(img, 8, 5, 16, 1, darkWood.light);
  rect(img, 14, 5, 4, 3, darkIron.base);
  px(img, 15, 6, ember.base);
  px(img, 16, 6, ember.shadow);
  // Plates: a thigh plate and a knee cop on each leg, lit from the top left.
  for (const [cx, side] of [
    [11.5, -1],
    [20.5, 1],
  ] as const) {
    eachInEllipse(cx, 12.5, 3.3, 3, (x, y, nx, ny) =>
      px(img, x, y, shadeOf(darkIron, domeLight(nx, ny) + (side > 0 ? -0.08 : 0.05))),
    );
    eachInEllipse(cx + side * 0.6, 20, 2.6, 2.2, (x, y, nx, ny) =>
      px(img, x, y, shadeOf(darkIron, domeLight(nx, ny) + 0.12)),
    );
    // Shin plate down to the cuff.
    for (let y = 23; y <= 26; y++) {
      const half = 2.2 - (y - 23) * 0.15;
      const mid = cx + side * (1 + (y - 23) * 0.35);
      for (let x = Math.ceil(mid - half); x < mid + half; x++) {
        const u = (x + 0.5 - mid) / half;
        px(img, x, y, shadeOf(darkIron, cylinderLight(u) - (side > 0 ? 0.1 : 0)));
      }
    }
    // The glowing lower edges of the plates.
    for (const [ex, ey] of [
      [cx - 2, 15],
      [cx - 1, 15],
      [cx, 15],
      [cx + 1, 15],
      [cx + side * 0.6 - 1, 22],
      [cx + side * 0.6, 22],
      [cx + side * 0.6 + 1, 22],
    ] as const)
      px(img, Math.round(ex), ey, ember.shadow);
  }
  outline(img, { amount: 0.5, color: darken(ember.deep, 0.45) });
}

// ---- quest -------------------------------------------------------------------------------

function smugglerTally(img: Image, _rand: Rng, seed: number): void {
  // A flat peeled stick on the diagonal, notches along its top edge, a burnt oar mark.
  const pale = material("#dcc398", "#bb9d6c", "#8e744c", "#5f4d32");
  eachInCapsule(6, 25, 26, 7, 3.2, 3.2, (x, y, u) => {
    const grain = (tileNoise(x + y, x - y, 6, 1, seed) - 0.5) * 0.18;
    px(img, x, y, shadeOf(pale, (u < -0.55 ? 0.82 : u > 0.5 ? 0.3 : 0.6) + grain));
  });
  // Tally notches cut across the upper half of the stick, each with a lit edge.
  const len = Math.hypot(20, 18);
  const dx = 20 / len;
  const dy = -18 / len;
  for (let k = 0; k < 5; k++) {
    const along = 13 + k * 2.6;
    const cx = 6.5 + dx * along;
    const cy = 25.5 + dy * along;
    // Across the stick: the normal (-dy, dx) points down-right.
    line(
      img,
      Math.round(cx + dy * 2.6),
      Math.round(cy - dx * 2.6),
      Math.round(cx - dy * 1.4),
      Math.round(cy + dx * 1.4),
      pale.deep,
    );
    px(img, Math.round(cx + dy * 2.6) - 1, Math.round(cy - dx * 2.6), pale.light);
  }
  // The oar mark burnt into the lower half: a shaft and a blade.
  const burn = hex("#3a2616");
  line(img, 8, 23, 12, 19, burn);
  eachRotated(14, 17.5, -42, 4, (x, y, lx, ly) => {
    if ((lx / 2.4) ** 2 + (ly / 1.4) ** 2 <= 1) px(img, x, y, burn);
  });
  outline(img, { amount: 0.5 });
}

/**
 * The ember key (docs/02 "Puertas con llave"): the ember root shaped into a key of dark
 * stone that never cools. It lies on the diagonal, the ring bow up right and the two-toothed
 * bit down left, with ember glowing in a crack along the shaft and inside the bow.
 */
function emberKey(img: Image, _rand: Rng, seed: number): void {
  const { ember } = PALETTE;
  const grain = (x: number, y: number): number => (tileNoise(x, y, 4, 2, seed) - 0.5) * 0.25;
  // The bit: two teeth hanging off the shaft toward the bottom right.
  rod(img, [7, 24], [11, 28], 1.8, 1.6, SLAG, 0.1);
  rod(img, [10.5, 20.5], [14.5, 24.5], 1.8, 1.6, SLAG, 0.1);
  // The shaft, from the bit up to the bow.
  eachInCapsule(5, 26, 18, 13, 2.1, 2.1, (x, y, u) =>
    px(img, x, y, shadeOf(SLAG, cylinderLight(u) + 0.12 + grain(x, y))),
  );
  // The bow: a thick ring, lit on its top-left, with a hole through it.
  eachInEllipse(22, 9.5, 7.2, 7.2, (x, y, nx, ny) => {
    const d = nx * nx + ny * ny;
    if (d < 0.17) return; // the hole
    const rim = d < 0.36 ? -0.2 : 0; // the inner face sits in shadow
    px(img, x, y, shadeOf(SLAG, domeLight(nx, ny) + 0.15 + rim + grain(x, y)));
  });
  // Ember in the crack of the shaft and around the inside of the bow.
  line(img, 7, 24, 17, 14, ember.shadow);
  line(img, 10, 21, 15, 16, ember.base);
  eachInEllipse(22, 9.5, 3.8, 3.8, (x, y, nx, ny) => {
    const d = nx * nx + ny * ny;
    if (d >= 0.55 && d < 1) px(img, x, y, nx + ny > 0 ? ember.base : ember.shadow);
  });
  px(img, 12, 19, ember.light);
  px(img, 24, 12, ember.light);
  outline(img, { amount: 0.45 });
}

// A brass key for the practice gate of the sandbox island (pruebas_key): the ember key's
// shape in plain polished brass, with a square bit and a ring at its bow.
function brassKey(img: Image, _rand: Rng, seed: number): void {
  const { gold } = PALETTE;
  const grain = (x: number, y: number): number => (tileNoise(x, y, 4, 2, seed) - 0.5) * 0.15;
  // The bit: two square teeth hanging off the shaft toward the bottom right.
  rod(img, [7, 24], [11, 28], 1.6, 1.6, gold, 0.15);
  rod(img, [11, 20], [14, 23], 1.6, 1.6, gold, 0.15);
  // The shaft, from the bit up to the bow.
  eachInCapsule(5, 26, 18, 13, 1.8, 1.8, (x, y, u) =>
    px(img, x, y, shadeOf(gold, cylinderLight(u) + 0.15 + grain(x, y))),
  );
  // The bow: a ring lit on its top-left, with a round hole through it.
  eachInEllipse(22, 9.5, 6.6, 6.6, (x, y, nx, ny) => {
    const d = nx * nx + ny * ny;
    if (d < 0.22) return; // the hole
    const rim = d < 0.4 ? -0.25 : 0; // the inner face sits in shadow
    px(img, x, y, shadeOf(gold, domeLight(nx, ny) + 0.2 + rim + grain(x, y)));
  });
  // A glint on the shaft and on the bow.
  px(img, 13, 17, gold.light);
  px(img, 19, 6, gold.light);
  outline(img, { amount: 0.45 });
}

export const ITEMS: RecipeBook = {
  "currency/copper_coin": { kind: "item", draw: coinPile(COIN_COPPER) },
  "currency/silver_coin": { kind: "item", draw: coinPile(silver) },
  "materials/birch_log": { kind: "item", draw: birchLog },
  "materials/elm_log": { kind: "item", draw: elmLog },
  "materials/thorn_heartwood": { kind: "item", draw: thornHeartwood },
  "materials/iron_ingot": { kind: "item", draw: ingotStack(iron) },
  "materials/embersteel_ingot": { kind: "item", draw: ingotStack(darkIron, PALETTE.ember) },
  "materials/ember_ore": { kind: "item", draw: emberOre },
  "materials/slag_core": { kind: "item", draw: slagCore },
  "materials/quartz_crystal": { kind: "item", draw: quartzCrystal },
  "materials/gull_feather": { kind: "item", draw: gullFeather },
  "materials/crab_claw": { kind: "item", draw: crabClaw },
  "materials/bat_wing": { kind: "item", draw: batWing },
  "materials/boar_tusk": { kind: "item", draw: boarTusk },
  "materials/stag_antler": { kind: "item", draw: stagAntler },
  "materials/beetle_carapace": { kind: "item", draw: beetleCarapace },
  "materials/crawler_chitin": { kind: "item", draw: crawlerChitin },
  "materials/toad_gland": { kind: "item", draw: toadGland },
  "materials/glowcap": { kind: "item", draw: glowcap },
  "food/raw_fish": { kind: "item", draw: rawFish },
  "food/grilled_fish": { kind: "item", draw: grilledFish },
  "food/harbour_stew": { kind: "item", draw: harbourStew },
  "food/glowcap_broth": { kind: "item", draw: glowcapBroth },
  "food/seaweed_poultice": { kind: "item", draw: seaweedPoultice },
  "tools/fishing_rod": { kind: "item", draw: fishingRod },
  "tools/rope": { kind: "item", draw: ropeCoil },
  "tools/pickaxe": { kind: "item", draw: pickaxe },
  "tools/shovel": { kind: "item", draw: shovel },
  "containers/backpack": { kind: "item", draw: backpack },
  "armor/canvas_trousers": { kind: "item", draw: canvasTrousers },
  "armor/stagleather_leggings": { kind: "item", draw: stagleatherLeggings },
  "armor/embersteel_greaves": { kind: "item", draw: embersteelGreaves },
  "quest/smuggler_tally": { kind: "item", draw: smugglerTally },
  "quest/ember_key": { kind: "item", draw: emberKey },
  "tools/brass_key": { kind: "item", draw: brassKey },
};
