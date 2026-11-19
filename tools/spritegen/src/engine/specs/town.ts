// The town prop kit (docs/17 "Kit de props de pueblo"; data/items/decoration.yaml, "Town prop
// kit"): one-tile props in warm materials that furnish the temples, depots, plazas and houses
// of Farol, Raigal and Brasal. Own designs, drawn as models with the engine's light and
// outline; what the review of the first engine props taught holds here too (docs/17 "Motor de
// sprites"): few pieces, one warm material that stands off the floor, low texture, and the
// detail (seams, hoops, goods) kept to what still reads at 1x.
// - barrel: oak staves bulging in the middle, four iron hoops and a dark lid (elevation 8).
// - table: a plank top with two seams on four square legs (elevation 8).
// - bench: a plank seat on two slab legs and a stretcher; it does not block.
// - shelf: a tall open shelf against the back of its tile, with pots, bottles and books.
// - bed: a frame with a headboard, a mattress, a red blanket turned down and a pillow.
// - lamp_post: an iron post on a stone foot with an open lantern on top; its flame flickers
//   (a loop) and it gives light in caves (assets/sprites.yaml `light`).
// - well: a round stone curb round dark water, two posts, a gabled roof and a windlass with
//   its rope and bucket.
// - sacks: two grain sacks tied with rope and a third lying across them.
// - fishing_net: a net drying on a rack of two posts, with cork floats on its foot.
// - flower_box: a plank planter of soil with leaves and red, yellow and white flowers.
// - market_stall: a counter with baskets of apples and bread and a bolt of cloth, under a
//   striped awning whose fringe flaps in the wind (a loop).
// - flag_pole: a pole on a stone foot with a gilt knob; the flag is four cards hung one from
//   the other that turn in a chain, so a wave runs along it (a loop).
import type { KeySpec, PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";

/** Four square legs of side `s` under a top of half sizes hx, hy, from z 0 to z1. */
function legs(hx: number, hy: number, s: number, z1: number): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const x = sx * (hx - s / 2 - 0.3);
      const y = sy * (hy - s / 2 - 0.3);
      out.push({ type: "box", min: [x - s / 2, y - s / 2, 0], max: [x + s / 2, y + s / 2, z1] });
    }
  return out;
}

/** A dark seam across a plank top at y (along x from -hx to hx), on its top face at z. */
const seamX = (hx: number, y: number, z: number): ShapeSpec => ({
  type: "box",
  min: [-hx, y - 0.4, z - 0.4],
  max: [hx, y + 0.4, z + 0.05],
  bias: -0.5,
});

/** A dark seam across a front face at z (along x from -hx to hx), on the face at y. */
const seamFront = (hx: number, y: number, z: number): ShapeSpec => ({
  type: "box",
  min: [-hx, y - 0.05, z - 0.4],
  max: [hx, y + 0.4, z + 0.4],
  bias: -0.5,
});

// ---- barrel ---------------------------------------------------------------------------------

const BARREL_H = 15;

export const BARREL: SpriteSpec = {
  sprite: "decor/barrel",
  size: "object",
  figure: { height: [20, 28], width: [16, 22] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "staves",
      material: "wood",
      // Staves: noise cells long up the barrel.
      texture: { amount: 0.12, cell: [1.6, 1.6, 30] },
      shapes: [
        { type: "cylinder", a: [0, 0, 0], b: [0, 0, BARREL_H], radius: 7 },
        { type: "ellipsoid", center: [0, 0, BARREL_H / 2], radii: [8.4, 8.4, 9.4] },
      ],
    },
    {
      name: "hoops",
      material: "darkIron",
      shapes: [
        { type: "cylinder", a: [0, 0, 1.3], b: [0, 0, 2.5], radius: 7.5 },
        { type: "cylinder", a: [0, 0, 5], b: [0, 0, 6.1], radius: 8.45 },
        { type: "cylinder", a: [0, 0, 8.9], b: [0, 0, 10], radius: 8.45 },
        { type: "cylinder", a: [0, 0, 12.5], b: [0, 0, 13.7], radius: 7.5 },
      ],
    },
    {
      name: "lid",
      material: "darkWood",
      shapes: [
        { type: "cylinder", a: [0, 0, BARREL_H - 0.4], b: [0, 0, BARREL_H + 0.1], radius: 5.6 },
      ],
    },
  ],
};

// ---- table ----------------------------------------------------------------------------------

const TABLE_TOP = 10;

