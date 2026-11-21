// The signpost (data/items/decoration.yaml: every `*_sign` of Cinderstead and the mine): a board of
// two planks with carved lines, nailed to a post and turned a little toward the path, so its
// thickness shows. The design spritegen drew by hand (recipes/terrain.ts until 2026-11-18),
// now a model: the planks and the post have depth, the letters are shallow grooves and the
// nails catch the light. It stands at the front of its tile (y = -4) to keep its height on a
// 32x32 canvas, as the hand-drawn one did.
import type { ShapeSpec, SpriteSpec } from "../spec.ts";

/** A row of carved letters at height z, in words (x ranges) on the board's front. */
const carve = (z: number, words: readonly (readonly [number, number])[]): ShapeSpec[] =>
  words.map(([a, b]) => ({
    type: "box",
    min: [a, -1.75, z - 0.5],
    max: [b, -1.5, z + 0.5],
    bias: -1,
  }));

export const SIGNPOST: SpriteSpec = {
  sprite: "decor/signpost",
  size: "object",
  figure: { height: [18, 26], width: [22, 30] },
  seenOn: "ground/basalt",
  parts: [
    {
      name: "post",
      at: [0, -3, 0],
      material: "darkWood",
      texture: { amount: 0.12, cell: [1, 1, 5] },
      shapes: [
        { type: "box", min: [-1.4, -1.4, 0], max: [1.4, 1.4, 17.5] },
        // A bevelled top.
        {
          type: "extrusion",
          axis: "y",
          from: -1.4,
          to: 1.4,
          points: [
            [-1.4, 17.5],
            [1.4, 17.5],
            [0, 19],
          ],
        },
      ],
    },
    {
      name: "board",
      parent: "post",
      at: [0, -1.4, 0],
      rot: [0, 0, 0],
      material: "wood",
      texture: { amount: 0.18, cell: [5, 1, 0.8] },
      shapes: [
        // Two planks with a dark seam between them.
        { type: "box", min: [-11, -1.6, 12.2], max: [11, 0.4, 16.4] },
        { type: "box", min: [-11, -1.6, 7.6], max: [11, 0.4, 11.8] },
        { type: "box", min: [-10.6, -1.7, 11.6], max: [10.6, -1.5, 12.4], bias: -0.9 },
        ...carve(14.3, [
          [-8.5, -4.5],
          [-3.5, 1],
          [2, 8.5],
        ]),
        ...carve(9.7, [
          [-7.5, -1.5],
          [-0.5, 6.5],
        ]),
      ],
      marks: [
        { at: [-9.8, -1.7, 15.2], material: "iron", tone: "light" },
        { at: [9.8, -1.7, 15.2], material: "iron", tone: "light" },
        { at: [-9.8, -1.7, 8.8], material: "iron", tone: "light" },
        { at: [9.8, -1.7, 8.8], material: "iron", tone: "light" },
      ],
    },
  ],
};
