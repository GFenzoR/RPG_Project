// The forge echo (data/npcs/volcan_forge_echo.yaml): "what is left of the forge's last smith,
// bound to the sealed gate". A fire spirit in a smith's shape: a white-hot chest, head and
// arms inside flames that rise as hair, beard and tongues off the shoulders, a body that
// thins into a curling flame instead of legs, and the smith's hammer still raised in its
// right hand. It hovers (assets/sprites.yaml `flying: true`: the client bobs it). Our own
// design; until 2026-11-18 it was a Dungeon Crawl fire elemental. Built facing west.
import { keys } from "../motion.ts";
import type { PartSpec, SpriteSpec } from "../spec.ts";

/** Flicker: tall noise cells, so the fire streaks upward. */
const FIRE = { amount: 0.16, cell: [1.6, 1.6, 3.2] } as const;

/** A glowing part of the hot core (chest, head, arms). */
const core = (p: Omit<PartSpec, "material" | "glow" | "texture">): PartSpec => ({
  ...p,
  material: "fireCore",
  glow: true,
  texture: FIRE,
});
/** A glowing flame (hair, beard, tongues, the tail): yellow to a red rim. */
const flame = (p: Omit<PartSpec, "material" | "glow" | "texture">): PartSpec => ({
  ...p,
  material: "flame",
  glow: true,
  texture: FIRE,
});

