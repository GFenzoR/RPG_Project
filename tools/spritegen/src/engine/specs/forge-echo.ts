// The forge echo (data/npcs/volcan_forge_echo.yaml): "what is left of the forge's last smith,
// bound to the sealed gate". An ember spirit in a smith's shape: a body of glowing embers that
// thins into a flame instead of legs, flame for hair, a charred leather apron and the hammer
// still in its hand. It hovers (assets/sprites.yaml `flying: true`: the client bobs it). Our
// own design; until 2026-11-18 it was a Dungeon Crawl fire elemental. Built facing west.
import { keys } from "../motion.ts";
import type { SpriteSpec } from "../spec.ts";

/** Flicker: tall noise cells, so the fire streaks upward. */
const FIRE = { amount: 0.16, cell: [1.6, 1.6, 3.2] } as const;

const arm = (side: number): SpriteSpec["parts"][number][] => {
  const n = side < 0 ? "l" : "r";
  return [
    {
      name: `arm_${n}`,
      parent: "torso",
      at: [0.5, 6.2 * side, 4.5],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [0, 0.8 * side, -6.5], radius: 2.1, radius2: 1.6 },
      ],
    },
    {
      name: `hand_${n}`,
      parent: `arm_${n}`,
      at: [0, 0.8 * side, -6.5],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [-3, 0, -4], radius: 1.6, radius2: 1.3 },
        { type: "ellipsoid", center: [-3.3, 0, -4.6], radii: [1.7, 1.7, 1.7] },
      ],
    },
  ];
};

