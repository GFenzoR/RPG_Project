// What pays for exploring (docs/02 "Libros y cofres"): the readable books and scrolls and the
// reward chest of data/items/exploration.yaml. Own designs, drawn as models with the engine's
// light and outline; one warm material each so they read on stone, dirt and planks at 1x.
// - The closed book lies on the ground turned a little, its red cloth cover over the page
//   block (the paper shows on three sides), a rounded spine and a brass clasp.
// - The lectern is a wooden stand (a foot, a post and a desk that tilts toward the reader)
//   with a book open on it: two pages bent up from the spine, with their lines of text.
// - The scroll is a roll of parchment lying across the tile, wooden knobs at its ends and a
//   red ribbon round its middle, the end of the sheet curling off the roll.
// - The reward chest is a plank box with a round lid, two iron bands over it, iron corners
//   and a brass lock on its front. It stays closed: the server answers who opened it, the
//   map item is the same for everyone (docs/02).
import type { ShapeSpec, SpriteSpec } from "../spec.ts";

/**
 * Lines of text on a page: thin dark strips on its top face (z), across x from a to b, far
 * enough apart to stay one pixel line each at 1x (closer ones merged into blobs that read as
 * a face).
 */
function textLines(a: number, b: number, y0: number, y1: number, z: number): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  let i = 0;
  for (let y = y1 - 1.4; y > y0 + 1; y -= 2.4, i++)
    out.push({
      type: "box",
      min: [a, y - 0.4, z - 0.15],
      max: [b - (i % 2) * 1.6, y + 0.4, z + 0.06],
      bias: -0.8,
    });
  return out;
}

export const BOOK_CLOSED: SpriteSpec = {
  sprite: "decor/book_closed",
  size: "object",
  figure: { height: [7, 16], width: [14, 24] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "book",
      material: "redCloth",
      rot: [0, 0, 18],
      texture: { amount: 0.06, cell: [2, 2, 1] },
      shapes: [
        // Back and front covers, a little larger than the pages.
        { type: "box", min: [-6.6, -4.8, 0], max: [7, 4.8, 0.9] },
        { type: "box", min: [-6.6, -4.8, 2.9], max: [7, 4.8, 3.8] },
        // The page block.
        {
          type: "box",
          min: [-6.4, -4.4, 0.9],
          max: [6.6, 4.4, 2.9],
          material: "paper",
          bias: -0.15,
        },
        // The rounded spine on the west.
        { type: "capsule", a: [-6.8, -4.8, 1.9], b: [-6.8, 4.8, 1.9], radius: 1.9, radius2: 1.9 },
        // Two raised bands across the spine.
        {
          type: "capsule",
          a: [-6.9, -2.4, 1.9],
          b: [-6.9, -1.6, 1.9],
          radius: 2.15,
          radius2: 2.15,
          bias: -0.35,
        },
        {
          type: "capsule",
          a: [-6.9, 1.6, 1.9],
          b: [-6.9, 2.4, 1.9],
          radius: 2.15,
          radius2: 2.15,
          bias: -0.35,
        },
        // The brass clasp over the fore edge.
        { type: "box", min: [6.4, -1, 0.5], max: [7.6, 1, 4.1], material: "gold" },
        { type: "box", min: [4.6, -1, 3.75], max: [7.6, 1, 4.2], material: "gold" },
      ],
      marks: [{ at: [5.2, 0, 4.25], material: "gold", tone: "glint" }],
    },
  ],
};

/** The desk's tilt toward the reader (degrees about x: the north edge rises). */
const TILT = 30;

export const LECTERN_BOOK: SpriteSpec = {
  sprite: "decor/lectern_book",
  size: "object",
  figure: { height: [18, 28], width: [16, 26] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "foot",
      material: "darkWood",
      texture: { amount: 0.08, cell: [4, 1, 1] },
      shapes: [
        { type: "box", min: [-4.5, -3.5, 0], max: [4.5, 3.5, 1.4] },
        { type: "box", min: [-3, -2.2, 1.4], max: [3, 2.2, 2.4], bias: 0.15 },
      ],
    },
    {
      name: "post",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 4] },
      shapes: [{ type: "box", min: [-1.2, -1.2, 2.4], max: [1.2, 1.2, 12.2] }],
    },
    {
      name: "desk",
      at: [0, 0, 12.6],
      rot: [TILT, 0, 0],
      material: "wood",
      texture: { amount: 0.1, cell: [5, 1, 1] },
      shapes: [
        { type: "box", min: [-8.5, -5.6, -0.9], max: [8.5, 5.2, 0.3] },
        // The ledge the book rests on.
        { type: "box", min: [-8.5, -6.2, 0.3], max: [8.5, -5.2, 1.4], material: "darkWood" },
      ],
    },
    {
      name: "covers",
      parent: "desk",
      at: [0, 0, 0.3],
      material: "redCloth",
      shapes: [
        { type: "box", min: [-7.4, -5, 0], max: [7.4, 4.6, 0.5] },
        // The ribbon marking the page, hanging over the ledge.
        { type: "box", min: [1.2, -6.8, -1.8], max: [2, -4.8, 0.9] },
      ],
    },
    {
      name: "left_page",
      parent: "covers",
      at: [-0.3, 0, 0.5],
      rot: [0, -7, 0],
      material: "paper",
      shapes: [
        { type: "box", min: [-6.7, -4.6, 0], max: [0, 4.2, 0.7] },
        ...textLines(-6, -0.9, -4.6, 4.2, 0.7),
      ],
    },
    {
      name: "right_page",
      parent: "covers",
      at: [0.3, 0, 0.5],
      rot: [0, 7, 0],
      material: "paper",
      shapes: [
        { type: "box", min: [0, -4.6, 0], max: [6.7, 4.2, 0.7] },
        ...textLines(0.9, 6, -4.6, 4.2, 0.7),
      ],
    },
  ],
};

