// The living world's objects (livingworld/README.md, data/items/livingworld.yaml): each
// one intact and broken, own designs drawn as models like the town props (few pieces, one
// material that stands off the ground, low texture). The broken states lie flat and never
// read as something that blocks: a few planks, staves, shards, stubble or stones.
// - weathered_crate: a grey, sun-bleached crate with rusty nails; debris: planks and a lid.
// - rickety_barrel: a barrel of grey staves with rusty hoops, the lowest slipped; debris:
//   staves lying round its lid.
// - clay_pot: a terracotta pot with a neck and a lip; shards: curved pieces in a ring.
// - thorny_vines: a tangle of thorny stems with dark leaves, as tall as a man; cut: stumps
//   and cut stems on the ground.
// - thick_bush: a dense round bush of dark leaves; cut: stubble and a few leaves.
// - cracked_rock: a squat rock split by a dark crack; rubble: loose stones.
// - rotten_barricade: two crossed posts and three planks, mossy; planks: broken pieces.
// - spider_web: a web strung across the tile, spokes and rings; torn: strands hanging.
// - mossy_boulder: a round boulder with moss on top (pushed by walking into it).
// - heavy_crate: a big dark crate with iron bands (pushed too).
// - pressure_plate: a square stone plate sunk in a darker frame.
// - portcullis: an iron grate between two stone posts; open, the grate is raised.
import type { PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";

/** A flat plank lying on the ground at (x, y), turned `deg` about z. */
function plank(
  name: string,
  x: number,
  y: number,
  deg: number,
  len: number,
  material: PartSpec["material"] = "weatheredWood",
  wide = 2.2,
): PartSpec {
  return {
    name,
    material,
    at: [x, y, 0],
    rot: [0, 0, deg],
    texture: { amount: 0.1, cell: [4, 1, 1] },
    shapes: [{ type: "box", min: [-len / 2, -wide / 2, 0], max: [len / 2, wide / 2, 1.1] }],
  };
}

/** A small stone lying at (x, y) of radius r. */
const pebble = (x: number, y: number, r: number): ShapeSpec => ({
  type: "ellipsoid",
  center: [x, y, r * 0.55],
  radii: [r, r * 0.85, r * 0.7],
});

// ---- crate ------------------------------------------------------------------------------------

const CW = 10;
const CD = 7;
const CH = 13;

export const WEATHERED_CRATE: SpriteSpec = {
  sprite: "livingworld/weathered_crate",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "planks",
      material: "weatheredWood",
      texture: { amount: 0.14, cell: [5, 1.2, 1] },
      shapes: [
        { type: "box", min: [-CW, -CD, 0], max: [CW, CD, CH] },
        { type: "box", min: [-CW, -2.6, CH - 0.5], max: [CW, -1.8, CH + 0.05], bias: -0.5 },
        { type: "box", min: [-CW, 2.2, CH - 0.5], max: [CW, 3, CH + 0.05], bias: -0.5 },
        { type: "box", min: [-CW, -CD - 0.05, 6], max: [CW, -CD + 0.4, 6.8], bias: -0.5 },
      ],
    },
    {
      name: "battens",
      material: "darkWood",
      shapes: [
        { type: "box", min: [-CW - 0.3, -CD - 0.7, 0], max: [-CW + 2, -CD + 1, CH] },
        { type: "box", min: [CW - 2, -CD - 0.7, 0], max: [CW + 0.3, -CD + 1, CH] },
      ],
      marks: [
        { at: [-CW + 0.9, -CD - 0.7, 2], material: "rust", tone: "base" },
        { at: [CW - 0.9, -CD - 0.7, CH - 2], material: "rust", tone: "base" },
      ],
    },
  ],
};

export const WEATHERED_CRATE_DEBRIS: SpriteSpec = {
  sprite: "livingworld/weathered_crate_debris",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    plank("p1", -4, -2, 18, 14),
    plank("p2", 4, 3, -30, 12),
    plank("p3", 1, -5, 75, 9, "darkWood", 1.8),
    plank("p4", -6, 4, -60, 8),
    plank("lid", 6, -3, 8, 8, "weatheredWood", 5),
  ],
};

// ---- barrel -----------------------------------------------------------------------------------

const BH = 14;

