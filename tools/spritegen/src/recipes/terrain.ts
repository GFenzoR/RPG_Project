// Ground, walls and map decoration (T0.5). Ground and walls tile seamlessly; objects are
// drawn on transparency in 3/4 view (top and south face visible), lit from the top-left.
import type { Image, Rgba } from "@rpg/spritepack";
import {
  box,
  cylinderLight,
  domeLight,
  eachInEllipse,
  eachInRect,
  hash2,
  line,
  opaque,
  outline,
  polygon,
  px,
  rect,
  shadeOf,
  tileNoise,
  tint,
} from "../draw.ts";
import type { Rng } from "../draw.ts";
import { darken, lighten, mix, PALETTE } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

const { wood, darkWood, weatheredWood, iron, darkIron, rope, paper, redCloth, moss, pine, bark } =
  PALETTE;

// ---- ground ------------------------------------------------------------------------------

/** Horizontal planks, 8 px wide, one staggered butt joint per row. */
function woodenFloor(img: Image, _rand: Rng, seed: number): void {
  const joints = [5, 21, 13, 29];
  eachInRect(0, 0, 32, 32, (x, y) => {
    const row = Math.floor(y / 8);
    const yy = y % 8;
    const j = joints[row] ?? 0;
    const plank = x >= j ? 1 : 0;
    const tone = (hash2(row, plank, seed) - 0.5) * 0.18;
    let c;
    if (yy === 7) c = wood.outline;
    else if (x === j) c = wood.deep;
    else if (yy === 0 || x === (j + 1) % 32) c = wood.light;
    else if (yy === 6) c = wood.shadow;
    else {
      const grain = tileNoise(x, y * 3, 8, 1, seed);
      c = shadeOf(wood, 0.36 + grain * 0.5 + tone);
    }
    px(img, x, y, c);
  });
  // A couple of knots.
  knot(img, 24, 3, wood);
  knot(img, 9, 19, wood);
}

function knot(img: Image, x: number, y: number, m: Material): void {
  px(img, x, y, m.deep);
  px(img, x + 1, y, m.shadow);
  px(img, x - 1, y, m.shadow);
}

/** Grey vertical dock planks over dark water gaps, with nailed butt joints. */
function dockPlanks(img: Image, _rand: Rng, seed: number): void {
  const m = weatheredWood;
  const gap = mix(m.outline, PALETTE.water.deep, 0.5);
  const joints = [6, 22, 14, 30];
  eachInRect(0, 0, 32, 32, (x, y) => {
    const col = Math.floor(x / 8);
    const xx = x % 8;
    const j = joints[col] ?? 0;
    const tone = (hash2(col, y >= j ? 1 : 0, seed) - 0.5) * 0.2;
    let c;
    if (xx === 7) c = gap;
    else if (y === j) c = m.deep;
    else if (xx === 0 || y === (j + 1) % 32) c = m.light;
    else if (xx === 6) c = m.shadow;
    else c = shadeOf(m, 0.34 + tileNoise(x * 3, y, 1, 8, seed) * 0.52 + tone);
    px(img, x, y, c);
  });
  // Nails either side of each joint.
  joints.forEach((j, col) => {
    for (const dy of [-2, 2]) {
      const y = (j + dy + 32) % 32;
      px(img, col * 8 + 2, y, darkIron.base);
      px(img, col * 8 + 5, y, darkIron.base);
    }
  });
}

// ---- volcanic grounds (Isla Volcánica, T5.5) ---------------------------------------------

const wrap = (v: number): number => ((v % 32) + 32) % 32;

/** px() that wraps around the tile, for marks that cross the edge of a seamless ground. */
function pxw(img: Image, x: number, y: number, c: Rgba): void {
  px(img, wrap(x), wrap(y), c);
}

/**
 * Nearest point of a jittered lattice that repeats every 32 px: cells of cellW x cellH, one
 * point per cell. `squash` stretches y when measuring (2 = cells look half as tall) and
 * `stagger` shifts every other column half a cell down (hexagons with pointed sides).
 * Returns the id of the nearest cell and the pixel offset from its point.
 */