export const TABLE: SpriteSpec = {
  sprite: "decor/table",
  size: "object",
  figure: { height: [16, 24], width: [24, 30] },
  seenOn: "ground/wooden_floor",
  parts: [
    {
      name: "legs",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 4] },
      shapes: [
        ...legs(12, 7.5, 2.2, TABLE_TOP),
        // The apron under the top.
        { type: "box", min: [-10.8, -6.4, TABLE_TOP - 2], max: [10.8, 6.4, TABLE_TOP] },
      ],
    },
    {
      name: "top",
      material: "wood",
      texture: { amount: 0.1, cell: [7, 1.2, 1] },
      shapes: [
        { type: "box", min: [-12.6, -7.8, TABLE_TOP], max: [12.6, 7.8, TABLE_TOP + 1.8] },
        seamX(12.2, -2.6, TABLE_TOP + 1.8),
        seamX(12.2, 2.6, TABLE_TOP + 1.8),
      ],
    },
  ],
};

// ---- bench ----------------------------------------------------------------------------------

const SEAT = 6;

export const BENCH: SpriteSpec = {
  sprite: "decor/bench",
  size: "object",
  figure: { height: [9, 16], width: [24, 30] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "legs",
      material: "darkWood",
      shapes: [
        { type: "box", min: [-10.5, -2.6, 0], max: [-8.3, 2.6, SEAT] },
        { type: "box", min: [8.3, -2.6, 0], max: [10.5, 2.6, SEAT] },
        // The stretcher between them.
        { type: "box", min: [-8.3, -0.7, 2], max: [8.3, 0.7, 3.2] },
      ],
    },
    {
      name: "seat",
      material: "wood",
      texture: { amount: 0.1, cell: [7, 1.2, 1] },
      shapes: [
        { type: "box", min: [-12.6, -3.4, SEAT], max: [12.6, 3.4, SEAT + 1.8] },
        seamX(12.2, 0, SEAT + 1.8),
      ],
    },
  ],
};

// ---- shelf ----------------------------------------------------------------------------------

const SHELF_BACK = 7; // the back of the shelf (y): it stands at the back of its tile
const SHELF_FRONT = 0.5;
const BOARDS = [0, 11.5, 23] as const; // the z of each shelf board's top
const SHELF_TOP = 33;

/** A clay pot standing on a board at (x, z): a squat jar with a dark mouth. */
const pot = (x: number, z: number, r: number, h: number): ShapeSpec[] => [
  {
    type: "ellipsoid",
    center: [x, SHELF_BACK - 3.4, z + h / 2],
    radii: [r, r * 0.9, h / 2],
    material: "cinder",
  },
  {
    type: "cylinder",
    a: [x, SHELF_BACK - 3.4, z + h - 1],
    b: [x, SHELF_BACK - 3.4, z + h + 0.6],
    radius: r * 0.55,
    material: "cinder",
    bias: -0.3,
  },
];

/** A bottle on a board at (x, z). */
const bottle = (x: number, z: number): ShapeSpec[] => [
  {
    type: "capsule",
    a: [x, SHELF_BACK - 3, z + 1.4],
    b: [x, SHELF_BACK - 3, z + 4.2],
    radius: 1.5,
    radius2: 1.4,
    material: "water",
  },
  {
    type: "capsule",
    a: [x, SHELF_BACK - 3, z + 5],
    b: [x, SHELF_BACK - 3, z + 7],
    radius: 0.6,
    radius2: 0.6,
    material: "water",
    bias: -0.2,
  },
];

/** A row of books standing on a board at z, from x0, each [width, height, material]. */
function books(
  x0: number,
  z: number,
  row: readonly (readonly [number, number, "redCloth" | "blueCloth" | "leather"])[],
): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  let x = x0;
  for (const [w, h, m] of row) {
    out.push({
      type: "box",
      min: [x, SHELF_BACK - 5.2, z],
      max: [x + w, SHELF_BACK - 1, z + h],
      material: m,
    });
    x += w + 0.2;
  }
  return out;
}

