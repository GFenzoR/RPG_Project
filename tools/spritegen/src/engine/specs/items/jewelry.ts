// Jewelry and ammunition icons (docs/17 "Íconos de items"): the amulets and rings of the
// catalog by level band (from band 3 up) and the two ammunitions. An amulet hangs facing the
// camera, its cord or chain a loop with the pendant at the bottom; a ring stands a little
// tilted back, so its hole shows and its stone sits on top; ammunition is a small bundle
// leaning on the diagonal like the weapons.
import type { MaterialName } from "../../../palette.ts";
import type { Vec3 } from "../../math.ts";
import type { PartSpec, ShapeSpec, SpriteSpec } from "../../spec.ts";
import { arc, gem, icon, lean, onPlane, plate, tube } from "./kit.ts";

type Piece = Omit<PartSpec, "parent">;

/** Parts as one model: the first is the root, the rest hang from it. */
function model(sprite: string, pieces: readonly Piece[], scale = 1): SpriteSpec {
  const [root, ...rest] = pieces;
  if (!root) throw new Error(`${sprite}: no parts`);
  return icon(sprite, [root, ...rest.map((p) => ({ ...p, parent: root.name }))], { scale });
}

// ---- Amulets --------------------------------------------------------------------------

/** The loop of a necklace, open at the bottom where the pendant hangs. */
const LOOP = onPlane(arc(0, 3.6, 7.6, 8.4, -62, 242, 18), 0.6);

/** A cord: a smooth tube. A chain: beads along the loop. */
function strand(material: MaterialName, chain: boolean): Piece {
  return {
    name: "strand",
    material,
    ...(chain && { shiny: true }),
    shapes: chain ? LOOP.map((c, i) => gem(c, i % 2 ? 0.8 : 1, 0.8)) : tube(LOOP, 0.65),
  };
}

export const AMULETS: SpriteSpec[] = [
  // Band 3: a polished stag antler tip hanging from a leather cord.
  model("jewelry/antler_amulet", [
    strand("leather", false),
    {
      name: "antler",
      material: "bone",
      bias: -0.08,
      shapes: [
        ...tube(
          onPlane(
            [
              [0, -3.6],
              [-1.4, -7.4],
              [0.6, -11.6],
            ],
            -0.4,
          ),
          1.7,
          0.5,
        ),
        { type: "capsule", a: [-0.8, -0.4, -6.4], b: [2.8, -0.4, -8], radius: 0.8, radius2: 0.4 },
      ],
    },
    {
      name: "knot",
      material: "leather",
      shapes: [gem([0, -0.8, -3.6], 1.5, 1.2)],
    },
  ]),
  // Band 4: an ember sealed in volcanic glass, on an iron chain.
  model("jewelry/cinder_amulet", [
    strand("iron", true),
    {
      name: "setting",
      material: "darkIron",
      shiny: true,
      shapes: [gem([0, -0.2, -3.6], 2, 1.4)],
    },
    {
      name: "glass",
      material: "obsidian",
      shiny: true,
      shapes: [
        { type: "capsule", a: [0, -0.4, -6.6], b: [0, -0.4, -11], radius: 3.2, radius2: 0.9 },
      ],
    },
    { name: "ember", material: "ember", glow: true, shapes: [gem([0, -2.8, -7.4], 1.8, 0.9)] },
  ]),
  // Band 5: a wyrmling fang set in embersteel, on a gold chain with a jade bead.
  model("jewelry/wyrmtooth_amulet", [
    strand("gold", true),
    {
      name: "fang",
      material: "bone",
      shapes: tube(
        onPlane(
          [
            [0, -5],
            [0.8, -8.4],
            [-0.6, -12.2],
          ],
          -0.4,
        ),
        2,
        0.4,
      ),
    },
    {
      name: "cap",
      material: "darkIron",
      shiny: true,
      shapes: [{ type: "cylinder", a: [0, -0.4, -5.8], b: [0, -0.4, -3.4], radius: 2.4 }],
    },
    { name: "bead", material: "wyrmScale", shiny: true, shapes: [gem([0, -1, -1.8], 1.4, 1.2)] },
  ]),
  // Band 6: a black pearl the size of an eye in a tidesteel setting with a ring of runes.
  model("jewelry/blackpearl_amulet", [
    strand("tidesteel", true),
    {
      name: "setting",
      material: "tidesteel",
      shiny: true,
      shapes: tube(onPlane(arc(0, -7.4, 4, 4, 0, 360, 14), -0.4), 0.8),
    },
    { name: "pearl", material: "obsidian", shiny: true, shapes: [gem([0, -0.6, -7.4], 3.2, 2.6)] },
    {
      name: "runes",
      material: "rune",
      glow: true,
      shapes: [
        gem([0, -1.4, -2.6], 1.2, 0.8),
        gem([-4, -1.2, -7.4], 0.7, 0.6),
        gem([4, -1.2, -7.4], 0.7, 0.6),
      ],
    },
  ]),
];

