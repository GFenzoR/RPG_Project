// Weapon icons (docs/17 "Íconos de items"): the seven weapon lines of the catalog by level
// band, plus the retired pieces that stay in old inventories. Each weapon is built along +z
// (grip at the bottom, head at the top) and leans on the diagonal (kit.ts `lean`), its -x
// side (an axe's bit, a bow's back) toward the top left, where the light comes from.
import type { MaterialName } from "../../../palette.ts";
import type { Vec3 } from "../../math.ts";
import type { MarkSpec, PartSpec, ShapeSpec, SpriteSpec } from "../../spec.ts";
import { arc, blade, gem, icon, lean, onPlane, plate, resized, rivets, tube } from "./kit.ts";

/** A wrapped grip: bands across the handle. */
const WRAP = { amount: 0.22, cell: [6, 6, 0.9] } as const;
/** Wood grain along a haft. */
const GRAIN = { amount: 0.08, cell: [0.8, 0.8, 4] } as const;

// ---- Swords ---------------------------------------------------------------------------

interface SwordLook {
  sprite: string;
  /** Blade length, its half-width at the guard and how much of it is the tapered tip. */
  length: number;
  width: number;
  tip: number;
  /** Where the tip ends up across the blade (+x bends toward the edge, the shaded side). */
  curve?: number;
  /** The blade grows this much wider toward the tip (a sabre's belly). */
  swell?: number;
  blade: MaterialName;
  /** Light added to the blade (a dull, pitted one is darker). */
  bladeBias?: number;
  /** A line down the blade (a rune that glows, or a dark groove). */
  fuller?: { material: MaterialName; glow?: boolean };
  /** A glowing edge (embersteel never quite cools down). */
  edge?: MaterialName;
  /** Spots on the blade: rust on the cutlass. */
  spots?: { material: MaterialName; at: [number, number][] };
  guard: { material: MaterialName; span: number; kind: "bar" | "disc" | "shell" | "horns" };
  grip: { material: MaterialName; length: number };
  pommel: { material: MaterialName; r: number; shiny?: boolean };
  /** A stone set in the guard. */
  stone?: { material: MaterialName; glow?: boolean };
}

/** The centre line and half-widths of a blade. */
function bladeLine(l: SwordLook): { line: [number, number][]; half: number[] } {
  const zs: number[] = [];
  const body = l.length - l.tip;
  for (let i = 0; i <= 5; i++) zs.push(0.5 + ((body - 0.5) * i) / 5);
  zs.push(body + l.tip * 0.5, l.length);
  const line = zs.map((z): [number, number] => [(l.curve ?? 0) * (z / l.length) ** 2, z]);
  const half = zs.map((z, i) => {
    if (i === zs.length - 1) return 0;
    const w = l.width * (1 + ((l.swell ?? 0) * z) / l.length);
    return z <= body ? w : w * (1 - (z - body) / l.tip) * 1.1;
  });
  return { line, half };
}

/** Spots on a blade: [across, along (0..1)] to marks on its face. */
function spots(
  material: MaterialName,
  at: readonly (readonly [number, number])[],
  centre: (i: number) => [number, number],
  n: number,
): MarkSpec[] {
  return at.map(([u, v]): MarkSpec => {
    const [x, z] = centre(Math.round(v * (n - 1)));
    return { at: [x + u, -0.75, z], tone: "base", material };
  });
}

function sword(l: SwordLook): SpriteSpec {
  const { line, half } = bladeLine(l);
  const at = (i: number): [number, number] => line[i] ?? [0, 0];
  const parts: PartSpec[] = [
    lean({
      name: "grip",
      material: l.grip.material,
      texture: WRAP,
      shapes: [{ type: "capsule", a: [0, 0, -1], b: [0, 0, -l.grip.length], radius: 1.2 }],
    }),
    {
      name: "blade",
      parent: "grip",
      material: l.blade,
      shiny: true,
      ...(l.bladeBias !== undefined && { bias: l.bladeBias }),
      shapes: blade(line, half, 0.7),
      ...(l.spots && { marks: spots(l.spots.material, l.spots.at, at, line.length) }),
    },
  ];
  if (l.fuller) {
    const groove = line.slice(1, -2).map(([x, z]): Vec3 => [x, -0.75, z]);
    parts.push({
      name: "fuller",
      parent: "grip",
      material: l.fuller.material,
      ...(l.fuller.glow && { glow: true }),
      shapes: tube(groove, 0.45),
    });
  }
  if (l.edge) {
    const edge = line
      .slice(1, -1)
      .map(([x, z], i): Vec3 => [x + (half[i + 1] ?? 0) - 0.5, -0.6, z]);
    parts.push({
      name: "edge",
      parent: "grip",
      material: l.edge,
      glow: true,
      shapes: tube(edge, 0.5),
    });
  }
  const g = l.guard;
  const guardShapes: ShapeSpec[] =
    g.kind === "bar"
      ? [{ type: "capsule", a: [-g.span, 0, 0], b: [g.span, 0, 0], radius: 1.25 }]
      : g.kind === "disc"
        ? [{ type: "ellipsoid", radii: [g.span, 1.6, 1.5] }]
        : g.kind === "shell"
          ? [
              { type: "ellipsoid", center: [0.6, 0, 0], radii: [g.span, 1.8, 1.7] },
              // The knuckle bow down to the pommel, on the edge side.
              ...tube(
                onPlane(
                  arc(
                    0,
                    -l.grip.length / 2 - 0.4,
                    g.span - 0.6,
                    l.grip.length / 2 + 0.6,
                    80,
                    -80,
                    6,
                  ),
                ),
                0.65,
              ),
            ]
          : // Horns: two fangs curling up along the blade.
            [
              ...tube(
                onPlane([
                  [0, 0],
                  [-g.span * 0.7, 0.4],
                  [-g.span, 2.4],
                  [-g.span * 0.75, 4.6],
                ]),
                1.2,
                0.55,
              ),
              ...tube(
                onPlane([
                  [0, 0],
                  [g.span * 0.7, 0.4],
                  [g.span, 2.4],
                  [g.span * 0.75, 4.6],
                ]),
                1.2,
                0.55,
              ),
            ];
  parts.push({
    name: "guard",
    parent: "grip",
    material: g.material,
    shiny: true,
    shapes: guardShapes,
  });
  if (l.stone)
    parts.push({
      name: "stone",
      parent: "grip",
      material: l.stone.material,
      ...(l.stone.glow ? { glow: true } : { shiny: true }),
      shapes: [gem([0, -1.3, 0], 1.15)],
    });
  parts.push({
    name: "pommel",
    parent: "grip",
    material: l.pommel.material,
    ...(l.pommel.shiny !== false && { shiny: true }),
    shapes: [gem([0, 0, -l.grip.length - l.pommel.r * 0.7], l.pommel.r, l.pommel.r)],
  });
  return icon(l.sprite, parts);
}