export const SCROLL: SpriteSpec = {
  sprite: "decor/scroll",
  size: "object",
  figure: { height: [6, 14], width: [14, 26] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "roll",
      material: "paper",
      rot: [0, 0, -18],
      bias: -0.2,
      texture: { amount: 0.05, cell: [3, 2, 2] },
      shapes: [
        { type: "cylinder", a: [-6.8, 0, 2.5], b: [6.8, 0, 2.5], radius: 2.5 },
        // The spiral of the sheet at each end.
        { type: "cylinder", a: [-7, 0, 2.5], b: [-6.7, 0, 2.5], radius: 1.7, bias: -0.7 },
        { type: "cylinder", a: [6.7, 0, 2.5], b: [7, 0, 2.5], radius: 1.7, bias: -0.7 },
        // The ribbon round its middle and its wax seal.
        {
          type: "cylinder",
          a: [-1.1, 0, 2.5],
          b: [0.9, 0, 2.5],
          radius: 2.8,
          material: "redCloth",
        },
        {
          type: "ellipsoid",
          center: [-0.1, -2.6, 2.4],
          radii: [1.5, 0.8, 1.5],
          material: "redCloth",
          bias: -0.2,
        },
      ],
    },
    {
      name: "knobs",
      parent: "roll",
      material: "darkWood",
      shapes: [
        { type: "capsule", a: [-7, 0, 2.5], b: [-8.8, 0, 2.5], radius: 1.2, radius2: 1 },
        { type: "capsule", a: [7, 0, 2.5], b: [8.8, 0, 2.5], radius: 1.2, radius2: 1 },
      ],
    },
  ],
};

const CW = 9.5; // half width (x)
const CD = 6; // half depth (y)
const CH = 7.5; // height of the box (z): the lid's axis

export const REWARD_CHEST: SpriteSpec = {
  sprite: "decor/reward_chest",
  size: "object",
  figure: { height: [16, 27], width: [20, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "box",
      material: "wood",
      bias: -0.15,
      texture: { amount: 0.1, cell: [6, 1, 1.2] },
      shapes: [{ type: "box", min: [-CW, -CD, 0], max: [CW, CD, CH] }],
    },
    {
      name: "lid",
      material: "wood",
      bias: 0.1,
      texture: { amount: 0.1, cell: [6, 1.2, 1.2] },
      shapes: [
        // The round lid, a little wider than the box, over a dark lip.
        { type: "cylinder", a: [-CW - 0.3, 0, CH], b: [CW + 0.3, 0, CH], radius: CD + 0.3 },
        {
          type: "box",
          min: [-CW - 0.3, -CD - 0.3, CH - 0.9],
          max: [CW + 0.3, CD + 0.3, CH],
          material: "darkWood",
        },
      ],
    },
    {
      name: "bands",
      material: "darkIron",
      shapes: [
        // Two iron bands over the lid and down the front.
        { type: "cylinder", a: [-6.4, 0, CH], b: [-5, 0, CH], radius: CD + 0.6 },
        { type: "cylinder", a: [5, 0, CH], b: [6.4, 0, CH], radius: CD + 0.6 },
        { type: "box", min: [-6.4, -CD - 0.35, 0], max: [-5, CD + 0.35, CH] },
        { type: "box", min: [5, -CD - 0.35, 0], max: [6.4, CD + 0.35, CH] },
        // Iron corners at the foot.
        { type: "box", min: [-CW - 0.3, -CD - 0.3, 0], max: [-CW + 1.6, -CD + 1.6, 2.2] },
        { type: "box", min: [CW - 1.6, -CD - 0.3, 0], max: [CW + 0.3, -CD + 1.6, 2.2] },
      ],
    },
    {
      name: "lock",
      material: "gold",
      shiny: true,
      shapes: [
        { type: "box", min: [-1.6, -CD - 0.7, 3.6], max: [1.6, -CD + 0.2, 7.6] },
        { type: "box", min: [-0.8, -CD - 1, 7.6], max: [0.8, -CD + 0.2, 9.6] },
      ],
      marks: [{ at: [0, -CD - 0.75, 5], material: "darkIron", tone: "deep" }],
    },
  ],
};

