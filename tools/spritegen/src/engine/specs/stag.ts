// The bramble stag (data/monsters/bramble_stag.yaml): a red deer whose antlers are thorny
// bramble wood with leaves and berries, and a bramble vine across its back. The design
// spritegen drew by hand since T3.6, now a model: antlers up at a person's height (~44 px)
// and the body about the wolf's length (docs/17 ART-2, "Animales medianos"). Built facing west.
import { keys, trot } from "../motion.ts";
import type { MarkSpec, PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";

const COAT = { amount: 0.08, cell: [3, 2, 1.4] } as const;

const leg = (name: string, at: readonly [number, number, number], hip: number): PartSpec => ({
  name,
  parent: "body",
  at,
  material: "stagCoat",
  shapes: [
    { type: "capsule", a: [0, 0, 1.5], b: [0, 0, -hip + 1.5], radius: 1.7, radius2: 1 },
    { type: "box", min: [-1.2, -1, -hip], max: [1, 1, -hip + 1.4], material: "hoof" },
  ],
});

/** One antler, mirrored across the head by `side` (-1 left, 1 right). */
function antler(side: number): ShapeSpec[] {
  const s = (v: readonly [number, number, number]): [number, number, number] => [
    v[0],
    v[1] * side,
    v[2],
  ];
  const beam = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    r = 0.75,
  ): ShapeSpec => ({
    type: "capsule",
    a: s(a),
    b: s(b),
    radius: r,
    radius2: 0.5,
  });
  return [
    beam([0.5, 1.4, 2.2], [1.5, 4, 5.8], 0.9),
    beam([1.5, 4, 5.8], [3.5, 6.5, 9.6]),
    beam([1.2, 3.4, 4.6], [-2.5, 5.8, 7]),
    beam([2.4, 5.2, 7.8], [0.5, 8.6, 10]),
    beam([3.5, 6.5, 9.6], [5.5, 6, 11.4]),
    { type: "ellipsoid", center: s([-2.8, 6, 7.4]), radii: [1.6, 1.6, 1.3], material: "foliage" },
    { type: "ellipsoid", center: s([0.2, 8.9, 10.4]), radii: [1.5, 1.5, 1.3], material: "foliage" },
  ];
}

const berries = (side: number): MarkSpec[] =>
  (
    [
      [-3.6, 6.6, 8.3],
      [1, 9.6, 11.2],
      [5.8, 6.2, 11.9],
    ] as const
  ).map(([x, y, z]) => ({ at: [x, y * side, z], material: "berry", tone: "base" }));

const LEGS = {
  frontLeft: "leg_fl",
  frontRight: "leg_fr",
  backLeft: "leg_bl",
  backRight: "leg_br",
} as const;

