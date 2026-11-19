// The remains a monster leaves where it dies (data/items/decoration.yaml `remains_*` and
// `creature_remains`; data/monsters `corpse`): the fallen body of each family, lying on its
// tile with the loot inside, until combat.monster_corpse_ms takes it away. Each one is the
// last pose of its family's death (on its side, on its back, slumped into a heap), drawn as
// a model on a 32x32 object canvas: about 22-28 px long, low (a body on the ground) and
// darker than the living creature, with no blood pool (the hit effects already have it).
// The client shows the death animation over it (CreatureDisappear DEATH, ANI-7), so it
// comes in under the falling body.
//
// Units are sprite pixels, x east, y north, z up; the origin is the middle of the tile on the
// ground. Every body lies along x and a little across the tile, so it fits from its nose to
// its tail without touching the canvas border.
import type { MarkSpec, PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";
import type { Vec3 } from "../math.ts";

const FUR = { amount: 0.1, cell: [3, 2, 1.2] } as const;

const times = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/** A shape `k` times its size about the part's origin. */
function growShape(sh: ShapeSpec, k: number): ShapeSpec {
  switch (sh.type) {
    case "ellipsoid":
      return { ...sh, center: sh.center && times(sh.center, k), radii: times(sh.radii, k) };
    case "box":
      return { ...sh, min: times(sh.min, k), max: times(sh.max, k) };
    case "cylinder":
      return { ...sh, a: times(sh.a, k), b: times(sh.b, k), radius: sh.radius * k };
    case "capsule":
      return {
        ...sh,
        a: times(sh.a, k),
        b: times(sh.b, k),
        radius: sh.radius * k,
        radius2: sh.radius2 === undefined ? undefined : sh.radius2 * k,
      };
    case "extrusion":
      return {
        ...sh,
        points: sh.points.map(([u, v]) => [u * k, v * k] as const),
        from: sh.from * k,
        to: sh.to * k,
      };
    case "polygon":
      return {
        ...sh,
        points: sh.points.map(([u, v]) => [u * k, v * k] as const),
        at: sh.at === undefined ? undefined : sh.at * k,
        thickness: (sh.thickness ?? 1) * k,
      };
  }
}

/**
 * The model `k` times its size (joints, shapes and marks): every corpse is drawn at the
 * proportions of its family and then grown to fill its tile, 24-30 px long.
 */
function grow(spec: SpriteSpec, k: number): SpriteSpec {
  return {
    ...spec,
    parts: spec.parts.map((p) => ({
      ...p,
      at: p.at && times(p.at, k),
      shapes: p.shapes.map((sh) => growShape(sh, k)),
      marks: p.marks?.map((m): MarkSpec => ({ ...m, at: times(m.at, k) })),
    })),
  };
}

/** A leg lying on the ground, from the hip (a, on the body) to the foot (b). */
const limb = (
  name: string,
  parent: string,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  material: PartSpec["material"],
  radius = 1.3,
): PartSpec => ({
  name,
  parent,
  material,
  shapes: [{ type: "capsule", a, b, radius, radius2: radius * 0.8 }],
});

/** A beast on its side (wolf, hound, rat, stag, boar, bat): its flank up, legs to the south. */
export const REMAINS_FUR: SpriteSpec = {
  sprite: "decor/remains_fur",
  size: "object",
  figure: { height: [10, 18], width: [22, 30] },
  parts: [
    {
      name: "body",
      at: [1, 0, 0],
      material: "fur",
      texture: FUR,
      shapes: [
        { type: "ellipsoid", center: [0, 0, 3.6], radii: [8, 4.6, 3.6] },
        // The belly, paler, toward the camera.
        { type: "ellipsoid", center: [0, -2.4, 2.4], radii: [6, 2.2, 2.2], bias: 0.25 },
      ],
    },
    {
      name: "head",
      parent: "body",
      at: [-8.5, -0.5, 2.6],
      material: "fur",
      texture: FUR,
      shapes: [
        { type: "ellipsoid", radii: [3.2, 3, 2.6] },
        { type: "capsule", a: [-2, -0.5, -0.4], b: [-5, -1, -0.9], radius: 1.6, radius2: 1.1 },
        // The ear, flat on the ground.
        { type: "capsule", a: [1, 1.8, 1.4], b: [2.8, 3.2, 0.8], radius: 1, radius2: 0.5 },
      ],
      marks: [
        { at: [-1.6, -2.6, 0.9], material: "eye", tone: "deep" },
        { at: [-5.9, -1.4, -0.6], material: "eye" },
      ],
    },
    {
      name: "tail",
      parent: "body",
      at: [7.5, 0.5, 2.6],
      material: "fur",
      texture: FUR,
      shapes: [{ type: "capsule", a: [0, 0, 0], b: [4.5, 2.5, -1.6], radius: 1.4, radius2: 0.7 }],
    },
    limb("leg_far_front", "body", [-6, 1, 2.5], [-10, 4.5, 1.2], "fur", 1.2),
    limb("leg_far_back", "body", [4, 1, 2.5], [8.5, 4, 1.2], "fur", 1.2),
    limb("leg_near_front", "body", [-4.5, -2.5, 1.6], [-7, -7.5, 0.9], "fur"),
    limb("leg_near_back", "body", [4.5, -2.5, 1.6], [7.5, -7, 0.9], "fur"),
  ],
};

/** An arthropod on its back (crab, spider, beetle, crawler): the pale belly up, legs curled. */
export const REMAINS_CHITIN: SpriteSpec = {
  sprite: "decor/remains_chitin",
  size: "object",
  figure: { height: [10, 18], width: [20, 28] },
  parts: [
    {
      name: "shell",
      material: "cinder",
      shiny: true,
      shapes: [
        // The carapace, upside down: its rim shows round the belly.
        { type: "ellipsoid", center: [0, 0, 2.6], radii: [9.5, 6.4, 2.6] },
      ],
    },
    {
      name: "belly",
      parent: "shell",
      material: "sand",
      bias: -0.15,
      shapes: [
        { type: "ellipsoid", center: [0, -0.4, 4.2], radii: [7.2, 4.6, 1.6] },
        // Plates across the belly.
        { type: "box", min: [-3.9, -4.6, 4.6], max: [-3.3, 3.8, 6], bias: -0.7 },
        { type: "box", min: [-0.3, -4.8, 4.6], max: [0.3, 4, 6], bias: -0.7 },
        { type: "box", min: [3.3, -4.6, 4.6], max: [3.9, 3.8, 6], bias: -0.7 },
      ],
    },
    // Six legs, splayed out from the rim and curled up over it, bent at the knee.
    ...([-5, 0, 5] as const).flatMap((x, i): PartSpec[] => [
      {
        name: `leg_s${i}`,
        parent: "shell",
        material: "hoof",
        shapes: [
          { type: "capsule", a: [x, -4.8, 3.4], b: [x - 1.6, -7.6, 6.2], radius: 0.9 },
          { type: "capsule", a: [x - 1.6, -7.6, 6.2], b: [x - 3, -5.8, 8.2], radius: 0.8 },
        ],
      },
      {
        name: `leg_n${i}`,
        parent: "shell",
        material: "hoof",
        shapes: [
          { type: "capsule", a: [x, 4.8, 3.4], b: [x + 1.6, 6.8, 6.6], radius: 0.9 },
          { type: "capsule", a: [x + 1.6, 6.8, 6.6], b: [x + 2.8, 5, 8.4], radius: 0.8 },
        ],
      },
    ]),
  ],
};

/** A reptile on its side (salamander, wyrmling, toad): a long body and a curled tail. */
export const REMAINS_SCALES: SpriteSpec = {
  sprite: "decor/remains_scales",
  size: "object",
  figure: { height: [8, 16], width: [22, 30] },
  parts: [
    {
      name: "body",
      at: [-1, 0, 0],
      material: "moss",
      texture: { amount: 0.12, cell: [1.5, 1.5, 1.5] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, 3], radii: [6.5, 4, 3] },
        // The pale belly, turned up toward the camera.
        { type: "ellipsoid", center: [0, -2.2, 2.2], radii: [5, 2, 1.8], material: "sand" },
      ],
    },
    {
      name: "head",
      parent: "body",
      at: [-6.5, -0.5, 2.4],
      material: "moss",
      shapes: [
        { type: "ellipsoid", center: [-1.5, 0, 0], radii: [3.2, 2.6, 2.2] },
        { type: "ellipsoid", center: [-4.2, -0.3, -0.5], radii: [1.8, 1.8, 1.4] },
      ],
      marks: [{ at: [-2.2, -2.4, 0.9], material: "eye", tone: "deep" }],
    },
    {
      name: "tail",
      parent: "body",
      at: [6, 0, 2.2],
      material: "moss",
      shapes: [
        { type: "capsule", a: [0, 0, 0], b: [4.5, 2.6, -0.8], radius: 2, radius2: 1.4 },
        { type: "capsule", a: [4.5, 2.6, -0.8], b: [7.5, 0.4, -1.2], radius: 1.4, radius2: 0.8 },
        { type: "capsule", a: [7.5, 0.4, -1.2], b: [7, -2.6, -1.4], radius: 0.8, radius2: 0.5 },
      ],
    },
    limb("leg_fl", "body", [-3.5, -3, 1.4], [-5, -6.5, 0.8], "moss", 1.1),
    limb("leg_bl", "body", [3.5, -3, 1.4], [5.5, -6.5, 0.8], "moss", 1.1),
    limb("leg_fr", "body", [-3, 3, 3.8], [-4.5, 5.5, 5.4], "moss", 1),
  ],
};