/**
 * Sigil plates of the milestone quests (docs/02 "Quests de hito"): a round slab of dark
 * stone set in the floor, a ring cut round its edge and a four-pointed sigil in its middle
 * inlaid with a material that names who it is for: a soft ember glow for anyone, gold for
 * the guardian, a pale blue glow for the arcanist, green leaf for the ranger and berry red for
 * the druid. Flat (a player stands on it), so it reads under a character's feet.
 */
function sigilPlate(
  sprite: string,
  inlay: "ember" | "gold" | "water" | "foliage" | "berry",
): SpriteSpec {
  const glow = inlay === "ember" || inlay === "water";
  return {
    sprite,
    size: "object",
    figure: { height: [6, 16], width: [20, 30] },
    seenOn: "ground/stone_floor",
    parts: [
      {
        name: "slab",
        material: "darkStone",
        texture: { amount: 0.08, cell: [2, 2, 1] },
        shapes: [
          { type: "cylinder", a: [0, 0, 0], b: [0, 0, 1.2], radius: 11 },
          // The ring cut round its edge.
          {
            type: "cylinder",
            a: [0, 0, 1.2],
            b: [0, 0, 1.4],
            radius: 9.6,
            material: "stone",
            bias: -0.3,
          },
          { type: "cylinder", a: [0, 0, 1.25], b: [0, 0, 1.5], radius: 8.4, bias: -0.1 },
        ],
      },
      {
        name: "sigil",
        material: inlay,
        ...(glow ? { glow: true } : { shiny: inlay === "gold" }),
        shapes: [
          // A four-pointed star: two long diamonds across each other, and its eye.
          { type: "box", min: [-6.5, -0.9, 1.5], max: [6.5, 0.9, 1.9] },
          { type: "box", min: [-0.9, -6.5, 1.5], max: [0.9, 6.5, 1.9] },
          { type: "cylinder", a: [0, 0, 1.5], b: [0, 0, 2], radius: 2 },
        ],
      },
    ],
  };
}

export const SIGIL_PLATES: readonly SpriteSpec[] = [
  sigilPlate("decor/sigil_plate", "ember"),
  sigilPlate("decor/sigil_plate_guardian", "gold"),
  sigilPlate("decor/sigil_plate_arcanist", "water"),
  sigilPlate("decor/sigil_plate_ranger", "foliage"),
  sigilPlate("decor/sigil_plate_druid", "berry"),
];

/**
 * The account stash (data/items/decoration.yaml `stash_chest`, docs/02 "Baúl de la cuenta"):
 * a squat strongbox of dark planks under a flat lid, wider and lower than the reward chest so
 * the two never read alike, held by three iron bands, with iron corners at the foot and a
 * square silver lock plate. A stash stands in every town: it reads as heavy and safe, not as
 * loot.
 */
const SW = 11.5; // half width (x)
const SD = 7; // half depth (y)
const SH = 9; // height of the box (z)

export const STASH_CHEST: SpriteSpec = {
  sprite: "decor/stash_chest",
  size: "object",
  figure: { height: [14, 26], width: [22, 30] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "box",
      material: "darkWood",
      bias: 0.05,
      texture: { amount: 0.12, cell: [5, 1, 1.4] },
      shapes: [{ type: "box", min: [-SW, -SD, 0], max: [SW, SD, SH] }],
    },
    {
      name: "lid",
      material: "wood",
      bias: -0.05,
      texture: { amount: 0.1, cell: [5, 1.2, 1] },
      shapes: [
        // A flat lid a little wider than the box, over a dark lip.
        { type: "box", min: [-SW - 0.5, -SD - 0.5, SH], max: [SW + 0.5, SD + 0.5, SH + 2.2] },
        { type: "box", min: [-SW - 0.5, -SD - 0.5, SH - 0.8], max: [SW + 0.5, SD + 0.5, SH], material: "darkWood" },
      ],
    },
    {
      name: "bands",
      material: "darkIron",
      shapes: [
        // Three bands over the lid and down the front.
        { type: "box", min: [-8.2, -SD - 0.7, 0], max: [-6.8, SD + 0.7, SH + 2.6] },
        { type: "box", min: [6.8, -SD - 0.7, 0], max: [8.2, SD + 0.7, SH + 2.6] },
        { type: "box", min: [-SW - 0.7, -0.7, 0], max: [SW + 0.7, 0.7, SH + 2.6] },
        // Iron corners at the foot.
        { type: "box", min: [-SW - 0.6, -SD - 0.6, 0], max: [-SW + 1.8, -SD + 1.8, 2.4] },
        { type: "box", min: [SW - 1.8, -SD - 0.6, 0], max: [SW + 0.6, -SD + 1.8, 2.4] },
      ],
    },
    {
      name: "lock",
      material: "silver",
      shiny: true,
      shapes: [{ type: "box", min: [-2, -SD - 0.9, 4], max: [2, -SD + 0.2, 8.4] }],
      marks: [{ at: [0, -SD - 0.95, 5.6], material: "darkIron", tone: "deep" }],
    },
  ],
};
