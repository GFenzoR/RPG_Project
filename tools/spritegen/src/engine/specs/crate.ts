// The cargo crate (data/items/decoration.yaml `cargo_crate`): a crate of warm planks on the
// docks, its lid lit with two seams, its front held by darker battens round the edge and a
// diagonal brace, an iron nail at each corner. The design spritegen drew by hand
// (recipes/terrain.ts until 2026-11-18), now a model. The first engine try, with a grey frame
// round the lid and seams on the front, read worse than the old one on the dock planks: the
// lid lost its edge and the frame melted into the boards. One warm material and a plain lid
// read best.
import type { SpriteSpec } from "../spec.ts";

const W = 11; // half width (x)
const D = 8; // half depth (y)
const H = 15; // height (z)
const P = 0.8; // how far the battens stand out

export const CRATE: SpriteSpec = {
  sprite: "decor/cargo_crate",
  size: "object",
  figure: { height: [20, 30], width: [20, 26] },
  seenOn: "ground/dock_planks",
  parts: [
    {
      name: "planks",
      material: "wood",
      texture: { amount: 0.1, cell: [6, 1.2, 1] },
      shapes: [
        { type: "box", min: [-W + 0.4, -D + 0.4, 0], max: [W - 0.4, D - 0.4, H] },
        // Seams on the lid.
        {
          type: "box",
          min: [-W + 0.4, -2.9, H - 0.5],
          max: [W - 0.4, -2.1, H + 0.05],
          bias: -0.45,
        },
        { type: "box", min: [-W + 0.4, 2.1, H - 0.5], max: [W - 0.4, 2.9, H + 0.05], bias: -0.45 },
      ],
    },
    {
      name: "battens",
      material: "darkWood",
      shapes: [
        { type: "box", min: [-W, -D - P, 0], max: [-W + 2.2, -D + 1, H] },
        { type: "box", min: [W - 2.2, -D - P, 0], max: [W, -D + 1, H] },
        { type: "box", min: [-W, -D - P, 0], max: [W, -D + 1, 2] },
        { type: "box", min: [-W, -D - P, H - 2], max: [W, -D + 1, H] },
        {
          type: "polygon",
          axis: "y",
          at: -D - P / 2,
          thickness: P + 0.4,
          points: [
            [-W + 2, 2],
            [-W + 4.4, 2],
            [W - 2, H - 4.2],
            [W - 2, H - 2],
            [W - 4.4, H - 2],
            [-W + 2, 4.2],
          ],
        },
      ],
      marks: [
        { at: [-W + 1.1, -D - P, 1], material: "iron", tone: "base" },
        { at: [W - 1.1, -D - P, 1], material: "iron", tone: "base" },
        { at: [-W + 1.1, -D - P, H - 1], material: "iron", tone: "base" },
        { at: [W - 1.1, -D - P, H - 1], material: "iron", tone: "base" },
      ],
    },
  ],
};