export const FORGE_ECHO: SpriteSpec = {
  sprite: "npcs/forge_echo",
  size: "humanoid",
  figure: { height: [40, 50], width: [16, 40] },
  flying: true,
  // Where it stands: the dirt floor of the volcano's mine (world/islands/volcan, floor 8).
  seenOn: "ground/dirt",
  // Seen from the side, turned a little toward the camera: the face and the chest show, and
  // the hammer stays clear of the face when it is on the near side (facing east).
  views: { w: 20, e: -20 },
  parts: [
    // A broad smith's chest and shoulders, narrowing to the waist.
    core({
      name: "torso",
      at: [0, 0, 21],
      shapes: [
        { type: "ellipsoid", center: [-0.5, 0, 2], radii: [4.6, 6.6, 5.4] },
        { type: "ellipsoid", center: [0, 0, 4.6], radii: [4.2, 7.8, 3.2] },
        { type: "ellipsoid", center: [0.3, 0, -3.6], radii: [3.8, 4.8, 4.2] },
      ],
    }),
    // No legs: the body thins into a flame that curls back under it.
    flame({
      name: "tail",
      parent: "torso",
      at: [0.3, 0, -6],
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [0.2, 0, -7], radius: 4, radius2: 2.4 }],
    }),
    flame({
      name: "tail_tip",
      parent: "tail",
      at: [0.2, 0, -7],
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [0.6, 0.6, -7.2], radius: 2.4, radius2: 0.4 },
        { type: "capsule", a: [0, -1.4, 0.8], b: [-1.2, -3.8, -3.2], radius: 1.3, radius2: 0.3 },
        { type: "capsule", a: [0, 1.4, 0.8], b: [1.6, 3.8, -2.6], radius: 1.3, radius2: 0.3 },
      ],
    }),
    core({
      name: "head",
      parent: "torso",
      at: [-0.8, 0, 10.6],
      shapes: [
        { type: "ellipsoid", radii: [3.9, 3.6, 4.1] },
        // The jaw, heavier than the skull.
        { type: "ellipsoid", center: [-1.2, 0, -2.4], radii: [3, 3.3, 2.3] },
      ],
      marks: [
        { at: [-3.85, -1.5, 0.7], material: "eye", tone: "base" },
        { at: [-3.85, 1.5, 0.7], material: "eye", tone: "base" },
      ],
    }),
    flame({
      name: "beard",
      parent: "head",
      shapes: [
        { type: "capsule", a: [-2.8, 0, -3], b: [-3.8, 0, -8.6], radius: 2.5, radius2: 0.5 },
        { type: "capsule", a: [-2.4, -1.8, -2.6], b: [-3, -2.6, -7], radius: 1.5, radius2: 0.4 },
        { type: "capsule", a: [-2.4, 1.8, -2.6], b: [-3, 2.6, -7], radius: 1.5, radius2: 0.4 },
      ],
    }),
    // Hair of fire, rising and streaming back.
    flame({
      name: "hair",
      parent: "head",
      at: [0.6, 0, 2.6],
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [2.6, 0, 10], radius: 2.6, radius2: 0.3 },
        { type: "capsule", a: [0, -2, 0], b: [1.6, -4.4, 7.4], radius: 1.9, radius2: 0.3 },
        { type: "capsule", a: [0, 2, 0], b: [1.6, 4.4, 7.4], radius: 1.9, radius2: 0.3 },
        { type: "capsule", a: [1.6, 0, -1], b: [5.4, 0, 5.6], radius: 2, radius2: 0.3 },
      ],
    }),
    // Tongues of flame licking up from the shoulders and the back.
    flame({
      name: "tongues",
      parent: "torso",
      shapes: [
        { type: "capsule", a: [0.5, -7, 5.6], b: [1.8, -8.6, 11.4], radius: 1.7, radius2: 0.3 },
        { type: "capsule", a: [0.5, 7, 5.6], b: [1.8, 8.6, 11.4], radius: 1.7, radius2: 0.3 },
        { type: "capsule", a: [3, -3.6, 3], b: [5.6, -4.6, 10.6], radius: 1.8, radius2: 0.3 },
        { type: "capsule", a: [3, 3.6, 3], b: [5.6, 4.6, 10.6], radius: 1.8, radius2: 0.3 },
      ],
    }),
    // The left arm hangs, its fist clenched.
    flame({
      name: "arm_l",
      parent: "torso",
      at: [0, -7.6, 4.2],
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [-1.2, -1.8, -6.2], radius: 2.4, radius2: 1.9 }],
    }),
    flame({
      name: "hand_l",
      parent: "arm_l",
      at: [-1.2, -1.8, -6.2],
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [-2.4, -0.4, -4.4], radius: 1.9, radius2: 1.6 },
        { type: "ellipsoid", center: [-2.7, -0.4, -5.2], radii: [2, 2, 2] },
      ],
    }),
    // The right arm holds the hammer up before it: the elbow forward, the fist by the head.
    flame({
      name: "arm_r",
      parent: "torso",
      at: [0, 7.6, 4.2],
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [-3.6, 1.4, -0.6], radius: 2.4, radius2: 1.9 }],
    }),
    flame({
      name: "hand_r",
      parent: "arm_r",
      at: [-3.6, 1.4, -0.6],
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [-2, -2, 6.4], radius: 1.9, radius2: 1.6 },
        { type: "ellipsoid", center: [-2.2, -2.1, 7.2], radii: [2, 2, 2] },
      ],
    }),
    {
      name: "hammer",
      parent: "hand_r",
      at: [-2.2, -2.1, 7.2],
      rot: [0, 0, 50],
      material: "darkWood",
      shiny: true,
      shapes: [
        { type: "capsule", a: [0, 0, -1.6], b: [0.6, 0, 8], radius: 0.7 },
        { type: "box", min: [-1.6, -3.4, 7.2], max: [1.8, 3.4, 10.6], material: "darkIron" },
      ],
    },
    {
      name: "sparks",
      at: [0, 0, 28],
      material: "flame",
      shapes: [],
      marks: [
        { at: [3, -8, 6], tone: "light" },
        { at: [-2, 9, 11], tone: "light" },
        { at: [5, 4, 16], tone: "base" },
      ],
    },
  ],
  actions: {
    // The flames lick up, the tail sways, the sparks rise and the hammer lifts a little.
    idle: {
      frames: 4,
      ms: 420,
      keys: keys(
        [0, {}],
        [
          0.25,
          {
            hair: { rot: [10, -8, 0] },
            beard: { rot: [6, 0, 0] },
            tongues: { rot: [6, 0, 0], move: [0, 0, 0.8] },
            tail: { rot: [8, 0, 0] },
            tail_tip: { rot: [-14, 0, 0] },
            torso: { move: [0, 0, 0.6] },
            hand_r: { rot: [0, -8, 0] },
            sparks: { rot: [0, 0, 35], move: [0, 0, 1.5] },
          },
        ],
        [
          0.5,
          {
            hair: { rot: [0, 6, 0] },
            tongues: { rot: [0, 8, 0], move: [0, 0, 1.2] },
            tail: { rot: [-6, 0, 0] },
            tail_tip: { rot: [12, 0, 0] },
            torso: { move: [0, 0, 0.6] },
            hand_r: { rot: [0, -12, 0] },
            sparks: { rot: [0, 0, 70], move: [0, 0, 3] },
          },
        ],
        [
          0.75,
          {
            hair: { rot: [-10, -4, 0] },
            beard: { rot: [-6, 0, 0] },
            tongues: { rot: [-6, 0, 0], move: [0, 0, 0.4] },
            tail: { rot: [4, 0, 0] },
            tail_tip: { rot: [-8, 0, 0] },
            hand_r: { rot: [0, -4, 0] },
            sparks: { rot: [0, 0, 105], move: [0, 0, 4.5] },
          },
        ],
      ),
    },
    // It glides: leaning in, the tail trailing and swaying, the hair streaming back.
    walk: {
      frames: 4,
      keys: keys(
        [
          0,
          {
            tail: { rot: [6, -8, 0] },
            tail_tip: { rot: [0, -10, 0] },
            arm_l: { rot: [0, 16, 0] },
            hair: { rot: [0, 14, 0] },
          },
        ],
        [
          0.25,
          {
            torso: { move: [0, 0, 0.8] },
            tail: { rot: [0, -10, 0] },
            tail_tip: { rot: [-10, -12, 0] },
            hair: { rot: [0, 20, 0] },
            tongues: { rot: [0, 10, 0] },
          },
        ],
        [
          0.5,
          {
            tail: { rot: [-6, -8, 0] },
            tail_tip: { rot: [0, -10, 0] },
            arm_l: { rot: [0, -12, 0] },
            hair: { rot: [0, 14, 0] },
          },
        ],
        [
          0.75,
          {
            torso: { move: [0, 0, 0.8] },
            tail: { rot: [0, -10, 0] },
            tail_tip: { rot: [10, -12, 0] },
            hair: { rot: [0, 20, 0] },
          },
        ],
      ),
    },
  },
};
