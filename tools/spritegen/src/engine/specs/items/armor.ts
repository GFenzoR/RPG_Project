// Armour icons (docs/17 "Íconos de items"): shields, the heavy torso, robes, head, legs and
// feet by level band, plus the retired pieces. Each one stands upright facing the camera, in
// the x-z plane (x to the right, z up), its plates a little rounded (`bulge`) so the light
// from the top left reads on them.
import type { MaterialName } from "../../../palette.ts";
import type { Vec3 } from "../../math.ts";
import type { MarkSpec, PartSpec, Profile, ShapeSpec, SpriteSpec } from "../../spec.ts";
import { arc, ellipse, gem, icon, mirrored, moved, onPlane, plate, rivets, tube } from "./kit.ts";

type Piece = Omit<PartSpec, "parent">;

/** A profile scaled about (0, cz) by k (a face inside its rim). */
const inset = (p: Profile, k: number, cz = 0): Profile =>
  p.map(([x, z]) => [x * k, cz + (z - cz) * k] as const);

/** Parts as one model: the first is the root, the rest hang from it. */
function model(sprite: string, pieces: readonly Piece[], scale = 1): SpriteSpec {
  const [root, ...rest] = pieces;
  if (!root) throw new Error(`${sprite}: no parts`);
  const parts: PartSpec[] = [root, ...rest.map((p) => ({ ...p, parent: root.name }))];
  return icon(sprite, parts, { scale });
}

/** Vertical lines of marks (the joints between planks) inside an outline, at these x. */
function planks(outline: Profile, xs: readonly number[], y: number): MarkSpec[] {
  const out: MarkSpec[] = [];
  const zs = outline.map(([, z]) => z);
  const lo = Math.min(...zs);
  const hi = Math.max(...zs);
  for (const x of xs)
    for (let z = Math.ceil(lo) + 1; z <= Math.floor(hi) - 1; z++)
      if (insideProfile(outline, x, z + 0.5) && insideProfile(outline, x, z - 0.5))
        out.push({ at: [x, y, z], tone: "deep" });
  return out;
}

function insideProfile(pts: Profile, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i] ?? [0, 0];
    const [xj, zj] = pts[j] ?? [0, 0];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---- Shields --------------------------------------------------------------------------

interface ShieldLook {
  sprite: string;
  outline: Profile;
  face: MaterialName;
  rim: MaterialName;
  /** How much of the outline the face covers (the rest is rim). */
  faceScale?: number;
  /** Joints between planks, at these x. */
  planks?: readonly number[];
  /** Metal bands across the face, at these z. */
  bands?: { material: MaterialName; at: readonly number[]; half: number };
  boss?: { material: MaterialName; r: number; at?: Vec3 };
  /** Rivets around the rim, n of them. */
  rivets?: number;
  emblem?: Piece;
  texture?: PartSpec["texture"];
  scale?: number;
}

function shield(l: ShieldLook): SpriteSpec {
  const face = inset(l.outline, l.faceScale ?? 0.84);
  const pieces: Piece[] = [
    {
      name: "rim",
      material: l.rim,
      shiny: true,
      shapes: [plate(l.outline, 0.9, { y0: 0.6, bulge: 0.35 })],
      ...(l.rivets && {
        marks: inset(l.outline, 0.93)
          .filter((_, i, all) => i % Math.max(1, Math.round(all.length / (l.rivets ?? 1))) === 0)
          .map(([x, z]): MarkSpec => ({ at: [x, -0.4, z], tone: "light" })),
      }),
    },
    {
      name: "face",
      material: l.face,
      ...(l.texture && { texture: l.texture }),
      shapes: [plate(face, 0.9, { y0: -0.1, bulge: 0.4 })],
      ...(l.planks && { marks: planks(face, l.planks, -1.05) }),
    },
  ];
  const bands = l.bands;
  if (bands)
    pieces.push({
      name: "bands",
      material: bands.material,
      shiny: true,
      shapes: bands.at.map((z): ShapeSpec => ({
        type: "box",
        min: [-bands.half, -1.5, z - 0.8],
        max: [bands.half, -0.6, z + 0.8],
      })),
    });
  if (l.boss)
    pieces.push({
      name: "boss",
      material: l.boss.material,
      shiny: true,
      shapes: [gem(l.boss.at ?? [0, -1.2, 0.5], l.boss.r, l.boss.r * 0.7)],
    });
  if (l.emblem) pieces.push(l.emblem);
  return model(l.sprite, pieces, l.scale);
}

const ROUND = ellipse(0, 0, 10.5, 10.5, 28);
const HEATER = mirrored([
  [0, 11.5],
  [5, 11.6],
  [9.5, 11],
  [9.6, 4],
  [8.2, -3],
  [5, -8.6],
  [0, -12.6],
]);