export const SHELF: SpriteSpec = {
  sprite: "decor/shelf",
  size: "object",
  canvas: [32, 64],
  figure: { height: [34, 44], width: [24, 30] },
  seenOn: "ground/wooden_floor",
  parts: [
    {
      name: "frame",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 5] },
      shapes: [
        // Sides.
        { type: "box", min: [-12.4, SHELF_FRONT, 0], max: [-10.6, SHELF_BACK, SHELF_TOP] },
        { type: "box", min: [10.6, SHELF_FRONT, 0], max: [12.4, SHELF_BACK, SHELF_TOP] },
        // The back board, darker.
        {
          type: "box",
          min: [-10.6, SHELF_BACK - 1, 0],
          max: [10.6, SHELF_BACK, SHELF_TOP],
          bias: -0.35,
        },
        // The top.
        {
          type: "box",
          min: [-12.8, SHELF_FRONT - 0.3, SHELF_TOP],
          max: [12.8, SHELF_BACK + 0.2, SHELF_TOP + 1.6],
        },
      ],
    },
    {
      name: "boards",
      material: "wood",
      shapes: BOARDS.map((z): ShapeSpec => ({
        type: "box",
        min: [-10.6, SHELF_FRONT, z],
        max: [10.6, SHELF_BACK - 1, z + 1.4],
      })),
    },
    {
      name: "goods",
      material: "cinder",
      shapes: [
        // Bottom: two pots and a third, smaller.
        ...pot(-6.4, BOARDS[0] + 1.4, 3, 7),
        ...pot(0.2, BOARDS[0] + 1.4, 2.6, 6),
        ...pot(6.2, BOARDS[0] + 1.4, 3.2, 7.6),
        // Middle: bottles and a folded cloth.
        ...bottle(-7.6, BOARDS[1] + 1.4),
        ...bottle(-4.4, BOARDS[1] + 1.4),
        {
          type: "box",
          min: [0, SHELF_BACK - 5.6, BOARDS[1] + 1.4],
          max: [8.8, SHELF_BACK - 1.2, BOARDS[1] + 4.8],
          material: "cloth",
        },
        {
          type: "box",
          min: [0.4, SHELF_BACK - 5.4, BOARDS[1] + 4.8],
          max: [8.4, SHELF_BACK - 1.4, BOARDS[1] + 7.2],
          material: "blueCloth",
        },
        // Top: a row of books and one lying flat.
        ...books(-9.6, BOARDS[2] + 1.4, [
          [2, 7.4, "redCloth"],
          [1.8, 6.6, "leather"],
          [2.2, 7.8, "blueCloth"],
          [1.8, 6.8, "redCloth"],
          [2, 7.2, "leather"],
        ]),
        {
          type: "box",
          min: [2.4, SHELF_BACK - 5.6, BOARDS[2] + 1.4],
          max: [9.2, SHELF_BACK - 1, BOARDS[2] + 3],
          material: "redCloth",
        },
      ],
    },
  ],
};

// ---- bed ------------------------------------------------------------------------------------

const BED_HX = 8;
const BED_S = -11.5; // the foot (y)
const BED_N = 10.5; // the head (y)

export const BED: SpriteSpec = {
  sprite: "decor/bed",
  size: "object",
  figure: { height: [18, 30], width: [16, 22] },
  seenOn: "ground/wooden_floor",
  parts: [
    {
      name: "frame",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 5, 1] },
      shapes: [
        // The rails.
        { type: "box", min: [-BED_HX, BED_S, 1.6], max: [BED_HX, BED_N, 4.4] },
        ...legs(BED_HX, (BED_N - BED_S) / 2, 1.8, 1.6).map((s): ShapeSpec =>
          s.type === "box"
            ? {
                ...s,
                min: [s.min[0], s.min[1] + (BED_N + BED_S) / 2, s.min[2]],
                max: [s.max[0], s.max[1] + (BED_N + BED_S) / 2, s.max[2]],
              }
            : s,
        ),
        // The footboard.
        { type: "box", min: [-BED_HX - 0.4, BED_S - 1.4, 0], max: [BED_HX + 0.4, BED_S, 7.4] },
        // The headboard with a rounded top.
        {
          type: "extrusion",
          axis: "y",
          from: BED_N,
          to: BED_N + 1.8,
          points: [
            [-BED_HX - 0.6, 0],
            [BED_HX + 0.6, 0],
            [BED_HX + 0.6, 10.5],
            [5, 13],
            [-5, 13],
            [-BED_HX - 0.6, 10.5],
          ],
        },
      ],
    },
    {
      name: "mattress",
      material: "cloth",
      shapes: [
        {
          type: "extrusion",
          axis: "y",
          from: BED_S + 0.4,
          to: BED_N,
          bulge: 0.5,
          points: [
            [-BED_HX + 0.6, 4.4],
            [BED_HX - 0.6, 4.4],
            [BED_HX - 0.6, 6.2],
            [BED_HX - 1.6, 7.2],
            [-BED_HX + 1.6, 7.2],
            [-BED_HX + 0.6, 6.2],
          ],
        },
      ],
    },
    {
      name: "blanket",
      material: "redCloth",
      texture: { amount: 0.06, cell: [2, 2, 2] },
      shapes: [
        {
          type: "extrusion",
          axis: "y",
          from: BED_S + 0.2,
          to: 2.6,
          bulge: 0.5,
          points: [
            [-BED_HX - 0.2, 3.6],
            [BED_HX + 0.2, 3.6],
            [BED_HX + 0.2, 6.6],
            [BED_HX - 1.4, 7.8],
            [-BED_HX + 1.4, 7.8],
            [-BED_HX - 0.2, 6.6],
          ],
        },
        // The turned-down edge.
        {
          type: "box",
          min: [-BED_HX + 0.2, 2.2, 7.2],
          max: [BED_HX - 0.2, 4, 8.2],
          material: "cloth",
          bias: 0.15,
        },
      ],
    },
    {
      name: "pillow",
      material: "cloth",
      bias: 0.2,
      shapes: [{ type: "ellipsoid", center: [0, 7.2, 8], radii: [5.4, 2.6, 1.7] }],
    },
  ],
};