export const SWORDS: SpriteSpec[] = [
  // Band 1: a short curved cutlass, its iron pitted with rust, a plain disc guard.
  sword({
    sprite: "weapons/rusty_cutlass",
    length: 21,
    width: 1.8,
    tip: 6,
    curve: 3,
    swell: 0.45,
    blade: "iron",
    bladeBias: -0.12,
    spots: {
      material: "rust",
      at: [
        [-0.6, 0.2],
        [0.7, 0.35],
        [-0.2, 0.5],
        [0.9, 0.62],
        [0.3, 0.75],
      ],
    },
    guard: { material: "rust", span: 3, kind: "disc" },
    grip: { material: "darkWood", length: 6 },
    pommel: { material: "rust", r: 1.4 },
  }),
  // Band 2: a straight iron sword with a cross bar and a groove down the blade.
  sword({
    sprite: "weapons/iron_sword",
    length: 23,
    width: 1.7,
    tip: 4.5,
    blade: "iron",
    fuller: { material: "darkIron" },
    guard: { material: "iron", span: 4.6, kind: "bar" },
    grip: { material: "leather", length: 6 },
    pommel: { material: "iron", r: 1.7 },
  }),
  // Band 3: a short, heavy steel saber with a shell guard and a knuckle bow.
  sword({
    sprite: "weapons/boarding_saber",
    length: 21,
    width: 2,
    tip: 6,
    curve: 2.4,
    swell: 0.25,
    blade: "steel",
    guard: { material: "steel", span: 3.4, kind: "shell" },
    grip: { material: "leather", length: 6 },
    pommel: { material: "steel", r: 1.5 },
  }),
  // Band 4: a long curved embersteel sabre with its edge still glowing.
  sword({
    sprite: "weapons/embersteel_sabre",
    length: 22.5,
    width: 1.9,
    tip: 7,
    curve: 3.4,
    swell: 0.3,
    blade: "darkIron",
    bladeBias: 0.08,
    edge: "ember",
    guard: { material: "darkIron", span: 4.4, kind: "bar" },
    stone: { material: "ember", glow: true },
    grip: { material: "redCloth", length: 6 },
    pommel: { material: "darkIron", r: 1.7 },
  }),
  // Band 5: a blade curved like a fang in a gold guard of two horns, a jade grip.
  sword({
    sprite: "weapons/wyrmfang_blade",
    length: 22.5,
    width: 2.1,
    tip: 8,
    curve: -3.2,
    swell: 0.35,
    blade: "bone",
    fuller: { material: "steel" },
    guard: { material: "gold", span: 3.8, kind: "horns" },
    stone: { material: "wyrmScale" },
    grip: { material: "wyrmScale", length: 6 },
    pommel: { material: "gold", r: 1.7 },
  }),
  // Band 6: a long tidesteel sword, a rune glowing down its fuller, a pearl pommel.
  sword({
    sprite: "weapons/tidesteel_sword",
    length: 25,
    width: 2,
    tip: 5,
    blade: "tidesteel",
    bladeBias: -0.05,
    fuller: { material: "rune", glow: true },
    guard: { material: "tidesteel", span: 3.8, kind: "horns" },
    stone: { material: "rune", glow: true },
    grip: { material: "blueCloth", length: 6 },
    pommel: { material: "pearl", r: 1.9 },
  }),
];

/** Retired swords (docs/02 "Retirados"): still in old inventories. */
export const RETIRED_SWORDS: SpriteSpec[] = [
  // A short hand-forged iron blade.
  sword({
    sprite: "weapons/forged_shortsword",
    length: 17,
    width: 1.9,
    tip: 4,
    blade: "iron",
    guard: { material: "iron", span: 3.6, kind: "bar" },
    grip: { material: "wood", length: 5.5 },
    pommel: { material: "iron", r: 1.5 },
  }),
  // Steel tempered with thorn sap, a grip of living thornwood.
  sword({
    sprite: "weapons/thornwood_blade",
    length: 20,
    width: 1.9,
    tip: 5,
    curve: 1.2,
    blade: "steel",
    fuller: { material: "thornWood" },
    guard: { material: "thornWood", span: 3.2, kind: "horns" },
    grip: { material: "thornWood", length: 6 },
    pommel: { material: "thornWood", r: 1.5, shiny: false },
  }),
];

// ---- Hafted weapons: axes and maces ---------------------------------------------------

interface Haft {
  material: MaterialName;
  /** From the butt (z = -low) to the top (z = high). */
  low: number;
  high: number;
  radius?: number;
  /** A wrapped grip at the butt. */
  wrap?: MaterialName;
  /** Bands around the haft (z positions). */
  bands?: { material: MaterialName; at: readonly number[] };
  /** A knob at the butt. */
  butt?: MaterialName;
  grain?: boolean;
}

/** A haft leaning on the diagonal, with the head's parts hanging from it. */
function hafted(
  sprite: string,
  h: Haft,
  head: readonly Omit<PartSpec, "parent">[],
  scale = 1,
): SpriteSpec {
  const r = h.radius ?? 1.1;
  const parts: PartSpec[] = [
    lean({
      name: "haft",
      material: h.material,
      ...(h.grain !== false && { texture: GRAIN }),
      shapes: [{ type: "capsule", a: [0, 0, -h.low], b: [0, 0, h.high], radius: r }],
    }),
  ];
  if (h.wrap)
    parts.push({
      name: "wrap",
      parent: "haft",
      material: h.wrap,
      texture: WRAP,
      shapes: [{ type: "capsule", a: [0, 0, -h.low + 1], b: [0, 0, -h.low + 7], radius: r + 0.25 }],
    });
  if (h.bands)
    parts.push({
      name: "bands",
      parent: "haft",
      material: h.bands.material,
      shiny: true,
      shapes: h.bands.at.map((z): ShapeSpec => ({
        type: "cylinder",
        a: [0, 0, z - 0.6],
        b: [0, 0, z + 0.6],
        radius: r + 0.35,
      })),
    });
  if (h.butt)
    parts.push({
      name: "butt",
      parent: "haft",
      material: h.butt,
      shiny: true,
      shapes: [gem([0, 0, -h.low - 0.4], r + 0.6, r + 0.6)],
    });
  for (const p of head) parts.push({ ...p, parent: "haft" });
  return icon(sprite, parts, { scale });
}