export const SHIELDS: SpriteSpec[] = [
  // Band 1: a barrel lid with a strap nailed on: planks in a rusty hoop.
  shield({
    sprite: "shields/barrel_lid_shield",
    outline: ellipse(0, 0, 10, 10, 26),
    face: "weatheredWood",
    rim: "rust",
    faceScale: 0.86,
    planks: [-4.5, 0, 4.5],
    rivets: 8,
    texture: { amount: 0.08, cell: [0.8, 0.8, 5] },
  }),
  // Band 2: planks nailed to a crossbar, an iron rim.
  shield({
    sprite: "shields/plank_shield",
    outline: mirrored([
      [0, 11],
      [7.4, 11],
      [9, 9.6],
      [9, -9.6],
      [7.4, -11],
      [0, -11],
    ]),
    face: "wood",
    rim: "iron",
    faceScale: 0.88,
    planks: [-4.6, -1.4, 1.8, 5],
    bands: { material: "darkWood", at: [4.5, -4.5], half: 7.6 },
    rivets: 10,
    texture: { amount: 0.08, cell: [0.8, 0.8, 5] },
  }),
  // Band 3: elm planks with steel bands and a steel boss.
  shield({
    sprite: "shields/elmwood_shield",
    outline: ROUND,
    face: "wood",
    rim: "steel",
    planks: [-5, 0, 5],
    bands: { material: "steel", at: [5.6, -5.6], half: 7.4 },
    boss: { material: "steel", r: 3 },
    texture: { amount: 0.08, cell: [0.8, 0.8, 5] },
  }),
  // Band 4: an embersteel heater over an elm core, an ember glowing in its crest.
  shield({
    sprite: "shields/embersteel_shield",
    outline: HEATER,
    face: "darkIron",
    rim: "darkIron",
    faceScale: 0.82,
    rivets: 12,
    emblem: {
      name: "emblem",
      material: "ember",
      glow: true,
      shapes: [
        plate(
          mirrored([
            [0, 6],
            [2.6, 2],
            [1.6, -3],
            [0, -5.6],
          ]),
          0.5,
          { y0: -1.2 },
        ),
      ],
    },
  }),
  // Band 5: a tall pavise of overlapping jade scales in a gold rim.
  shield({
    sprite: "shields/wyrmscale_pavise",
    outline: mirrored([
      [0, 13],
      [5, 12.6],
      [8, 11],
      [8, -10.6],
      [5.6, -12.6],
      [0, -13.2],
    ]),
    face: "wyrmScale",
    rim: "gold",
    faceScale: 0.85,
    emblem: {
      name: "scales",
      material: "wyrmScale",
      bias: -0.05,
      shapes: [-7.5, -3.8, 0, 3.8, 7.5].flatMap((z, row) =>
        [-4.2, 0, 4.2]
          .map((x) => x + (row % 2 ? 2.1 : 0))
          .filter((x) => Math.abs(x) < 5.6)
          .map((x): ShapeSpec => ({
            type: "ellipsoid",
            center: [x, -1, z],
            radii: [2.2, 0.6, 2.2],
          })),
      ),
    },
    boss: { material: "gold", r: 1.8, at: [0, -1.6, 9.6] },
  }),
  // Band 6: a round tidesteel shield, smooth as still water, a ring of runes, a pearl boss.
  shield({
    sprite: "shields/tidesteel_shield",
    outline: ROUND,
    face: "tidesteel",
    rim: "tidesteel",
    faceScale: 0.86,
    boss: { material: "pearl", r: 2.8 },
    emblem: {
      name: "runes",
      material: "rune",
      glow: true,
      shapes: tube(onPlane(arc(0, 0.5, 6, 6, 100, 440, 16), -1.3), 0.5),
    },
  }),
];

export const RETIRED_SHIELDS: SpriteSpec[] = [
  // A wooden round shield with a riveted iron rim.
  shield({
    sprite: "shields/riveted_round_shield",
    outline: ROUND,
    face: "darkWood",
    rim: "iron",
    faceScale: 0.8,
    planks: [-3.5, 1.5],
    rivets: 12,
    boss: { material: "iron", r: 2.4 },
    texture: { amount: 0.08, cell: [0.8, 0.8, 5] },
  }),
];

// ---- Body: the heavy torso, robes and the retired vests --------------------------------