// ---- lamp post ------------------------------------------------------------------------------

const POST_TOP = 30;
const LANTERN = POST_TOP + 1; // the lantern's floor (z)

export const LAMP_POST: SpriteSpec = {
  sprite: "decor/lamp_post",
  size: "object",
  canvas: [32, 64],
  figure: { height: [40, 50], width: [9, 16] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "foot",
      material: "stone",
      texture: { amount: 0.08, cell: [2, 2, 2] },
      shapes: [
        { type: "box", min: [-3.6, -3.6, 0], max: [3.6, 3.6, 2.2] },
        { type: "box", min: [-2.6, -2.6, 2.2], max: [2.6, 2.6, 3.6], bias: 0.1 },
      ],
    },
    {
      name: "post",
      material: "darkIron",
      shapes: [
        { type: "cylinder", a: [0, 0, 3.6], b: [0, 0, POST_TOP], radius: 1.1 },
        // A collar near the foot and the cup under the lantern.
        { type: "cylinder", a: [0, 0, 5], b: [0, 0, 6.2], radius: 1.6 },
        { type: "cylinder", a: [0, 0, POST_TOP - 1.2], b: [0, 0, LANTERN], radius: 2.4 },
      ],
    },
    {
      name: "cage",
      material: "darkIron",
      shapes: [
        // The lantern's floor, its four corner rods and its roof.
        { type: "box", min: [-3.4, -3.4, LANTERN - 0.4], max: [3.4, 3.4, LANTERN + 0.8] },
        ...[-1, 1].flatMap((sx) =>
          [-1, 1].map((sy): ShapeSpec => ({
            type: "box",
            min: [sx * 3.1 - 0.5, sy * 3.1 - 0.5, LANTERN + 0.8],
            max: [sx * 3.1 + 0.5, sy * 3.1 + 0.5, LANTERN + 7.4],
          })),
        ),
        {
          type: "extrusion",
          axis: "y",
          from: -3.9,
          to: 3.9,
          points: [
            [-4.4, LANTERN + 7.4],
            [4.4, LANTERN + 7.4],
            [1.2, LANTERN + 10.2],
            [-1.2, LANTERN + 10.2],
          ],
        },
        { type: "ellipsoid", center: [0, 0, LANTERN + 10.8], radii: [1.2, 1.2, 1] },
      ],
    },
    {
      name: "glass",
      material: "spark",
      glow: true,
      shapes: [{ type: "box", min: [-2.6, -2.6, LANTERN + 0.8], max: [2.6, 2.6, LANTERN + 7.4] }],
    },
    {
      name: "flame",
      at: [0, -2.7, LANTERN + 1],
      material: "flame",
      glow: true,
      shapes: [{ type: "capsule", a: [0, 0, 0.6], b: [0, 0, 4.6], radius: 1.4, radius2: 0.3 }],
    },
  ],
  // The flame in the lantern sways and stretches.
  loop: {
    frames: 3,
    ms: 130,
    sync: "tile",
    keys: [
      { at: 0, pose: { flame: { rot: [0, 0, 0] } } },
      { at: 1 / 3, pose: { flame: { rot: [0, 16, 0], move: [0, 0, 0.5] } } },
      { at: 2 / 3, pose: { flame: { rot: [0, -14, 0], move: [0, 0, -0.3] } } },
    ],
  },
};

// ---- well -----------------------------------------------------------------------------------

const CURB = 8; // the curb's height
const ROOF = 25;