/** An axe head: the cheek plate, its honed (or glowing) edge, an optional back spike. */
function axeHead(
  metal: MaterialName,
  cheek: readonly (readonly [number, number])[],
  edge: readonly (readonly [number, number])[],
  look: { edge?: MaterialName; glow?: boolean; back?: readonly (readonly [number, number])[] } = {},
): Omit<PartSpec, "parent">[] {
  const parts: Omit<PartSpec, "parent">[] = [
    {
      name: "head",
      material: metal,
      shiny: true,
      shapes: [
        plate(cheek, 1.1, { bulge: 0.45 }),
        ...(look.back ? [plate(look.back, 0.9, { bulge: 0.3 })] : []),
      ],
    },
    {
      name: "edge",
      material: look.edge ?? metal,
      ...(look.glow ? { glow: true } : { shiny: true, bias: 0.32 }),
      shapes: [plate(edge, 1.15, { y0: -0.05, bulge: 0.3 })],
    },
  ];
  return parts;
}

/** Every axe at 0.9 times the size it is built at: the heads are big for their hafts. */
export const AXES: SpriteSpec[] = [
  // Band 1: a short hand axe, a small rusty head on a plain haft.
  hafted("weapons/hatchet", { material: "wood", low: 14, high: 13 }, [
    ...axeHead(
      "rust",
      [
        [1.9, 12.5],
        [1.9, 8.5],
        [-2, 8.8],
        [-4.8, 7.2],
        [-6.8, 6.6],
        [-7.3, 10.2],
        [-6.8, 13.6],
        [-4.4, 12.9],
        [-2, 12.4],
      ],
      [
        [-5.6, 7.1],
        [-6.8, 6.6],
        [-7.3, 10.2],
        [-6.8, 13.6],
        [-5.6, 13.1],
        [-6.1, 10.2],
      ],
      { edge: "iron" },
    ),
  ]),
  // Band 2: a thick iron head on a pale birch haft.
  hafted("weapons/forged_axe", { material: "wood", low: 14, high: 13.5, radius: 1.2 }, [
    ...axeHead(
      "iron",
      [
        [2.2, 13.4],
        [2.2, 8],
        [-2, 8],
        [-4.6, 6.2],
        [-8, 5.4],
        [-8.6, 10.2],
        [-8, 15],
        [-4.4, 14.2],
        [-2, 13.4],
      ],
      [
        [-6.8, 5.8],
        [-8, 5.4],
        [-8.6, 10.2],
        [-8, 15],
        [-6.8, 14.6],
        [-7.3, 10.2],
      ],
    ),
  ]),
  // Band 3: a steel head with a long beard that hooks shields, a leather-wrapped haft.
  hafted("weapons/bearded_axe", { material: "darkWood", low: 14, high: 14, wrap: "leather" }, [
    ...axeHead(
      "steel",
      [
        [2, 13.6],
        [2, 9.4],
        [-1.4, 9.4],
        [-3.2, 6.4],
        [-5.4, 2.6],
        [-8.6, 1.6],
        [-9.2, 6.4],
        [-8.8, 11.6],
        [-7.6, 15.2],
        [-4.4, 14.2],
        [-1.6, 13.6],
      ],
      [
        [-7.4, 2],
        [-8.6, 1.6],
        [-9.2, 6.4],
        [-8.8, 11.6],
        [-7.6, 15.2],
        [-6.6, 14.6],
        [-7.6, 11.4],
        [-8, 6.4],
      ],
    ),
  ]),
  // Band 4: a broad embersteel crescent with a back spike, its edge glowing, iron bands.
  hafted(
    "weapons/embersteel_axe",
    { material: "darkWood", low: 14, high: 14.5, bands: { material: "darkIron", at: [-12, 4] } },
    [
      ...axeHead(
        "darkIron",
        [
          [2.2, 14],
          [2.2, 8.4],
          [-2, 8],
          [-5, 4.2],
          [-9, 2.6],
          [-10, 9.2],
          [-9, 16],
          [-5, 14.8],
          [-2, 14],
        ],
        [
          [-7.6, 3],
          [-9, 2.6],
          [-10, 9.2],
          [-9, 16],
          [-7.6, 15.4],
          [-8.6, 9.2],
        ],
        {
          edge: "ember",
          glow: true,
          back: [
            [2, 12.6],
            [6.4, 11],
            [2, 9.6],
          ],
        },
      ),
    ],
  ),
  // Band 5: a steel crescent set in a wyrmling bone haft, a gold collar and a jade grip.
  hafted(
    "weapons/wyrmbone_axe",
    {
      material: "bone",
      low: 14,
      high: 14.5,
      wrap: "wyrmScale",
      bands: { material: "gold", at: [6.6, 15] },
      grain: false,
    },
    [
      ...axeHead(
        "steel",
        [
          [2, 14.2],
          [2, 8.6],
          [-3, 8.2],
          [-6, 4],
          [-9.6, 2.2],
          [-10.2, 9.4],
          [-9.6, 16.6],
          [-6, 14.8],
          [-3, 14.2],
        ],
        [
          [-8.2, 2.6],
          [-9.6, 2.2],
          [-10.2, 9.4],
          [-9.6, 16.6],
          [-8.2, 15.9],
          [-8.8, 9.4],
        ],
        { edge: "gold" },
      ),
    ],
  ),
  // Band 6: a broad double-bit tidesteel head with a rune down its cheek, a drownwood haft.
  hafted(
    "weapons/tidesteel_axe",
    { material: "drownwood", low: 12, high: 15, butt: "pearl", wrap: "blueCloth" },
    [
      ...axeHead(
        "tidesteel",
        [
          [2, 13.8],
          [2, 8.2],
          [-2, 8.2],
          [-5.6, 4.4],
          [-10, 2.6],
          [-10.6, 9.6],
          [-10, 16.2],
          [-5.6, 14.8],
          [-2, 13.8],
        ],
        [
          [-8.6, 3.1],
          [-10, 2.6],
          [-10.6, 9.6],
          [-10, 16.2],
          [-8.6, 15.6],
          [-9.2, 10.2],
        ],
        {
          // A back spike curling like a breaking wave.
          back: [
            [2, 13.2],
            [5, 14.6],
            [7.4, 13.4],
            [6, 12.2],
            [4.6, 12.8],
            [3.8, 10.4],
            [2, 9.4],
          ],
        },
      ),
      {
        name: "rune",
        material: "rune",
        glow: true,
        shapes: tube(
          onPlane(
            [
              [-7.4, 6.4],
              [-6, 10.4],
              [-7.4, 14.2],
            ],
            -1.25,
          ),
          0.5,
        ),
      },
    ],
  ),
].map((s) => resized(s, 0.9));