/** A golem slumped into a heap of cooled slag, the last embers still in its cracks. */
export const REMAINS_SLAG: SpriteSpec = {
  sprite: "decor/remains_slag",
  size: "object",
  figure: { height: [10, 20], width: [20, 30] },
  parts: [
    {
      name: "heap",
      material: "basalt",
      texture: { amount: 0.14, cell: [2, 2, 2] },
      shapes: [
        { type: "ellipsoid", center: [0, 1, 4], radii: [6.5, 5, 4.5] },
        { type: "ellipsoid", center: [-6.5, -1, 2.6], radii: [4.2, 3.6, 2.8], bias: 0.1 },
        { type: "ellipsoid", center: [6.5, -0.5, 2.8], radii: [4.4, 3.8, 3] },
        { type: "ellipsoid", center: [1.5, -4, 2], radii: [3.6, 2.6, 2.2], material: "lavaRock" },
        { type: "box", min: [-10.5, -4.5, 0], max: [-8, -2.4, 1.8], material: "lavaRock" },
      ],
    },
    {
      name: "embers",
      parent: "heap",
      material: "ember",
      glow: true,
      shapes: [
        { type: "capsule", a: [-2.5, -3.2, 5.4], b: [1.5, -3.6, 4.6], radius: 0.6 },
        { type: "capsule", a: [5, -3.4, 3.8], b: [7.5, -3, 4.8], radius: 0.55 },
      ],
    },
  ],
};