export const WELL: SpriteSpec = {
  sprite: "decor/well",
  size: "object",
  canvas: [32, 64],
  figure: { height: [30, 44], width: [22, 30] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "curb",
      material: "stone",
      // Courses of stone: cells wide round the ring and short in height.
      texture: { amount: 0.16, cell: [3.2, 3.2, 2.6] },
      shapes: [{ type: "cylinder", a: [0, 0, 0], b: [0, 0, CURB], radius: 9.2 }],
    },
    {
      name: "water",
      material: "water",
      bias: -0.7,
      shapes: [{ type: "cylinder", a: [0, 0, CURB - 0.2], b: [0, 0, CURB + 0.05], radius: 6.8 }],
    },
    {
      name: "posts",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 5] },
      shapes: [
        { type: "box", min: [-9.8, -1, 0], max: [-7.8, 1, ROOF] },
        { type: "box", min: [7.8, -1, 0], max: [9.8, 1, ROOF] },
      ],
    },
    {
      name: "windlass",
      material: "wood",
      shapes: [
        { type: "cylinder", a: [-7.8, 0, ROOF - 5], b: [7.8, 0, ROOF - 5], radius: 1.3 },
        // The crank on the east.
        {
          type: "box",
          min: [9.8, -0.5, ROOF - 5.4],
          max: [11, 0.5, ROOF - 2.2],
          material: "darkIron",
        },
      ],
    },
    {
      name: "rope",
      material: "rope",
      shapes: [{ type: "box", min: [-0.5, -0.5, CURB + 5.4], max: [0.5, 0.5, ROOF - 5] }],
    },
    {
      name: "bucket",
      material: "darkWood",
      shapes: [
        { type: "cylinder", a: [0, 0, CURB + 1.6], b: [0, 0, CURB + 5.4], radius: 2.2 },
        {
          type: "cylinder",
          a: [0, 0, CURB + 3.2],
          b: [0, 0, CURB + 4],
          radius: 2.35,
          material: "darkIron",
        },
      ],
    },
    {
      name: "roof",
      material: "bark",
      bias: -0.1,
      texture: { amount: 0.26, cell: [40, 1.4, 1.4] },
      shapes: [
        {
          type: "extrusion",
          axis: "x",
          from: -12.4,
          to: 12.4,
          points: [
            [-6.4, ROOF - 0.4],
            [-6.4, ROOF + 0.8],
            [0, ROOF + 6.4],
            [6.4, ROOF + 0.8],
            [6.4, ROOF - 0.4],
            [0, ROOF + 5],
          ],
        },
      ],
    },
  ],
};

// ---- sacks ----------------------------------------------------------------------------------

/** A sack standing at (x, y): a burlap bag of height h, tied with rope under a tuft. */
function sack(name: string, x: number, y: number, r: number, h: number): PartSpec {
  return {
    name,
    material: "sand",
    texture: { amount: 0.08, cell: [1.4, 1.4, 1.4] },
    shapes: [
      { type: "ellipsoid", center: [x, y, h * 0.42], radii: [r, r * 0.85, h * 0.44] },
      // The gathered neck, its rope and the tuft above it.
      {
        type: "capsule",
        a: [x, y, h * 0.74],
        b: [x, y, h * 0.92],
        radius: r * 0.5,
        radius2: r * 0.3,
      },
      {
        type: "cylinder",
        a: [x, y, h * 0.8],
        b: [x, y, h * 0.8 + 1.1],
        radius: r * 0.44,
        material: "darkWood",
      },
      {
        type: "ellipsoid",
        center: [x, y, h + 0.2],
        radii: [r * 0.5, r * 0.42, 1.4],
        bias: 0.1,
      },
    ],
  };
}

export const SACKS: SpriteSpec = {
  sprite: "decor/sacks",
  size: "object",
  figure: { height: [16, 24], width: [20, 28] },
  seenOn: "ground/dock_planks",
  parts: [
    sack("sack_west", -5.6, 2.4, 4.8, 15),
    sack("sack_east", 5.4, 2.8, 4.6, 13),
    {
      name: "sack_lying",
      material: "sand",
      bias: 0.1,
      texture: { amount: 0.08, cell: [1.4, 1.4, 1.4] },
      shapes: [
        { type: "ellipsoid", center: [-0.6, -4.4, 3.2], radii: [8, 3.6, 3.2] },
        {
          type: "cylinder",
          a: [7, -4.4, 3.2],
          b: [8.1, -4.4, 3.2],
          radius: 1.5,
          material: "darkWood",
        },
        { type: "ellipsoid", center: [9.4, -4.4, 3.2], radii: [1.6, 1.8, 1.8] },
      ],
    },
  ],
};

// ---- fishing net ----------------------------------------------------------------------------

const RACK = 16.5; // the rack bar (z)
const NET_HALF = 9; // the net's half width under the bar

/** The net's lower edge at x: it sags in the middle, between the posts. */
const netFoot = (x: number): number => 3.6 + 2.2 * (x / NET_HALF) ** 2;

/**
 * The net hanging from the bar on the plane y = -1.2: a diamond mesh of rope (strands at 45°
 * every 4 px, cut into short capsules between the bar and the sagging foot) and a cord along
 * the foot.
 */
