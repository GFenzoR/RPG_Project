// Monsters, NPCs and the player outfit (T0.5 phase 2), standing on their tile in 3/4 view,
// lit from the top-left. Monsters face south-west like the Dungeon Crawl animals; people
// face the viewer. Each body part is a flat-shaded region of one material, so outfits can
// later be recoloured per part (hair, head, body, legs, feet).
import type { Image, Rgba } from "@rpg/spritepack";
import {
  canvas,
  composite,
  cylinderLight,
  domeLight,
  eachInEllipse,
  eachInPolygon,
  get,
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
import type { Recipe, RecipeBook } from "../recipe.ts";

const { feather, bone, skin, darkWood, foliage, redCloth, wood, rope } = PALETTE;

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
const coat = material("#5f8fae", "#3f6d8c", "#2e5069", "#1f3649");
const strawHat = rope;
const beard = material("#b9b2a6", "#948c80", "#6f685e", "#4c463f");
const darkCloth = material("#6c6a66", "#504e4a", "#3a3835", "#272523");
const boot = material("#6a4c34", "#4e3624", "#382618", "#24180e");
const hair = material("#8f6842", "#6c4b2c", "#4f351e", "#33210f");
const tunic = material("#86a060", "#667f45", "#4a5d31", "#313f20");
const trousers = material("#8f7858", "#6e5b40", "#50422e", "#352b1d");

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
  // Beak, pointing down-left, with the red spot.
  rect(img, 3, 13, 4, 1, beak.light);
  rect(img, 3, 14, 4, 1, beak.base);
  px(img, 2, 14, beak.shadow);
  px(img, 4, 14, redCloth.light);
  // The stolen fish hanging from the beak.
  const fish = material("#d3e2de", "#93b3ac", "#62847e", "#405955");
  shape(
    img,
    [
      [4, 14.5],
      [5.8, 17],
      [5.6, 20.5],
      [4, 22.5],
      [2.4, 20.5],
      [2.2, 17],
    ],
    fish,
    (x) => (x <= 2 ? 0.3 : x === 3 ? 0.85 : 0.55),
  );
  for (const [x, y] of [
    [2, 24],
    [3, 23],
    [5, 23],
    [6, 24],
  ] as const)
    px(img, x, y, fish.shadow); // forked tail
  px(img, 4, 23, fish.deep);
  px(img, 4, 16, [30, 26, 22, 255]); // fish eye
  outline(img, { amount: 0.55 });
}

/** A squat, dark boar with a pale bristle crest along its back and curved tusks. */
function bristlebackBoar(img: Image): void {
  // Far legs.
  limb(img, 22, 24, 3, 5, boarFur, -0.3);
  limb(img, 26, 23, 3, 5, boarFur, -0.3);
  rect(img, 22, 28, 3, 1, hoof.base);
  rect(img, 26, 27, 3, 1, hoof.base);
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
  limb(img, 9, 25, 3, 5, boarFur, -0.05);
  limb(img, 15, 25, 3, 5, boarFur, -0.05);
  rect(img, 9, 29, 3, 1, hoof.base);
  rect(img, 15, 29, 3, 1, hoof.base);
  outline(img, { amount: 0.55 });
}

