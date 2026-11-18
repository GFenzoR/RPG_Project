// Monsters standing on their tile in 3/4 view, lit from the top-left, facing south-west like
// the Dungeon Crawl animals. The player outfits and the NPCs drawn here before (T0.5) are
// Liberated Pixel Cup characters since docs/17 A12: assets/sprites.yaml `animations`.
import type { Image } from "@rpg/spritepack";
import {
  cylinderLight,
  domeLight,
  eachInEllipse,
  eachInPolygon,
  hash2,
  line,
  outline,
  px,
  rect,
  shadeOf,
} from "../draw.ts";
import type { Point } from "../draw.ts";
import { hex, material, PALETTE } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

const { feather, bone, foliage, redCloth } = PALETTE;

// ---- local materials ---------------------------------------------------------------------

const gullGrey = material("#a7abb0", "#83888e", "#61666c", "#43474c");
const wingTip = material("#55565a", "#38393c", "#28292b", "#1b1b1d");
const beak = material("#f2d266", "#d6a83a", "#a67a26", "#6c4e18");
const gullLeg = material("#e3a05a", "#c27a3a", "#8f5527", "#5c3418");
const boarFur = material("#7c6350", "#5c4738", "#423328", "#2b211a");
const bristle = material("#b3a289", "#8f7e67", "#6b5c4a", "#493e32");
const snout = material("#c49484", "#a07364", "#7a5446", "#52372d");
const hoof = material("#5a5048", "#3f3832", "#2c2723", "#1d1a17");
const stagCoat = material("#b8814f", "#935f36", "#6b4325", "#462b17");
const stagBelly = material("#e4d2b0", "#c8b48e", "#a08b69", "#76654b");
const thornWood = material("#6e5440", "#4f3a2b", "#38291e", "#251b13");

// ---- helpers -----------------------------------------------------------------------------

/**
 * A four-legged trot (docs/17 ANI-2): frame f of 4, the legs in diagonal pairs (near front
 * with far back, near back with far front). Each pair reaches forward (towards the head,
 * to the left), passes under the body lifted 1 px, swings back and passes again on the
 * ground. f < 0 is the standing pose: no offset.
 */
const TROT = [
  { dx: -1, lift: 0 },
  { dx: 0, lift: 1 },
  { dx: 1, lift: 0 },
  { dx: 0, lift: 0 },
] as const;
const trot = (f: number, pair: 0 | 1): { dx: number; lift: number } =>
  f < 0 ? { dx: 0, lift: 0 } : (TROT[(f + pair * 2) % TROT.length] ?? { dx: 0, lift: 0 });

/** A shaded ellipse (a body, a head): domeLight plus a bias. */
function ball(img: Image, cx: number, cy: number, rx: number, ry: number, m: Material, bias = 0) {
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) =>
    px(img, x, y, shadeOf(m, domeLight(nx, ny) + bias)),
  );
}

/** A polygon filled by a light function of the pixel. */
function shape(
  img: Image,
  pts: readonly Point[],
  m: Material,
  level: (x: number, y: number) => number,
) {
  eachInPolygon(pts, (x, y) => px(img, x, y, shadeOf(m, level(x, y))));
}

/** A vertical limb/column x..x+w-1, y..y+h-1 shaded like a cylinder; bias darkens far limbs. */
function limb(img: Image, x: number, y: number, w: number, h: number, m: Material, bias = 0) {
  for (let qx = x; qx < x + w; qx++) {
    const u = w === 1 ? 0 : ((qx - x) / (w - 1)) * 2 - 1;
    for (let qy = y; qy < y + h; qy++) px(img, qx, qy, shadeOf(m, cylinderLight(u * 0.8) + bias));
  }
}

/** A slanted leg from (x0, y0) to (x1, y1), w pixels wide, shaded across its width. */
function slantLimb(
  img: Image,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  m: Material,
  bias = 0,
) {
  for (let y = y0; y <= y1; y++) {
    const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
    const left = Math.round(x0 + (x1 - x0) * t - w / 2);
    for (let i = 0; i < w; i++) {
      const u = w === 1 ? 0 : (i / (w - 1)) * 2 - 1;
      px(img, left + i, y, shadeOf(m, cylinderLight(u * 0.8) + bias));
    }
  }
}