function netMesh(): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const y = -1.2;
  const step = 0.5;
  for (const dir of [1, -1])
    for (let c = -NET_HALF - RACK; c <= NET_HALF + RACK; c += 4) {
      // The strand x = c + dir * z, walked down from the bar.
      let prev: [number, number] | undefined;
      for (let z = RACK - 0.4; z >= 0; z -= step) {
        const x = c + dir * z;
        const inside = Math.abs(x) <= NET_HALF && z >= netFoot(x);
        if (inside && prev)
          out.push({ type: "capsule", a: [prev[0], y, prev[1]], b: [x, y, z], radius: 0.62 });
        prev = inside ? [x, z] : undefined;
      }
    }
  for (let x = -NET_HALF; x < NET_HALF; x += 1.5)
    out.push({
      type: "capsule",
      a: [x, y, netFoot(x)],
      b: [x + 1.5, y, netFoot(x + 1.5)],
      radius: 0.55,
    });
  return out;
}

export const FISHING_NET: SpriteSpec = {
  sprite: "decor/fishing_net",
  size: "object",
  figure: { height: [17, 24], width: [22, 30] },
  seenOn: "ground/sand",
  parts: [
    {
      name: "posts",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 5] },
      shapes: [
        { type: "box", min: [-12, -1, 0], max: [-10, 1, RACK + 1.4] },
        { type: "box", min: [10, -1, 0], max: [12, 1, RACK + 1.4] },
        { type: "cylinder", a: [-12.4, 0, RACK + 0.4], b: [12.4, 0, RACK + 0.4], radius: 1 },
      ],
    },
    { name: "net", material: "rope", shapes: netMesh() },
    {
      name: "floats",
      material: "redCloth",
      shapes: [-6.6, -2.2, 2.2, 6.6].map((x): ShapeSpec => ({
        type: "ellipsoid",
        center: [x, -1.6, netFoot(x) - 0.4],
        radii: [1.3, 1.1, 1.3],
      })),
    },
  ],
};

// ---- flower box -----------------------------------------------------------------------------

const BOX_TOP = 6.5;

/** A blossom: a small ball of colour on a leaf at (x, y, z). */
const blossom = (x: number, y: number, z: number, m: "berry" | "gold" | "paper"): ShapeSpec => ({
  type: "ellipsoid",
  center: [x, y, z],
  radii: [1.3, 1.3, 1.1],
  material: m,
});

export const FLOWER_BOX: SpriteSpec = {
  sprite: "decor/flower_box",
  size: "object",
  figure: { height: [14, 24], width: [22, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "box",
      material: "wood",
      texture: { amount: 0.1, cell: [7, 1.2, 1] },
      shapes: [
        { type: "box", min: [-11, -4.6, 0], max: [11, 4.6, BOX_TOP] },
        seamFront(10.6, -4.6, BOX_TOP / 2),
        // The rim, darker.
        {
          type: "box",
          min: [-11.4, -5, BOX_TOP - 1.2],
          max: [11.4, 5, BOX_TOP],
          material: "darkWood",
        },
      ],
    },
    {
      name: "leaves",
      material: "foliage",
      texture: { amount: 0.14, cell: [1.6, 1.6, 1.6] },
      shapes: [
        { type: "ellipsoid", center: [-7, 0.4, BOX_TOP + 2.4], radii: [3.6, 3.4, 3] },
        { type: "ellipsoid", center: [-1.6, 1, BOX_TOP + 3], radii: [3.8, 3.4, 3.6] },
        { type: "ellipsoid", center: [3.8, 0.2, BOX_TOP + 2.6], radii: [3.6, 3.4, 3.2] },
        { type: "ellipsoid", center: [8, 0.8, BOX_TOP + 2], radii: [2.6, 3, 2.6] },
      ],
    },
    {
      name: "flowers",
      material: "berry",
      shapes: [
        blossom(-8, -1.4, BOX_TOP + 4.4, "berry"),
        blossom(-4.4, -0.6, BOX_TOP + 5.6, "gold"),
        blossom(-0.8, -1.6, BOX_TOP + 6.2, "berry"),
        blossom(2.4, 0.6, BOX_TOP + 6, "paper"),
        blossom(5.6, -1.4, BOX_TOP + 4.8, "gold"),
        blossom(8.6, -0.6, BOX_TOP + 4, "berry"),
      ],
    },
  ],
};

// ---- market stall ---------------------------------------------------------------------------

const COUNTER = 10.5; // the counter's top
const AWN_BACK: readonly [number, number] = [5.8, 30]; // [y, z] of the awning's back edge
const AWN_FRONT: readonly [number, number] = [-8.8, 24.5]; // [y, z] of its front edge
const AWN_HALF = 13.6;
const STRIPES = 7;