/** A red deer whose antlers are thorny bramble wood, with leaves and berries, and a vine on its back. */
function brambleStag(img: Image): void {
  // Far legs.
  slantLimb(img, 15, 20, 14, 28, 2, stagCoat, -0.35);
  slantLimb(img, 25, 20, 26, 28, 2, stagCoat, -0.35);
  rect(img, 13, 29, 2, 1, hoof.base);
  rect(img, 26, 29, 2, 1, hoof.base);
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
  slantLimb(img, 12, 19, 11, 28, 2, stagCoat, -0.05);
  slantLimb(img, 22, 20, 23, 28, 2, stagCoat, -0.05);
  rect(img, 10, 29, 2, 1, hoof.base);
  rect(img, 23, 29, 2, 1, hoof.base);
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
  // Bramble antlers: crooked thorny branches.
  const branches: [number, number, number, number][] = [
    [9, 6, 7, 1],
    [8, 3, 4, 2],
    [7, 4, 5, 5],
    [11, 6, 14, 1],
    [13, 3, 17, 2],
    [12, 4, 15, 5],
  ];
  for (const [x0, y0, x1, y1] of branches) line(img, x0, y0, x1, y1, thornWood.base);
  line(img, 10, 6, 7, 2, thornWood.light);
  line(img, 12, 6, 14, 2, thornWood.shadow);
  for (const [x, y] of [
    [6, 0],
    [3, 2],
    [15, 0],
    [17, 3],
    [4, 6],
  ] as const)
    px(img, x, y, thornWood.light); // thorns
  for (const [x, y] of [
    [5, 1],
    [16, 1],
    [16, 5],
  ] as const) {
    px(img, x, y, foliage.light);
    px(img, x + 1, y, foliage.base);
  }
  px(img, 3, 4, redCloth.light); // berries
  px(img, 18, 2, redCloth.light);
  // A bramble vine across its back.
  for (let x = 14; x <= 26; x++) {
    const y = 12 + Math.round(Math.sin(x * 0.9) * 1.2);
    px(img, x, y, foliage.shadow);
    if (x % 4 === 1) px(img, x, y - 1, foliage.light);
    if (x % 4 === 3) px(img, x, y + 1, thornWood.light);
  }
  outline(img, { amount: 0.55 });
}

// ---- NPCs --------------------------------------------------------------------------------

/** Tavin the ferryman: straw hat, grey beard, blue sea coat, holding a tall oar. */
function ferryman(img: Image): void {
  // The oar, behind his right hand (viewer's left): shaft and blade at the top.
  limb(img, 5, 8, 2, 22, wood, 0);
  shape(
    img,
    [
      [3.5, 1],
      [8.5, 1],
      [8, 9],
      [6.5, 10.5],
      [5.5, 10.5],
      [4, 9],
    ],
    wood,
    (x, y) => (x < 5 ? 0.9 : x < 7 ? 0.6 : 0.3) - (y > 8 ? 0.2 : 0),
  );
  // Legs and boots.
  limb(img, 12, 24, 4, 3, darkCloth);
  limb(img, 16, 24, 4, 3, darkCloth, -0.15);
  limb(img, 11, 27, 5, 3, boot);
  limb(img, 16, 27, 5, 3, boot, -0.1);
  // Long coat flaring at the hem.
  shape(
    img,
    [
      [11, 13],
      [21, 13],
      [22, 25],
      [10, 25],
    ],
    coat,
    (x, y) => cylinderLight(((x - 10) / 12) * 2 - 1) + (y === 13 ? 0.2 : 0),
  );
  line(img, 16, 15, 16, 24, coat.deep); // front opening
  rect(img, 11, 20, 11, 1, darkWood.base); // belt
  px(img, 16, 20, PALETTE.gold.base);
  // Arms: his right holds the oar, the left hangs.
  limb(img, 8, 14, 3, 5, coat, 0.05);
  limb(img, 21, 14, 3, 7, coat, -0.15);
  ball(img, 6.5, 18.5, 1.8, 1.7, skin, 0.1); // hand on the oar
  rect(img, 21, 21, 3, 2, skin.shadow);
  // Head: face, beard.
  ball(img, 16, 9.5, 4, 4, skin, 0.05);
  eachInEllipse(16, 12, 3.6, 2.6, (x, y, nx, ny) => {
    if (y >= 11) px(img, x, y, shadeOf(beard, domeLight(nx, ny) + 0.1));
  });
  px(img, 14, 9, [40, 30, 24, 255]);
  px(img, 17, 9, [40, 30, 24, 255]);
  px(img, 15, 11, beard.light);
  px(img, 16, 11, beard.light);
  // Straw hat: wide brim and a low crown.
  ball(img, 16, 7, 7.5, 2, strawHat, 0.05);
  ball(img, 16, 4.5, 4, 2.6, strawHat, 0.15);
  rect(img, 12, 6, 8, 1, redCloth.shadow); // hat band
  outline(img, { amount: 0.55 });
}

