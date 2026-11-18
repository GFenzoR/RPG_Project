// The anvil (data/items/decoration.yaml `anvil`): an iron anvil with its horn to the left,
// a polished face with the hardy hole at the heel, a narrow waist and a broad foot. The design
// spritegen drew by hand (recipes/terrain.ts until 2026-11-18), now a model: the body is an
// extrusion of its front profile, the horn a tapered capsule, the face a thin shiny plate.
import type { SpriteSpec } from "../spec.ts";

export const ANVIL: SpriteSpec = {
  sprite: "decor/anvil",
  size: "object",
  figure: { height: [12, 22], width: [18, 28] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "foot",
      material: "darkIron",
      shapes: [
        {
          type: "extrusion",
          axis: "y",
          from: -3,
          to: 3,
          points: [
            [-8.5, 0],
            [8.5, 0],
            [7, 1.6],
            [3.5, 2.6],
            [-3.5, 2.6],
            [-7, 1.6],
          ],
        },
      ],
    },
    {
      name: "waist",
      material: "darkIron",
      shapes: [{ type: "cylinder", a: [0.5, 0, 2.5], b: [0.5, 0, 7.8], radius: 2.6 }],
    },
    {
      name: "block",
      material: "darkIron",
      shapes: [
        {
          type: "extrusion",
          axis: "y",
          from: -3,
          to: 3,
          points: [
            [-7, 8.2],
            [-4, 7.4],
            [5, 7.4],
            [9.5, 8.6],
            [9.5, 10.6],
            [-7, 10.6],
          ],
        },
        { type: "capsule", a: [-6, 0, 9.4], b: [-14, 0, 10.6], radius: 2, radius2: 0.4 },
      ],
    },
    {
      name: "face",
      material: "iron",
      shiny: true,
      shapes: [{ type: "box", min: [-7, -3, 10.6], max: [9.5, 3, 11.4] }],
      marks: [{ at: [7.5, 0, 11.5], tone: "deep", material: "darkIron" }],
    },
  ],
};