function lattice(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  seed: number,
  opts: { jitter?: number; squash?: number; stagger?: boolean } = {},
): { id: number; dx: number; dy: number } {
  const { jitter = 1, squash = 1, stagger = false } = opts;
  const cols = 32 / cellW;
  const rows = 32 / cellH;
  let best = Infinity;
  let out = { id: 0, dx: 0, dy: 0 };
  const cx0 = Math.floor(x / cellW);
  for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
    const col = ((gx % cols) + cols) % cols;
    const shift = stagger && col % 2 === 1 ? cellH / 2 : 0;
    const cy0 = Math.floor((y - shift) / cellH);
    for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
      const row = ((gy % rows) + rows) % rows;
      const id = row * cols + col;
      const px0 = gx * cellW + cellW / 2 + (hash2(col, row, seed) - 0.5) * jitter * cellW;
      const py0 =
        gy * cellH + shift + cellH / 2 + (hash2(col, row, seed + 1) - 0.5) * jitter * cellH;
      const dx = x + 0.5 - px0;
      const dy = y + 0.5 - py0;
      const d = dx * dx + dy * squash * (dy * squash);
      if (d < best) {
        best = d;
        out = { id, dx, dy };
      }
    }
  }
  return out;
}

/** Fine grey ash in soft drifts, with a few dark cinders and pale pumice grains. */
function ashGround(img: Image, _rand: Rng, seed: number): void {
  const m = PALETTE.ash;
  eachInRect(0, 0, 32, 32, (x, y) => {
    const drift = tileNoise(x, y, 16, 8, seed) * 0.6 + tileNoise(x, y, 8, 8, seed + 1) * 0.4;
    const v = drift + (hash2(x, y, seed + 2) - 0.5) * 0.14;
    px(img, x, y, v > 0.72 ? m.light : v > 0.27 ? m.base : m.shadow);
  });
  // Ripples the wind leaves: short lit lines with their shadow just below.
  for (let i = 0; i < 4; i++) {
    const x0 = Math.floor(hash2(i, 1, seed + 3) * 32);
    const y0 = Math.floor(hash2(i, 2, seed + 3) * 32);
    const len = 4 + Math.floor(hash2(i, 3, seed + 3) * 4);
    for (let k = 0; k < len; k++) {
      const yy = y0 + (k >= len / 2 ? 1 : 0);
      pxw(img, x0 + k, yy, m.light);
      pxw(img, x0 + k, yy + 1, m.shadow);
    }
  }
  // Cinders (dark, with a shadow pixel below) and pumice grains.
  eachInRect(0, 0, 32, 32, (x, y) => {
    const h = hash2(x, y, seed + 4);
    if (h < 0.008) {
      pxw(img, x, y, PALETTE.lavaRock.light);
      pxw(img, x, y + 1, m.deep);
    } else if (h > 0.993) px(img, x, y, lighten(m.light, 0.25));
  });
}

/** Hexagonal basalt column tops in 3/4: flat-topped hexes, lit rims, dark joints. */
function basaltPaving(img: Image, _rand: Rng, seed: number): void {
  const m = PALETTE.basalt;
  const cellOf = (x: number, y: number): number =>
    lattice(wrap(x + 8), wrap(y), 16, 16, seed, { jitter: 0, squash: 1.2, stagger: true }).id;
  eachInRect(0, 0, 32, 32, (x, y) => {
    const id = cellOf(x, y);
    const tone = (hash2(id, 5, seed) - 0.5) * 0.36;
    let c: Rgba;
    if (cellOf(x, y + 1) !== id || cellOf(x + 1, y) !== id)
      c = m.outline; // the joint
    else if (cellOf(x, y + 2) !== id)
      c = m.shadow; // the south face of the column
    else if (cellOf(x, y - 1) !== id || cellOf(x - 1, y) !== id)
      c = m.light; // lit rim
    else c = shadeOf(m, 0.56 + tone + (tileNoise(x, y, 4, 4, seed + 6) - 0.5) * 0.18);
    px(img, x, y, c);
  });
  // A few pits and chips on the faces.
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (hash2(x, y, seed + 7) < 0.015 && img.data[(y * 32 + x) * 4] === m.base[0])
      px(img, x, y, m.shadow);
  });
}