// ---- the player outfits ------------------------------------------------------------------
//
// Every outfit is the same body, frames and walk cycle (citizen's); a Look swaps the
// materials of each part and adds its details in hooks, so a new outfit walks exactly like
// the others. The shop outfits (T5.7, data/cosmetics.yaml) are original designs.

type Dir = "n" | "e" | "s" | "w";
type View = { kind: "front"; dir: "n" | "s" } | { kind: "side"; f: number; cx: number };

interface Look {
  hair: Material;
  /** Torso. */
  top: Material;
  /** Arms (sleeves). */
  sleeve: Material;
  legs: Material;
  boot: Material;
  /** The belt row (y 20). */
  belt: (top: Material) => Rgba;
  /** First row of the boots: 27 = ankle boots, lower = taller. */
  bootTop: number;
  /** Replaces the hair cap of the front views (a hood). */
  hairFront?: (dir: "n" | "s", y: number, nx: number) => boolean;
  /** Replaces the hair of the profile; back > 0 is the face side. */
  hairSide?: (y: number, back: number) => boolean;
  /** Front views, after the torso and before the head. */
  torso?: (img: Image, dir: "n" | "s", frame: number) => void;
  /** Last details, before the outline (the whole figure is drawn). */
  finish?: (img: Image, view: View, frame: number) => void;
}

const CITIZEN: Look = {
  hair,
  top: tunic,
  sleeve: tunic,
  legs: trousers,
  boot,
  belt: (top) => top.deep,
  bootTop: 27,
};

/** Recolours the pixels drawn in one material's shades into another's, shade for shade. */
function recolor(
  img: Image,
  from: Material,
  to: Material,
  keep: (x: number, y: number) => boolean = () => true,
): void {
  const pairs: [Rgba, Rgba][] = [
    [from.light, to.light],
    [from.base, to.base],
    [from.shadow, to.shadow],
    [from.deep, to.deep],
  ];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const c = get(img, x, y);
      if (!c || c[3] === 0 || !keep(x, y)) continue;
      const hit = pairs.find(([a]) => a[0] === c[0] && a[1] === c[1] && a[2] === c[2]);
      if (hit) px(img, x, y, hit[1]);
    }
}

/**
 * One frame of an outfit. frame 0 stands; frames 1 and 2 are the two walking steps.
 */
function person(look: Look, dir: Dir, frame: number): (img: Image) => void {
  return (img) =>
    dir === "e" || dir === "w"
      ? personSide(img, look, dir, frame)
      : personFront(img, look, dir, frame);
}

const BLACK_EYE: [number, number, number, 255] = [36, 26, 20, 255];