/** A flanged mace head: a core with four fins around it (two seen edge-on to the sides). */
function flangedHead(
  metal: MaterialName,
  z0: number,
  z1: number,
  reach: number,
  core?: MaterialName,
): Omit<PartSpec, "parent">[] {
  const fin = (s: number): readonly (readonly [number, number])[] => [
    [s * 1.4, z0],
    [s * reach, z0 + 2],
    [s * reach, z1 - 1.6],
    [s * 1.4, z1],
  ];
  const parts: Omit<PartSpec, "parent">[] = [
    {
      name: "head",
      material: metal,
      shiny: true,
      shapes: [
        { type: "cylinder", a: [0, 0, z0], b: [0, 0, z1], radius: 2.2 },
        plate(fin(-1), 0.75, { bulge: 0.3 }),
        plate(fin(1), 0.75, { bulge: 0.3 }),
        // The fin toward the camera, seen face-on as a ridge down the middle.
        {
          type: "extrusion",
          axis: "x",
          from: -0.7,
          to: 0.7,
          points: [
            [-1.4, z0],
            [-reach + 0.8, z0 + 2],
            [-reach + 0.8, z1 - 1.6],
            [-1.4, z1],
          ],
          bias: 0.12,
        },
        gem([0, 0, z1 + 0.6], 1.5, 1.5),
      ],
    },
  ];
  if (core)
    parts.push({
      name: "core",
      material: core,
      glow: true,
      shapes: [
        { type: "capsule", a: [-1.9, -1.2, z0 + 1.4], b: [-1.9, -1.2, z1 - 1.4], radius: 0.55 },
        { type: "capsule", a: [1.9, -1.2, z0 + 1.4], b: [1.9, -1.2, z1 - 1.4], radius: 0.55 },
      ],
    });
  return parts;
}

/** A knotty lump of a head (an elm root, a bone knot): a cluster of ellipsoids with hoops. */
function knotHead(
  material: MaterialName,
  z: number,
  hoops: MaterialName,
  extra: readonly ShapeSpec[] = [],
): Omit<PartSpec, "parent">[] {
  return [
    {
      name: "head",
      material,
      texture: { amount: 0.1, cell: [1.6, 1.6, 1.6] },
      shapes: [
        { type: "ellipsoid", center: [0, 0, z], radii: [4.2, 3.6, 5.2] },
        { type: "ellipsoid", center: [-2.6, -0.6, z + 2.6], radii: [2.2, 2.2, 2.2] },
        { type: "ellipsoid", center: [2.4, -0.4, z - 2.4], radii: [2.2, 2.2, 2.2] },
        { type: "ellipsoid", center: [1.4, 0, z + 4], radii: [2, 2, 2] },
        ...extra,
      ],
    },
    {
      name: "hoops",
      material: hoops,
      shiny: true,
      shapes: [
        { type: "cylinder", a: [0, 0, z - 2.6], b: [0, 0, z - 1.6], radius: 4.4 },
        { type: "cylinder", a: [0, 0, z + 1.4], b: [0, 0, z + 2.4], radius: 4.5 },
      ],
    },
  ];
}

/** Iron nails sticking out of a club, in the plane of the icon and toward the camera. */
function nails(
  material: MaterialName,
  at: readonly (readonly [number, number, number])[],
): Omit<PartSpec, "parent"> {
  return {
    name: "nails",
    material,
    shiny: true,
    shapes: at.map(([x, z, out]): ShapeSpec => ({
      type: "capsule",
      a: [x, 0, z],
      b: [x + out, 0, z + 0.4],
      radius: 0.6,
      radius2: 0.35,
    })),
  };
}