export const RICKETY_BARREL: SpriteSpec = {
  sprite: "livingworld/rickety_barrel",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "staves",
      material: "weatheredWood",
      texture: { amount: 0.16, cell: [1.5, 1.5, 30] },
      shapes: [
        { type: "cylinder", a: [0, 0, 0], b: [0, 0, BH], radius: 6.6 },
        { type: "ellipsoid", center: [0, 0, BH / 2], radii: [7.8, 7.8, 8.8] },
      ],
    },
    {
      name: "hoops",
      material: "rust",
      shapes: [
        // The lowest hoop slipped to the foot; the top one holds.
        { type: "cylinder", a: [0, 0, 0], b: [0, 0, 0.9], radius: 7.1 },
        { type: "cylinder", a: [0, 0, 9], b: [0, 0, 10], radius: 7.9 },
        { type: "cylinder", a: [0, 0, 12], b: [0, 0, 13], radius: 7.1 },
      ],
    },
    {
      name: "lid",
      material: "darkWood",
      shapes: [{ type: "cylinder", a: [0, 0, BH - 0.4], b: [0, 0, BH + 0.1], radius: 5.2 }],
    },
  ],
};

export const RICKETY_BARREL_DEBRIS: SpriteSpec = {
  sprite: "livingworld/rickety_barrel_debris",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    plank("s1", -5, -1, 100, 11, "weatheredWood", 1.8),
    plank("s2", -1, 4, 160, 10, "weatheredWood", 1.8),
    plank("s3", 5, 1, 70, 11, "weatheredWood", 1.8),
    plank("s4", 2, -5, 20, 9, "weatheredWood", 1.8),
    {
      name: "lid",
      material: "darkWood",
      at: [0, 0, 0],
      shapes: [{ type: "cylinder", a: [0, 0, 0], b: [0, 0, 1], radius: 4.6 }],
    },
    {
      name: "hoop",
      material: "rust",
      at: [3, 5, 0],
      shapes: [{ type: "box", min: [-4, -0.5, 0], max: [4, 0.5, 0.8] }],
    },
  ],
};

// ---- clay pot ---------------------------------------------------------------------------------

export const CLAY_POT: SpriteSpec = {
  sprite: "livingworld/clay_pot",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "body",
      material: "rust",
      texture: { amount: 0.06, cell: [2, 2, 2] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, 5.5], radii: [6, 6, 5.8] },
        { type: "cylinder", a: [0, 0, 9], b: [0, 0, 12], radius: 3 },
        { type: "cylinder", a: [0, 0, 12], b: [0, 0, 13], radius: 3.8 },
        // A dark band round the belly.
        { type: "cylinder", a: [0, 0, 6.6], b: [0, 0, 7.4], radius: 6.05, bias: -0.45 },
      ],
    },
    {
      name: "mouth",
      material: "darkStone",
      shapes: [{ type: "cylinder", a: [0, 0, 12.9], b: [0, 0, 13.1], radius: 2.6 }],
    },
  ],
};

export const CLAY_POT_SHARDS: SpriteSpec = {
  sprite: "livingworld/clay_pot_shards",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    plank("a", -4, -2, 30, 5, "rust", 3.2),
    plank("b", 3, -3, -40, 4, "rust", 2.6),
    plank("c", 4, 3, 80, 5, "rust", 3),
    plank("d", -2, 4, 120, 4, "rust", 2.4),
    {
      name: "neck",
      material: "rust",
      at: [0, 0, 0],
      shapes: [{ type: "cylinder", a: [0, 0, 0], b: [0, 0, 2.6], radius: 2.8 }],
    },
  ],
};

// ---- vines and bush ---------------------------------------------------------------------------

/** A stem from a to b with a few leaves and thorns, for the vines. */
function stems(): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const s: [number, number, number, number][] = [
    [-9, -2, 4, 22],
    [9, 1, -3, 21],
    [-5, 2, 9, 18],
    [5, -3, -8, 19],
    [0, 3, 0, 24],
    [-11, 0, 11, 14],
  ];
  for (const [x0, y0, x1, h] of s)
    out.push({ type: "capsule", a: [x0, y0, 0], b: [x1, -y0, h], radius: 0.9, radius2: 0.6 });
  return out;
}