/** Facing the viewer (s) or away (n). A step lifts one foot and swings the opposite arm. */
function personFront(img: Image, look: Look, dir: "n" | "s", frame: number): void {
  // Which leg steps forward (screen left = 1, right = 2). Facing north, screen left is the
  // character's left, so the same frames alternate the same way.
  const lift = (side: 1 | 2): number => (frame === 0 ? 0 : frame === side ? 0 : 2);
  const reach = (side: 1 | 2): number => (frame === 0 ? 0 : frame === side ? -1 : 1);
  // Legs and boots: the lifted leg is shorter.
  const legs: [number, 1 | 2][] = [
    [12, 1],
    [16, 2],
  ];
  for (const [x, side] of legs) {
    const up = lift(side);
    limb(img, x, 22, 4, look.bootTop - 22 - up, look.legs, side === 2 ? -0.1 : 0);
    limb(img, x, look.bootTop - up, 4, 30 - look.bootTop, look.boot, side === 2 ? -0.1 : 0);
  }
  // Arms: the arm opposite the forward leg swings forward (hand lower).
  const arms: [number, 1 | 2][] = [
    [10, 2],
    [20, 1],
  ];
  for (const [x, side] of arms) {
    const d = reach(side);
    limb(img, x, 14, 2, 6 + d, look.sleeve, x > 16 ? -0.15 : 0.05);
    rect(img, x, 20 + d, 2, 2, x > 16 ? skin.shadow : skin.base);
  }
  // Torso with rounded shoulders, flaring a little at the hem, and a belt.
  shape(
    img,
    [
      [12.5, 13],
      [19.5, 13],
      [20, 14],
      [20, 22],
      [12, 22],
      [12, 14],
    ],
    look.top,
    (x) => cylinderLight(((x - 11.5) / 8.5) * 2 - 1) + 0.05,
  );
  rect(img, 12, 20, 8, 1, look.belt(look.top));
  if (dir === "s") line(img, 16, 14, 16, 16, look.top.shadow); // collar slit
  look.torso?.(img, dir, frame);
  // Head.
  rect(img, 15, 13, 2, 1, skin.shadow); // neck
  ball(img, 16, 9, 4.3, 4.4, skin, 0.08);
  // Hair: a cap on top (south) or the whole back of the head (north).
  eachInEllipse(16, 9, 4.3, 4.4, (x, y, nx, ny) => {
    const isHair = look.hairFront
      ? look.hairFront(dir, y, nx)
      : dir === "n"
        ? y <= 11 || Math.abs(nx) > 0.75
        : y <= 6 || (Math.abs(nx) > 0.72 && y <= 10);
    if (isHair) px(img, x, y, shadeOf(look.hair, domeLight(nx, ny) + 0.1));
  });
  if (dir === "s") {
    px(img, 14, 9, BLACK_EYE);
    px(img, 17, 9, BLACK_EYE);
    if (!look.hairFront) {
      px(img, 15, 7, look.hair.base); // fringe
      px(img, 16, 7, look.hair.shadow);
    }
  } else if (!look.hairFront) {
    rect(img, 14, 12, 4, 1, skin.shadow); // nape below the hair
  }
  look.finish?.(img, { kind: "front", dir }, frame);
  outline(img, { amount: 0.55 });
}

/** Profile, facing east or west. A step scissors the legs and swings the arms. */
function personSide(img: Image, look: Look, dir: "e" | "w", frame: number): void {
  const f = dir === "e" ? 1 : -1;
  const cx = 16;
  // Leg swing: frame 1 near leg forward, frame 2 near leg back.
  const swing = frame === 0 ? 0 : frame === 1 ? 2 : -2;
  const layer = canvas(img.width, img.height);
  // Far arm (behind the body, darker).
  slantLimb(layer, cx - 0.5, 14, cx - 0.5 + swing * f, 19, 2, look.sleeve, -0.35);
  rect(layer, Math.round(cx - 1.5 + swing * f), 20, 2, 1, skin.shadow);
  // Far leg, then the near leg.
  for (const [s, bias] of [
    [-swing, -0.3],
    [swing, 0],
  ] as const) {
    slantLimb(layer, cx, 22, cx + s * f, 26, 4, look.legs, bias);
    if (look.bootTop < 27) {
      // A tall boot covers the shin: the same slant, from bootTop down.
      const at = (y: number): number => cx + (s * f * (y - 22)) / 4;
      slantLimb(layer, at(look.bootTop), look.bootTop, at(26), 26, 4, look.boot, bias);
    }
    footSide(layer, cx + s * f, f, bias, look.boot);
  }
  // Torso.
  shape(
    layer,
    [
      [cx - 3, 13],
      [cx + 3, 13],
      [cx + 3.5, 14],
      [cx + 3.5, 22],
      [cx - 3.5, 22],
      [cx - 3.5, 14],
    ],
    look.top,
    (x) => cylinderLight(((x - (cx - 4)) / 7) * 2 - 1) + 0.1,
  );
  rect(layer, cx - 3, 20, 7, 1, look.belt(look.top));
  // Head: face to the front side, hair to the back and top.
  ball(layer, cx + 0.5 * f, 9, 3.9, 4.4, skin, 0.08);
  eachInEllipse(cx + 0.5 * f, 9, 3.9, 4.4, (x, y, nx, ny) => {
    const back = nx * f;
    const isHair = look.hairSide
      ? look.hairSide(y, back)
      : y <= 6 || (back < 0.1 && y <= 11) || (back < -0.5 && y <= 12);
    if (isHair) px(layer, x, y, shadeOf(look.hair, domeLight(nx, ny) + 0.1));
  });
  px(layer, cx + 4 * f + (f < 0 ? 1 : 0), 10, skin.base); // nose
  px(layer, cx + 2 * f + (f < 0 ? 1 : 0), 9, BLACK_EYE);
  rect(layer, cx - 1 + (f > 0 ? 0 : 1), 13, 2, 1, skin.shadow); // neck
  // Near arm, in front of the torso, swinging against the near leg.
  slantLimb(layer, cx + 0.5, 14, cx + 0.5 - swing * f, 19, 2, look.sleeve, 0.05);
  rect(layer, Math.round(cx - 0.5 - swing * f), 20, 2, 1, skin.base);
  look.finish?.(layer, { kind: "side", f, cx }, frame);
  outline(layer, { amount: 0.55 });
  composite(img, layer);
}