// ---- monsters ----------------------------------------------------------------------------

/** A grey-backed gull with a stolen fish in its beak. */
function thievingGull(img: Image): void {
  // Tail and black wingtips, behind the body.
  shape(
    img,
    [
      [22, 15],
      [30, 11],
      [31, 14],
      [25, 20],
    ],
    wingTip,
    (x, y) => 0.55 - (y - 14) * 0.06 + (hash2(x, y, 7) < 0.15 ? 0.4 : 0),
  );
  // Legs.
  for (const lx of [15, 19]) {
    rect(img, lx, 25, 1, 4, gullLeg.shadow);
    rect(img, lx - 2, 29, 3, 1, gullLeg.base);
    px(img, lx + 1, 29, gullLeg.shadow);
  }
  // Body (white breast) and folded grey wing on its back.
  ball(img, 17, 20, 8, 5.5, feather, 0.15);
  shape(
    img,
    [
      [13, 16],
      [19, 14.5],
      [27, 14],
      [25, 21],
      [17, 21],
    ],
    gullGrey,
    (x, y) => 0.85 - (x - 13) * 0.02 - (y - 14) * 0.07,
  );
  // Feather rows on the wing.
  line(img, 16, 18, 23, 17, gullGrey.deep);
  line(img, 19, 20, 24, 19, gullGrey.deep);
  // Neck and head.
  ball(img, 12, 16, 3.5, 3.5, feather, 0.15);
  ball(img, 10, 11.5, 4.5, 4, feather, 0.2);
  px(img, 8, 11, [30, 26, 22, 255]); // eye
  px(img, 9, 10, gullGrey.base); // brow
  // The stolen fish, hanging head-up from the beak: a blue back on the left, a silver belly
  // on the right, a fin on its back and a wide forked tail, big enough to read at 1x.
  const fishBack = material("#86aac4", "#5a84a2", "#3f627c", "#2a4356");
  const fishBelly = material("#f4f5ee", "#d6dad2", "#a9aea6", "#787d77");
  eachInPolygon(
    [
      [4, 13],
      [6.6, 16],
      [7.4, 19.5],
      [6.4, 23],
      [4.6, 26],
      [3.4, 26],
      [1.6, 23],
      [0.8, 19.5],
      [1.6, 16],
    ],
    (x, y) => {
      const c =
        x <= 1
          ? fishBack.shadow
          : x === 2
            ? fishBack.base
            : x === 3
              ? fishBack.light
              : x <= 5
                ? fishBelly.light
                : fishBelly.shadow;
      px(img, x, y, y >= 24 && x >= 3 ? fishBelly.shadow : c);
    },
  );
  line(img, 2, 18, 2, 22, fishBack.deep); // the line along its flank
  px(img, 0, 19, fishBack.base); // the back fin
  px(img, 0, 20, fishBack.shadow);
  for (const [x, y, c] of [
    [3, 27, fishBack.base],
    [4, 27, fishBack.shadow],
    [2, 28, fishBack.base],
    [5, 28, fishBack.shadow],
    [1, 29, fishBack.light],
    [6, 29, fishBack.base],
  ] as const)
    px(img, x, y, c); // the forked tail
  px(img, 3, 16, [24, 22, 26, 255]); // fish eye
  px(img, 5, 17, fishBack.shadow); // the gill
  // Beak, pointing down-left, clamped on the fish's head, with the red spot.
  rect(img, 3, 13, 4, 1, beak.light);
  rect(img, 3, 14, 4, 1, beak.base);
  px(img, 2, 14, beak.shadow);
  px(img, 4, 14, redCloth.light);
  outline(img, { amount: 0.55 });
}