/** A garment's front: [x, z] right half, from the neck down the sleeve to the hem. */
const TUNIC = mirrored([
  [0, 10.4],
  [2.8, 10.6],
  [6.2, 9.6],
  [9.8, 7.2],
  [11.4, 2.4],
  [8.6, 1.4],
  [7.4, 4.6],
  [6.8, -2],
  [7.4, -9.4],
  [0, -9.8],
]);
/** A long robe: narrow shoulders, bell sleeves hanging to the hips, a skirt that flares. */
const ROBE = mirrored([
  [0, 11.6],
  [2.6, 11.8],
  [5.6, 10.8],
  [8.2, 8.6],
  [10.6, 0],
  [11.8, -4.6],
  [7.8, -4.8],
  [7, 1.4],
  [6.4, -3],
  [9.4, -13],
  [0, -13.4],
]);
/** The hood of a robe, bunched behind the neck. */
const hood = (material: MaterialName): Piece => ({
  name: "hood",
  material,
  bias: -0.12,
  shapes: [{ type: "ellipsoid", center: [0, 1.6, 10.6], radii: [5.6, 2.4, 2.4] }],
});
const COAT = mirrored([
  [0, 10.6],
  [3, 10.8],
  [6.6, 9.8],
  [10, 7],
  [11.6, -2.6],
  [8.6, -3.2],
  [7.4, 3.6],
  [7.2, -2],
  [8.2, -11.6],
  [0, -11.8],
]);
const VEST = mirrored([
  [0, 10.2],
  [3, 10.4],
  [6.8, 9.2],
  [7.8, 6],
  [6.8, 2],
  [7, -3],
  [7.6, -9.6],
  [0, -10],
]);
const CUIRASS = mirrored([
  [0, 9.6],
  [3.2, 10],
  [7.4, 8.6],
  [8, 4],
  [6.8, 0],
  [7.2, -5],
  [6.6, -8.4],
  [0, -9.4],
]);

/** The dark inside of a neck opening, a V or a round one. */
const neck = (width: number, depth: number, top: number): ShapeSpec =>
  plate(
    [
      [-width, top],
      [width, top],
      [width * 0.4, top - depth * 0.7],
      [0, top - depth],
      [-width * 0.4, top - depth * 0.7],
    ],
    0.5,
    { y0: -1.15, bias: -1 },
  );

/** A belt across the waist at z. */
const belt = (material: MaterialName, half: number, z: number, buckle?: MaterialName): Piece[] => [
  {
    name: "belt",
    material,
    shapes: [{ type: "box", min: [-half, -1.7, z - 0.9], max: [half, -0.6, z + 0.9] }],
  },
  ...(buckle
    ? [
        {
          name: "buckle",
          material: buckle,
          shiny: true,
          shapes: [
            { type: "box", min: [-1.2, -2, z - 1.1], max: [1.2, -1.4, z + 1.1] } as ShapeSpec,
          ],
        },
      ]
    : []),
];

/** A trim along the hem of a garment between x = ±half at z. */
const hem = (material: MaterialName, half: number, z: number, glow = false): Piece => ({
  name: "hem",
  material,
  ...(glow && { glow: true }),
  shapes: [{ type: "box", min: [-half, -1.4, z], max: [half, -0.5, z + 1.4] }],
});

/** Round pauldrons on the shoulders. */
const pauldrons = (material: MaterialName, r: number, x = 7.4, z = 7.6): Piece => ({
  name: "pauldrons",
  material,
  shiny: true,
  shapes: [
    { type: "ellipsoid", center: [-x, -0.4, z], radii: [r, r * 0.8, r * 0.85] },
    { type: "ellipsoid", center: [x, -0.4, z], radii: [r, r * 0.8, r * 0.85] },
  ],
});

/** The body of a garment or a breastplate: its outline, a little rounded. */
const body = (
  material: MaterialName,
  outline: Profile,
  look: {
    texture?: PartSpec["texture"];
    shiny?: boolean;
    marks?: MarkSpec[];
    extra?: ShapeSpec[];
  } = {},
): Piece => ({
  name: "body",
  material,
  ...(look.texture && { texture: look.texture }),
  ...(look.shiny && { shiny: true }),
  shapes: [plate(outline, 1.1, { bulge: 0.45 }), ...(look.extra ?? [])],
  ...(look.marks && { marks: look.marks }),
});

const CLOTH = { amount: 0.07, cell: [0.9, 2, 2.4] } as const;
const LEATHER = { amount: 0.1, cell: [1.6, 1.6, 1.6] } as const;