/** The awning: stripes of red and cream cloth sloping from the back posts to the front. */
function awningStripes(): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const w = (AWN_HALF * 2) / STRIPES;
  for (let i = 0; i < STRIPES; i++)
    out.push({
      type: "extrusion",
      axis: "x",
      from: -AWN_HALF + i * w,
      to: -AWN_HALF + (i + 1) * w,
      material: i % 2 === 0 ? "redCloth" : "cloth",
      points: [
        [AWN_BACK[0], AWN_BACK[1]],
        [AWN_BACK[0], AWN_BACK[1] + 1],
        [AWN_FRONT[0], AWN_FRONT[1] + 1],
        [AWN_FRONT[0], AWN_FRONT[1]],
      ],
    });
  return out;
}

/**
 * Scallop i of the fringe hanging from the awning's front edge, in its stripe's colour: a part
 * of its own, hung from the edge, so the wind can swing each one a little after the last.
 */
function scallop(i: number): PartSpec {
  const w = (AWN_HALF * 2) / STRIPES;
  const x0 = -AWN_HALF + i * w;
  return {
    name: `fringe_${i}`,
    at: [x0 + w / 2, AWN_FRONT[0] - 0.2, AWN_FRONT[1] + 0.4],
    material: i % 2 === 0 ? "redCloth" : "cloth",
    shapes: [
      {
        type: "polygon",
        axis: "y",
        thickness: 0.8,
        points: [
          [-w / 2, 0.6],
          [w / 2, 0.6],
          [w / 2, -2.4],
          [0, -4.4],
          [-w / 2, -2.4],
        ],
      },
    ],
  };
}

/** A basket of round goods on the counter at x: a low wicker tub heaped with balls. */
function basket(x: number, y: number, goods: "berry" | "wood"): ShapeSpec[] {
  return [
    {
      type: "cylinder",
      a: [x, y, COUNTER],
      b: [x, y, COUNTER + 2.6],
      radius: 3.6,
      material: "rope",
    },
    {
      type: "ellipsoid",
      center: [x - 1.4, y - 0.6, COUNTER + 3],
      radii: [1.6, 1.6, 1.5],
      material: goods,
    },
    {
      type: "ellipsoid",
      center: [x + 1.5, y - 0.4, COUNTER + 3],
      radii: [1.6, 1.6, 1.5],
      material: goods,
    },
    {
      type: "ellipsoid",
      center: [x, y + 1.2, COUNTER + 3.8],
      radii: [1.6, 1.6, 1.5],
      material: goods,
    },
  ];
}

/**
 * The gust at `phase` of the loop: it blows the scallops back under the awning (a turn about
 * x, so their points rise), each a little after the one to its west.
 */
function gust(phase: number): KeySpec["pose"] {
  const pose: Record<string, { rot: [number, number, number] }> = {};
  for (let i = 0; i < STRIPES; i++)
    pose[`fringe_${i}`] = {
      rot: [36 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase - i * 0.8)), 0, 0],
    };
  return pose;
}

export const MARKET_STALL: SpriteSpec = {
  sprite: "decor/market_stall",
  size: "object",
  canvas: [32, 64],
  figure: { height: [36, 46], width: [26, 31] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "posts",
      material: "darkWood",
      texture: { amount: 0.08, cell: [1, 1, 5] },
      shapes: [
        { type: "box", min: [-13, 4.4, 0], max: [-11.4, 6, AWN_BACK[1]] },
        { type: "box", min: [11.4, 4.4, 0], max: [13, 6, AWN_BACK[1]] },
        { type: "box", min: [-13, -8.4, 0], max: [-11.4, -6.8, AWN_FRONT[1]] },
        { type: "box", min: [11.4, -8.4, 0], max: [13, -6.8, AWN_FRONT[1]] },
      ],
    },
    {
      name: "counter",
      material: "wood",
      texture: { amount: 0.1, cell: [7, 1.2, 1] },
      shapes: [
        { type: "box", min: [-11.4, -6.6, 0], max: [11.4, 1.6, COUNTER] },
        seamFront(11, -6.6, 3.6),
        seamFront(11, -6.6, 7),
        // The counter's top board, lighter and overhanging.
        {
          type: "box",
          min: [-12, -7.4, COUNTER - 1.2],
          max: [12, 2, COUNTER],
          bias: 0.12,
        },
      ],
    },
    {
      name: "goods",
      material: "berry",
      shapes: [
        ...basket(-6.6, -2.6, "berry"),
        ...basket(1.2, -2.2, "wood"),
        // A bolt of blue cloth lying on the counter.
        {
          type: "cylinder",
          a: [5.2, -3.8, COUNTER + 1.6],
          b: [10.6, -3.8, COUNTER + 1.6],
          radius: 1.6,
          material: "blueCloth",
        },
      ],
    },
    { name: "awning", material: "redCloth", shapes: awningStripes() },
    ...Array.from({ length: STRIPES }, (_, i) => scallop(i)),
  ],
  // Gusts run along the fringe and lift its points.
  loop: {
    frames: 4,
    ms: 160,
    sync: "tile",
    keys: [0, 0.25, 0.5, 0.75].map((at) => ({ at, pose: gust(at) })),
  },
};