export const THORNY_VINES: SpriteSpec = {
  sprite: "livingworld/thorny_vines",
  size: "object",
  canvas: [32, 64],
  seenOn: "ground/grass",
  parts: [
    { name: "stems", material: "thornWood", shapes: stems() },
    {
      name: "leaves",
      material: "pine",
      texture: { amount: 0.12, cell: [1.5, 1.5, 1.5] },
      shapes: [
        { type: "ellipsoid", center: [-6, 0, 10], radii: [3.4, 2.4, 2.6] },
        { type: "ellipsoid", center: [6, 0, 14], radii: [3.6, 2.4, 2.8] },
        { type: "ellipsoid", center: [0, 1, 19], radii: [3, 2.2, 2.4] },
        { type: "ellipsoid", center: [-2, -1, 5], radii: [3.4, 2.4, 2.4] },
        { type: "ellipsoid", center: [8, -1, 5], radii: [2.6, 2, 2] },
      ],
      marks: [
        { at: [-7, -2.4, 11], material: "berry", tone: "base" },
        { at: [5, -2.4, 15], material: "berry", tone: "base" },
        { at: [-1, -2.2, 6], material: "berry", tone: "base" },
      ],
    },
  ],
};

export const CUT_VINES: SpriteSpec = {
  sprite: "livingworld/cut_vines",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "stumps",
      material: "wood",
      shapes: [
        { type: "cylinder", a: [-8, 0, 0], b: [-8, 0, 2.5], radius: 1.1 },
        { type: "cylinder", a: [7, 2, 0], b: [7, 2, 2], radius: 1 },
        { type: "cylinder", a: [1, -3, 0], b: [1, -3, 2.8], radius: 1.1 },
        { type: "capsule", a: [-6, 4, 0.5], b: [4, 6, 0.5], radius: 0.6 },
        { type: "capsule", a: [-2, -6, 0.5], b: [8, -4, 0.5], radius: 0.6 },
      ],
    },
    {
      name: "leaves",
      material: "foliage",
      shapes: [pebble(-3, 5, 2.2), pebble(5, -5, 1.8)],
    },
  ],
};

export const THICK_BUSH: SpriteSpec = {
  sprite: "livingworld/thick_bush",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "leaves",
      material: "foliage",
      texture: { amount: 0.14, cell: [1.6, 1.6, 1.6] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, 8], radii: [10, 7.5, 8] },
        { type: "ellipsoid", center: [-6, -1, 6], radii: [6, 5, 6] },
        { type: "ellipsoid", center: [6, 1, 6], radii: [6, 5, 6] },
        { type: "ellipsoid", center: [1, -2, 13], radii: [6, 4.5, 4.5] },
      ],
    },
    {
      name: "shade",
      material: "pine",
      shapes: [{ type: "ellipsoid", center: [0, 0, 2], radii: [10.5, 7.8, 2.4] }],
    },
  ],
};

export const CUT_BUSH: SpriteSpec = {
  sprite: "livingworld/cut_bush",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "stubble",
      material: "bark",
      shapes: [
        { type: "cylinder", a: [-4, 0, 0], b: [-4, 0, 2.4], radius: 0.8 },
        { type: "cylinder", a: [0, -2, 0], b: [0, -2, 3], radius: 0.9 },
        { type: "cylinder", a: [4, 1, 0], b: [4, 1, 2.2], radius: 0.8 },
        { type: "cylinder", a: [1, 3, 0], b: [1, 3, 2], radius: 0.7 },
      ],
    },
    {
      name: "leaves",
      material: "foliage",
      shapes: [pebble(-7, 3, 2), pebble(6, -4, 2.2), pebble(-2, -6, 1.6), pebble(7, 5, 1.6)],
    },
  ],
};

// ---- rock -------------------------------------------------------------------------------------

export const CRACKED_ROCK: SpriteSpec = {
  sprite: "livingworld/cracked_rock",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "rock",
      material: "rock",
      texture: { amount: 0.16, cell: [2.5, 2.5, 2.5] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, 6], radii: [11, 8, 8] },
        { type: "ellipsoid", center: [-4, -2, 10], radii: [6, 5, 5] },
      ],
    },
    {
      name: "crack",
      material: "darkStone",
      bias: -0.7,
      shapes: [
        {
          type: "polygon",
          axis: "y",
          at: -7.6,
          thickness: 1.6,
          points: [
            [-1, 13],
            [1, 13],
            [0, 9],
            [2.5, 6],
            [0.5, 2],
            [1.5, 0],
            [-0.5, 0],
            [-1.5, 2],
            [0.5, 6],
            [-2, 9],
          ],
        },
      ],
    },
  ],
};

export const ROCK_RUBBLE: SpriteSpec = {
  sprite: "livingworld/rock_rubble",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "stones",
      material: "rock",
      texture: { amount: 0.12, cell: [2, 2, 2] },
      shapes: [
        pebble(-5, -2, 3.2),
        pebble(3, -4, 2.6),
        pebble(5, 3, 3),
        pebble(-2, 4, 2.2),
        pebble(0, 0, 1.8),
        pebble(-8, 3, 1.6),
      ],
    },
  ],
};

