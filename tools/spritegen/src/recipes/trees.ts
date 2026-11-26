// Trees and bushes (docs/17 ART-2, ART-5, ART-7): own art in 3/4 view, centred on their tile
// (assets/sprites.yaml tiles: anchor bc), a trunk on the tile and a canopy that rises two to
// three tiles and overhangs half a tile each side. Each has
// - a cast shadow, <sprite>/shadow: a blob under the canopy toward the bottom-right (light
//   from the top-left), drawn translucent by the renderer under the items;
// - wind metadata (`wind`): its type and where its trunk ends. The client sways the canopy
//   over that row with the wind of the living world (livingworld/README.md "Viento"); the
//   old baked frames (<sprite>/frame_<n>) are gone.
// The canopy is clumps of leaves (a jittered lattice of small cells, each lit on its
// top-left) over a few overlapping domes lit from the top-left, with a dark underside.
import { createImage } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import {
  cylinderLight,
  disc,
  domeLight,
  eachInRect,
  get,
  hash2,
  opaque,
  outline,
  px,
} from "../draw.ts";
import { hex } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { plantWind } from "../wind.ts";
import type { WindMeta } from "../wind.ts";
import { stones } from "./walls.ts";

type Blob = readonly [cx: number, cy: number, rx: number, ry: number];

function ramp(colors: readonly Rgba[], level: number): Rgba {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(level * colors.length)));
  return colors[i] as Rgba;
}

/** Leafy canopy over the union of the blobs, lit from the top-left. */
function canopy(
  img: Image,
  blobs: readonly Blob[],
  leaves: readonly Rgba[],
  seed: number,
  cell = 4,
): void {
  const xs = blobs.flatMap(([cx, , rx]) => [cx - rx, cx + rx]);
  const ys = blobs.flatMap(([, cy, , ry]) => [cy - ry, cy + ry]);
  const x0 = Math.floor(Math.min(...xs));
  const x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys));
  const y1 = Math.ceil(Math.max(...ys));
  const ccx = (x0 + x1) / 2;
  const ccy = (y0 + y1) / 2;
  const crx = (x1 - x0) / 2;
  const cry = (y1 - y0) / 2;
  eachInRect(x0, y0, x1 - x0, y1 - y0, (x, y) => {
    let inside = false;
    let local = 0;
    for (const [cx, cy, rx, ry] of blobs) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      inside = true;
      local = Math.max(local, domeLight(nx, ny));
    }
    if (!inside) return;
    const big = domeLight((x + 0.5 - ccx) / crx, (y + 0.5 - ccy) / cry);
    const st = stones(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, cell, cell, seed);
    let level =
      big * 0.55 + local * 0.35 - (st.dx + st.dy) * 0.3 + (hash2(st.id, 4, seed) - 0.5) * 0.15;
    if (st.gap < 0.1) level -= 0.25;
    px(img, x, y, ramp(leaves, level));
  });
}

/** A trunk from (x, top) down to its foot at `foot`, w px wide, with root flare and bark. */
function trunk(
  img: Image,
  cx: number,
  top: number,
  foot: number,
  w: number,
  bark: readonly Rgba[],
  seed: number,
): void {
  for (let y = top; y <= foot; y++) {
    // The roots flare over the last rows.
    const half = w / 2 + Math.max(0, y - (foot - 3));
    for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
      const u = (x + 0.5 - cx) / half;
      const grain = (hash2(x, y >> 1, seed) - 0.5) * 0.25;
      px(img, x, y, ramp(bark, cylinderLight(u) * 0.9 + grain));
    }
  }
}

/** The cast shadow of a tree: a blob round the foot, toward the bottom-right. */
function treeShadow(w: number, h: number, cx: number, foot: number, rx: number, ry: number): Image {
  const img = createImage(w, h);
  disc(img, cx + rx * 0.3, foot - ry * 0.4, rx, ry, [0, 0, 0, 255]);
  return img;
}

interface TreeSpec {
  w: number;
  h: number;
  draw(img: Image, seed: number): void;
  /**
   * How it takes the wind (wind.ts): its type and its pivot, the px over the sprite's
   * bottom edge where the trunk ends and the canopy starts. The client sways the canopy
   * over it (livingworld/README.md "Viento"); no frames are drawn for it.
   */
  wind: WindMeta;
  shadow: { cx: number; foot: number; rx: number; ry: number };
}

function tree(sprite: string, spec: TreeSpec): RecipeBook {
  const seed = seedOf(sprite);
  const base = (): Image => {
    const img = createImage(spec.w, spec.h);
    spec.draw(img, seed);
    outline(img, { amount: 0.55 });
    return img;
  };
  const { cx, foot, rx, ry } = spec.shadow;
  return {
    [sprite]: {
      kind: "object",
      width: spec.w,
      height: spec.h,
      wind: spec.wind,
      draw: (img) => blitAll(base(), img),
    },
    [`${sprite}/shadow`]: {
      kind: "object",
      width: spec.w,
      height: spec.h,
      draw: (img) => blitAll(treeShadow(spec.w, spec.h, cx, foot, rx, ry), img),
    },
  };
}