// ---- flag pole ------------------------------------------------------------------------------

const POLE_X = -8;
const POLE_TOP = 46;
const FLAG_TOP = POLE_TOP - 2;
const FLAG_H = 9;
const CARD = 4.4; // the width of each of the flag's four cards
const CARDS = 4;

/** Card i of the flag: a thin cloth card hung from the previous one's far edge. */
function flagCard(i: number): PartSpec {
  return {
    name: `flag_${i}`,
    ...(i === 0 ? {} : { parent: `flag_${i - 1}` }),
    at: i === 0 ? [POLE_X + 1, 0, FLAG_TOP - FLAG_H] : [CARD, 0, 0],
    material: "blueCloth",
    shapes: [
      {
        type: "polygon",
        axis: "y",
        thickness: 0.7,
        // The last card ends in a swallowtail.
        points:
          i === CARDS - 1
            ? [
                [0, 0],
                [CARD + 0.4, 0],
                [CARD - 1.6, FLAG_H / 2],
                [CARD + 0.4, FLAG_H],
                [0, FLAG_H],
              ]
            : [
                [0, 0],
                [CARD + 0.1, 0],
                [CARD + 0.1, FLAG_H],
                [0, FLAG_H],
              ],
      },
      // A gilt band across the middle.
      {
        type: "box",
        min: [0, -0.4, FLAG_H / 2 - 0.8],
        max: [i === CARDS - 1 ? CARD - 2.2 : CARD + 0.1, 0.4, FLAG_H / 2 + 0.8],
        material: "gold",
      },
    ],
  };
}

/** The wave: card i turns about the vertical by amp, a quarter turn behind the one before. */
function wave(phase: number): KeySpec["pose"] {
  const pose: Record<string, { rot: [number, number, number] }> = {};
  for (let i = 0; i < CARDS; i++)
    pose[`flag_${i}`] = {
      rot: [0, 0, (i === 0 ? 8 : 18) * Math.sin(2 * Math.PI * phase - i * (Math.PI / 2))],
    };
  return pose;
}

export const FLAG_POLE: SpriteSpec = {
  sprite: "decor/flag_pole",
  size: "object",
  canvas: [32, 64],
  figure: { height: [44, 56], width: [16, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "foot",
      material: "stone",
      texture: { amount: 0.08, cell: [2, 2, 2] },
      shapes: [
        { type: "box", min: [POLE_X - 3.4, -3.4, 0], max: [POLE_X + 3.4, 3.4, 2.4] },
        { type: "box", min: [POLE_X - 2.4, -2.4, 2.4], max: [POLE_X + 2.4, 2.4, 3.8], bias: 0.1 },
      ],
    },
    {
      name: "pole",
      material: "darkWood",
      texture: { amount: 0.06, cell: [1, 1, 6] },
      shapes: [{ type: "cylinder", a: [POLE_X, 0, 3.8], b: [POLE_X, 0, POLE_TOP], radius: 1.1 }],
    },
    {
      name: "knob",
      material: "gold",
      shiny: true,
      shapes: [{ type: "ellipsoid", center: [POLE_X, 0, POLE_TOP + 1.2], radii: [1.6, 1.6, 1.6] }],
    },
    ...Array.from({ length: CARDS }, (_, i) => flagCard(i)),
  ],
  loop: {
    frames: 4,
    ms: 170,
    sync: "tile",
    keys: [0, 0.25, 0.5, 0.75].map((at) => ({ at, pose: wave(at) })),
  },
};

/** The kit, in the order of data/items/decoration.yaml. */
export const TOWN_PROPS: readonly SpriteSpec[] = [
  BARREL,
  TABLE,
  BENCH,
  SHELF,
  BED,
  LAMP_POST,
  WELL,
  SACKS,
  FISHING_NET,
  FLOWER_BOX,
  MARKET_STALL,
  FLAG_POLE,
];

/** The floors the kit stands on in the towns: its review board has a row for each. */
export const TOWN_FLOORS: readonly string[] = [
  "ground/stone_floor",
  "ground/wooden_floor",
  "ground/dirt",
  "ground/basalt",
  "ground/grass",
  "ground/sand",
  "ground/dock_planks",
];