/** Packed red-brown scoria with loose cinder pebbles: the paths of the island. */
function cinderPath(img: Image, _rand: Rng, seed: number): void {
  const m = PALETTE.cinder;
  const dark = PALETTE.lavaRock;
  eachInRect(0, 0, 32, 32, (x, y) => {
    const v = tileNoise(x, y, 8, 8, seed) * 0.55 + (hash2(x, y, seed + 1) - 0.5) * 0.25;
    px(img, x, y, v > 0.36 ? m.base : v > 0.16 ? m.shadow : m.deep);
  });
  // Pebbles: one per 4x4 cell of a jittered lattice, about two in five drawn.
  eachInRect(0, 0, 32, 32, (x, y) => {
    const p = lattice(x, y, 4, 4, seed + 2, { jitter: 0.6 });
    if (hash2(p.id, 9, seed) > 0.42) return;
    const r = 1.1 + hash2(p.id, 10, seed) * 0.7;
    if (p.dx * p.dx + p.dy * p.dy > r * r) return;
    const pm = hash2(p.id, 11, seed) < 0.3 ? dark : m;
    const lit = p.dx + p.dy < -0.6;
    const shade = p.dx + p.dy > 0.9;
    px(img, x, y, lit ? pm.light : shade ? pm.deep : pm.base);
  });
}

/**
 * Cooled lava: a near-black crust broken into slabs, each one lit on its top-left rim and
 * shaded on the bottom-right, mottled, with a dull red glow deep in a few cracks.
 */
function cooledLava(img: Image, _rand: Rng, seed: number): void {
  const m = PALETTE.lavaRock;
  const { ember } = PALETTE;
  const slabOf = (x: number, y: number): number =>
    lattice(wrap(x), wrap(y), 8, 8, seed + 4, { jitter: 0.8 }).id;
  eachInRect(0, 0, 32, 32, (x, y) => {
    const id = slabOf(x, y);
    if (slabOf(x + 1, y) !== id || slabOf(x, y + 1) !== id) {
      const glow = tileNoise(x, y, 8, 8, seed + 5) > 0.72 && hash2(x, y, seed + 9) < 0.7;
      px(img, x, y, glow ? mix(m.deep, ember.deep, 0.7) : m.outline);
      return;
    }
    const tone = (hash2(id, 8, seed) - 0.5) * 0.3;
    const mottle = (tileNoise(x, y, 4, 4, seed + 6) - 0.5) * 0.3;
    let level = 0.52 + tone + mottle;
    if (slabOf(x, y + 2) !== id || slabOf(x + 2, y) !== id)
      level -= 0.25; // far rim
    else if (slabOf(x, y - 1) !== id || slabOf(x - 1, y) !== id) level += 0.3; // lit rim
    px(img, x, y, shadeOf(m, level));
  });
  // Glassy glints.
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (hash2(x, y, seed + 3) < 0.03 && img.data[(y * 32 + x) * 4] === m.light[0])
      px(img, x, y, lighten(m.light, 0.3));
  });
}

/**
 * Molten lava: a glowing flow in small swirls (fine detail hides the 32 px repeat), a
 * darker cooling skin on its crests and two small drifting plates of black crust, each with
 * a red-hot rim.
 */