export const HEAVY_TORSO: SpriteSpec[] = [
  // Band 3: a thick stag-leather coat, laced down the front, with a fur collar and a belt.
  model("armor/stagleather_coat", [
    body("stagCoat", COAT, {
      texture: LEATHER,
      marks: rivets([0, -1.2, 7], [0, -1.2, -10], 9, "deep"),
    }),
    {
      name: "collar",
      material: "fur",
      texture: { amount: 0.14, cell: [1, 1, 1] },
      shapes: [
        { type: "ellipsoid", center: [-3.6, -0.6, 9.6], radii: [3.4, 1.8, 1.8] },
        { type: "ellipsoid", center: [3.6, -0.6, 9.6], radii: [3.4, 1.8, 1.8] },
      ],
    },
    ...belt("leather", 7.2, -2.4, "steel"),
  ]),
  // Band 4: an embersteel cuirass over hound hide, with pauldrons and an ember seam.
  model("armor/embersteel_cuirass", [
    body("darkIron", CUIRASS, {
      shiny: true,
      marks: [
        ...rivets([-5.4, -1.2, 5.4], [-5.4, -1.2, -6], 5, "light"),
        ...rivets([5.4, -1.2, 5.4], [5.4, -1.2, -6], 5, "light"),
      ],
      extra: [neck(3, 3, 10)],
    }),
    pauldrons("darkIron", 3.6),
    {
      name: "seam",
      material: "ember",
      glow: true,
      shapes: tube(
        onPlane(
          [
            [-5.6, -1.4],
            [0, -3],
            [5.6, -1.4],
          ],
          -1.35,
        ),
        0.55,
      ),
    },
    {
      name: "tassets",
      material: "darkIron",
      shiny: true,
      shapes: [
        plate(
          [
            [-6.6, -8],
            [-0.6, -8.6],
            [-0.8, -12],
            [-6, -11.4],
          ],
          0.8,
          { y0: -0.6, bulge: 0.3 },
        ),
        plate(
          [
            [6.6, -8],
            [0.6, -8.6],
            [0.8, -12],
            [6, -11.4],
          ],
          0.8,
          { y0: -0.6, bulge: 0.3 },
        ),
      ],
    },
  ]),
  // Band 5: wyrmling scales sewn over embersteel, gold at the collar and the hem.
  model("armor/wyrmscale_mail", [
    body("wyrmScale", COAT, {
      texture: { amount: 0.2, cell: [1.4, 1.4, 1.1] },
      extra: [neck(2.6, 3.4, 10.8)],
    }),
    {
      name: "trim",
      material: "gold",
      shiny: true,
      shapes: [
        ...tube(
          onPlane(
            [
              [-6.4, 9.4],
              [-2.6, 10.4],
              [0, 7],
              [2.6, 10.4],
              [6.4, 9.4],
            ],
            -1.2,
          ),
          0.6,
        ),
        { type: "box", min: [-8, -1.5, -11.8], max: [8, -0.6, -10.4] },
      ],
    },
    ...belt("darkIron", 7.2, -2.6, "gold"),
  ]),
  // Band 6: tidesteel plates over mail, layered pauldrons, a rune down the breastbone.
  model("armor/tidesteel_plate", [
    body("tidesteel", CUIRASS, { shiny: true, extra: [neck(3, 3, 10)] }),
    {
      name: "mail",
      material: "iron",
      texture: { amount: 0.18, cell: [0.7, 0.7, 0.7] },
      shapes: [
        plate(
          [
            [-7, -7.6],
            [7, -7.6],
            [7.6, -12],
            [-7.6, -12],
          ],
          0.8,
          { y0: 0.2 },
        ),
      ],
    },
    pauldrons("tidesteel", 3.9),
    {
      name: "pauldron_tops",
      material: "tidesteel",
      shiny: true,
      shapes: [
        { type: "ellipsoid", center: [-7.6, -0.8, 9.2], radii: [2.6, 2, 1.6] },
        { type: "ellipsoid", center: [7.6, -0.8, 9.2], radii: [2.6, 2, 1.6] },
      ],
    },
    {
      name: "rune",
      material: "rune",
      glow: true,
      shapes: [
        { type: "capsule", a: [0, -1.4, 5.4], b: [0, -1.4, -6.4], radius: 0.6 },
        { type: "capsule", a: [-2.6, -1.3, 0], b: [2.6, -1.3, 0], radius: 0.5 },
      ],
    },
  ]),
];

export const ROBES: SpriteSpec[] = [
  // Band 1: old linen with more patches than cloth, a rope belt.
  model("armor/patched_tunic", [
    body("cloth", TUNIC, { texture: CLOTH, extra: [neck(2.6, 3.6, 10.6)] }),
    {
      name: "patches",
      material: "leather",
      shapes: [
        plate(
          [
            [-5.6, -4],
            [-2, -4.4],
            [-2.2, -8],
            [-5.8, -7.6],
          ],
          0.4,
          { y0: -1.2 },
        ),
        plate(
          [
            [3.2, 6.6],
            [6, 6.2],
            [5.8, 3.6],
            [3.4, 3.8],
          ],
          0.4,
          { y0: -1.2, material: "sand" },
        ),
      ],
      marks: rivets([-5.4, -1.7, -4.4], [-2.4, -1.7, -4.6], 3, "deep"),
    },
    ...belt("rope", 7, -1.6),
  ]),
  // Band 3: forest moss spun with wool, wide sleeves, a rope belt.
  model("armor/mossweave_robe", [
    body("mossCloth", ROBE, { texture: CLOTH, extra: [neck(2.6, 4.6, 11.8)] }),
    hood("mossCloth"),
    ...belt("rope", 6.6, -1.6),
    hem("moss", 9.2, -13.2),
  ]),
  // Band 4: ash-grey cloth that does not burn, an ember-red hem and cuffs.
  model("armor/ashweave_robe", [
    body("ashCloth", ROBE, { texture: CLOTH, extra: [neck(2.6, 4.6, 11.8)] }),
    hood("ashCloth"),
    hem("cinder", 9.2, -13.2),
    {
      name: "cuffs",
      material: "cinder",
      shapes: [tubeOf([-11.8, -3.8], [-7.8, -4]), tubeOf([11.8, -3.8], [7.8, -4])].flat(),
    },
    ...belt("darkIron", 6.6, -1.6, "ember"),
  ]),
  // Band 5: cloth the colour of dusk, gold at the hem, the cuffs and the clasp.
  model("armor/duskweave_robe", [
    body("duskCloth", ROBE, { texture: CLOTH, extra: [neck(2.6, 4.6, 11.8)] }),
    hood("duskCloth"),
    hem("gold", 9.2, -13.2),
    {
      name: "cuffs",
      material: "gold",
      shiny: true,
      shapes: [tubeOf([-11.8, -3.8], [-7.8, -4]), tubeOf([11.8, -3.8], [7.8, -4])].flat(),
    },
    ...belt("gold", 6.6, -1.6, "wyrmScale"),
  ]),
  // Band 6: silk sewn with pearls, a hem of runes that glows faintly.
  model("armor/pearlweave_robe", [
    body("pearlCloth", ROBE, { texture: CLOTH, extra: [neck(2.6, 4.6, 11.8)] }),
    hood("pearlCloth"),
    hem("rune", 9.2, -13.2, true),
    {
      name: "pearls",
      material: "pearl",
      shiny: true,
      shapes: [5.4, 2.8, -4.6, -7.2, -9.8].map((z) => gem([0, -1.3, z], 0.85, 0.7)),
    },
    ...belt("tidesteel", 6.6, -1.6, "rune"),
  ]),
];