// ---- Rings ----------------------------------------------------------------------------

/**
 * How far a ring lying flat tips toward the camera: its band reads as an ellipse with the hole
 * showing, and its stone, on top of the far side, rises above it.
 */
const RING_TILT = 15;
const RING_R = 6.6;

/** A ring band: a loop of capsules in the x-y plane, the root tipped toward the camera. */
function band(material: MaterialName, thickness: number, look: Partial<PartSpec> = {}): Piece {
  const pts = arc(0, 0, RING_R, RING_R, 0, 360, 20).map(([x, y]): Vec3 => [x, y, 0]);
  return {
    name: "band",
    material,
    shiny: true,
    rot: [RING_TILT, 0, 0],
    ...look,
    shapes: tube(pts, thickness),
  };
}

/** A point h above the far side of a ring's band, in the band's frame (where a stone sits). */
const onTop = (h: number): Vec3 => [0, RING_R, h];

export const RINGS: SpriteSpec[] = [
  // Band 3: a briar twig that curled into a ring by itself, its thorns still on.
  model("jewelry/briar_ring", [
    band("thornWood", 1.2, { shiny: false, bias: 0.3, texture: { amount: 0.1, cell: [1, 1, 1] } }),
    {
      name: "thorns",
      material: "thornWood",
      bias: 0.3,
      shapes: [30, 110, 200, 290].map((a): ShapeSpec => {
        const r = (a * Math.PI) / 180;
        const c: Vec3 = [Math.cos(r) * RING_R, Math.sin(r) * RING_R, 0];
        const o: Vec3 = [Math.cos(r) * (RING_R + 2.6), Math.sin(r) * (RING_R + 2.6), 0.6];
        return { type: "capsule", a: c, b: o, radius: 0.7, radius2: 0.3 };
      }),
    },
    {
      name: "leaf",
      material: "foliage",
      shapes: [{ type: "ellipsoid", center: [1.4, RING_R, 1.6], radii: [2.2, 1.2, 1] }],
    },
  ]),
  // Band 4: a band of obsidian carved from one piece, black and cold, a flat facet on top.
  model("jewelry/obsidian_ring", [
    band("obsidian", 1.6),
    {
      name: "facet",
      material: "obsidian",
      shiny: true,
      bias: 0.2,
      shapes: [{ type: "box", min: [-2.4, RING_R - 1.4, 0.6], max: [2.4, RING_R + 1.4, 2] }],
    },
  ]),
  // Band 5: an embersteel band, gold claws, a red stone that beats like a heart.
  model("jewelry/emberheart_ring", [
    band("darkIron", 1.2),
    {
      name: "claws",
      material: "gold",
      shiny: true,
      shapes: [{ type: "cylinder", a: onTop(0), b: onTop(1.8), radius: 2.6 }],
    },
    { name: "stone", material: "heartstone", glow: true, shapes: [gem(onTop(2.8), 2.2, 2.2)] },
  ]),
  // Band 6: a tidesteel band with a sea-blue stone that gets wet and dries with the tides.
  model("jewelry/tidestone_ring", [
    band("tidesteel", 1.25),
    {
      name: "setting",
      material: "pearl",
      shiny: true,
      shapes: [{ type: "cylinder", a: onTop(0), b: onTop(1.6), radius: 2.7 }],
    },
    { name: "stone", material: "water", shiny: true, shapes: [gem(onTop(2.8), 2.4, 2.4)] },
    {
      name: "glint",
      material: "rune",
      glow: true,
      shapes: [gem([-0.8, RING_R - 2, 3.8], 0.8, 0.8)],
    },
  ]),
];