function moltenLava(img: Image, _rand: Rng, seed: number): void {
  const { ember } = PALETTE;
  const crust = PALETTE.lavaRock;
  const flowAt = (x: number, y: number): number =>
    tileNoise(x, y, 8, 8, seed) * 0.5 +
    tileNoise(x, y, 16, 8, seed + 1) * 0.3 +
    tileNoise(x, y, 4, 4, seed + 2) * 0.2;
  // Thresholds by share of the tile, not by value: the mix of noises bunches up round 0.5.
  const sorted: number[] = [];
  eachInRect(0, 0, 32, 32, (x, y) => sorted.push(flowAt(x, y)));
  sorted.sort((a, b) => a - b);
  const q = (share: number): number => sorted[Math.floor(share * (sorted.length - 1))] ?? 0.5;
  const [hot, warm, cooling, skin] = [q(0.3), q(0.48), q(0.72), q(0.88)];
  eachInRect(0, 0, 32, 32, (x, y) => {
    const flow = flowAt(x, y);
    let c: Rgba;
    if (flow > skin)
      c = ember.deep; // the cooling skin on the crests
    else if (flow > cooling) c = ember.shadow;
    else if (flow > warm) c = ember.base;
    else if (flow > hot) c = mix(ember.base, ember.light, 0.5);
    else c = ember.light;
    px(img, x, y, c);
  });
  // Crust plates: two of the four 16 px cells, ragged at the edge.
  const plates = [0, 1, 2, 3].sort((a, b) => hash2(a, 6, seed) - hash2(b, 6, seed)).slice(0, 2);
  eachInRect(0, 0, 32, 32, (x, y) => {
    const cell = lattice(x, y, 16, 16, seed + 4, { jitter: 0.7 });
    if (!plates.includes(cell.id)) return;
    const size = 2 + hash2(cell.id, 7, seed) * 1.4;
    const r = Math.hypot(cell.dx, cell.dy * 1.25) + (tileNoise(x, y, 4, 4, seed + 8) - 0.5) * 2.4;
    if (r > size + 1) return;
    if (r > size) {
      px(img, x, y, ember.shadow); // the cooler halo round a plate
      return;
    }
    const lit = cell.dx + cell.dy < -1.2;
    const dark = cell.dx + cell.dy > 1.2;
    px(img, x, y, r > size - 1 ? ember.deep : lit ? crust.light : dark ? crust.deep : crust.base);
  });
  // White-hot sparks in the brightest flow.
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (hash2(x, y, seed + 3) < 0.03 && img.data[(y * 32 + x) * 4 + 2] === ember.light[2])
      px(img, x, y, lighten(ember.light, 0.5));
  });
}

// ---- walls -------------------------------------------------------------------------------

/** Stacked round logs (8 px each) with dark chinking between them. */
function woodenWall(img: Image, _rand: Rng, seed: number): void {
  const levels = [0, 0.85, 0.7, 0.6, 0.52, 0.45, 0.3, 0.12];
  eachInRect(0, 0, 32, 32, (x, y) => {
    const yy = y % 8;
    if (yy === 0) return px(img, x, y, mix(PALETTE.cloth.shadow, darkWood.deep, 0.3));
    const grain = tileNoise(x, y * 4, 8, 1, seed) - 0.5;
    px(img, x, y, shadeOf(wood, (levels[yy] ?? 0) + grain * 0.28));
  });
  knot(img, 7, 4, wood);
  knot(img, 22, 20, wood);
  // Split end-grain checks catching the light.
  line(img, 14, 12, 18, 12, wood.shadow);
  line(img, 26, 28, 29, 28, wood.shadow);
}

// ---- objects -----------------------------------------------------------------------------

/** 64x64 conifer: four tiers of needles over a short trunk in the bottom-right tile. */
function pineTree(img: Image, rand: Rng, seed: number): void {
  const cx = 44;
  // Trunk.
  eachInRect(41, 46, 7, 16, (x, y) => {
    const u = (x + 0.5 - 44.5) / 3.5;
    px(img, x, y, shadeOf(bark, cylinderLight(u) + (hash2(x, y >> 1, seed) - 0.5) * 0.2));
  });
  rect(img, 40, 60, 9, 2, bark.deep); // root flare
  px(img, 39, 61, bark.deep);
  px(img, 49, 61, bark.deep);
  // Tiers from the bottom up, so the upper ones overlap and shade the lower ones.
  const tiers: [top: number, bottom: number, half: number][] = [
    [30, 53, 20],
    [21, 43, 16],
    [12, 32, 12],
    [3, 21, 8],
  ];
  for (const [top, bottom, half] of tiers) {
    const jag = (x: number): number => (((x + top) % 4) - 1.5) * 1.1 + (rand() - 0.5);
    for (let x = cx - half; x <= cx + half; x++) {
      const u = (x + 0.5 - cx) / half; // -1 .. 1
      // Slanted sides: a tier is a triangle with a drooping, jagged hem.
      const yTop = top + Math.abs(u) * (bottom - top) * 0.78;
      const yBot = bottom - (1 - Math.abs(u)) * 1.5 + jag(x);
      for (let y = Math.floor(yTop); y <= yBot; y++) {
        const v = (y - yTop) / Math.max(1, yBot - yTop); // 0 at the top, 1 at the hem
        let level = 0.86 - u * 0.5 - v * 0.32 + (tileNoise(x, y, 4, 2, seed, 64) - 0.5) * 0.24;
        if (yBot - y < 1.2) level -= 0.25; // underside of the hem
        px(img, x, y, shadeOf(pine, level));
      }
      // The hem casts a 1-2 px shadow on what is below it.
      for (let d = 1; d <= 3; d++)
        tint(img, x, Math.floor(yBot) + d, (c) => darken(c, d === 3 ? 0.2 : 0.4));
    }
  }
  outline(img, { amount: 0.55 });
}