export const MACES: SpriteSpec[] = [
  // Band 1: a hardwood mooring pin, turned on a lathe: a thin handle and a thick body.
  hafted("weapons/belaying_pin", { material: "wood", low: 14, high: -2, radius: 1.2 }, [
    {
      name: "body",
      material: "wood",
      texture: GRAIN,
      shapes: [
        { type: "ellipsoid", center: [0, 0, -2], radii: [2.3, 2.3, 1] },
        { type: "capsule", a: [0, 0, -1], b: [0, 0, 13], radius: 2.2, radius2: 2.7 },
      ],
    },
  ]),
  // Band 2: a hardwood cudgel bristling with iron nails.
  hafted("weapons/spiked_cudgel", { material: "darkWood", low: 14, high: 13, radius: 1.3 }, [
    {
      name: "club",
      material: "darkWood",
      texture: GRAIN,
      shapes: [{ type: "capsule", a: [0, 0, -2], b: [0, 0, 12], radius: 1.4, radius2: 3.4 }],
      marks: rivets([-0.8, -3.2, 6], [1, -3.4, 11], 3, "light", "iron"),
    },
    nails("iron", [
      [-2.2, 4, -2],
      [2.2, 6, 2],
      [-2.9, 8.6, -2.2],
      [2.9, 10.4, 2.2],
      [-2.4, 12.6, -2],
      [1.4, 14.4, 1.6],
    ]),
  ]),
  // Band 3: a knot of elm root bound with two steel hoops.
  hafted("weapons/elmroot_maul", { material: "wood", low: 14, high: 6, wrap: "leather" }, [
    ...knotHead("wood", 10, "steel"),
  ]),
  // Band 4: a flanged embersteel head with an ember glow between the fins.
  hafted(
    "weapons/embersteel_mace",
    { material: "darkIron", low: 14, high: 6, wrap: "redCloth", butt: "darkIron", grain: false },
    flangedHead("darkIron", 5.4, 14.6, 4.6, "ember"),
  ),
  // Band 5: a knot of wyrmling bone hooped with embersteel, a gold cap and a jade grip.
  hafted(
    "weapons/wyrmbone_maul",
    { material: "bone", low: 14, high: 6, wrap: "wyrmScale", butt: "gold", grain: false },
    [
      ...knotHead("bone", 10.6, "darkIron", []),
      {
        name: "cap",
        material: "gold",
        shiny: true,
        shapes: [gem([0.6, 0, 16.4], 1.7, 1.5)],
      },
    ],
  ),
  // Band 6: a flanged tidesteel head, a rune glowing in its core, a pearl knob.
  hafted(
    "weapons/tidesteel_mace",
    { material: "drownwood", low: 14, high: 6, wrap: "blueCloth", butt: "pearl" },
    [
      ...flangedHead("tidesteel", 5.4, 15, 5, "rune"),
      { name: "knob", material: "pearl", shiny: true, shapes: [gem([0, 0, 16.6], 1.6, 1.6)] },
    ],
  ),
];

/** Retired maces: the driftwood club, a gnarled piece of wood the sea left on the beach. */
export const RETIRED_MACES: SpriteSpec[] = [
  hafted("weapons/driftwood_club", { material: "weatheredWood", low: 14, high: 0, radius: 1.3 }, [
    {
      name: "club",
      material: "weatheredWood",
      texture: { amount: 0.12, cell: [0.8, 0.8, 3] },
      shapes: [
        { type: "capsule", a: [0, 0, -1], b: [0.6, 0, 13], radius: 1.6, radius2: 3 },
        { type: "ellipsoid", center: [-2.2, -0.4, 6], radii: [1.6, 1.6, 1.8] },
        { type: "ellipsoid", center: [2.4, 0, 10.4], radii: [1.5, 1.5, 1.6] },
      ],
    },
  ]),
];

// ---- Bows and crossbows ----------------------------------------------------------------

interface BowLook {
  sprite: string;
  /** Length tip to tip and how far the limbs bend back (toward -x). */
  length: number;
  bend: number;
  /** Tips that curl forward again (a recurve), px. */
  recurve?: number;
  limb: MaterialName;
  limbRadius?: number;
  grip: MaterialName;
  string: MaterialName;
  /** Caps on the tips (metal nocks, glowing ones). */
  tips?: { material: MaterialName; glow?: boolean };
  /** Plates or a rune along the limbs' back. */
  back?: { material: MaterialName; glow?: boolean };
  /** Thorns along the limbs. */
  thorns?: boolean;
}

function bowPoint(l: BowLook, t: number): [number, number] {
  // t from -1 (bottom tip) to 1 (top tip).
  const z = (t * l.length) / 2;
  let x = -l.bend * (1 - t * t);
  if (l.recurve) x += l.recurve * Math.max(0, Math.abs(t) - 0.7) ** 2 * 11;
  return [x, z];
}

function bow(l: BowLook): SpriteSpec {
  const ts = Array.from({ length: 13 }, (_, i) => -1 + i / 6);
  const pts = ts.map((t) => bowPoint(l, t));
  const half = (from: number, to: number): Vec3[] => onPlane(pts.slice(from, to + 1));
  const r = l.limbRadius ?? 1.05;
  const tipB = pts[0] ?? [0, 0];
  const tipT = pts[pts.length - 1] ?? [0, 0];
  const mid = pts[6] ?? [0, 0];
  const parts: PartSpec[] = [
    lean({
      name: "grip",
      material: l.grip,
      texture: WRAP,
      shapes: [{ type: "capsule", a: [mid[0], 0, -3], b: [mid[0], 0, 3], radius: r + 0.45 }],
    }),
    {
      name: "limbs",
      parent: "grip",
      material: l.limb,
      texture: GRAIN,
      shapes: [...tube(half(0, 6), r * 0.6, r), ...tube(half(6, 12), r, r * 0.6)],
    },
    {
      name: "string",
      parent: "grip",
      material: l.string,
      shapes: [
        {
          type: "capsule",
          a: [tipB[0] + 0.3, 0.6, tipB[1] + 0.6],
          b: [tipT[0] + 0.3, 0.6, tipT[1] - 0.6],
          radius: 0.42,
        },
      ],
    },
  ];
  if (l.back) {
    const plates = pts
      .filter((_, i) => i !== 6 && i > 0 && i < 12)
      .map(([x, z]): Vec3 => [x - 0.2, -0.75, z]);
    parts.push({
      name: "back",
      parent: "grip",
      material: l.back.material,
      ...(l.back.glow ? { glow: true } : { shiny: true }),
      shapes: [...tube(plates.slice(0, 5), 0.6), ...tube(plates.slice(5), 0.6)],
    });
  }
  if (l.tips)
    parts.push({
      name: "tips",
      parent: "grip",
      material: l.tips.material,
      ...(l.tips.glow ? { glow: true } : { shiny: true }),
      shapes: [gem([tipB[0], 0, tipB[1]], 1.1, 1.1), gem([tipT[0], 0, tipT[1]], 1.1, 1.1)],
    });
  if (l.thorns)
    parts.push({
      name: "thorns",
      parent: "grip",
      material: l.limb,
      shapes: [2, 4, 8, 10].map((i): ShapeSpec => {
        const [x, z] = pts[i] ?? [0, 0];
        return {
          type: "capsule",
          a: [x, 0, z],
          b: [x - 1.8, 0, z + (i < 6 ? -0.8 : 0.8)],
          radius: 0.55,
          radius2: 0.3,
        };
      }),
    });
  return icon(l.sprite, parts);
}