// ---- barricade --------------------------------------------------------------------------------

export const ROTTEN_BARRICADE: SpriteSpec = {
  sprite: "livingworld/rotten_barricade",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "posts",
      material: "darkWood",
      shapes: [
        { type: "capsule", a: [-12, 0, 0], b: [10, 0, 18], radius: 1.3 },
        { type: "capsule", a: [12, 0, 0], b: [-10, 0, 18], radius: 1.3 },
      ],
    },
    {
      name: "planks",
      material: "weatheredWood",
      texture: { amount: 0.16, cell: [5, 1, 1] },
      shapes: [
        { type: "box", min: [-14, -2.2, 3], max: [14, -1, 6] },
        { type: "box", min: [-13, -2.2, 8], max: [12, -1, 11] },
        { type: "box", min: [-11, -2.2, 13], max: [13, -1, 16] },
      ],
      marks: [
        { at: [-9, -2.2, 4], material: "moss", tone: "base" },
        { at: [6, -2.2, 9], material: "moss", tone: "base" },
        { at: [-3, -2.2, 14], material: "moss", tone: "base" },
      ],
    },
  ],
};

export const BARRICADE_PLANKS: SpriteSpec = {
  sprite: "livingworld/barricade_planks",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    plank("a", -3, -3, 10, 15),
    plank("b", 4, 2, -20, 12),
    plank("c", -5, 5, 40, 9),
    plank("post", 2, -6, -70, 11, "darkWood", 2.4),
  ],
};

// ---- web --------------------------------------------------------------------------------------

/** Spokes and rings of a web strung in the plane y = 0, centred at (0, cz). */
function web(rings: readonly number[], spokes: number, cz: number): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const point = (r: number, i: number): [number, number, number] => {
    const a = (i / spokes) * Math.PI * 2 + 0.3;
    return [Math.cos(a) * r, 0, cz + Math.sin(a) * r * 0.9];
  };
  const outer = rings[rings.length - 1] ?? 10;
  for (let i = 0; i < spokes; i++)
    out.push({ type: "capsule", a: [0, 0, cz], b: point(outer + 2, i), radius: 0.32 });
  for (const r of rings)
    for (let i = 0; i < spokes; i++)
      out.push({ type: "capsule", a: point(r, i), b: point(r, i + 1), radius: 0.28 });
  return out;
}

export const SPIDER_WEB: SpriteSpec = {
  sprite: "livingworld/spider_web",
  size: "object",
  canvas: [32, 64],
  seenOn: "ground/dirt",
  parts: [{ name: "silk", material: "stone", bias: 0.15, shapes: web([3.5, 7, 10.5], 8, 13) }],
};

export const TORN_WEB: SpriteSpec = {
  sprite: "livingworld/torn_web",
  size: "object",
  seenOn: "ground/dirt",
  parts: [
    {
      name: "silk",
      material: "stone",
      bias: 0.1,
      shapes: [
        // The web fallen in a heap, a few strands still rising from it.
        { type: "ellipsoid", center: [0, 0, 1], radii: [7, 4, 1.4] },
        { type: "ellipsoid", center: [-4, -1, 1.2], radii: [3.4, 2.6, 1.6] },
        { type: "capsule", a: [-3, 0, 1], b: [-7, 0, 9], radius: 0.4 },
        { type: "capsule", a: [2, 0, 1], b: [6, 0, 8], radius: 0.4 },
        { type: "capsule", a: [0, 0, 1], b: [1, 0, 11], radius: 0.4 },
      ],
    },
  ],
};

// ---- pushables --------------------------------------------------------------------------------

export const MOSSY_BOULDER: SpriteSpec = {
  sprite: "livingworld/mossy_boulder",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "rock",
      material: "rock",
      texture: { amount: 0.14, cell: [2.5, 2.5, 2.5] },
      shapes: [{ type: "ellipsoid", center: [0, 0, 8.5], radii: [9.8, 8, 8.5] }],
    },
    {
      name: "moss",
      material: "moss",
      texture: { amount: 0.16, cell: [1.4, 1.4, 1.4] },
      shapes: [
        { type: "ellipsoid", center: [-2, 1, 15.2], radii: [6, 5, 2.2] },
        { type: "ellipsoid", center: [4, -2, 13], radii: [3, 2.6, 1.8] },
      ],
    },
  ],
};

const HW = 10;
const HD = 7;
const HH = 13;