/** Iron anvil with a horn to the left, on its foot. */
function anvil(img: Image): void {
  const top = iron;
  const side = darkIron;
  // Horn: top face and its shadowed underside.
  polygon(
    img,
    [
      [10, 10],
      [2, 12],
      [10, 14],
    ],
    top.base,
  );
  line(img, 3, 12, 9, 11, top.light);
  polygon(
    img,
    [
      [10, 14],
      [2, 12],
      [4, 14],
      [10, 17],
    ],
    side.shadow,
  );
  // Face (top) and its front.
  rect(img, 9, 10, 19, 4, top.base);
  rect(img, 9, 10, 19, 1, top.light);
  rect(img, 9, 10, 1, 4, top.light);
  rect(img, 26, 11, 1, 2, top.shadow); // hardy hole
  rect(img, 9, 14, 19, 4, side.base);
  rect(img, 9, 14, 19, 1, side.light);
  rect(img, 27, 14, 1, 4, side.deep);
  // Waist.
  eachInRect(13, 18, 11, 5, (x, y) => {
    const u = (x + 0.5 - 18.5) / 5.5;
    px(img, x, y, shadeOf(side, cylinderLight(u) - 0.1));
  });
  // Foot: a low box.
  box(img, 9, 22, 19, 2, 5, side);
  rect(img, 9, 22, 19, 1, top.shadow);
  outline(img, { amount: 0.5 });
}

/** Wooden cargo crate with a darker frame, a diagonal brace and nails. */
function cargoCrate(img: Image): void {
  const m = weatheredWood;
  box(img, 5, 6, 22, 7, 18, wood);
  // Top face planks.
  for (const x of [12, 19]) line(img, x, 7, x, 12, wood.shadow);
  // Front planks and frame.
  for (const y of [18, 23]) line(img, 8, y, 23, y, darken(wood.shadow, 0.2));
  rect(img, 5, 13, 3, 18, m.base);
  rect(img, 24, 13, 3, 18, m.shadow);
  rect(img, 5, 13, 22, 2, m.base);
  rect(img, 5, 29, 22, 2, m.shadow);
  rect(img, 5, 13, 1, 18, m.light);
  rect(img, 5, 13, 22, 1, m.light);
  // Diagonal brace from bottom-left to top-right.
  for (let i = 0; i <= 15; i++) {
    const x = 8 + i;
    const y = 28 - Math.round((i * 12) / 15);
    px(img, x, y, m.base);
    px(img, x, y - 1, m.light);
    px(img, x, y + 1, m.shadow);
  }
  for (const [x, y] of [
    [6, 14],
    [25, 14],
    [6, 29],
    [25, 29],
  ] as const)
    px(img, x, y, darkIron.base);
  outline(img, { amount: 0.5 });
}

/** 32x64 notice board on two posts, with a little roof and pinned notes. */
function marketBoard(img: Image, rand: Rng): void {
  // Posts.
  for (const x0 of [5, 24]) {
    eachInRect(x0, 18, 3, 44, (x, y) => {
      px(img, x, y, shadeOf(darkWood, [0.8, 0.5, 0.25][x - x0] ?? 0));
    });
  }
  // Board: horizontal planks inside a dark frame.
  eachInRect(2, 19, 28, 25, (x, y) => {
    const yy = (y - 19) % 6;
    const level = yy === 5 ? 0.15 : yy === 0 ? 0.62 : 0.5 + (hash2(x >> 2, y, 7) - 0.5) * 0.25;
    px(img, x, y, shadeOf(wood, level));
  });
  rect(img, 2, 19, 28, 1, darkWood.base);
  rect(img, 2, 43, 28, 2, darkWood.shadow);
  rect(img, 2, 19, 1, 26, darkWood.base);
  rect(img, 29, 19, 1, 26, darkWood.deep);
  // Roof: a short plank lid seen from above and its front edge.
  box(img, 0, 12, 32, 4, 3, darkWood);
  for (const x of [8, 16, 24]) line(img, x, 13, x, 15, darkWood.shadow);
  // Notes.
  const notes: [number, number, number, number][] = [
    [5, 22, 8, 9],
    [15, 21, 7, 7],
    [23, 23, 5, 8],
    [7, 33, 9, 8],
    [18, 31, 8, 10],
  ];
  notes.forEach(([x, y, w, h], i) => {
    rect(img, x, y, w, h, paper.base);
    rect(img, x, y, w, 1, paper.light);
    rect(img, x + w - 1, y + 1, 1, h - 1, paper.shadow);
    rect(img, x, y + h - 1, w, 1, paper.shadow);
    for (let ty = y + 2; ty < y + h - 2; ty += 2) {
      const len = 2 + Math.floor(rand() * (w - 3));
      line(img, x + 1, ty, x + len, ty, paper.deep);
    }
    px(img, x + (w >> 1), y, i % 2 === 0 ? redCloth.base : iron.light); // pin
  });
  outline(img, { amount: 0.5 });
}