/** A skeleton fallen apart in a dark puddle (the drowned miner and the undead). */
export const REMAINS_BONES: SpriteSpec = {
  sprite: "decor/remains_bones",
  size: "object",
  figure: { height: [8, 16], width: [20, 30] },
  parts: [
    {
      name: "puddle",
      material: "water",
      bias: -0.35,
      shapes: [{ type: "ellipsoid", center: [1, 0.5, 0.2], radii: [9.5, 5, 0.5] }],
    },
    {
      name: "skull",
      parent: "puddle",
      at: [-7.5, -0.5, 0],
      material: "bone",
      shapes: [
        { type: "ellipsoid", center: [0, 0, 3], radii: [3, 2.8, 2.7] },
        // The jaw, a little apart from the cranium.
        { type: "box", min: [-1.8, -2.9, 0.4], max: [1.8, -1.2, 1.5], bias: -0.25 },
      ],
      marks: [
        { at: [-1.1, -2.6, 3], material: "eye", tone: "base" },
        { at: [1.1, -2.6, 3], material: "eye", tone: "base" },
        { at: [0, -2.8, 2], material: "eye", tone: "base" },
      ],
    },
    {
      name: "ribs",
      parent: "puddle",
      at: [1, 0.5, 0],
      material: "bone",
      bias: -0.15,
      shapes: [
        // The spine and four ribs arching over it.
        { type: "capsule", a: [-4.5, 0, 1], b: [4.5, 0, 1], radius: 0.8 },
        ...([-3, -1, 1, 3] as const).flatMap((x) => [
          {
            type: "capsule" as const,
            a: [x, -2.8, 0.6] as const,
            b: [x, 0, 3] as const,
            radius: 0.75,
          },
          {
            type: "capsule" as const,
            a: [x, 0, 3] as const,
            b: [x, 2.8, 0.6] as const,
            radius: 0.75,
          },
        ]),
      ],
    },
    {
      name: "bones",
      parent: "puddle",
      material: "bone",
      bias: -0.1,
      shapes: [
        { type: "capsule", a: [6, -1, 0.9], b: [10.5, -3.5, 0.9], radius: 0.9 },
        { type: "ellipsoid", center: [10.8, -3.7, 1], radii: [1.2, 1.2, 1] },
        { type: "capsule", a: [6, 1.5, 0.9], b: [10, 4, 0.9], radius: 0.9 },
        { type: "capsule", a: [-2.5, -3, 0.8], b: [-4.5, -6, 0.8], radius: 0.85 },
      ],
    },
  ],
};

