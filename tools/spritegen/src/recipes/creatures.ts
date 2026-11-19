// Monsters standing on their tile in 3/4 view, lit from the top-left, facing south-west like
// the Dungeon Crawl animals. The player outfits and the NPCs drawn here before (T0.5) are
// Liberated Pixel Cup characters since docs/17 A12: assets/sprites.yaml `animations`. The
// boar and the stag are models of the sprite engine since 2026-11-18 (engine/specs/); the
// gull stays hand-drawn while the owner decides its art.
import type { Image } from "@rpg/spritepack";
import {
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
import { material, PALETTE } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

const { feather, redCloth } = PALETTE;

// ---- local materials ---------------------------------------------------------------------

const gullGrey = material("#a7abb0", "#83888e", "#61666c", "#43474c");
const wingTip = material("#55565a", "#38393c", "#28292b", "#1b1b1d");
const beak = material("#f2d266", "#d6a83a", "#a67a26", "#6c4e18");
const gullLeg = material("#e3a05a", "#c27a3a", "#8f5527", "#5c3418");

// ---- helpers -----------------------------------------------------------------------------

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

export const CREATURES: RecipeBook = {
  "creatures/thieving_gull": { kind: "creature", draw: thievingGull },
};