/** A wooden bollard with a mushroom cap and a coil of rope, for tying boats. */
function mooringPost(img: Image, _rand: Rng, seed: number): void {
  const cx = 16;
  const r = 4.5;
  // Shaft.
  eachInRect(12, 10, 9, 18, (x, y) => {
    const u = (x + 0.5 - cx) / r;
    const grain = (hash2(x, y >> 2, seed) - 0.5) * 0.15;
    px(img, x, y, shadeOf(darkWood, cylinderLight(u) + grain - (y < 12 ? 0.3 : 0)));
  });
  // Rounded foot.
  eachInEllipse(cx, 27.5, r, 1.6, (x, y, nx) => {
    if (y >= 27) px(img, x, y, shadeOf(darkWood, cylinderLight(nx) - 0.2));
  });
  // Mushroom cap: a flattened dome wider than the shaft.
  eachInEllipse(cx, 8.5, 6.5, 4, (x, y, nx, ny) => {
    if (ny > 0.55) return; // flat underside
    px(img, x, y, shadeOf(darkWood, domeLight(nx, ny) + 0.12));
  });
  // Rope coil: two turns, a little wider than the shaft.
  for (let turn = 0; turn < 2; turn++) {
    const y0 = 18 + turn * 2;
    eachInRect(11, y0, 11, 2, (x, y) => {
      const u = (x + 0.5 - cx) / 5.5;
      const twist = (x + y) % 3 === 0 ? -0.3 : 0;
      px(img, x, y, shadeOf(rope, cylinderLight(u) + twist + (y === y0 ? 0.15 : -0.05)));
    });
  }
  // Loose end hanging to the right.
  for (const [x, y] of [
    [22, 21],
    [23, 22],
    [23, 23],
    [24, 24],
    [24, 25],
    [24, 26],
  ] as const) {
    px(img, x, y, rope.base);
  }
  px(img, 25, 26, rope.shadow);
  outline(img, { amount: 0.5 });
}