/** A squat, dark boar with a pale bristle crest along its back and curved tusks. */
function bristlebackBoar(img: Image, f = -1): void {
  // Diagonal pairs: a = near front + far back, b = near back + far front.
  const a = trot(f, 0);
  const b = trot(f, 1);
  // Far legs.
  limb(img, 22 + b.dx, 24, 3, 5 - b.lift, boarFur, -0.3);
  limb(img, 26 + a.dx, 23, 3, 5 - a.lift, boarFur, -0.3);
  rect(img, 22 + b.dx, 28 - b.lift, 3, 1, hoof.base);
  rect(img, 26 + a.dx, 27 - a.lift, 3, 1, hoof.base);
  // Tail.
  line(img, 29, 16, 30, 18, boarFur.shadow);
  // Body.
  ball(img, 19, 19, 10, 6.5, boarFur);
  // Bristle crest: spikes along the top of the back, pale tips.
  for (let x = 10; x <= 28; x++) {
    const u = (x + 0.5 - 19) / 10;
    const top = Math.round(19 - 6.5 * Math.sqrt(Math.max(0, 1 - u * u)));
    const h = 2 + (x % 2 === 0 ? 1 : 0) + (x > 13 && x < 24 ? 1 : 0);
    for (let k = 0; k < h; k++) {
      const c = k === h - 1 ? bristle.light : k === 0 ? bristle.shadow : bristle.base;
      px(img, x, top - k + 1, c);
    }
  }
  // Head, lower left, in front of the body.
  ball(img, 9.5, 20.5, 6, 5.5, boarFur, 0.05);
  // Ears.
  shape(
    img,
    [
      [8, 13],
      [12, 15.5],
      [8.5, 17],
    ],
    boarFur,
    () => 0.3,
  );
  shape(
    img,
    [
      [13, 14],
      [15.5, 17],
      [12, 17],
    ],
    boarFur,
    () => 0.55,
  );
  // Snout.
  ball(img, 4.5, 24, 3, 2.5, snout);
  px(img, 3, 24, snout.deep);
  px(img, 5, 24, snout.deep);
  // Tusks curling up beside the snout.
  px(img, 7, 26, bone.shadow);
  px(img, 8, 25, bone.base);
  px(img, 8, 24, bone.light);
  px(img, 8, 23, bone.light);
  px(img, 2, 26, bone.shadow);
  px(img, 1, 25, bone.base);
  px(img, 1, 24, bone.light);
  // Eye.
  px(img, 8, 19, [40, 18, 14, 255]);
  px(img, 9, 19, boarFur.deep);
  // Near legs.
  limb(img, 9 + a.dx, 25, 3, 5 - a.lift, boarFur, -0.05);
  limb(img, 15 + b.dx, 25, 3, 5 - b.lift, boarFur, -0.05);
  rect(img, 9 + a.dx, 29 - a.lift, 3, 1, hoof.base);
  rect(img, 15 + b.dx, 29 - b.lift, 3, 1, hoof.base);
  outline(img, { amount: 0.55 });
}