export const HEAVY_CRATE: SpriteSpec = {
  sprite: "livingworld/heavy_crate",
  size: "object",
  seenOn: "ground/grass",
  parts: [
    {
      name: "planks",
      material: "darkWood",
      texture: { amount: 0.12, cell: [5, 1.2, 1] },
      shapes: [
        { type: "box", min: [-HW, -HD, 0], max: [HW, HD, HH] },
        { type: "box", min: [-HW, -0.5, HH - 0.5], max: [HW, 0.5, HH + 0.05], bias: -0.5 },
      ],
    },
    {
      name: "bands",
      material: "darkIron",
      shapes: [
        { type: "box", min: [-HW - 0.4, -HD - 0.5, 2], max: [HW + 0.4, HD + 0.5, 3.6] },
        { type: "box", min: [-HW - 0.4, -HD - 0.5, HH - 4], max: [HW + 0.4, HD + 0.5, HH - 2.4] },
        { type: "box", min: [-1, -HD - 0.5, 0], max: [1, HD + 0.5, HH + 0.3] },
      ],
      marks: [
        { at: [-HW + 1, -HD - 0.5, 2.8], material: "iron", tone: "base" },
        { at: [HW - 1, -HD - 0.5, 2.8], material: "iron", tone: "base" },
      ],
    },
  ],
};

// ---- plate and portcullis ---------------------------------------------------------------------

export const PRESSURE_PLATE: SpriteSpec = {
  sprite: "livingworld/pressure_plate",
  size: "object",
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "frame",
      material: "darkStone",
      shapes: [{ type: "box", min: [-11, -8, 0], max: [11, 8, 0.8] }],
    },
    {
      name: "plate",
      material: "stone",
      texture: { amount: 0.08, cell: [2, 2, 1] },
      shapes: [
        { type: "box", min: [-9, -6.4, 0.8], max: [9, 6.4, 1.6] },
        { type: "box", min: [-0.4, -6.4, 1.55], max: [0.4, 6.4, 1.7], bias: -0.5 },
        { type: "box", min: [-9, -0.4, 1.55], max: [9, 0.4, 1.7], bias: -0.5 },
      ],
    },
  ],
};

/** The stone posts of the portcullis, at the ends of the tile. */
const POSTS: PartSpec = {
  name: "posts",
  material: "darkStone",
  texture: { amount: 0.1, cell: [2, 2, 3] },
  shapes: [
    { type: "box", min: [-13, -2.5, 0], max: [-10.5, 2.5, 30] },
    { type: "box", min: [10.5, -2.5, 0], max: [13, 2.5, 30] },
    { type: "box", min: [-13, -2.5, 30], max: [13, 2.5, 32.5] },
  ],
};

/** The grate from z0 to z1. */
function grate(z0: number, z1: number): PartSpec {
  const shapes: ShapeSpec[] = [];
  for (let x = -8; x <= 8; x += 4)
    shapes.push({ type: "box", min: [x - 0.9, -0.9, z0], max: [x + 0.9, 0.9, z1 + 0.5] });
  for (let z = z0 + 2; z < z1; z += 6)
    shapes.push({ type: "box", min: [-11, -0.9, z], max: [11, 0.9, z + 1.6] });
  return { name: "grate", material: "iron", shapes };
}

export const PORTCULLIS_CLOSED: SpriteSpec = {
  sprite: "livingworld/portcullis_closed",
  size: "object",
  canvas: [32, 64],
  seenOn: "ground/stone_floor",
  parts: [POSTS, grate(0, 30)],
};

export const PORTCULLIS_OPEN: SpriteSpec = {
  sprite: "livingworld/portcullis_open",
  size: "object",
  canvas: [32, 64],
  seenOn: "ground/stone_floor",
  parts: [POSTS, grate(24, 30)],
};

export const LIVING_WORLD: readonly SpriteSpec[] = [
  WEATHERED_CRATE,
  WEATHERED_CRATE_DEBRIS,
  RICKETY_BARREL,
  RICKETY_BARREL_DEBRIS,
  CLAY_POT,
  CLAY_POT_SHARDS,
  THORNY_VINES,
  CUT_VINES,
  THICK_BUSH,
  CUT_BUSH,
  CRACKED_ROCK,
  ROCK_RUBBLE,
  ROTTEN_BARRICADE,
  BARRICADE_PLANKS,
  SPIDER_WEB,
  TORN_WEB,
  MOSSY_BOULDER,
  HEAVY_CRATE,
  PRESSURE_PLATE,
  PORTCULLIS_CLOSED,
  PORTCULLIS_OPEN,
];
