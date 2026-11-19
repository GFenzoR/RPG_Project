// The market board (data/items/decoration.yaml `market_board`): a notice board of planks in a
// dark frame on two square posts, under a little gabled roof, with notes pinned on it. The
// design spritegen drew by hand (recipes/terrain.ts until 2026-11-18), now a model: the posts
// and the board have depth, the roof is a swept gable and every note is a thin card with its
// lines and its pin. One note lifts in the wind (an ART-7 loop: the sprite and frame_1..3),
// so the board people use for the market catches the eye.
import type { PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";

const FRONT = -1.2; // the board's front face (y)
const BOTTOM = 15;
const TOP = 37;
const HALF = 12.6;

/**
 * A pinned note: a paper card at (x, z) of w x h, with its written lines and its pin. The
 * part hangs from its pin (top centre), so a key that turns it about x lifts its foot.
 */
function note(
  name: string,
  x: number,
  z: number,
  w: number,
  h: number,
  pin: "redCloth" | "iron",
): PartSpec {
  const px = x + w / 2;
  const pz = z + h;
  const lines: ShapeSpec[] = [];
  for (let lz = z + h - 2.5; lz > z + 1; lz -= 2)
    lines.push({
      type: "box",
      min: [x + 1 - px, -0.75, lz - 0.45 - pz],
      max: [x + w - 1 - ((lz * 7) % 3) - px, -0.55, lz + 0.45 - pz],
      bias: -0.9,
    });
  return {
    name,
    at: [px, FRONT, pz],
    material: "paper",
    shapes: [{ type: "box", min: [-w / 2, -0.6, -h], max: [w / 2, 0, 0] }, ...lines],
    marks: [{ at: [0, -0.7, -0.6], material: pin, tone: "base" }],
  };
}

export const MARKET_BOARD: SpriteSpec = {
  sprite: "decor/market_board",
  size: "object",
  canvas: [32, 64],
  figure: { height: [44, 54], width: [26, 31] },
  seenOn: "ground/stone_floor",
  parts: [
    {
      name: "posts",
      material: "darkWood",
      texture: { amount: 0.1, cell: [1, 1, 5] },
      shapes: [
        { type: "box", min: [-11.6, -0.2, 0], max: [-9.2, 2.2, TOP + 2] },
        { type: "box", min: [9.2, -0.2, 0], max: [11.6, 2.2, TOP + 2] },
      ],
    },
    {
      name: "board",
      material: "wood",
      texture: { amount: 0.16, cell: [6, 1, 1.2] },
      shapes: [
        { type: "box", min: [-HALF, FRONT, BOTTOM], max: [HALF, 1, TOP] },
        // Seams between the planks.
        ...[20.5, 25.5, 30.5].map((z): ShapeSpec => ({
          type: "box",
          min: [-HALF + 1.5, FRONT - 0.15, z - 0.45],
          max: [HALF - 1.5, FRONT + 0.2, z + 0.45],
          bias: -0.55,
        })),
      ],
    },
    {
      name: "frame",
      material: "darkWood",
      shapes: [
        {
          type: "box",
          min: [-HALF - 0.4, FRONT - 0.5, BOTTOM - 1.4],
          max: [HALF + 0.4, 1, BOTTOM],
        },
        { type: "box", min: [-HALF - 0.4, FRONT - 0.5, TOP], max: [HALF + 0.4, 1, TOP + 1.2] },
        { type: "box", min: [-HALF - 0.4, FRONT - 0.5, BOTTOM], max: [-HALF + 1, 1, TOP] },
        { type: "box", min: [HALF - 1, FRONT - 0.5, BOTTOM], max: [HALF + 0.4, 1, TOP] },
      ],
    },
    {
      name: "roof",
      material: "bark",
      bias: -0.12,
      // Shingle courses: noise cells long along the ridge.
      texture: { amount: 0.28, cell: [40, 1.4, 1.4] },
      shapes: [
        {
          type: "extrusion",
          axis: "x",
          from: -14.2,
          to: 14.2,
          points: [
            [-5.4, TOP + 0.6],
            [-5.4, TOP + 1.8],
            [0.4, TOP + 7.2],
            [5.6, TOP + 2.4],
            [5.6, TOP + 1.2],
            [0.4, TOP + 5.8],
          ],
        },
      ],
    },
    note("note_a", -10.5, 25.5, 7, 9, "redCloth"),
    note("note_b", -1.5, 27, 6, 7.5, "iron"),
    note("note_c", 6, 24, 5, 9, "redCloth"),
    note("note_d", -9, 16.5, 8, 7, "iron"),
    note("note_e", 1.5, 17, 7, 8.5, "redCloth"),
  ],
  // A gust lifts the foot of the lower right note toward the passer-by and lets it fall.
  loop: {
    frames: 4,
    ms: 180,
    sync: "tile",
    keys: [
      { at: 0, pose: { note_e: { rot: [0, 0, 0] } } },
      { at: 0.25, pose: { note_e: { rot: [-28, 0, 4] } } },
      { at: 0.5, pose: { note_e: { rot: [-48, 0, 8] } } },
      { at: 0.75, pose: { note_e: { rot: [-22, 0, 3] } } },
    ],
  },
};