export const BOWS: SpriteSpec[] = [
  // Band 1: a short bow of ash, bent over a fire.
  bow({
    sprite: "weapons/short_bow",
    length: 28,
    bend: 5,
    limb: "wood",
    grip: "leather",
    string: "rope",
  }),
  // Band 2: a tall yew longbow with horn nocks.
  bow({
    sprite: "weapons/yew_longbow",
    length: 34,
    bend: 5.5,
    limb: "copper",
    grip: "leather",
    string: "rope",
    tips: { material: "bone" },
  }),
  // Band 3: a recurved thornwood longbow, thorns along its limbs.
  bow({
    sprite: "weapons/thornwood_longbow",
    length: 33,
    bend: 6,
    recurve: 2.4,
    limb: "thornWood",
    grip: "stagCoat",
    string: "rope",
    thorns: true,
    tips: { material: "steel" },
  }),
  // Band 4: elm limbs backed with embersteel plates, ember-hot nocks.
  bow({
    sprite: "weapons/embersteel_longbow",
    length: 33.5,
    bend: 6,
    recurve: 2.6,
    limb: "wood",
    limbRadius: 1.15,
    grip: "redCloth",
    string: "rope",
    back: { material: "darkIron" },
    tips: { material: "ember", glow: true },
  }),
  // Band 5: wyrmling bone limbs strung with sinew, a jade grip and gold nocks.
  bow({
    sprite: "weapons/wyrmsinew_bow",
    length: 33.5,
    bend: 6.4,
    recurve: 3,
    limb: "bone",
    limbRadius: 1.2,
    grip: "wyrmScale",
    string: "stagBelly",
    tips: { material: "gold" },
  }),
  // Band 6: drownwood limbs with a rune glowing down their back, tidesteel nocks.
  bow({
    sprite: "weapons/drownwood_bow",
    length: 34,
    bend: 6.6,
    recurve: 3.2,
    limb: "drownwood",
    limbRadius: 1.2,
    grip: "pearl",
    string: "pearl",
    back: { material: "rune", glow: true },
    tips: { material: "tidesteel" },
  }),
];

interface CrossbowLook {
  sprite: string;
  stock: MaterialName;
  prod: MaterialName;
  string: MaterialName;
  fittings: MaterialName;
  /** Half the prod's span. */
  span: number;
  /** A glowing accent on the prod's tips. */
  tips?: { material: MaterialName; glow?: boolean };
}

function crossbow(l: CrossbowLook): SpriteSpec {
  const z0 = 7.5;
  const prod = Array.from({ length: 9 }, (_, i): [number, number] => {
    const x = -l.span + (2 * l.span * i) / 8;
    return [x, z0 - 0.045 * x * x];
  });
  const end = l.span;
  const zEnd = z0 - 0.045 * end * end;
  const parts: PartSpec[] = [
    lean({
      name: "stock",
      material: l.stock,
      texture: GRAIN,
      shapes: [
        plate(
          [
            [-1.6, 10.5],
            [1.6, 10.5],
            [1.6, -5],
            [2.8, -12],
            [-1.2, -13],
            [-1.6, -5],
          ],
          1.3,
          { bulge: 0.35 },
        ),
      ],
      // The groove the bolt lies in.
      marks: rivets([0, -1.4, -2], [0, -1.4, 9.5], 7, "deep"),
    }),
    {
      name: "prod",
      parent: "stock",
      material: l.prod,
      shiny: true,
      shapes: tube(onPlane(prod, -0.4), 1.05, 1.05),
    },
    {
      name: "string",
      parent: "stock",
      material: l.string,
      shapes: [
        { type: "capsule", a: [-end + 0.4, -0.3, zEnd], b: [0, -1.5, 1.5], radius: 0.4 },
        { type: "capsule", a: [end - 0.4, -0.3, zEnd], b: [0, -1.5, 1.5], radius: 0.4 },
      ],
    },
    {
      name: "fittings",
      parent: "stock",
      material: l.fittings,
      shiny: true,
      shapes: [
        // The nut that holds the string, and the trigger under the stock.
        gem([0, -1.4, 1.5], 1.2, 0.8),
        { type: "capsule", a: [1.6, 0, -1], b: [3.6, 0, -3], radius: 0.6 },
        { type: "box", min: [-2.1, -1.5, 7], max: [2.1, 1.5, 8.6] },
      ],
    },
  ];
  if (l.tips)
    parts.push({
      name: "tips",
      parent: "stock",
      material: l.tips.material,
      ...(l.tips.glow ? { glow: true } : { shiny: true }),
      shapes: [gem([-end, -0.4, zEnd], 1.2, 1.2), gem([end, -0.4, zEnd], 1.2, 1.2)],
    });
  return icon(l.sprite, parts);
}

export const CROSSBOWS: SpriteSpec[] = [
  // Band 3: a short wooden crossbow with a steel prod.
  crossbow({
    sprite: "weapons/smuggler_crossbow",
    stock: "wood",
    prod: "steel",
    string: "rope",
    fittings: "iron",
    span: 9,
  }),
  // Band 4: a dark stock with an embersteel prod, its tips still glowing.
  crossbow({
    sprite: "weapons/embersteel_crossbow",
    stock: "darkWood",
    prod: "darkIron",
    string: "rope",
    fittings: "darkIron",
    span: 10,
    tips: { material: "ember", glow: true },
  }),
  // Band 5: a bone prod strung with sinew on a stock with gold fittings.
  crossbow({
    sprite: "weapons/wyrmsinew_crossbow",
    stock: "wyrmScale",
    prod: "bone",
    string: "stagBelly",
    fittings: "gold",
    span: 10.5,
    tips: { material: "gold" },
  }),
  // Band 6: a tidesteel prod on a drownwood stock, rune-lit tips.
  crossbow({
    sprite: "weapons/tidesteel_crossbow",
    stock: "drownwood",
    prod: "tidesteel",
    string: "pearl",
    fittings: "tidesteel",
    span: 11,
    tips: { material: "rune", glow: true },
  }),
];

// ---- Wands (the arcanist's) and staffs (the druid's) -----------------------------------

