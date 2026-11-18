// The bristleback boar (data/monsters/bristleback_boar.yaml): a squat, dark boar with a pale
// bristle crest along its back and curved tusks. The design spritegen drew by hand since
// T0.5 (recipes/creatures.ts until 2026-11-18), now a model: about 36 px long and 23 px tall
// at the scale of the LPC person (docs/17 ART-2, "Animales medianos"). Built facing west.
import { keys, mergePoses, trot } from "../motion.ts";
import type { PartSpec, SpriteSpec } from "../spec.ts";

const FUR = { amount: 0.1, cell: [3, 2, 1.2] } as const;

/** Degrees the legs splay out to the sides: a squat, four-square stance from the front. */
const SPLAY = 8;

/** A leg from its hip (`at`, in the body's frame) to a hoof on the ground. */
const leg = (name: string, at: readonly [number, number, number], hip: number): PartSpec => ({
  name,
  parent: "body",
  at,
  rot: [at[1] < 0 ? -SPLAY : SPLAY, 0, 0],
  material: "boarFur",
  shapes: [
    { type: "capsule", a: [0, 0, 1], b: [0, 0, -hip + 1.4], radius: 2.3, radius2: 1.6 },
    { type: "box", min: [-1.7, -1.5, -hip], max: [1.5, 1.5, -hip + 1.4], material: "hoof" },
  ],
});

const LEGS = {
  frontLeft: "leg_fl",
  frontRight: "leg_fr",
  backLeft: "leg_bl",
  backRight: "leg_br",
} as const;