function blitAll(src: Image, dst: Image): void {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const c = get(src, x, y);
      if (c) px(dst, x, y, c);
    }
}

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BARK = ["#24180f", "#33241a", "#463224", "#5a4230", "#6d533d"].map(hex);
const BIRCH_BARK = ["#3b3a36", "#8c8a80", "#b4b1a4", "#d2cfc1", "#e4e1d3"].map(hex);
const OAK_LEAVES = ["#0f2412", "#173318", "#21441f", "#2c5526", "#3a672e", "#4c7a37"].map(hex);
const ELM_LEAVES = ["#0d2018", "#142e20", "#1d3e29", "#284f33", "#33603c", "#447246"].map(hex);
const BIRCH_LEAVES = ["#2a3313", "#3c4719", "#535e20", "#6d7428", "#8a8a33", "#a6a046"].map(hex);
const PINE_LEAVES = ["#0b1d16", "#10281d", "#163425", "#1e412d", "#285036", "#346042"].map(hex);
const BUSH_LEAVES = ["#122a14", "#1b3a1b", "#264b22", "#31592a", "#3f6a32"].map(hex);

/** 64x96 oak: a thick trunk and a broad, round crown of three domes. */
function oak(img: Image, seed: number): void {
  trunk(img, 32, 62, 90, 8, BARK, seed);
  // Two boughs into the crown.
  for (let i = 0; i < 9; i++) {
    px(img, 28 - i, 68 - i, BARK[2] as Rgba);
    px(img, 36 + i, 69 - i, BARK[1] as Rgba);
  }
  canopy(
    img,
    [
      [32, 46, 28, 21],
      [18, 56, 14, 12],
      [46, 55, 14, 12],
      [32, 32, 20, 15],
      [24, 40, 12, 10],
    ],
    OAK_LEAVES,
    seed,
  );
}

/** 64x96 elm: a tall trunk and a vase-shaped crown, darker and cooler. */
function elm(img: Image, seed: number): void {
  trunk(img, 32, 58, 90, 7, BARK, seed + 1);
  canopy(
    img,
    [
      [32, 38, 24, 25],
      [19, 52, 13, 12],
      [45, 50, 13, 13],
      [32, 18, 16, 12],
    ],
    ELM_LEAVES,
    seed,
  );
}

/** 64x96 birch: a slender white trunk with dark marks and a light, airy crown. */
function birch(img: Image, seed: number): void {
  trunk(img, 32, 50, 90, 5, BIRCH_BARK, seed);
  for (let y = 48; y < 88; y += 5) {
    const x = 30 + Math.floor(hash2(y, 1, seed) * 3);
    px(img, x, y, BIRCH_BARK[0] as Rgba);
    px(img, x + 1, y, BIRCH_BARK[0] as Rgba);
  }
  canopy(
    img,
    [
      [32, 38, 20, 22],
      [22, 50, 11, 10],
      [42, 48, 11, 11],
      [33, 20, 13, 11],
    ],
    BIRCH_LEAVES,
    seed,
    4,
  );
}

/** 64x96 pine: tiers of needles, each overlapping the one below, over a short trunk. */
function pine(img: Image, seed: number): void {
  trunk(img, 32, 70, 90, 6, BARK, seed);
  const tiers: [top: number, bottom: number, half: number][] = [
    [38, 76, 24],
    [24, 60, 19],
    [12, 44, 14],
    [2, 28, 9],
  ];
  for (const [top, bottom, half] of tiers) {
    for (let x = 32 - half; x <= 32 + half; x++) {
      const u = (x + 0.5 - 32) / half;
      const yTop = top + Math.abs(u) * (bottom - top) * 0.75;
      const jag = (((x * 7 + top) % 5) - 2) * 0.8;
      const yBot = bottom - (1 - Math.abs(u)) * 3 + jag;
      for (let y = Math.floor(yTop); y <= yBot; y++) {
        const v = (y - yTop) / Math.max(1, yBot - yTop);
        const st = stones(((x % 32) + 32) % 32, y % 32, 4, 4, seed);
        let level = 0.8 - u * 0.4 - v * 0.35 - (st.dx + st.dy) * 0.2;
        if (yBot - y < 1.5) level -= 0.3;
        px(img, x, y, ramp(PINE_LEAVES, level));
      }
    }
  }
}

/** 32x32 bush: a round shrub of leaf clumps. */
function bush(img: Image, seed: number): void {
  canopy(
    img,
    [
      [16, 19, 13, 10],
      [10, 22, 7, 6],
      [22, 22, 7, 6],
      [16, 13, 8, 7],
    ],
    BUSH_LEAVES,
    seed,
  );
  // A few berries.
  for (const [x, y] of [
    [11, 16],
    [20, 13],
    [23, 21],
  ] as const)
    if (opaque(img, x, y)) px(img, x, y, hex("#8a2d2d"));
}

export const TREES: RecipeBook = {
  ...tree("decor/oak_tree", {
    w: 64,
    h: 96,
    draw: oak,
    wind: plantWind("tree", { pivot: 28 }),
    shadow: { cx: 32, foot: 92, rx: 22, ry: 7 },
  }),
  ...tree("decor/elm_tree", {
    w: 64,
    h: 96,
    draw: elm,
    wind: plantWind("tree", { pivot: 32 }),
    shadow: { cx: 32, foot: 92, rx: 19, ry: 6 },
  }),
  ...tree("decor/birch_tree", {
    w: 64,
    h: 96,
    draw: birch,
    wind: plantWind("tree", { pivot: 36 }),
    shadow: { cx: 32, foot: 92, rx: 16, ry: 6 },
  }),
  ...tree("decor/pine_tree", {
    w: 64,
    h: 96,
    draw: pine,
    // Under the lowest tier's fringe: the trunk alone stays planted.
    wind: plantWind("tree", { pivot: 17 }),
    shadow: { cx: 32, foot: 92, rx: 20, ry: 6 },
  }),
  ...tree("decor/bush", {
    w: 32,
    h: 32,
    draw: bush,
    wind: plantWind("bush", { pivot: 6 }),
    shadow: { cx: 16, foot: 31, rx: 12, ry: 4 },
  }),
};
