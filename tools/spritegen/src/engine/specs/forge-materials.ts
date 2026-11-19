// The forge's materials (data/items/forge.yaml, docs/02 "Forja"), as items on the ground and
// in the backpack: three temper stones, one per band of items, and the warding amber.
// - The temper stones are whetstone bars lying across the tile, rounded at the ends: the
//   lesser is plain grey stone with a rough grain; the greater, a fine blue-grey stone with a
//   lighter band along it; the radiant, a pale stone crossed by veins that glow gold.
// - The warding amber is a drop of honey-coloured resin, shiny, with a spark held inside.
// Own designs, drawn as models with the engine's light and outline.
import type { PartSpec, SpriteSpec } from "../spec.ts";

const L = 11; // half length of a bar (x before the turn)
const W = 4.2; // half width (y)
const H = 4.6; // height (z)

/** A whetstone bar lying on the ground, turned 25° from east-west. */
function bar(material: PartSpec["material"], extra: Partial<PartSpec> = {}): PartSpec {
  return {
    name: "bar",
    material,
    rot: [0, 0, 25],
    texture: { amount: 0.12, cell: [3, 1.2, 1.2] },
    ...extra,
    shapes: [
      { type: "box", min: [-L + 2, -W, 0], max: [L - 2, W, H] },
      // Rounded ends.
      {
        type: "capsule",
        a: [-L + 2, -W + 0.6, H / 2],
        b: [-L + 2, W - 0.6, H / 2],
        radius: H / 2,
        radius2: H / 2,
      },
      {
        type: "capsule",
        a: [L - 2, -W + 0.6, H / 2],
        b: [L - 2, W - 0.6, H / 2],
        radius: H / 2,
        radius2: H / 2,
      },
    ],
  };
}

export const LESSER_TEMPER_STONE: SpriteSpec = {
  sprite: "materials/lesser_temper_stone",
  size: "object",
  figure: { height: [8, 18], width: [18, 28] },
  seenOn: "ground/stone_floor",
  parts: [bar("stone", { texture: { amount: 0.22, cell: [1.6, 1.6, 1.2] } })],
};

export const GREATER_TEMPER_STONE: SpriteSpec = {
  sprite: "materials/greater_temper_stone",
  size: "object",
  figure: { height: [8, 18], width: [18, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    bar("temperBlue", { texture: { amount: 0.08, cell: [4, 1.2, 1.2] } }),
    {
      name: "band",
      parent: "bar",
      at: [0, 0, 0],
      material: "temperBlue",
      bias: 0.35,
      shapes: [{ type: "box", min: [-L + 2.5, -1, H - 0.4], max: [L - 2.5, 1, H + 0.15] }],
    },
  ],
};

export const RADIANT_TEMPER_STONE: SpriteSpec = {
  sprite: "materials/radiant_temper_stone",
  size: "object",
  figure: { height: [8, 18], width: [18, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    bar("paleStone", { texture: { amount: 0.06, cell: [3, 2, 1.2] } }),
    {
      name: "veins",
      parent: "bar",
      at: [0, 0, 0],
      material: "fireCore",
      glow: true,
      shapes: [
        // Two veins across the top and down the near face.
        {
          type: "polygon",
          axis: "z",
          at: H + 0.05,
          thickness: 0.3,
          points: [
            [-6, -W + 0.5],
            [-4.8, -W + 0.5],
            [-2, 0.5],
            [-1.4, W - 0.4],
            [-2.6, W - 0.4],
            [-3.2, 0.8],
          ],
        },
        {
          type: "polygon",
          axis: "z",
          at: H + 0.05,
          thickness: 0.3,
          points: [
            [3, -W + 0.5],
            [4.2, -W + 0.5],
            [5.8, -0.5],
            [7, W - 0.4],
            [5.8, W - 0.4],
            [4.6, 0],
          ],
        },
        { type: "box", min: [-6, -W - 0.15, 1.2], max: [-4.8, -W + 0.2, H] },
        { type: "box", min: [3, -W - 0.15, 0.8], max: [4.2, -W + 0.2, H] },
      ],
    },
  ],
};

export const WARDING_AMBER: SpriteSpec = {
  sprite: "materials/warding_amber",
  size: "object",
  figure: { height: [12, 20], width: [10, 18] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "drop",
      material: "amber",
      shiny: true,
      shapes: [
        { type: "ellipsoid", center: [0, 0, 4.6], radii: [5.2, 4.6, 4.6] },
        // The drop's tip, leaning a little to the right.
        { type: "capsule", a: [0, 0, 6.5], b: [1.4, 0, 13], radius: 3.6, radius2: 0.6 },
      ],
      marks: [
        // The spark held inside.
        { at: [-0.8, -4.7, 5.2], material: "fireCore", tone: "light" },
        { at: [0.4, -4.6, 4.2], material: "fireCore", tone: "base" },
      ],
    },
  ],
};

export const FORGE_MATERIALS: readonly SpriteSpec[] = [
  LESSER_TEMPER_STONE,
  GREATER_TEMPER_STONE,
  RADIANT_TEMPER_STONE,
  WARDING_AMBER,
];