/** A rod leaning on the diagonal with a head at the top. */
function rod(
  sprite: string,
  r: {
    material: MaterialName;
    low: number;
    high: number;
    radius?: number;
    radius2?: number;
    grain?: boolean;
  },
  head: readonly Omit<PartSpec, "parent">[],
  scale = 1,
): SpriteSpec {
  const parts: PartSpec[] = [
    lean({
      name: "rod",
      material: r.material,
      ...(r.grain !== false && { texture: GRAIN }),
      shapes: [
        {
          type: "capsule",
          a: [0, 0, -r.low],
          b: [0, 0, r.high],
          radius: r.radius ?? 1,
          radius2: r.radius2 ?? r.radius ?? 1,
        },
      ],
    }),
  ];
  for (const p of head) parts.push({ ...p, parent: "rod" });
  return icon(sprite, parts, { scale });
}

/** A crystal: a long faceted gem (a capsule tapering to a point). */
const crystal = (a: Vec3, b: Vec3, r: number): ShapeSpec => ({
  type: "capsule",
  a,
  b,
  radius: r,
  radius2: 0.35,
});

/** Every wand at 1.12 times its size: a short rod still fills half the slot. */
export const WANDS: SpriteSpec[] = [
  // Band 1: a brass rod crackling with a spark at its tip.
  rod(
    "weapons/spark_wand",
    { material: "gold", low: 9, high: 7, radius: 1, radius2: 0.8, grain: false },
    [
      {
        name: "grip",
        material: "darkWood",
        texture: WRAP,
        shapes: [{ type: "capsule", a: [0, 0, -9], b: [0, 0, -3], radius: 1.3 }],
      },
      {
        name: "spark",
        material: "spark",
        glow: true,
        shapes: [
          gem([0, 0, 9], 2, 2),
          crystal([0, 0, 9], [-2.8, 0, 12], 0.9),
          crystal([0, 0, 9], [2.6, 0, 11.4], 0.9),
        ],
      },
    ],
  ),
  // Band 2: a branch of white coral, still cold, with an icy bead at its tip.
  rod(
    "weapons/coral_wand",
    { material: "coral", low: 10, high: 8, radius: 1.2, radius2: 0.9, grain: false },
    [
      {
        name: "branches",
        material: "coral",
        shapes: [
          ...tube(
            onPlane([
              [0, 2],
              [-2.4, 5],
              [-3, 8],
            ]),
            0.9,
            0.6,
          ),
          ...tube(
            onPlane([
              [0, 5],
              [2.2, 7.6],
              [2.4, 10],
            ]),
            0.8,
            0.55,
          ),
        ],
      },
      { name: "bead", material: "ice", shiny: true, shapes: [gem([0, 0, 9.6], 1.8, 1.6)] },
    ],
  ),
  // Band 3: a steel rod with prongs holding a crystal of stormglass.
  rod("weapons/stormglass_wand", { material: "steel", low: 10, high: 5, radius: 1, grain: false }, [
    {
      name: "grip",
      material: "leather",
      texture: WRAP,
      shapes: [{ type: "capsule", a: [0, 0, -10], b: [0, 0, -4], radius: 1.3 }],
    },
    {
      name: "prongs",
      material: "steel",
      shiny: true,
      shapes: [
        ...tube(
          onPlane([
            [0, 4],
            [-2.4, 7],
            [-1.8, 10.5],
          ]),
          0.6,
        ),
        ...tube(
          onPlane([
            [0, 4],
            [2.4, 7],
            [1.8, 10.5],
          ]),
          0.6,
        ),
      ],
    },
    {
      name: "crystal",
      material: "stormglass",
      glow: true,
      shapes: [crystal([0, -0.4, 6], [0, -0.4, 13.5], 2)],
    },
  ]),
  // Band 4: a shard of polished volcanic glass, an ember caught inside its tip.
  rod(
    "weapons/obsidian_wand",
    { material: "darkIron", low: 10, high: 0, radius: 1.1, grain: false },
    [
      {
        name: "grip",
        material: "redCloth",
        texture: WRAP,
        shapes: [{ type: "capsule", a: [0, 0, -10], b: [0, 0, -4], radius: 1.35 }],
      },
      {
        name: "shard",
        material: "obsidian",
        shiny: true,
        shapes: [crystal([0, 0, 0], [0.4, 0, 13.6], 2.2), crystal([0, 0, 2], [-2.8, 0, 7], 1.2)],
      },
      { name: "ember", material: "ember", glow: true, shapes: [gem([0.2, -1.6, 8], 1, 0.6)] },
    ],
  ),
  // Band 5: a hollow spiral horn that hums, set in a gold cap with a jade stone.
  rod(
    "weapons/wyrmhorn_wand",
    { material: "bone", low: 6, high: 11, radius: 2, radius2: 0.55, grain: false },
    [
      {
        name: "ridges",
        material: "bone",
        bias: -0.32,
        shapes: [-3, 0, 3, 6].map((z): ShapeSpec => ({
          type: "capsule",
          a: [-1.9 + z * 0.12, -0.5, z],
          b: [1.7 - z * 0.12, -0.5, z + 2],
          radius: 0.45,
        })),
      },
      {
        name: "cap",
        material: "gold",
        shiny: true,
        shapes: [
          { type: "cylinder", a: [0, 0, -7.6], b: [0, 0, -5.2], radius: 2.4 },
          { type: "capsule", a: [0, 0, -10.6], b: [0, 0, -7.4], radius: 1.1 },
        ],
      },
      { name: "stone", material: "wyrmScale", shiny: true, shapes: [gem([0, 0, -11], 1.5, 1.5)] },
    ],
  ),
  // Band 6: a tidesteel rod whose claws hold a pearl with a small storm glowing in it.
  rod(
    "weapons/pearlstorm_wand",
    { material: "tidesteel", low: 10, high: 5, radius: 1, grain: false },
    [
      {
        name: "grip",
        material: "blueCloth",
        texture: WRAP,
        shapes: [{ type: "capsule", a: [0, 0, -10], b: [0, 0, -4], radius: 1.3 }],
      },
      {
        name: "claws",
        material: "tidesteel",
        shiny: true,
        shapes: [
          ...tube(
            onPlane([
              [0, 4],
              [-3, 6.6],
              [-2.6, 10.6],
            ]),
            0.6,
          ),
          ...tube(
            onPlane([
              [0, 4],
              [3, 6.6],
              [2.6, 10.6],
            ]),
            0.6,
          ),
        ],
      },
      { name: "pearl", material: "pearl", shiny: true, shapes: [gem([0, 0.6, 9], 2.8, 2.6)] },
      { name: "storm", material: "rune", glow: true, shapes: [gem([-0.4, -2, 9.4], 1.2, 0.5)] },
    ],
  ),
].map((s) => resized(s, 1.12));