/** A short tube across [x, z] points in front of the body (a cuff). */
function tubeOf(a: readonly [number, number], b: readonly [number, number]): ShapeSpec[] {
  return [{ type: "capsule", a: [a[0], -0.9, a[1]], b: [b[0], -0.9, b[1]], radius: 0.9 }];
}

export const RETIRED_BODY: SpriteSpec[] = [
  // Boiled, hardened leather stitched by a harbour saddler.
  model("armor/leather_jerkin", [
    body("leather", VEST, {
      texture: LEATHER,
      marks: [
        ...rivets([-3.2, -1.2, 4], [-3.2, -1.2, -8], 7, "light", "rope"),
        ...rivets([3.2, -1.2, 4], [3.2, -1.2, -8], 7, "light", "rope"),
      ],
      extra: [neck(2.6, 4, 10.4)],
    }),
    ...belt("darkWood", 7, -3, "iron"),
  ]),
  // Light, supple hide with the fur still on.
  model("armor/hide_vest", [
    body("fur", VEST, {
      texture: { amount: 0.16, cell: [0.8, 1, 2] },
      extra: [neck(3, 5, 10.4)],
    }),
    {
      name: "lacing",
      material: "leather",
      shapes: [
        { type: "capsule", a: [-1.6, -1.3, 3], b: [1.6, -1.3, 1.6], radius: 0.45 },
        { type: "capsule", a: [-1.6, -1.3, 0], b: [1.6, -1.3, -1.4], radius: 0.45 },
      ],
    },
  ]),
];

// ---- Head -----------------------------------------------------------------------------

/** A dome: the top of a helm or a cap, with its lower half hidden behind a front piece. */
const dome = (rx: number, rz: number, z = 0): ShapeSpec => ({
  type: "ellipsoid",
  center: [0, 0, z],
  radii: [rx, rx * 0.9, rz],
});

/**
 * How far in front of a helm's centre its visor or band sits: in front of the dome (radius
 * 8 across, so 7.2 deep), which would otherwise bulge through it.
 */
const VISOR_Y = -7;
/** The front face of a visor (VISOR_Y less its half-thickness): marks and slits go on it. */
const VISOR_FACE = VISOR_Y - 1.2;

/** A front plate covering the lower half of a dome: a band, a face guard. */
const front = (
  outline: Profile,
  look: { bias?: number; material?: MaterialName } = {},
): ShapeSpec => plate(outline, 1.2, { y0: VISOR_Y, bulge: 0.5, ...look });