export const FORGE_ECHO: SpriteSpec = {
  sprite: "npcs/forge_echo",
  size: "humanoid",
  figure: { height: [40, 50], width: [12, 40] },
  flying: true,
  seenOn: "ground/ash",
  parts: [
    {
      name: "tail",
      at: [0, 0, 12],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [1, 0, -6], radius: 4.6, radius2: 2.4 }],
    },
    {
      name: "tail_tip",
      parent: "tail",
      at: [1, 0, -6],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [1.5, 0, -5], radius: 2.4, radius2: 0.4 },
        { type: "capsule", a: [0, -1.5, 1], b: [-0.5, -4, -3], radius: 1.4, radius2: 0.3 },
        { type: "capsule", a: [0, 1.5, 1], b: [2, 4, -2.5], radius: 1.4, radius2: 0.3 },
      ],
    },
    {
      name: "torso",
      at: [0, 0, 20],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "ellipsoid", radii: [4.2, 6.2, 7.6] },
        { type: "ellipsoid", center: [0.5, 0, 3.5], radii: [4, 7.2, 4] },
      ],
    },
    {
      name: "apron",
      parent: "torso",
      material: "leather",
      shapes: [
        {
          type: "extrusion",
          axis: "x",
          points: [
            [-4.2, 1.5],
            [4.2, 1.5],
            [4.8, -9],
            [-4.8, -9],
          ],
          from: -4.9,
          to: -2.6,
        },
        // The neck strap.
        {
          type: "capsule",
          a: [-3.4, -3.6, 1.5],
          b: [-1.5, -2.2, 6],
          radius: 0.7,
          material: "darkWood",
        },
        {
          type: "capsule",
          a: [-3.4, 3.6, 1.5],
          b: [-1.5, 2.2, 6],
          radius: 0.7,
          material: "darkWood",
        },
      ],
    },
    ...arm(-1),
    ...arm(1),
    {
      name: "hammer",
      parent: "hand_r",
      at: [-3.3, 0, -4.6],
      material: "darkWood",
      shapes: [
        { type: "capsule", a: [0, 0, 1.5], b: [0, 0, -8], radius: 0.65 },
        { type: "box", min: [-3, -1.4, -10.6], max: [2.2, 1.4, -7.6], material: "darkIron" },
      ],
      shiny: true,
    },
    {
      name: "head",
      parent: "torso",
      at: [-0.5, 0, 10],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "ellipsoid", radii: [3.8, 3.6, 4] },
        // A beard of flame.
        { type: "capsule", a: [-2.4, 0, -1.5], b: [-2.8, 0, -6.5], radius: 2.2, radius2: 0.5 },
      ],
      marks: [
        { at: [-3.7, -1.5, 0.6], material: "lavaRock", tone: "deep" },
        { at: [-3.7, 1.5, 0.6], material: "lavaRock", tone: "deep" },
      ],
    },
    {
      name: "flames",
      parent: "head",
      at: [0.5, 0, 2.5],
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [2.5, 0, 10.5], radius: 2.2, radius2: 0.3 },
        { type: "capsule", a: [0, -1.8, 0], b: [1.8, -4, 7.5], radius: 1.7, radius2: 0.3 },
        { type: "capsule", a: [0, 1.8, 0], b: [1.8, 4, 7.5], radius: 1.7, radius2: 0.3 },
        { type: "capsule", a: [1, -2.6, -1], b: [2.5, -5.2, 3.5], radius: 1.3, radius2: 0.3 },
        { type: "capsule", a: [1, 2.6, -1], b: [2.5, 5.2, 3.5], radius: 1.3, radius2: 0.3 },
      ],
    },
    {
      // Tongues of flame licking up from the shoulders and the back.
      name: "tongues",
      parent: "torso",
      material: "ember",
      glow: true,
      texture: FIRE,
      shapes: [
        { type: "capsule", a: [0.5, -6.6, 4.5], b: [1.5, -9, 10.5], radius: 1.6, radius2: 0.3 },
        { type: "capsule", a: [0.5, 6.6, 4.5], b: [1.5, 9, 10.5], radius: 1.6, radius2: 0.3 },
        { type: "capsule", a: [3, -3, 3], b: [5.5, -4.2, 11.5], radius: 1.8, radius2: 0.3 },
        { type: "capsule", a: [3, 3, 3], b: [5.5, 4.2, 11.5], radius: 1.8, radius2: 0.3 },
        { type: "capsule", a: [1, -5.5, -4], b: [2, -8.2, 0], radius: 1.3, radius2: 0.3 },
        { type: "capsule", a: [1, 5.5, -4], b: [2, 8.2, 0], radius: 1.3, radius2: 0.3 },
      ],
    },
    {
      name: "sparks",
      at: [0, 0, 26],
      material: "ember",
      shapes: [],
      marks: [
        { at: [3, -8, 6], tone: "light" },
        { at: [-2, 9, 10], tone: "light" },
        { at: [5, 4, 15], tone: "base" },
      ],
    },
  ],
  actions: {
    // The flames lick up, the tail sways and the sparks rise and turn.
    idle: {
      frames: 4,
      ms: 420,
      keys: keys(
        [0, {}],
        [
          0.25,
          {
            flames: { rot: [10, -8, 0] },
            tongues: { rot: [6, 0, 0], move: [0, 0, 0.8] },
            tail: { rot: [8, 0, 0] },
            tail_tip: { rot: [-14, 0, 0] },
            torso: { move: [0, 0, 0.6] },
            sparks: { rot: [0, 0, 35], move: [0, 0, 1.5] },
          },
        ],
        [
          0.5,
          {
            flames: { rot: [0, 6, 0] },
            tongues: { rot: [0, 8, 0], move: [0, 0, 1.2] },
            tail: { rot: [-6, 0, 0] },
            tail_tip: { rot: [12, 0, 0] },
            torso: { move: [0, 0, 0.6] },
            sparks: { rot: [0, 0, 70], move: [0, 0, 3] },
          },
        ],
        [
          0.75,
          {
            flames: { rot: [-10, -4, 0] },
            tongues: { rot: [-6, 0, 0], move: [0, 0, 0.4] },
            tail: { rot: [4, 0, 0] },
            tail_tip: { rot: [-8, 0, 0] },
            sparks: { rot: [0, 0, 105], move: [0, 0, 4.5] },
          },
        ],
      ),
    },
    // It glides: leaning in, the tail trailing and swaying, the arms swinging a little.
    walk: {
      frames: 4,
      keys: keys(
        [
          0,
          {
            torso: { rot: [0, -8, 0] },
            tail: { rot: [6, 18, 0] },
            tail_tip: { rot: [0, 12, 0] },
            arm_l: { rot: [0, 18, 0] },
            arm_r: { rot: [0, -14, 0] },
            flames: { rot: [0, 14, 0] },
          },
        ],
        [
          0.25,
          {
            torso: { rot: [0, -8, 0], move: [0, 0, 0.8] },
            tail: { rot: [0, 22, 0] },
            tail_tip: { rot: [-10, 18, 0] },
            flames: { rot: [0, 20, 0] },
            tongues: { rot: [0, 10, 0] },
          },
        ],
        [
          0.5,
          {
            torso: { rot: [0, -8, 0] },
            tail: { rot: [-6, 18, 0] },
            tail_tip: { rot: [0, 12, 0] },
            arm_l: { rot: [0, -14, 0] },
            arm_r: { rot: [0, 18, 0] },
            flames: { rot: [0, 14, 0] },
          },
        ],
        [
          0.75,
          {
            torso: { rot: [0, -8, 0], move: [0, 0, 0.8] },
            tail: { rot: [0, 22, 0] },
            tail_tip: { rot: [10, 18, 0] },
            flames: { rot: [0, 20, 0] },
          },
        ],
      ),
    },
  },
};