// ---- Ammunition -----------------------------------------------------------------------

interface ShaftLook {
  shaft: MaterialName;
  head: MaterialName;
  vanes: MaterialName;
  /** From the nock (z = -low) to the base of the head (z = high). */
  low: number;
  high: number;
  radius: number;
  /** The head: its length and half-width. */
  headLength: number;
  headWidth: number;
  vaneLength: number;
}

/** One arrow or bolt along +z: shaft, head and two vanes. */
function shaft(name: string, l: ShaftLook): [Piece, ...Piece[]] {
  return [
    {
      name,
      material: l.shaft,
      shapes: [{ type: "capsule", a: [0, 0, -l.low], b: [0, 0, l.high], radius: l.radius }],
    },
    {
      name: `${name}_head`,
      material: l.head,
      shiny: true,
      shapes: [
        plate(
          [
            [0, l.high + l.headLength],
            [-l.headWidth, l.high + 1],
            [-0.6, l.high - 0.6],
            [0.6, l.high - 0.6],
            [l.headWidth, l.high + 1],
          ],
          0.7,
          { bulge: 0.4 },
        ),
      ],
    },
    {
      name: `${name}_vanes`,
      material: l.vanes,
      shapes: [-1, 1].map((s) =>
        plate(
          [
            [0, -l.low + l.vaneLength + 1],
            [s * 2.2, -l.low + 1.4],
            [s * 2.2, -l.low - 0.4],
            [0, -l.low + 1],
          ],
          0.45,
          { bias: s < 0 ? 0.1 : -0.1 },
        ),
      ),
    },
  ];
}

/** Three of them in a bundle, fanned a little, leaning on the diagonal. */
function bundle(sprite: string, l: ShaftLook, scale = 1): SpriteSpec {
  const [root, ...rest] = shaft("mid", l);
  const parts: PartSpec[] = [lean(root), ...rest.map((p) => ({ ...p, parent: "mid" }))];
  for (const [n, dx, dz, turn] of [
    ["left", -2.6, -1.6, -5],
    ["right", 2.6, 1.2, 5],
  ] as const) {
    const [r0, ...more] = shaft(n, l);
    parts.push({
      ...r0,
      parent: "mid",
      at: [dx, n === "left" ? -0.8 : 0.8, dz],
      rot: [0, turn, 0],
    });
    for (const p of more) parts.push({ ...p, parent: n });
  }
  return icon(sprite, parts, { scale });
}

export const AMMO: SpriteSpec[] = [
  // An iron tip and gull feathers.
  bundle("ammo/arrow", {
    shaft: "wood",
    head: "iron",
    vanes: "feather",
    low: 12,
    high: 9,
    radius: 0.6,
    headLength: 3.6,
    headWidth: 1.4,
    vaneLength: 5,
  }),
  // A short iron dart for a crossbow: a thick shaft, a heavy head, stiff leather vanes.
  bundle(
    "ammo/bolt",
    {
      shaft: "darkWood",
      head: "iron",
      vanes: "leather",
      low: 8,
      high: 6,
      radius: 0.8,
      headLength: 3,
      headWidth: 1.6,
      vaneLength: 3.6,
    },
    1.1,
  ),
];

export const JEWELRY_ICONS: SpriteSpec[] = [...AMULETS, ...RINGS];