export const HELMS: SpriteSpec[] = [
  // Band 1: a cap sewn from old sailcloth, its brim folded up.
  model("armor/sailcloth_cap", [
    {
      name: "dome",
      material: "cloth",
      bias: -0.08,
      texture: CLOTH,
      shapes: [dome(8.4, 7.4, -1)],
      marks: rivets([0, -7, 4.6], [0, -7.8, 1.2], 4, "shadow"),
    },
    {
      name: "brim",
      material: "cloth",
      bias: 0.06,
      shapes: [
        plate(
          [
            [-9.2, -1.4],
            [9.2, -1.4],
            [9.4, -5.6],
            [-9.4, -5.6],
          ],
          1.2,
          { y0: VISOR_Y - 0.4, bulge: 0.5 },
        ),
      ],
    },
    {
      name: "tassel",
      material: "redCloth",
      shapes: [gem([0, -1.6, 6.6], 1.6, 1.4)],
    },
  ]),
  // Band 3: a stag-leather hood lined with wool, its face opening and a short cape.
  model("armor/stagleather_hood", [
    {
      name: "hood",
      material: "stagCoat",
      texture: LEATHER,
      shapes: [
        { type: "ellipsoid", center: [0, 0, 2], radii: [7.6, 7, 8.6] },
        { type: "capsule", a: [0, 2, 7.4], b: [2.8, 4.6, 10.4], radius: 3, radius2: 0.6 },
      ],
    },
    {
      name: "opening",
      material: "stagCoat",
      bias: -1,
      shapes: [plate(ellipse(0, 0.6, 4.4, 5.2, 16), 0.5, { y0: -6.6 })],
    },
    {
      name: "lining",
      material: "cloth",
      shapes: [tubeLoop(0, 0.6, 4.9, 5.7, -6.4, 0.75)].flat(),
    },
    {
      name: "cape",
      material: "stagCoat",
      texture: LEATHER,
      shapes: [
        plate(
          mirrored([
            [0, -4],
            [6, -4],
            [10, -10],
            [0, -11],
          ]),
          1.4,
          { y0: -3.4, bulge: 0.45 },
        ),
      ],
    },
  ]),
  // Band 4: a closed embersteel helm, narrow slits against the sparks glowing within.
  model("armor/embersteel_helm", [
    {
      name: "dome",
      material: "darkIron",
      shiny: true,
      shapes: [dome(8.2, 9, 0)],
      marks: rivets([-5, -6.4, 2.2], [5, -6.4, 2.2], 5, "light"),
    },
    {
      name: "visor",
      material: "darkIron",
      shiny: true,
      shapes: [
        front(
          mirrored([
            [0, 1],
            [7.6, 0.6],
            [7.2, -7],
            [4, -10.4],
            [0, -11],
          ]),
        ),
        // A ridge down the middle.
        {
          type: "box",
          min: [-0.7, VISOR_FACE - 0.6, -9],
          max: [0.7, VISOR_FACE + 0.2, 0.6],
          bias: 0.15,
        },
      ],
    },
    {
      name: "slits",
      material: "ember",
      glow: true,
      shapes: [
        { type: "box", min: [-6, VISOR_FACE - 0.4, -3.2], max: [-1.6, VISOR_FACE + 0.2, -2.2] },
        { type: "box", min: [1.6, VISOR_FACE - 0.4, -3.2], max: [6, VISOR_FACE + 0.2, -2.2] },
      ],
    },
  ]),
  // Band 5: a jade-scaled helm crowned with two wyrmling horns, rimmed in gold.
  model("armor/wyrmcrest_helm", [
    {
      name: "dome",
      material: "wyrmScale",
      texture: { amount: 0.18, cell: [1.4, 1.4, 1.1] },
      shapes: [dome(8, 8.4, -1)],
    },
    {
      name: "rim",
      material: "gold",
      shiny: true,
      shapes: [
        front(
          mirrored([
            [0, -0.6],
            [8.4, -1],
            [8.6, -3.6],
            [6, -8.6],
            [0, -9.6],
          ]),
        ),
      ],
    },
    {
      name: "face",
      material: "wyrmScale",
      bias: -1,
      shapes: [
        plate(
          mirrored([
            [0, -2.6],
            [5.6, -2.6],
            [4.6, -6.2],
            [0, -8],
          ]),
          0.5,
          { y0: VISOR_FACE - 0.3 },
        ),
      ],
    },
    {
      name: "horns",
      material: "bone",
      shapes: [
        ...tube(
          onPlane(
            [
              [-6, 4],
              [-10.4, 7.6],
              [-11.4, 12.4],
            ],
            0,
          ),
          1.8,
          0.5,
        ),
        ...tube(
          onPlane(
            [
              [6, 4],
              [10.4, 7.6],
              [11.4, 12.4],
            ],
            0,
          ),
          1.8,
          0.5,
        ),
      ],
    },
  ]),
  // Band 6: a closed tidesteel helm shaped like a conch, its visor slit glowing with runes.
  model("armor/tidesteel_helm", [
    {
      name: "dome",
      material: "tidesteel",
      shiny: true,
      shapes: [
        dome(8, 8.4, 0),
        // The conch's spire, curling up to the right.
        { type: "capsule", a: [0, 0, 5], b: [4.4, 1, 10.4], radius: 3.4, radius2: 0.7 },
      ],
    },
    {
      name: "whorls",
      material: "tidesteel",
      bias: -0.4,
      shapes: tube(onPlane(arc(0.6, 4.4, 6.4, 4.4, 160, 20, 8), -6.2), 0.5),
    },
    {
      name: "visor",
      material: "tidesteel",
      shiny: true,
      shapes: [
        front(
          mirrored([
            [0, 0.6],
            [7.6, 0.2],
            [7.4, -6.6],
            [4.2, -10.6],
            [0, -11.6],
          ]),
        ),
      ],
    },
    {
      name: "slit",
      material: "rune",
      glow: true,
      shapes: [
        { type: "box", min: [-6, VISOR_FACE - 0.4, -3.4], max: [6, VISOR_FACE + 0.2, -2.2] },
      ],
    },
    {
      name: "pearl",
      material: "pearl",
      shiny: true,
      shapes: [gem([0, VISOR_FACE, -7.4], 1.2, 0.8)],
    },
  ]),
];