/** A seabird fallen on its back, one wing spread, a few feathers round it. */
export const REMAINS_FEATHERS: SpriteSpec = {
  sprite: "decor/remains_feathers",
  size: "object",
  figure: { height: [8, 16], width: [18, 28] },
  parts: [
    {
      name: "body",
      material: "feather",
      bias: -0.2,
      shapes: [{ type: "ellipsoid", center: [0, 0, 2.8], radii: [5, 3.4, 2.8] }],
    },
    {
      name: "head",
      parent: "body",
      at: [-5, -0.5, 2],
      material: "feather",
      bias: -0.15,
      shapes: [
        { type: "ellipsoid", center: [-1.2, 0, 0], radii: [2.2, 2, 1.8] },
        {
          type: "capsule",
          a: [-3, -0.3, -0.3],
          b: [-5.4, -0.8, -0.8],
          radius: 0.8,
          radius2: 0.5,
          material: "gold",
        },
      ],
      marks: [{ at: [-1.6, -1.9, 0.4], material: "eye", tone: "deep" }],
    },
    {
      name: "wing_spread",
      parent: "body",
      material: "stone",
      shapes: [
        {
          type: "polygon",
          axis: "z",
          at: 1,
          thickness: 1.4,
          bulge: 0.6,
          points: [
            [-2, -2],
            [3, -2],
            [9, -6],
            [6.5, -7.5],
            [1, -6.5],
          ],
        },
      ],
    },
    {
      name: "wing_folded",
      parent: "body",
      material: "stone",
      shapes: [
        { type: "ellipsoid", center: [1.5, 2.6, 2.6], radii: [4.6, 1.8, 1.8] },
        { type: "capsule", a: [5, 3, 2.2], b: [9.5, 4, 1.2], radius: 1.2, radius2: 0.5 },
      ],
    },
    {
      name: "feet",
      parent: "body",
      material: "gold",
      bias: -0.2,
      shapes: [
        { type: "capsule", a: [2.5, -0.5, 5], b: [3.5, -1, 7.5], radius: 0.55 },
        { type: "capsule", a: [3.5, 0.5, 5], b: [5, 0.5, 7.2], radius: 0.55 },
      ],
    },
  ],
};