/** A red deer whose antlers are thorny bramble wood, with leaves and berries, and a vine on its back. */
function brambleStag(img: Image, f = -1): void {
  // Diagonal pairs: a = near front + far back, b = near back + far front.
  const a = trot(f, 0);
  const b = trot(f, 1);
  // Far legs: the hip stays, the hoof moves.
  slantLimb(img, 15, 20, 14 + b.dx, 28 - b.lift, 2, stagCoat, -0.35);
  slantLimb(img, 25, 20, 26 + a.dx, 28 - a.lift, 2, stagCoat, -0.35);
  rect(img, 13 + b.dx, 29 - b.lift, 2, 1, hoof.base);
  rect(img, 26 + a.dx, 29 - a.lift, 2, 1, hoof.base);
  // Body with a pale belly.
  eachInEllipse(20, 16.5, 8.5, 5, (x, y, nx, ny) => {
    const m = ny > 0.55 ? stagBelly : stagCoat;
    px(img, x, y, shadeOf(m, domeLight(nx, ny) + 0.05));
  });
  // White rump and short tail.
  ball(img, 28, 14.5, 1.5, 2, stagBelly, 0.1);
  // Neck rising to the head (top left).
  shape(
    img,
    [
      [9, 9],
      [13.5, 8.5],
      [17, 14],
      [15, 19],
      [11, 17],
    ],
    stagCoat,
    (x, y) => 0.8 - (x - 9) * 0.05 + (y > 14 ? -0.1 : 0),
  );
  // Near legs.
  slantLimb(img, 12, 19, 11 + a.dx, 28 - a.lift, 2, stagCoat, -0.05);
  slantLimb(img, 22, 20, 23 + b.dx, 28 - b.lift, 2, stagCoat, -0.05);
  rect(img, 10 + a.dx, 29 - a.lift, 2, 1, hoof.base);
  rect(img, 23 + b.dx, 29 - b.lift, 2, 1, hoof.base);
  // Head and muzzle.
  ball(img, 9.5, 9.5, 3.5, 3, stagCoat, 0.1);
  ball(img, 6, 12, 2.2, 1.7, stagCoat, -0.05);
  px(img, 4, 12, [30, 22, 18, 255]); // nose
  px(img, 8, 9, [24, 16, 12, 255]); // eye
  // Ears.
  shape(
    img,
    [
      [11, 6],
      [15, 5],
      [13, 8],
    ],
    stagCoat,
    () => 0.5,
  );
  // Bramble antlers: crooked thorny branches, each three pixels wide so that after the
  // outline a lit core with a dark rim is left (a one-pixel line would turn all outline).
  const branches: [number, number, number, number][] = [
    [9, 6, 4, 1], // the left beam
    [7, 4, 2, 5], // its tine down to the left
    [5, 2, 6, 0], // and the one up
    [12, 6, 18, 1], // the right beam
    [14, 4, 20, 5], // its tine down to the right
    [16, 3, 15, 0], // and the one up
  ];
  const beam = (fn: (x: number, y: number) => void): void => {
    for (const [x0, y0, x1, y1] of branches) {
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1;
      const sy = y0 < y1 ? 1 : -1;
      let [x, y, err] = [x0, y0, dx - dy];
      for (;;) {
        fn(x, y);
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
          err -= dy;
          x += sx;
        }
        if (e2 < dx) {
          err += dx;
          y += sy;
        }
      }
    }
  };
  beam((x, y) => {
    for (const [ox, oy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const)
      if (y + oy <= 7) px(img, x + ox, y + oy, thornWood.shadow);
  });
  beam((x, y) => px(img, x, y, x < 11 ? thornWood.light : thornWood.base));
  // Leaf clusters on the branches (a lit pixel survives the outline in the middle).
  for (const [x, y] of [
    [3, 3],
    [18, 3],
    [10, 2],
  ] as const) {
    rect(img, x - 1, y - 1, 3, 3, foliage.base);
    px(img, x, y, foliage.light);
    px(img, x + 1, y + 1, foliage.shadow);
  }
  // A bramble vine across its back: a thick green stem with leaves and pale thorns.
  for (let x = 14; x <= 26; x++) {
    const y = 12 + Math.round(Math.sin(x * 0.9) * 1.2);
    px(img, x, y, foliage.shadow);
    px(img, x, y + 1, foliage.deep);
    if (x % 4 === 1) {
      px(img, x, y - 1, foliage.light);
      px(img, x + 1, y - 1, foliage.base);
    }
    if (x % 4 === 3) px(img, x, y + 2, thornWood.light);
  }
  outline(img, { amount: 0.55 });
  // Berries after the outline, so they stay bright: on the branch tips and the vine.
  for (const [x, y] of [
    [1, 5],
    [6, 0],
    [19, 0],
    [20, 6],
    [11, 1],
    [17, 11],
    [24, 11],
  ] as const) {
    px(img, x, y, hex("#d8343a"));
    if (y > 0) px(img, x, y - 1, hex("#f07a72"));
  }
}

/**
 * Walk cycles (docs/17 ANI-4): <sprite>/walk_w_<n>, looking left like the standing pose;
 * the client mirrors them to walk east (`facing: left` in assets/sprites.yaml).
 */
const walkCycle = (sprite: string, draw: (img: Image, f: number) => void): RecipeBook =>
  Object.fromEntries(
    TROT.map((_, f) => [
      `${sprite}/walk_w_${f}`,
      { kind: "creature" as const, draw: (img: Image) => draw(img, f) },
    ]),
  );

export const CREATURES: RecipeBook = {
  "creatures/thieving_gull": { kind: "creature", draw: thievingGull },
  "creatures/bristleback_boar": { kind: "creature", draw: (img) => bristlebackBoar(img) },
  "creatures/bramble_stag": { kind: "creature", draw: (img) => brambleStag(img) },
  ...walkCycle("creatures/bristleback_boar", bristlebackBoar),
  ...walkCycle("creatures/bramble_stag", brambleStag),
};