/** A ring of capsules around an ellipse in the x-z plane at y (a lining, a rune circle). */
function tubeLoop(
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  y: number,
  r: number,
): ShapeSpec[] {
  const pts = arc(cx, cz, rx, rz, 0, 360, 16).map(([x, z]): Vec3 => [x, y, z]);
  return tube(pts, r);
}

// ---- Legs -----------------------------------------------------------------------------

/** One leg of a pair, from the waist to the ankle; side -1 is the left leg. */
const leg = (side: -1 | 1, flare = 0): Profile => {
  const s = side;
  return [
    [s * 0.4, 9.4],
    [s * 7, 9.4],
    [s * (6.6 + flare), -11],
    [s * (1.4 - flare * 0.3), -11],
    [s * 0.8, 2],
  ];
};

interface LegsLook {
  sprite: string;
  material: MaterialName;
  texture?: PartSpec["texture"];
  shiny?: boolean;
  waist: MaterialName;
  buckle?: MaterialName;
  /** Knee pieces (patches, cops) and shin plates. */
  knees?: { material: MaterialName; shiny?: boolean; glow?: boolean; r: number };
  shins?: { material: MaterialName; shiny?: boolean };
  accent?: Piece;
  flare?: number;
}

function legs(l: LegsLook): SpriteSpec {
  const pieces: Piece[] = [
    {
      name: "legs",
      material: l.material,
      ...(l.texture && { texture: l.texture }),
      ...(l.shiny && { shiny: true }),
      shapes: [
        plate(leg(-1, l.flare), 1.4, { bulge: 0.45 }),
        plate(leg(1, l.flare), 1.4, { bulge: 0.45, bias: -0.06 }),
      ],
    },
    ...belt(l.waist, 7.4, 8.6, l.buckle),
  ];
  if (l.shins)
    pieces.push({
      name: "shins",
      material: l.shins.material,
      ...(l.shins.shiny && { shiny: true }),
      shapes: [-1, 1].map((s) =>
        plate(
          [
            [s * 1.6, -2],
            [s * 6.4, -2],
            [s * 6.2, -10.4],
            [s * 2, -10.4],
          ],
          0.8,
          { y0: -1.4, bulge: 0.5 },
        ),
      ),
    });
  const knees = l.knees;
  if (knees)
    pieces.push({
      name: "knees",
      material: knees.material,
      ...(knees.shiny && { shiny: true }),
      ...(knees.glow && { glow: true }),
      shapes: [-1, 1].map((s) => gem([s * 3.9, -1.9, -0.6], knees.r, knees.r * 0.6)),
    });
  if (l.accent) pieces.push(l.accent);
  return model(l.sprite, pieces);
}

export const LEGS: SpriteSpec[] = [
  // Band 1: thick canvas trousers patched at the knee.
  legs({
    sprite: "armor/canvas_trousers",
    material: "cloth",
    texture: CLOTH,
    waist: "rope",
    knees: { material: "leather", r: 2 },
  }),
  // Band 3: stag-leather leggings, laced at the side, a steel buckle.
  legs({
    sprite: "armor/stagleather_leggings",
    material: "stagCoat",
    texture: LEATHER,
    waist: "leather",
    buckle: "steel",
    accent: {
      name: "laces",
      material: "rope",
      shapes: [],
      marks: [
        ...rivets([-6.4, -1.5, 5], [-6, -1.5, -8], 7, "light"),
        ...rivets([6.4, -1.5, 5], [6, -1.5, -8], 7, "light"),
      ],
    },
  }),
  // Band 4: embersteel greaves and knee cops over hound-leather leggings.
  legs({
    sprite: "armor/embersteel_greaves",
    material: "leather",
    texture: LEATHER,
    waist: "darkIron",
    buckle: "ember",
    shins: { material: "darkIron", shiny: true },
    knees: { material: "darkIron", shiny: true, r: 2.6 },
    accent: {
      name: "embers",
      material: "ember",
      glow: true,
      shapes: [-1, 1].map((s) => gem([s * 3.9, -3.6, -0.6], 0.8, 0.5)),
    },
  }),
  // Band 5: wyrmling hide hardened in fire, gold at the knees.
  legs({
    sprite: "armor/wyrmhide_greaves",
    material: "wyrmScale",
    texture: { amount: 0.18, cell: [1.4, 1.4, 1.1] },
    waist: "darkIron",
    buckle: "gold",
    knees: { material: "gold", shiny: true, r: 2.4 },
  }),
  // Band 6: tidesteel greaves, cold even in the sun, runes at the knees.
  legs({
    sprite: "armor/tidesteel_greaves",
    material: "blueCloth",
    texture: CLOTH,
    waist: "tidesteel",
    buckle: "pearl",
    shins: { material: "tidesteel", shiny: true },
    knees: { material: "tidesteel", shiny: true, r: 2.7 },
    accent: {
      name: "runes",
      material: "rune",
      glow: true,
      shapes: [-1, 1].map((s): ShapeSpec => ({
        type: "capsule",
        a: [s * 4, -2.4, -4],
        b: [s * 4, -2.4, -9],
        radius: 0.5,
      })),
    },
  }),
];