/** A boot seen from the side at ankle centre x, toe pointing toward f. */
function footSide(img: Image, x: number, f: number, bias: number, m: Material): void {
  const left = Math.round(x - 2);
  limb(img, left, 27, 4, 3, m, bias);
  px(img, f > 0 ? left + 4 : left - 1, 28, shadeOf(m, 0.6 + bias));
  px(img, f > 0 ? left + 4 : left - 1, 29, shadeOf(m, 0.3 + bias));
}

// ---- shop outfits (T5.7) -------------------------------------------------------------------

const deckShirt = material("#ece8dc", "#cfcabb", "#a7a294", "#79756a");
const navy = material("#4a628c", "#33496d", "#243552", "#172339");
const neckerchief = material("#d0614f", "#a8443a", "#7a2f29", "#4f1d1a");
const blackHair = material("#5a4f48", "#3e3530", "#2b2420", "#1c1714");

/**
 * The sailor: a striped deck shirt (stripes on the torso and sleeves), navy trousers, a red
 * neckerchief knotted under the chin, dark hair.
 */
const SAILOR: Look = {
  hair: blackHair,
  top: deckShirt,
  sleeve: deckShirt,
  legs: navy,
  boot: PALETTE.darkWood,
  belt: () => navy.deep,
  bootTop: 27,
  finish: (img, view) => {
    // Navy stripes every other row of the shirt.
    recolor(img, deckShirt, navy, (_x, y) => y === 15 || y === 17 || y === 19);
    if (view.kind === "front") {
      if (view.dir === "s") {
        rect(img, 14, 13, 4, 1, neckerchief.base);
        px(img, 14, 13, neckerchief.light);
        rect(img, 15, 14, 2, 1, neckerchief.shadow);
        px(img, 16, 15, neckerchief.deep); // the knot's tail
      } else {
        rect(img, 14, 13, 4, 1, neckerchief.shadow);
      }
    } else {
      const { f, cx } = view;
      rect(img, cx - 2 + (f > 0 ? 0 : 1), 13, 3, 1, neckerchief.base);
      px(img, cx + 2 * f, 14, neckerchief.shadow);
    }
  },
};

const cloak = material("#6f9a4c", "#4f7a36", "#385a27", "#253d1a");
const jerkin = PALETTE.leather;
const strap = material("#7a5a3a", "#5c4129", "#43301e", "#2d2014");
const fletch = PALETTE.feather;

/**
 * The ranger: a hooded green cloak (hood framing the face, capelet on the shoulders, the
 * whole back seen from behind), a leather jerkin crossed by a quiver strap, tall boots.
 */