/** A person face down, an arm thrown out (the looters, the smugglers, the renegade miners). */
export const REMAINS_HUMANOID: SpriteSpec = {
  sprite: "decor/remains_humanoid",
  size: "object",
  figure: { height: [8, 16], width: [22, 30] },
  parts: [
    {
      name: "torso",
      at: [-1, 0, 0],
      material: "leather",
      shapes: [
        { type: "ellipsoid", center: [0, 0, 2.6], radii: [5.2, 3.6, 2.6] },
        // A belt.
        { type: "box", min: [3.4, -3.4, 0.4], max: [4.4, 3.4, 4.6], material: "darkWood" },
      ],
    },
    {
      name: "head",
      parent: "torso",
      at: [-7, 0, 0],
      material: "darkWood",
      texture: { amount: 0.1, cell: [1, 2.5, 1] },
      shapes: [
        // The back of the head (hair) and the neck.
        { type: "ellipsoid", center: [0, 0, 2.4], radii: [2.5, 2.4, 2.3] },
        { type: "capsule", a: [1.8, 0, 2], b: [3, 0, 2], radius: 1, material: "skin" },
      ],
    },
    {
      name: "arm_out",
      parent: "torso",
      material: "redCloth",
      shapes: [
        { type: "capsule", a: [-3.5, -3, 2.2], b: [-6.5, -6.6, 1.2], radius: 1.3, radius2: 1.1 },
        { type: "ellipsoid", center: [-7.6, -7.4, 1], radii: [1.3, 1.2, 0.9], material: "skin" },
      ],
    },
    {
      name: "arm_in",
      parent: "torso",
      material: "redCloth",
      shapes: [
        { type: "capsule", a: [-3, 3, 2.2], b: [0.5, 4.6, 1.2], radius: 1.2, radius2: 1 },
        { type: "ellipsoid", center: [1.6, 4.8, 1], radii: [1.2, 1.1, 0.9], material: "skin" },
      ],
    },
    {
      name: "legs",
      parent: "torso",
      material: "blueCloth",
      shapes: [
        { type: "capsule", a: [4.5, -1.4, 1.8], b: [10.5, -2.4, 1.4], radius: 1.6, radius2: 1.3 },
        { type: "capsule", a: [4.5, 1.4, 1.8], b: [10, 3.2, 1.4], radius: 1.6, radius2: 1.3 },
        { type: "ellipsoid", center: [11.5, -2.6, 1.6], radii: [1.4, 1.4, 1.6], material: "hoof" },
        { type: "ellipsoid", center: [11, 3.5, 1.6], radii: [1.4, 1.4, 1.6], material: "hoof" },
      ],
    },
  ],
};

/** A thorn creature come apart: a heap of withered, thorny stems with a few dry leaves. */
export const REMAINS_BRAMBLE: SpriteSpec = {
  sprite: "decor/remains_bramble",
  size: "object",
  figure: { height: [8, 18], width: [20, 30] },
  parts: [
    {
      name: "mound",
      material: "thornWood",
      texture: { amount: 0.12, cell: [3, 1, 1] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, 2], radii: [6, 4.5, 2.4] },
        { type: "capsule", a: [-11, -2, 1.4], b: [6, 3, 2.6], radius: 1.3, radius2: 1 },
        { type: "capsule", a: [-6, 4, 1.2], b: [10.5, -2.5, 1.6], radius: 1.2, radius2: 0.9 },
        { type: "capsule", a: [-8, -4, 1], b: [3, -1, 4.6], radius: 1.1, radius2: 0.8 },
        { type: "capsule", a: [2, -5, 1.2], b: [-1, 3, 5], radius: 1, radius2: 0.8 },
      ],
    },
    {
      name: "thorns",
      parent: "mound",
      material: "bark",
      bias: 0.2,
      shapes: [
        { type: "capsule", a: [-6, -0.4, 2.6], b: [-6.4, -0.4, 4.6], radius: 0.55, radius2: 0.3 },
        { type: "capsule", a: [1, 1.4, 3.4], b: [1.4, 1.4, 5.4], radius: 0.55, radius2: 0.3 },
        { type: "capsule", a: [6, -1, 2.6], b: [7.4, -1, 4], radius: 0.55, radius2: 0.3 },
      ],
    },
    {
      name: "leaves",
      parent: "mound",
      material: "moss",
      bias: -0.1,
      shapes: [
        { type: "ellipsoid", center: [-3, -3.2, 2.6], radii: [1.6, 1, 0.6] },
        { type: "ellipsoid", center: [4, 2, 3.2], radii: [1.5, 1.1, 0.6] },
        { type: "ellipsoid", center: [8.5, -1.5, 1.6], radii: [1.4, 1, 0.6] },
      ],
    },
  ],
};