export const BOAR: SpriteSpec = {
  sprite: "creatures/bristleback_boar",
  size: "mediumAnimal",
  figure: { height: [20, 30], width: [32, 44] },
  parts: [
    {
      name: "body",
      at: [2, 0, 11],
      material: "boarFur",
      texture: FUR,
      shapes: [
        { type: "ellipsoid", radii: [11.5, 9.2, 6.6] },
        // The shoulders, higher and rounder than the rump.
        { type: "ellipsoid", center: [-6, 0, 1.2], radii: [6.8, 9.8, 6.9] },
      ],
    },
    {
      name: "crest",
      parent: "body",
      material: "bristle",
      shapes: [
        {
          type: "polygon",
          points: [
            [-13, 6.5],
            [-12, 9],
            [-10, 7.5],
            [-8, 10],
            [-6, 8],
            [-4, 10],
            [-2, 8],
            [0, 9.5],
            [2, 7.5],
            [4, 9],
            [6, 6.5],
            [8, 7.5],
            [10, 4.5],
            [6, 4],
            [-6, 5.5],
          ],
          thickness: 2.6,
          bulge: 1,
          bias: -0.3,
        },
      ],
    },
    {
      name: "tail",
      parent: "body",
      at: [11.5, 0, 2],
      material: "boarFur",
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [2.5, 0, -3.5], radius: 0.9, radius2: 0.6 }],
    },
    leg("leg_fr", [-7, 5.4, -4.6], 6.4),
    leg("leg_br", [8, 5.4, -3.8], 7.2),
    {
      name: "head",
      parent: "body",
      at: [-11, 0, 0],
      rot: [0, -8, 0],
      material: "boarFur",
      texture: FUR,
      shapes: [
        { type: "ellipsoid", center: [-2.5, 0, -0.5], radii: [5.3, 6.6, 5.5] },
        { type: "ellipsoid", center: [-7.4, 0, -3], radii: [2.8, 3.6, 2.6], material: "snout" },
      ],
      marks: [
        { at: [-6.2, -3.4, 1.4], material: "eye" },
        { at: [-6.2, 3.4, 1.4], material: "eye" },
        { at: [-10.1, -1.4, -3], material: "snout" },
        { at: [-10.1, 1.4, -3], material: "snout" },
      ],
    },
    {
      name: "ears",
      parent: "head",
      material: "boarFur",
      shapes: [
        { type: "capsule", a: [-1.2, -4.2, 3.4], b: [0.8, -7.4, 7.4], radius: 1.8, radius2: 0.5 },
        { type: "capsule", a: [-1.2, 4.2, 3.4], b: [0.8, 7.4, 7.4], radius: 1.8, radius2: 0.5 },
      ],
    },
    {
      name: "tusks",
      parent: "head",
      material: "bone",
      shapes: [
        { type: "capsule", a: [-6.6, -3, -4.6], b: [-8.8, -5, -1.2], radius: 1, radius2: 0.55 },
        { type: "capsule", a: [-6.6, 3, -4.6], b: [-8.8, 5, -1.2], radius: 1, radius2: 0.55 },
      ],
    },
    leg("leg_fl", [-7, -5.4, -4.6], 6.4),
    leg("leg_bl", [8, -5.4, -3.8], 7.2),
  ],
  actions: {
    // Breathing, with a sniff: the body rises a pixel, the head dips and the tail flicks.
    idle: {
      frames: 4,
      ms: 500,
      keys: keys(
        [0, {}],
        [0.25, { body: { move: [0, 0, 0.7] }, head: { rot: [0, -4, 0] } }],
        [0.5, { body: { move: [0, 0, 0.7] }, head: { rot: [0, 4, 6] }, tail: { rot: [25, 0, 0] } }],
        [0.75, { head: { rot: [0, 2, 0] } }],
      ),
    },
    walk: trot({
      legs: LEGS,
      swing: 26,
      lift: 1.6,
      bob: 1,
      extra: (t) => ({
        head: { rot: [0, 5 * Math.cos(4 * Math.PI * t), 0] },
        tail: { rot: [20 * Math.sin(2 * Math.PI * t), 0, 0] },
      }),
    }),
    // A gore: it crouches with its head down, lunges and tosses its tusks up, and recovers.
    attack: {
      frames: 4,
      ms: 90,
      keys: keys(
        [
          0,
          mergePoses({
            "*": { move: [3, 0, -0.5] },
            body: { rot: [0, -5, 0] },
            head: { rot: [0, -18, 0] },
          }),
        ],
        [
          1 / 3,
          {
            "*": { move: [-5, 0, 0.5] },
            body: { rot: [0, 4, 0] },
            head: { rot: [0, 24, 0] },
            leg_fl: { rot: [0, 30, 0] },
            leg_fr: { rot: [0, 22, 0] },
            leg_bl: { rot: [0, -25, 0] },
            leg_br: { rot: [0, -30, 0] },
          },
        ],
        [
          2 / 3,
          { "*": { move: [-2, 0, 0] }, head: { rot: [0, 12, 0] }, leg_fl: { rot: [0, 12, 0] } },
        ],
        [1, {}],
      ),
    },
    // It staggers back, its legs buckle and it rolls onto its side.
    death: {
      frames: 5,
      ms: 120,
      keys: keys(
        [0, { "*": { move: [2, 0, 0] }, head: { rot: [0, 18, 0] }, tail: { rot: [30, 0, 0] } }],
        [
          0.25,
          {
            "*": { move: [2, 0, -1] },
            body: { rot: [0, -6, 0] },
            head: { rot: [0, -10, 0] },
            leg_fl: { rot: [0, 30, 0] },
            leg_fr: { rot: [0, 35, 0] },
            leg_bl: { rot: [0, -20, 0] },
            leg_br: { rot: [0, -25, 0] },
          },
        ],
        [
          0.5,
          {
            "*": { rot: [-45, 0, 0], move: [1, -4, 3.5] },
            head: { rot: [0, -12, 0] },
            leg_fl: { rot: [0, 25, 0] },
            leg_fr: { rot: [0, 30, 0] },
            leg_bl: { rot: [0, -20, 0] },
            leg_br: { rot: [0, -20, 0] },
          },
        ],
        [
          0.75,
          {
            "*": { rot: [-86, 0, 0], move: [0, -8, 7.5] },
            head: { rot: [-6, -14, 0] },
            leg_fl: { rot: [0, 35, 0] },
            leg_fr: { rot: [0, 15, 0] },
            leg_bl: { rot: [0, -30, 0] },
            leg_br: { rot: [0, -10, 0] },
          },
        ],
        [
          1,
          {
            "*": { rot: [-90, 0, 0], move: [0, -9, 7.5] },
            head: { rot: [-10, -18, 0] },
            leg_fl: { rot: [0, 30, 0] },
            leg_fr: { rot: [0, 20, 0] },
            leg_bl: { rot: [0, -25, 0] },
            leg_br: { rot: [0, -15, 0] },
            tail: { rot: [0, 30, 0] },
          },
        ],
      ),
    },
  },
};