export const STAFFS: SpriteSpec[] = [
  // Band 1: a sapling that keeps sprouting leaves.
  rod("weapons/sapling_staff", { material: "wood", low: 17, high: 14, radius: 1.1, radius2: 0.8 }, [
    {
      name: "leaves",
      material: "foliage",
      shapes: [
        { type: "ellipsoid", center: [-2.4, 0, 13], radii: [2.2, 1, 1.3] },
        { type: "ellipsoid", center: [2.2, 0, 10], radii: [2.2, 1, 1.3] },
        { type: "ellipsoid", center: [-0.6, 0, 16], radii: [1.3, 1, 2] },
        { type: "ellipsoid", center: [-2, 0, 4], radii: [1.8, 1, 1.1] },
      ],
    },
  ]),
  // Band 2: white frost wood shedding splinters of ice.
  rod(
    "weapons/rimewood_staff",
    { material: "stagBelly", low: 17, high: 12, radius: 1.5, radius2: 1.25 },
    [
      {
        name: "frost",
        material: "ice",
        shapes: [
          { type: "ellipsoid", center: [-1.2, -0.6, -2], radii: [1.4, 1, 1.4] },
          { type: "ellipsoid", center: [1.2, -0.6, 5], radii: [1.3, 1, 1.3] },
        ],
      },
      {
        name: "ice",
        material: "ice",
        shiny: true,
        shapes: [
          crystal([0, 0, 11], [0, 0, 18.6], 2),
          crystal([0, 0, 11], [-3.2, 0, 15.6], 1.3),
          crystal([0, 0, 11], [3, 0, 15.2], 1.3),
        ],
      },
    ],
  ),
  // Band 3: an elm branch furred with frost, a cluster of ice at its head.
  rod(
    "weapons/hoarfrost_staff",
    { material: "wood", low: 17, high: 12, radius: 1.25, radius2: 1.05 },
    [
      {
        name: "frost",
        material: "ice",
        shapes: [
          { type: "ellipsoid", center: [-1, -0.6, -4], radii: [1.4, 1, 1.6] },
          { type: "ellipsoid", center: [1, -0.6, 3], radii: [1.4, 1, 1.4] },
        ],
      },
      {
        name: "crystals",
        material: "ice",
        shiny: true,
        shapes: [
          crystal([0, 0, 11], [0, 0, 19], 2),
          crystal([0, 0, 11], [-3.4, 0, 16.6], 1.4),
          crystal([0, 0, 11], [3.2, 0, 16], 1.4),
        ],
      },
    ],
  ),
  // Band 4: basalt that fire does not warm, crowned with black ice.
  rod(
    "weapons/blackfrost_staff",
    { material: "basalt", low: 17, high: 12, radius: 1.3, radius2: 1.1 },
    [
      {
        name: "collar",
        material: "darkIron",
        shiny: true,
        shapes: [{ type: "cylinder", a: [0, 0, 9.6], b: [0, 0, 11.2], radius: 2.1 }],
      },
      {
        name: "crystals",
        material: "blackIce",
        shiny: true,
        shapes: [
          crystal([0, 0, 11], [0, 0, 19.4], 2.2),
          crystal([0, 0, 11], [-3.8, 0, 16.2], 1.5),
          crystal([0, 0, 11], [3.6, 0, 15.6], 1.5),
        ],
      },
    ],
  ),
  // Band 5: white wood with gold bands around a big core of ice that never melts.
  rod(
    "weapons/glacierheart_staff",
    { material: "bone", low: 17, high: 9, radius: 1.3, radius2: 1.2 },
    [
      {
        name: "bands",
        material: "gold",
        shiny: true,
        shapes: [
          { type: "cylinder", a: [0, 0, -9], b: [0, 0, -7.6], radius: 1.8 },
          { type: "cylinder", a: [0, 0, 7.4], b: [0, 0, 9], radius: 1.9 },
          ...tube(
            onPlane([
              [0, 8.4],
              [-3.4, 11.4],
              [-2.6, 16.6],
            ]),
            0.65,
          ),
          ...tube(
            onPlane([
              [0, 8.4],
              [3.4, 11.4],
              [2.6, 16.6],
            ]),
            0.65,
          ),
        ],
      },
      {
        name: "core",
        material: "ice",
        shiny: true,
        shapes: [gem([0, 0.6, 13.2], 2.8, 2.4), crystal([0, 0.6, 14], [0, 0.6, 19], 1.6)],
      },
    ],
  ),
  // Band 6: drownwood held in tidesteel claws around trench ice that glows.
  rod(
    "weapons/deepfrost_staff",
    { material: "drownwood", low: 17, high: 9, radius: 1.3, radius2: 1.15 },
    [
      {
        name: "claws",
        material: "tidesteel",
        shiny: true,
        shapes: [
          { type: "cylinder", a: [0, 0, 7.4], b: [0, 0, 9], radius: 1.9 },
          ...tube(
            onPlane([
              [0, 8.4],
              [-3.6, 11],
              [-3.2, 16.4],
            ]),
            0.7,
          ),
          ...tube(
            onPlane([
              [0, 8.4],
              [3.6, 11],
              [3.2, 16.4],
            ]),
            0.7,
          ),
        ],
      },
      {
        name: "ice",
        material: "blackIce",
        shiny: true,
        shapes: [crystal([0, 0.6, 9], [0, 0.6, 19.6], 2.5)],
      },
      { name: "glow", material: "rune", glow: true, shapes: [gem([0, -1.4, 13], 1.3, 0.6)] },
    ],
  ),
];

/** Every weapon icon (the catalog's lines and the retired pieces). */
export const WEAPON_ICONS: SpriteSpec[] = [
  ...SWORDS,
  ...AXES,
  ...MACES,
  ...BOWS,
  ...CROSSBOWS,
  ...WANDS,
  ...STAFFS,
  ...RETIRED_SWORDS,
  ...RETIRED_MACES,
];