/**
 * The default remains (creature_remains: a monster without its own corpse, and every
 * player): a neutral heap of bones on a torn hide, nothing of any one family.
 */
export const CREATURE_REMAINS: SpriteSpec = {
  sprite: "decor/creature_remains",
  size: "object",
  figure: { height: [8, 16], width: [18, 28] },
  parts: [
    {
      name: "hide",
      material: "boarFur",
      texture: { amount: 0.12, cell: [2, 2, 1] },
      shapes: [
        {
          type: "polygon",
          axis: "z",
          at: 0.6,
          thickness: 1.2,
          bulge: 0.5,
          points: [
            [-10.5, 0],
            [-8, -4.5],
            [-2.5, -5.5],
            [1, -4],
            [6, -5.5],
            [10, -2],
            [9, 2.5],
            [4, 5],
            [-3, 4.5],
            [-8.5, 3.5],
          ],
        },
        // A fold of the hide, heaped behind the bones.
        { type: "ellipsoid", center: [3.5, 2.5, 1.4], radii: [4.5, 2.4, 1.6] },
      ],
    },
    {
      name: "ribs",
      parent: "hide",
      at: [1.5, -0.5, 0],
      material: "bone",
      bias: -0.15,
      shapes: [
        { type: "capsule", a: [-3.5, 0, 1.4], b: [4.5, 0.5, 1.4], radius: 0.8 },
        ...([-2, 0.2, 2.4] as const).flatMap((x) => [
          {
            type: "capsule" as const,
            a: [x, -2.6, 1] as const,
            b: [x, 0, 3.4] as const,
            radius: 0.75,
          },
          {
            type: "capsule" as const,
            a: [x, 0, 3.4] as const,
            b: [x, 2.6, 1] as const,
            radius: 0.75,
          },
        ]),
      ],
    },
    {
      name: "skull",
      parent: "hide",
      at: [-6.5, -1, 0],
      material: "bone",
      shapes: [
        { type: "ellipsoid", center: [0, 0, 2.6], radii: [2.6, 2.3, 2.2] },
        { type: "ellipsoid", center: [-2.6, -0.6, 1.6], radii: [1.6, 1.4, 1.2], bias: -0.1 },
      ],
      marks: [{ at: [-0.8, -2.1, 2.8], material: "eye", tone: "base" }],
    },
    {
      name: "bone",
      parent: "hide",
      material: "bone",
      bias: -0.1,
      shapes: [
        { type: "capsule", a: [1, -4.5, 1.6], b: [8, -2.5, 1.6], radius: 0.8 },
        { type: "ellipsoid", center: [8.4, -2.4, 1.7], radii: [1.1, 1.3, 1] },
        { type: "ellipsoid", center: [0.6, -4.6, 1.7], radii: [1.1, 1.3, 1] },
      ],
    },
  ],
};

/** Every corpse spec, the default remains first, each grown to fill its tile. */
export const REMAINS: readonly SpriteSpec[] = [
  grow(CREATURE_REMAINS, 1.15),
  REMAINS_FUR,
  grow(REMAINS_CHITIN, 1.15),
  REMAINS_SCALES,
  grow(REMAINS_SLAG, 1.18),
  grow(REMAINS_BONES, 1.18),
  grow(REMAINS_FEATHERS, 1.12),
  grow(REMAINS_HUMANOID, 1.2),
  grow(REMAINS_BRAMBLE, 1.15),
];