export const STAG: SpriteSpec = {
  sprite: "creatures/bramble_stag",
  size: "mediumAnimal",
  figure: { height: [40, 48], width: [34, 46] },
  parts: [
    {
      name: "body",
      at: [3, 0, 15.5],
      material: "stagCoat",
      texture: COAT,
      shapes: [
        { type: "ellipsoid", radii: [11.5, 5, 5.8] },
        { type: "ellipsoid", center: [-5, 0, 0.8], radii: [5.5, 5.2, 5.6] },
        // The pale belly and the white rump.
        {
          type: "ellipsoid",
          center: [0.5, 0, -2.6],
          radii: [9.5, 4.4, 3.6],
          material: "stagBelly",
        },
        { type: "ellipsoid", center: [10.8, 0, 1], radii: [2, 3.6, 3.2], material: "stagBelly" },
      ],
    },
    {
      name: "tail",
      parent: "body",
      at: [12, 0, 2.5],
      material: "stagBelly",
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [1.5, 0, -2], radius: 1, radius2: 0.7 }],
    },
    {
      name: "vine",
      parent: "body",
      material: "foliage",
      shapes: [
        { type: "capsule", a: [-6, 0, 5.6], b: [-1, 0.6, 6.2], radius: 0.8 },
        { type: "capsule", a: [-1, 0.6, 6.2], b: [4, -0.6, 5.6], radius: 0.8 },
        { type: "capsule", a: [4, -0.6, 5.6], b: [10, 0.3, 4], radius: 0.8 },
        { type: "ellipsoid", center: [-3.5, -1.2, 6.6], radii: [1.3, 1.1, 0.9] },
        { type: "ellipsoid", center: [2, 1.2, 6.8], radii: [1.3, 1.1, 0.9] },
        { type: "ellipsoid", center: [7, -1, 5.6], radii: [1.3, 1.1, 0.9] },
      ],
      marks: [
        { at: [0.5, -0.8, 7], material: "berry", tone: "base" },
        { at: [5.5, 0.9, 6.3], material: "berry", tone: "base" },
        { at: [-5, 0.8, 6.3], material: "thornWood", tone: "light" },
      ],
    },
    leg("leg_fr", [-7, 2.6, -3], 12.5),
    leg("leg_br", [8.5, 2.6, -2.5], 13),
    {
      name: "neck",
      parent: "body",
      at: [-8, 0, 2],
      material: "stagCoat",
      texture: COAT,
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [-3.5, 0, 8], radius: 3.4, radius2: 2.4 }],
    },
    {
      name: "head",
      parent: "neck",
      at: [-4, 0, 8.5],
      material: "stagCoat",
      shapes: [
        { type: "ellipsoid", center: [-1.4, 0, 0], radii: [3.4, 2.8, 2.8] },
        { type: "ellipsoid", center: [-4.8, 0, -1.6], radii: [2.6, 1.9, 1.7] },
        { type: "capsule", a: [0.4, -2, 1.5], b: [1.8, -4.6, 3], radius: 1.2, radius2: 0.4 },
        { type: "capsule", a: [0.4, 2, 1.5], b: [1.8, 4.6, 3], radius: 1.2, radius2: 0.4 },
      ],
      marks: [
        { at: [-3, -2.4, 0.9], material: "eye" },
        { at: [-3, 2.4, 0.9], material: "eye" },
        { at: [-7.3, 0, -1.4], material: "eye" },
      ],
    },
    {
      name: "antlers",
      parent: "head",
      material: "thornWood",
      shapes: [...antler(-1), ...antler(1)],
      marks: [...berries(-1), ...berries(1)],
    },
    leg("leg_fl", [-7, -2.6, -3], 12.5),
    leg("leg_bl", [8.5, -2.6, -2.5], 13),
  ],
  actions: {
    // It breathes, flicks an ear, turns its head a little and flicks its tail.
    idle: {
      frames: 4,
      ms: 550,
      keys: keys(
        [0, {}],
        [
          0.25,
          { body: { move: [0, 0, 0.6] }, neck: { rot: [0, 3, 0] }, tail: { rot: [0, -25, 0] } },
        ],
        [0.5, { body: { move: [0, 0, 0.6] }, head: { rot: [0, 0, 14] } }],
        [0.75, { neck: { rot: [0, -3, 0] }, head: { rot: [0, 0, 6] } }],
      ),
    },
    walk: trot({
      legs: LEGS,
      swing: 22,
      lift: 2,
      bob: 0.8,
      extra: (t) => ({
        neck: { rot: [0, -4 * Math.cos(4 * Math.PI * t), 0] },
        tail: { rot: [0, 15 * Math.sin(2 * Math.PI * t), 0] },
      }),
    }),
    // It lowers its antlers, charges and tosses its head up.
    attack: {
      frames: 4,
      ms: 90,
      keys: keys(
        [0, { "*": { move: [2.5, 0, 0] }, neck: { rot: [0, -38, 0] }, head: { rot: [0, -20, 0] } }],
        [
          1 / 3,
          {
            "*": { move: [-5, 0, 0] },
            neck: { rot: [0, -48, 0] },
            head: { rot: [0, -15, 0] },
            leg_fl: { rot: [0, 25, 0] },
            leg_fr: { rot: [0, 18, 0] },
            leg_bl: { rot: [0, -22, 0] },
            leg_br: { rot: [0, -28, 0] },
          },
        ],
        [
          2 / 3,
          { "*": { move: [-3, 0, 0] }, neck: { rot: [0, -10, 0] }, head: { rot: [0, 18, 0] } },
        ],
        [1, {}],
      ),
    },
    // It rears back, its forelegs fold and it falls onto its side.
    death: {
      frames: 5,
      ms: 130,
      keys: keys(
        [
          0,
          {
            "*": { move: [2, 0, 0] },
            body: { rot: [0, 8, 0] },
            neck: { rot: [0, 18, 0] },
            leg_fl: { rot: [0, 25, 0] },
          },
        ],
        [
          0.25,
          {
            "*": { move: [1, 0, -1.5] },
            body: { rot: [0, -12, 0] },
            neck: { rot: [0, -15, 0] },
            leg_fl: { rot: [0, 75, 0] },
            leg_fr: { rot: [0, 70, 0] },
            leg_bl: { rot: [0, -15, 0] },
            leg_br: { rot: [0, -15, 0] },
          },
        ],
        [
          0.5,
          {
            "*": { rot: [-45, 0, 0], move: [-2, -6, 3] },
            neck: { rot: [0, -20, 0] },
            leg_fl: { rot: [0, 50, 0] },
            leg_fr: { rot: [0, 45, 0] },
            leg_bl: { rot: [0, -20, 0] },
            leg_br: { rot: [0, -25, 0] },
          },
        ],
        [
          0.75,
          {
            "*": { rot: [-90, 0, 0], move: [2, -12, 5] },
            neck: { rot: [0, 10, 0] },
            head: { rot: [70, 0, 0] },
            leg_fl: { rot: [0, 40, 0] },
            leg_fr: { rot: [0, 25, 0] },
            leg_bl: { rot: [0, -30, 0] },
            leg_br: { rot: [0, -12, 0] },
          },
        ],
        [
          1,
          {
            "*": { rot: [-90, 0, 0], move: [2, -12, 5] },
            neck: { rot: [0, 18, 0] },
            head: { rot: [85, -5, 0] },
            leg_fl: { rot: [0, 35, 0] },
            leg_fr: { rot: [0, 28, 0] },
            leg_bl: { rot: [0, -32, 0] },
            leg_br: { rot: [0, -18, 0] },
          },
        ],
      ),
    },
  },
};