/** A big rock in 3/4 view: chiselled facets, lit top, shadowed south face, a bit of moss. */
function boulder(img: Image, _rand: Rng, seed: number): void {
  const m = PALETTE.rock;
  const blobs: [number, number, number, number][] = [
    [16, 20, 13, 8.5],
    [12, 15, 8, 7],
    [20, 13.5, 8, 6.5],
    [24, 21, 6, 7],
  ];
  const inBlob = (x: number, y: number): boolean =>
    blobs.some(([bx, by, rx, ry]) => ((x + 0.5 - bx) / rx) ** 2 + ((y + 0.5 - by) / ry) ** 2 <= 1);
  // Facets: nearest of a jittered 7 px grid of points; each facet is shaded flat.
  const facet = (x: number, y: number): number => {
    let best = Infinity;
    let id = 0;
    for (let gy = -1; gy <= 5; gy++) {
      for (let gx = -1; gx <= 5; gx++) {
        const fx = gx * 7 + hash2(gx, gy, seed) * 7;
        const fy = gy * 7 + hash2(gx, gy, seed + 9) * 7;
        const d = (fx - x) ** 2 + (fy - y) ** 2;
        if (d < best) {
          best = d;
          id = gy * 16 + gx;
        }
      }
    }
    return id;
  };
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (!inBlob(x, y)) return;
    const f = facet(x, y);
    const flat = (hash2(f, 3, seed) - 0.5) * 0.4;
    let level = domeLight((x + 0.5 - 15) / 14, (y + 0.5 - 15) / 12) * 0.9 + flat;
    if (y >= 24) level -= 0.15 + (y - 24) * 0.04; // the south face
    level += (tileNoise(x, y, 2, 2, seed) - 0.5) * 0.12;
    px(img, x, y, shadeOf(m, level));
  });
  // Facet edges: a dark seam where a facet meets the one below or to its right.
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (!opaque(img, x, y) || !opaque(img, x + 1, y + 1)) return;
    if (facet(x, y) !== facet(x + 1, y + 1) && hash2(x, y, seed + 4) < 0.55)
      tint(img, x, y, (c) => darken(c, 0.22));
  });
  // Moss on the lit top.
  eachInRect(0, 0, 32, 32, (x, y) => {
    if (!opaque(img, x, y) || y > 15) return;
    const v = tileNoise(x, y, 4, 2, seed + 2);
    if (v > 0.74) px(img, x, y, v > 0.8 ? moss.base : moss.shadow);
  });
  outline(img, { amount: 0.5 });
}

/** A wooden signpost: a plank board with carved lines, nailed to a charred post. */
function signpost(img: Image, _rand: Rng, seed: number): void {
  // Post, lit on the left.
  eachInRect(14, 13, 5, 16, (x, y) => {
    const u = (x + 0.5 - 16.5) / 2.5;
    px(img, x, y, shadeOf(darkWood, cylinderLight(u) + (hash2(x, y >> 2, seed) - 0.5) * 0.15));
  });
  rect(img, 13, 28, 7, 1, darkWood.deep); // where it goes into the ground
  // Board: the lit top edge, two planks on the front, a darker frame.
  eachInRect(4, 7, 25, 12, (x, y) => {
    const yy = y - 7;
    const grain = tileNoise(x, y * 3, 8, 1, seed) - 0.5;
    let level = 0.5 + grain * 0.35;
    if (yy === 0) level = 0.85;
    else if (yy === 6)
      level = 0.1; // the seam between the planks
    else if (yy === 11) level = 0.15;
    px(img, x, y, shadeOf(wood, level));
  });
  rect(img, 4, 7, 1, 12, wood.light);
  rect(img, 28, 7, 1, 12, wood.deep);
  // Carved letters: short gouges in two lines.
  for (const [row, from, to] of [
    [10, 7, 25],
    [15, 8, 22],
  ] as const) {
    for (let x = from; x <= to; x++) {
      if (hash2(x, row, seed + 1) < 0.22) continue; // gaps between the words
      px(img, x, row, wood.deep);
      if (hash2(x, row, seed + 2) < 0.4) px(img, x, row + 1, wood.shadow);
    }
  }
  // Nails.
  for (const [x, y] of [
    [6, 9],
    [26, 9],
    [6, 16],
    [26, 16],
  ] as const)
    px(img, x, y, darkIron.base);
  outline(img, { amount: 0.5 });
}

export const TERRAIN: RecipeBook = {
  "ground/wooden_floor": { kind: "ground", draw: woodenFloor },
  "ground/dock_planks": { kind: "ground", draw: dockPlanks },
  "ground/ash": { kind: "ground", draw: ashGround },
  "ground/basalt": { kind: "ground", draw: basaltPaving },
  "ground/cinder_path": { kind: "ground", draw: cinderPath },
  "ground/cooled_lava": { kind: "ground", draw: cooledLava },
  "ground/lava": { kind: "ground", draw: moltenLava },
  "decor/signpost": { kind: "object", draw: signpost },
  "walls/wooden_wall": { kind: "wall", draw: woodenWall },
  "decor/pine_tree": { kind: "object", width: 64, height: 64, draw: pineTree },
  "decor/anvil": { kind: "object", draw: anvil },
  "decor/cargo_crate": { kind: "object", draw: cargoCrate },
  "decor/market_board": { kind: "object", height: 64, draw: marketBoard },
  "decor/mooring_post": { kind: "object", draw: mooringPost },
  "decor/boulder": { kind: "object", draw: boulder },
};