// ---- Feet -----------------------------------------------------------------------------

interface BootsLook {
  sprite: string;
  material: MaterialName;
  texture?: PartSpec["texture"];
  shiny?: boolean;
  sole: MaterialName;
  /** Shaft height above the ankle. */
  tall: number;
  /** A turned-down cuff, bands around the shaft, a buckle. */
  cuff?: MaterialName;
  bands?: { material: MaterialName; at: readonly number[]; shiny?: boolean; glow?: boolean };
  toe?: { material: MaterialName; shiny?: boolean };
}

/** A pair of boots seen from the side, toes to the left: the near one in front, left. */
function boots(l: BootsLook): SpriteSpec {
  const boot = (name: string, d: Vec3): Piece[] => {
    const at = (shapes: ShapeSpec[]): ShapeSpec[] => shapes.map((sh) => moved(sh, d));
    const out: Piece[] = [
      {
        name,
        material: l.material,
        ...(l.texture && { texture: l.texture }),
        ...(l.shiny && { shiny: true }),
        ...(d[1] > 0 && { bias: -0.08 }),
        shapes: at([
          // The shaft, and the foot from the heel to the toe.
          { type: "capsule", a: [1, 0, -4], b: [1.2, 0, l.tall], radius: 3, radius2: 3.2 },
          { type: "ellipsoid", center: [-2.2, 0, -5.2], radii: [5.4, 2.9, 2.6] },
        ]),
      },
      {
        name: `${name}_sole`,
        material: l.sole,
        shapes: at([{ type: "box", min: [-7.4, -2.6, -8.4], max: [4.2, 2.6, -7] }]),
      },
    ];
    if (l.cuff)
      out.push({
        name: `${name}_cuff`,
        material: l.cuff,
        shapes: at([
          { type: "cylinder", a: [1.2, 0, l.tall - 1.8], b: [1.2, 0, l.tall + 0.6], radius: 3.7 },
        ]),
      });
    if (l.bands)
      out.push({
        name: `${name}_bands`,
        material: l.bands.material,
        ...(l.bands.shiny && { shiny: true }),
        ...(l.bands.glow && { glow: true }),
        shapes: at(
          l.bands.at.map((z): ShapeSpec => ({
            type: "cylinder",
            a: [1.1, 0, z - 0.55],
            b: [1.1, 0, z + 0.55],
            radius: 3.45,
          })),
        ),
      });
    if (l.toe)
      out.push({
        name: `${name}_toe`,
        material: l.toe.material,
        ...(l.toe.shiny && { shiny: true }),
        shapes: at([{ type: "ellipsoid", center: [-5, 0, -5.4], radii: [2.8, 3.1, 2.5] }]),
      });
    return out;
  };
  // The near boot (in front, to the left) is the root; the far one stands behind it.
  return model(l.sprite, [...boot("near", [-3.2, -2.4, 0]), ...boot("far", [3.4, 2.6, 0])]);
}

export const FEET: SpriteSpec[] = [
  // Band 1: leather boots smeared with tar against the salt.
  boots({
    sprite: "armor/tarred_boots",
    material: "tar",
    texture: LEATHER,
    sole: "darkWood",
    tall: 3,
  }),
  // Band 3: tall stag-leather boots with a double sole and a turned-down cuff.
  boots({
    sprite: "armor/stagleather_boots",
    material: "stagCoat",
    texture: LEATHER,
    sole: "leather",
    tall: 5,
    cuff: "stagBelly",
  }),
  // Band 4: jointed embersteel sabatons, an ember seam at the ankle.
  boots({
    sprite: "armor/embersteel_sabatons",
    material: "darkIron",
    shiny: true,
    sole: "darkIron",
    tall: 4,
    bands: { material: "ember", at: [-1.6], glow: true },
    toe: { material: "darkIron", shiny: true },
  }),
  // Band 5: tall wyrmling-hide boots with gold buckles.
  boots({
    sprite: "armor/wyrmhide_boots",
    material: "wyrmScale",
    texture: { amount: 0.18, cell: [1.4, 1.4, 1.1] },
    sole: "darkIron",
    tall: 5,
    bands: { material: "gold", at: [-0.6, 3.4], shiny: true },
  }),
  // Band 6: jointed tidesteel sabatons, runes at the ankle.
  boots({
    sprite: "armor/tidesteel_sabatons",
    material: "tidesteel",
    shiny: true,
    sole: "drownwood",
    tall: 4.6,
    bands: { material: "rune", at: [-1.4], glow: true },
    toe: { material: "tidesteel", shiny: true },
  }),
];

export const ARMOR_ICONS: SpriteSpec[] = [
  ...SHIELDS,
  ...HEAVY_TORSO,
  ...ROBES,
  ...HELMS,
  ...LEGS,
  ...FEET,
  ...RETIRED_SHIELDS,
  ...RETIRED_BODY,
];