const RANGER: Look = {
  hair: cloak,
  top: jerkin,
  sleeve: cloak,
  legs: material("#7d7056", "#5e533e", "#453c2c", "#2e281d"),
  boot: material("#8a6446", "#6a4a32", "#4d3523", "#332216"),
  belt: () => strap.deep,
  bootTop: 25,
  hairFront: (dir, y, nx) => dir === "n" || y <= 7 || Math.abs(nx) > 0.55,
  hairSide: (y, back) => y <= 6 || back < 0.25,
  torso: (img, dir) => {
    if (dir === "n") {
      // From behind the cloak covers the back; the quiver sits on it.
      recolor(img, jerkin, cloak, (_x, y) => y <= 21);
      rect(img, 17, 12, 2, 7, strap.base);
      px(img, 17, 12, strap.light);
      for (const x of [17, 18]) px(img, x, 11, fletch.base);
      px(img, 18, 10, fletch.light);
    } else {
      line(img, 13, 14, 19, 20, strap.base); // quiver strap
      px(img, 13, 14, strap.light);
    }
    // The capelet over the shoulders.
    recolor(img, jerkin, cloak, (_x, y) => y <= 14);
  },
  finish: (img, view) => {
    if (view.kind === "front") {
      if (view.dir === "n") rect(img, 15, 13, 2, 1, cloak.shadow); // the hood hides the nape
      return;
    }
    const { f, cx } = view;
    // Capelet, and the quiver on the back with its fletching.
    recolor(img, jerkin, cloak, (_x, y) => y <= 14);
    const qx = f > 0 ? cx - 5 : cx + 4;
    rect(img, qx, 12, 2, 7, strap.base);
    px(img, qx, 12, strap.light);
    px(img, qx, 11, fletch.base);
    px(img, qx + 1, 10, fletch.light);
  },
};

const wine = material("#a8475a", "#813345", "#5e2433", "#3e1722");
const { gold } = PALETTE;
const capCloth = material("#4c4650", "#353038", "#252128", "#18151a");
const auburn = material("#b06a3c", "#8a4d29", "#65371d", "#432412");

/**
 * The noble: a burgundy doublet with a gold hem and buttons, a cream sash for a belt, dark
 * hose and a small black cap with a white feather.
 */
const NOBLE: Look = {
  hair: auburn,
  top: wine,
  sleeve: wine,
  legs: darkCloth,
  boot: material("#4f4642", "#37302d", "#26211f", "#191614"),
  belt: () => PALETTE.cloth.light,
  bootTop: 27,
  torso: (img, dir) => {
    recolor(img, wine, gold, (_x, y) => y === 21); // gold hem
    if (dir === "s") {
      px(img, 16, 17, gold.light);
      px(img, 16, 19, gold.base);
    }
  },
  finish: (img, view) => {
    if (view.kind === "front") {
      ball(img, 16, 5, 4.2, 1.7, capCloth, 0.1);
      px(img, 13, 5, capCloth.light);
      // A white feather tucked on the side of the cap.
      const fx = view.dir === "s" ? 19 : 13;
      px(img, fx, 3, PALETTE.feather.light);
      px(img, fx + (view.dir === "s" ? 1 : -1), 2, PALETTE.feather.base);
    } else {
      const { f, cx } = view;
      recolor(img, wine, gold, (_x, y) => y === 21);
      ball(img, cx + 0.5 * f, 5, 3.9, 1.7, capCloth, 0.1);
      px(img, cx - 3 * f, 3, PALETTE.feather.light);
      px(img, cx - 4 * f, 2, PALETTE.feather.base);
    }
  },
};

const LOOKS: Record<string, Look> = {
  citizen: CITIZEN,
  sailor: SAILOR,
  ranger: RANGER,
  noble: NOBLE,
};

const outfitFrames: RecipeBook = {};
for (const [id, look] of Object.entries(LOOKS)) {
  for (const dir of ["n", "e", "s", "w"] as const) {
    for (const frame of [0, 1, 2]) {
      const draw = person(look, dir, frame);
      const recipe: Recipe = { kind: "creature", draw: (img: Image) => draw(img) };
      outfitFrames[`outfits/${id}/${dir}_${frame}`] = recipe;
    }
  }
}

export const CREATURES: RecipeBook = {
  "creatures/thieving_gull": { kind: "creature", draw: thievingGull },
  "creatures/bristleback_boar": { kind: "creature", draw: bristlebackBoar },
  "creatures/bramble_stag": { kind: "creature", draw: brambleStag },
  "npcs/ferryman": { kind: "creature", draw: ferryman },
  ...outfitFrames,
};
