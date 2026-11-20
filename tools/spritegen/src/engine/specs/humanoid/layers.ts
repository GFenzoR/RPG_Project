// The paper doll of the engine humanoid (docs/17 "Humanoides del motor"): what is drawn
// over the bare body, one layer per slot, in the same rig poses so every layer follows every
// frame. The atlas budget (docs/07) asks for a few shapes per slot, not one drawing per
// catalog piece: every layer is drawn in a neutral ramp (palette.ts `look*`) and the client
// tints it with the material of the piece worn (data/items `worn: {shape, tint}`).
//
//   hair (6 styles; bald draws nothing) and beard (2; none draws nothing): on the head;
//   head: cap, hood, open helm, full helm, circlet;
//   torso: tunic, robe, leather, mail, plate, drawn per sex and build (they fit the trunk);
//   legs: trousers, greaves; feet: shoes, boots, sabatons;
//   shield (left forearm): buckler, round, kite, tower;
//   weapon (right hand; the bow in the left): sword, axe, mace, dagger, spear, bow,
//   crossbow, staff, wand. A weapon's grip turns per frame with its class's arc.
import type { MaterialName } from "../../../palette.ts";
import type { JointPose, PartSpec, ShapeSpec, TextureSpec } from "../../spec.ts";
import type { ActionName } from "../../style.ts";
import type { Vec3 } from "../../math.ts";
import { BODY_PARTS, BONES, BUILDS, bustShapes, LEG_PARTS, SEXES, TRUNKS } from "./skeleton.ts";
import type { BodyPart, Build, Sex } from "./skeleton.ts";

export type LayerSlot =
  "body" | "hair" | "beard" | "head" | "torso" | "legs" | "feet" | "shield" | "weapon";

/** What a layer's grip does in each frame (weapons only). */
export interface Grip {
  /** The hand it hangs from. */
  hand: "r" | "l";
  /**
   * The grip's turn about the hand's lateral axis (degrees) for frame i of an action, given
   * the hand's own pitch in that pose (`chain`: 0 = the forearm hangs straight down, 90 =
   * it points forward). Return `target - chain` to hold the weapon at a fixed angle in the
   * world (a level spear, an upright staff).
   */
  pitch: (action: ActionName, i: number, chain: number) => number;
}

export interface LayerDef {
  slot: LayerSlot;
  /** The shape's id in data (data/looks.yaml): short, plate, sword... */
  shape: string;
  /** Its atlas path. */
  sprite: string;
  /** The body it is drawn on (its occluders); shared layers fit the four bodies. */
  build: Build;
  sex: Sex;
  /** Its parts (none for the body itself), hung from the body's parts. */
  parts: PartSpec[];
  /** The body parts that hide it (default: all of them). */
  occlude?: readonly BodyPart[];
  grip?: Grip;
}

// ---- Helpers -----------------------------------------------------------------------------

type V = [number, number, number];
const cap = (a: Vec3, b: Vec3, r: number, r2?: number, extra: Partial<ShapeSpec> = {}): ShapeSpec =>
  ({
    type: "capsule",
    a,
    b,
    radius: r,
    ...(r2 !== undefined ? { radius2: r2 } : {}),
    ...extra,
  }) as ShapeSpec;
const ell = (center: Vec3, radii: Vec3, extra: Partial<ShapeSpec> = {}): ShapeSpec =>
  ({ type: "ellipsoid", center, radii, ...extra }) as ShapeSpec;
/** An elliptic skirt or tube: an ellipse in [x, y] swept along z from `from` to `to`. */
function tube(rx: number, ry: number, from: number, to: number, cx = 0): ShapeSpec {
  const pts: [number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([round(cx + rx * Math.cos(a)), round(ry * Math.sin(a))]);
  }
  return { type: "extrusion", axis: "z", points: pts, from, to, bulge: 0.6 };
}
const round = (v: number): number => Math.round(v * 100) / 100;
const part = (
  name: string,
  parent: BodyPart | string,
  material: MaterialName,
  shapes: ShapeSpec[],
  extra: Partial<PartSpec> = {},
): PartSpec => ({ name, parent, material, shapes, ...extra });

/** The body a garment fits (skeleton.ts TRUNKS). */
interface Body {
  build: Build;
  sex: Sex;
}

/** The trunk a garment covers, `by` px out from the skin (a woman's chest included). */
function trunkShell(body: Body, by: number): ShapeSpec[] {
  const t = TRUNKS[body.sex][body.build];
  const add = (r: V): V => [r[0] + by, r[1] + by, r[2] + by];
  return [
    ell([0, 0, 2.0], add(t.belly)),
    ell([-0.2, 0, 5.2], add(t.chest)),
    cap([0, -t.shoulderY, BONES.shoulderZ], [0, t.shoulderY, BONES.shoulderZ], t.shoulder + by),
    ...bustShapes(t, by),
  ];
}

/** Sleeves on both arms: on the upper arm down `upper` px and on the forearm `fore` px. */
function sleeves(
  prefix: string,
  body: Body,
  material: MaterialName,
  by: number,
  upper: number,
  fore = 0,
  extra: Partial<PartSpec> = {},
): PartSpec[] {
  const t = TRUNKS[body.sex][body.build];
  const out: PartSpec[] = [];
  for (const k of ["r", "l"] as const) {
    out.push(
      part(
        `${prefix}_sleeve_${k}`,
        `arm_${k}`,
        material,
        [cap([0, 0, 0.4], [0, 0, -Math.min(upper, BONES.upperArm)], t.arm + by, t.arm + by - 0.1)],
        extra,
      ),
    );
    if (fore > 0)
      out.push(
        part(
          `${prefix}_cuff_${k}`,
          `forearm_${k}`,
          material,
          [cap([0, 0, 0.3], [0, 0, -fore], t.fore + by, t.fore + by + (fore > 3 ? 0.25 : 0))],
          extra,
        ),
      );
  }
  return out;
}

// ---- Hair and beard ----------------------------------------------------------------------

const HAIR_TEXTURE: TextureSpec = { amount: 0.12, cell: [0.9, 2.2, 1.4] };

/** The dome of hair on the skull, set back so the face stays bare. */
const scalp = (by: number, back = 0.55): ShapeSpec =>
  ell([back, 0, 4.3], [3.05 + by, 2.85 + by, 2.55 + by]);
/** The fringe over the forehead, kept above the eyes (the camera looks down on it). */
const fringe = (by = 0): ShapeSpec => ell([-2.05, 0, 5.35], [1.0 + by, 2.3 + by, 0.75]);

const HAIR: Record<string, ShapeSpec[]> = {
  short: [
    scalp(0.15),
    fringe(),
    ell([-0.6, 2.7, 2.6], [0.75, 0.4, 1.1]),
    ell([-0.6, -2.7, 2.6], [0.75, 0.4, 1.1]),
  ],
  crop: [scalp(0.02, 0.45)],
  long: [
    scalp(0.2),
    fringe(0.1),
    ell([1.5, 0, 1.0], [1.9, 3.0, 3.6]),
    ell([-0.4, 2.85, 1.8], [1.0, 0.55, 2.4]),
    ell([-0.4, -2.85, 1.8], [1.0, 0.55, 2.4]),
  ],
  ponytail: [scalp(0.15), fringe(), cap([2.7, 0, 4.4], [4.3, 0, -1.2], 1.05, 0.6)],
  topknot: [scalp(0.05, 0.5), ell([0.7, 0, 6.6], [1.35, 1.35, 1.2])],
  curly: [
    ell([0.6, 0, 4.1], [3.55, 3.45, 3.15]),
    ell([-0.8, 2.9, 2.3], [1.1, 0.7, 1.4]),
    ell([-0.8, -2.9, 2.3], [1.1, 0.7, 1.4]),
  ],
};

const BEARD: Record<string, ShapeSpec[]> = {
  short: [ell([-1.45, 0, 1.15], [1.95, 2.2, 1.45])],
  full: [ell([-1.6, 0, 0.6], [2.15, 2.4, 2.1]), ell([-3.05, 0, 1.95], [0.55, 1.35, 0.45])],
};

// ---- Head gear ---------------------------------------------------------------------------

function circletRing(): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number): V => [round(-0.2 + 3.15 * Math.cos(a)), round(2.95 * Math.sin(a)), 4.4];
    out.push(cap(p(a0), p(a1), 0.42));
  }
  return out;
}

const HEAD: Record<
  string,
  { material: MaterialName; shapes: ShapeSpec[]; shiny?: boolean; texture?: TextureSpec }
> = {
  cap: {
    material: "lookCloth",
    shapes: [
      ell([0.55, 0, 4.6], [3.15, 3.0, 2.3]),
      ell([0.15, 0, 4.3], [3.3, 3.1, 0.7], { bias: -0.15 }),
    ],
  },
  hood: {
    material: "lookCloth",
    shapes: [
      ell([1.1, 0, 3.4], [3.9, 3.55, 3.9]),
      ell([1.6, 0, 6.2], [2.0, 1.6, 1.6]),
      ell([0.4, 0, -0.4], [3.2, 4.3, 1.8]),
    ],
  },
  open_helm: {
    material: "lookMetal",
    shiny: true,
    shapes: [
      ell([0.35, 0, 4.3], [3.25, 3.1, 2.65]),
      ell([0.0, 0, 3.9], [3.45, 3.25, 0.6], { bias: -0.12 }),
      { type: "box", min: [-3.65, -0.35, 1.6], max: [-3.05, 0.35, 4.0] },
    ],
  },
  full_helm: {
    material: "lookMetal",
    shiny: true,
    shapes: [
      ell([-0.15, 0, 3.0], [3.45, 3.2, 3.75]),
      { type: "box", min: [-3.75, -1.9, 2.75], max: [-3.2, 1.9, 3.35], material: "eye" },
      { type: "box", min: [-3.75, -0.3, 0.6], max: [-3.25, 0.3, 2.75], bias: -0.1 },
    ],
  },
  circlet: { material: "lookMetal", shiny: true, shapes: circletRing() },
};

// ---- Torso clothes -----------------------------------------------------------------------

function torsoParts(shape: string, body: Body): PartSpec[] {
  const p = `${shape}`;
  const trunk = TRUNKS[body.sex][body.build];
  const hips = trunk.hips;
  const female = body.sex === "female";
  /**
   * A belt round the top of the skirt (skirt radii rx, ry), a little proud of it. A
   * woman's is cinched at her waist instead, over the narrowest of the trunk: it draws her
   * waist on every garment.
   */
  const belt = (rx: number, ry: number, material: MaterialName = "lookLeather"): PartSpec =>
    female
      ? part(
          `${p}_belt`,
          "torso",
          material,
          [ell([0, 0, 1.4], [trunk.belly[0] + 0.85, trunk.belly[1] + 0.85, 0.5])],
          { bias: -0.25 },
        )
      : part(`${p}_belt`, "pelvis", material, [ell([0, 0, 1.2], [rx + 0.35, ry + 0.35, 0.55])], {
          bias: -0.25,
        });
  /** A skirt from the belt down to z = bottom (pelvis frame), flaring by `flare` px. */
  const skirt = (
    material: MaterialName,
    rx: number,
    ry: number,
    bottom: number,
    flare: number,
    extra: Partial<PartSpec> = {},
  ): PartSpec => {
    const mid = round((bottom + 1.4) / 2);
    return part(
      `${p}_skirt`,
      "pelvis",
      material,
      [tube(rx, ry, mid, 1.4), tube(rx + flare, ry + flare, bottom, mid + 0.01)],
      extra,
    );
  };
  switch (shape) {
    case "tunic":
      return [
        part(`${p}_body`, "torso", "lookCloth", trunkShell(body, 0.45)),
        // A woman's tunic falls a little longer and flares more (a short dress).
        skirt("lookCloth", 2.9, hips + 0.5, female ? -5.6 : -4.6, female ? 0.65 : 0.35),
        belt(2.9, hips + 0.5),
        ...sleeves(p, body, "lookCloth", 0.4, 2.8),
      ];
    case "robe":
      return [
        part(`${p}_body`, "torso", "lookCloth", trunkShell(body, 0.5)),
        part(`${p}_skirt`, "pelvis", "lookCloth", [
          tube(2.95, hips + 0.6, -6, 1.4),
          tube(3.5, hips + 1.2, -15.9, -5.8),
        ]),
        belt(2.95, hips + 0.6, "lookCloth"),
        ...sleeves(p, body, "lookCloth", 0.5, 6, BONES.forearm - 0.4),
      ];
    case "leather":
      return [
        part(`${p}_body`, "torso", "lookLeather", trunkShell(body, 0.55)),
        skirt("lookLeather", 2.95, hips + 0.6, -3.6, 0.3),
        belt(2.95, hips + 0.6),
        ...sleeves(p, body, "lookLeather", 0.55, 2.2),
        part(`${p}_pad_r`, "arm_r", "lookLeather", [ell([0, 0.2, -0.2], [1.9, 1.9, 1.3])]),
        part(`${p}_pad_l`, "arm_l", "lookLeather", [ell([0, -0.2, -0.2], [1.9, 1.9, 1.3])]),
      ];
    case "mail": {
      const rings: Partial<PartSpec> = { texture: { amount: 0.16, cell: [0.8, 0.8, 0.8] } };
      return [
        part(`${p}_body`, "torso", "lookMetal", trunkShell(body, 0.5), rings),
        skirt("lookMetal", 3.0, hips + 0.6, -5.2, 0.35, rings),
        belt(3.0, hips + 0.6),
        ...sleeves(p, body, "lookMetal", 0.5, BONES.upperArm, 1.2, rings),
      ];
    }
    case "plate":
      return [
        part(`${p}_body`, "torso", "lookMetal", trunkShell(body, 0.75), { shiny: true }),
        skirt("lookMetal", 3.1, hips + 0.75, -3.4, 0.3, { shiny: true }),
        belt(3.1, hips + 0.75),
        part(`${p}_pauldron_r`, "arm_r", "lookMetal", [ell([0, 0.3, -0.4], [2.3, 2.2, 1.7])], {
          shiny: true,
        }),
        part(`${p}_pauldron_l`, "arm_l", "lookMetal", [ell([0, -0.3, -0.4], [2.3, 2.2, 1.7])], {
          shiny: true,
        }),
        ...sleeves(p, body, "lookMetal", 0.45, 0, BONES.forearm - 0.6, { shiny: true }),
      ];
  }
  throw new Error(`no torso shape ${shape}`);
}

// ---- Legs and feet -----------------------------------------------------------------------

function legParts(shape: string): PartSpec[] {
  const out: PartSpec[] = [];
  const metal = shape === "greaves";
  const mat: MaterialName = metal ? "lookMetal" : "lookCloth";
  const extra: Partial<PartSpec> = metal ? { shiny: true } : {};
  out.push(part(`${shape}_seat`, "pelvis", mat, [ell([0, 0, 0.3], [2.75, 4.15, 2.3])], extra));
  for (const k of ["r", "l"] as const) {
    out.push(
      part(
        `${shape}_thigh_${k}`,
        `thigh_${k}`,
        mat,
        [cap([0, 0, 0], [0, 0, -BONES.thigh], 2.35, 1.9)],
        extra,
      ),
      part(
        `${shape}_shin_${k}`,
        `shin_${k}`,
        mat,
        [
          cap([0, 0, 0], [0, 0, -BONES.shin + 0.4], metal ? 1.95 : 1.75, metal ? 1.6 : 1.45),
          ...(metal ? [ell([-0.6, 0, 0], [1.4, 1.5, 1.3], { bias: 0.1 })] : []),
        ],
        extra,
      ),
    );
  }
  return out;
}

function feetParts(shape: string): PartSpec[] {
  const out: PartSpec[] = [];
  const metal = shape === "sabatons";
  const mat: MaterialName = metal ? "lookMetal" : "lookLeather";
  const extra: Partial<PartSpec> = metal ? { shiny: true } : {};
  const ankle = BONES.hip - BONES.thigh - BONES.shin;
  for (const k of ["r", "l"] as const) {
    out.push(
      part(
        `${shape}_foot_${k}`,
        `foot_${k}`,
        mat,
        [cap([0.6, 0, -ankle / 2], [-2.45, 0, -ankle / 2 + 0.05], 1.2, 1.1)],
        extra,
      ),
    );
    if (shape !== "shoes")
      out.push(
        part(
          `${shape}_shaft_${k}`,
          `shin_${k}`,
          mat,
          [
            cap(
              [0, 0, -BONES.shin + 0.3],
              [0, 0, -BONES.shin + (metal ? 3.6 : 4.6)],
              metal ? 1.65 : 1.6,
              metal ? 1.75 : 1.7,
            ),
          ],
          extra,
        ),
      );
  }
  return out;
}

// ---- Shields -----------------------------------------------------------------------------

/** A shield on the left forearm, its face turned forward and out (-45° about the arm). */
function shieldParts(shape: string): PartSpec[] {
  const face = (shapes: ShapeSpec[], material: MaterialName = "lookWood"): PartSpec =>
    part(`${shape}_face`, "forearm_l", material, shapes, {
      at: [0, -1.7, -2.6],
      rot: [0, 0, -40],
    });
  // Shapes in the shield's frame: its face looks to -y; x forward, z along the forearm.
  switch (shape) {
    case "buckler":
      return [
        face(
          [
            { type: "cylinder", a: [0, -0.1, 0], b: [0, -0.8, 0], radius: 2.9 },
            ell([0, -0.9, 0], [1.0, 0.7, 1.0], { bias: 0.15 }),
          ],
          "lookMetal",
        ),
      ];
    case "round":
      return [
        face([
          { type: "cylinder", a: [0, 0, 0], b: [0, -0.8, 0], radius: 4.3 },
          ell([0, -1.0, 0], [1.2, 0.7, 1.2], { material: "lookMetal" }),
        ]),
      ];
    case "kite":
      return [
        face(
          [
            {
              type: "polygon",
              axis: "y",
              at: -0.4,
              thickness: 0.9,
              bulge: 0.8,
              points: [
                [-3.4, 4.2],
                [-2.4, 5.0],
                [2.4, 5.0],
                [3.4, 4.2],
                [3.0, 0.5],
                [0.0, -6.0],
                [-3.0, 0.5],
              ],
            },
          ],
          "lookMetal",
        ),
      ];
    case "tower":
      return [
        face([
          {
            type: "polygon",
            axis: "y",
            at: -0.45,
            thickness: 1.0,
            bulge: 0.7,
            points: [
              [-3.7, 5.5],
              [3.7, 5.5],
              [3.7, -7.5],
              [-3.7, -7.5],
            ],
          },
          { type: "box", min: [-0.5, -1.1, -6.5], max: [0.5, -0.8, 4.5], material: "lookMetal" },
        ]),
      ];
  }
  throw new Error(`no shield shape ${shape}`);
}

// ---- Weapons -----------------------------------------------------------------------------

/** The hand's pitch in a key pose: the trunk's lean, the arm's swing, the forearm's bend. */
export function chainPitch(pose: Readonly<Record<string, JointPose>>, hand: "r" | "l"): number {
  const y = (name: string): number => pose[name]?.rot?.[1] ?? 0;
  return y("torso") + y(`arm_${hand}`) + 8 + y(`forearm_${hand}`);
}

/** A grip that rests at `rest` (degrees, in the world) and swings with the arm otherwise. */
const swingGrip =
  (
    rest: number,
    attack: readonly number[] = [0, 0, 0, 0],
    cast: readonly number[] = [0, 0, 0],
    shoot: readonly number[] = [0, 0, 0],
  ): Grip["pitch"] =>
  (action, i) => {
    // Relative to the hand, whose pitch at rest is 8 (the forearm's bend).
    const base = rest - 8;
    if (action === "attack") return base + (attack[i] ?? 0);
    if (action === "cast") return base + (cast[i] ?? 0);
    if (action === "shoot") return base + (shoot[i] ?? 0);
    return base;
  };
/** A grip held at fixed world angles in some actions (a level spear, an upright staff). */
const fixedGrip =
  (rest: number, fixed: Partial<Record<ActionName, readonly number[]>>): Grip["pitch"] =>
  (action, i, chain) => {
    const list = fixed[action];
    const want = list ? (list[i] ?? list[list.length - 1] ?? rest) : undefined;
    return want !== undefined ? want - chain : rest - 8;
  };

/**
 * Weapon shapes in the grip's frame: the fist at the origin, the business end toward -z
 * (down the forearm when the grip does not turn), the pommel or butt toward +z.
 */
const WEAPONS: Record<string, { parts: (grip: string) => PartSpec[]; grip: Grip }> = {
  sword: {
    parts: (g) => [
      part(
        g,
        "hand_r",
        "lookLeather",
        [
          cap([0, 0, 1.7], [0, 0, -0.7], 0.5),
          ell([0, 0, 2.1], [0.7, 0.7, 0.7], { material: "lookMetal" }),
        ],
        { at: [0, 0, -0.9] },
      ),
      part(
        `${g}_blade`,
        g,
        "lookMetal",
        [
          cap([-1.8, 0, -1.0], [1.8, 0, -1.0], 0.45),
          {
            type: "polygon",
            axis: "y",
            thickness: 0.9,
            bulge: 0.6,
            points: [
              [-0.65, -1.2],
              [0.65, -1.2],
              [0.55, -11.6],
              [0, -13.2],
              [-0.55, -11.6],
            ],
          },
        ],
        { shiny: true },
      ),
    ],
    grip: { hand: "r", pitch: swingGrip(35, [15, 0, 8, 0], [0, -20, 0]) },
  },
  axe: {
    parts: (g) => [
      part(g, "hand_r", "lookWood", [cap([0, 0, 2.2], [0, 0, -10.2], 0.55)], { at: [0, 0, -0.9] }),
      part(
        `${g}_head`,
        g,
        "lookMetal",
        [
          {
            type: "polygon",
            axis: "y",
            thickness: 1.0,
            bulge: 0.5,
            points: [
              [0.4, -6.4],
              [-2.6, -5.6],
              [-3.9, -6.6],
              [-4.0, -9.3],
              [-3.1, -10.6],
              [0.4, -9.6],
            ],
          },
          { type: "box", min: [0.2, -0.45, -9.2], max: [1.4, 0.45, -7.0] },
        ],
        { shiny: true },
      ),
    ],
    grip: { hand: "r", pitch: swingGrip(35, [30, -10, 0, 0], [0, -20, 0]) },
  },
  mace: {
    parts: (g) => [
      part(g, "hand_r", "lookWood", [cap([0, 0, 1.8], [0, 0, -7.6], 0.55)], { at: [0, 0, -0.9] }),
      part(
        `${g}_head`,
        g,
        "lookMetal",
        [
          ell([0, 0, -8.8], [1.7, 1.7, 1.9]),
          { type: "box", min: [-2.4, -0.3, -9.8], max: [2.4, 0.3, -7.8] },
          { type: "box", min: [-0.3, -2.4, -9.8], max: [0.3, 2.4, -7.8] },
        ],
        { shiny: true },
      ),
    ],
    grip: { hand: "r", pitch: swingGrip(35, [30, -5, 0, 0], [0, -20, 0]) },
  },
  dagger: {
    parts: (g) => [
      part(
        g,
        "hand_r",
        "lookLeather",
        [
          cap([0, 0, 1.3], [0, 0, -0.6], 0.45),
          ell([0, 0, 1.6], [0.55, 0.55, 0.55], { material: "lookMetal" }),
        ],
        { at: [0, 0, -0.9] },
      ),
      part(
        `${g}_blade`,
        g,
        "lookMetal",
        [
          cap([-1.2, 0, -0.9], [1.2, 0, -0.9], 0.4),
          {
            type: "polygon",
            axis: "y",
            thickness: 0.8,
            bulge: 0.6,
            points: [
              [-0.6, -1.1],
              [0.6, -1.1],
              [0.45, -5.6],
              [0, -6.9],
              [-0.45, -5.6],
            ],
          },
        ],
        { shiny: true },
      ),
    ],
    // A stab: the point stays level and forward through the blow.
    grip: { hand: "r", pitch: fixedGrip(35, { attack: [120, 92, 90, 60] }) },
  },
  spear: {
    parts: (g) => [
      part(g, "hand_r", "lookWood", [cap([0, 0, 6.5], [0, 0, -12.6], 0.5)], { at: [0, 0, -0.9] }),
      part(
        `${g}_head`,
        g,
        "lookMetal",
        [
          {
            type: "polygon",
            axis: "y",
            thickness: 0.9,
            bulge: 0.6,
            points: [
              [-0.85, -12.4],
              [0.85, -12.4],
              [0.6, -14.8],
              [0, -16.4],
              [-0.6, -14.8],
            ],
          },
        ],
        { shiny: true },
      ),
    ],
    // Upright at rest (point up); a thrust keeps it level and drives it forward.
    grip: {
      hand: "r",
      pitch: fixedGrip(172, {
        idle: [172],
        walk: [172],
        attack: [96, 90, 88, 120],
        shoot: [150, 150, 150],
        cast: [96, 116, 100],
        death: [150, 130, 120, 100],
      }),
    },
  },
  staff: {
    parts: (g) => [
      part(g, "hand_r", "lookWood", [cap([0, 0, 10.5], [0, 0, -11.2], 0.6, 0.55)], {
        at: [0, 0, -0.9],
      }),
      part(
        `${g}_crown`,
        g,
        "lookMetal",
        [ell([0, 0, -12.3], [1.3, 1.3, 1.5]), cap([0, 0, -10.9], [0, 0, -10.2], 0.95)],
        { shiny: true },
      ),
    ],
    // Upright, the crown up; raised with the spell and thrust toward the target.
    grip: {
      hand: "r",
      pitch: fixedGrip(176, {
        idle: [176],
        walk: [176],
        attack: [160, 120, 100, 140],
        shoot: [170, 170, 170],
        cast: [118, 142, 112],
        death: [160, 140, 120, 100],
      }),
    },
  },
  wand: {
    parts: (g) => [
      part(g, "hand_r", "lookWood", [cap([0, 0, 1.2], [0, 0, -6.4], 0.42, 0.32)], {
        at: [0, 0, -0.9],
      }),
      part(`${g}_tip`, g, "lookMetal", [ell([0, 0, -6.8], [0.75, 0.75, 0.85])], { shiny: true }),
    ],
    grip: {
      hand: "r",
      pitch: fixedGrip(35, { cast: [150, 170, 100], attack: [200, 110, 60, 40] }),
    },
  },
  bow: {
    parts: (g) => {
      // A longbow in the left hand: limbs along z bowing forward (-x), the string behind.
      const limb: [number, number][] = [];
      for (let i = 0; i <= 8; i++) {
        const z = -10 + (20 * i) / 8;
        limb.push([round(-1.8 * (1 - (z / 10) ** 2)), round(z)]);
      }
      const shapes: ShapeSpec[] = [];
      for (let i = 0; i < limb.length - 1; i++) {
        const a = limb[i] ?? [0, 0];
        const b = limb[i + 1] ?? [0, 0];
        shapes.push(cap([a[0], 0, a[1]], [b[0], 0, b[1]], i === 3 || i === 4 ? 0.6 : 0.45));
      }
      return [
        part(g, "hand_l", "lookWood", shapes, { at: [0, 0, -0.9] }),
        part(`${g}_string`, g, "lookLeather", [cap([0.6, 0, -9.8], [0.6, 0, 9.8], 0.18)], {
          bias: 0.3,
        }),
      ];
    },
    // Upright in every frame: carried at the side, raised and drawn.
    grip: {
      hand: "l",
      pitch: fixedGrip(0, {
        idle: [0],
        walk: [0],
        attack: [0],
        shoot: [0],
        cast: [20],
        death: [10, 30, 70, 90],
      }),
    },
  },
  crossbow: {
    parts: (g) => [
      part(
        g,
        "hand_r",
        "lookWood",
        [{ type: "box", min: [-0.7, -0.5, -8.6], max: [0.7, 0.5, 2.6] }],
        { at: [0, 0, -0.9] },
      ),
      part(
        `${g}_prod`,
        g,
        "lookMetal",
        [
          cap([0.6, -4.2, -8.0], [-0.4, 0, -8.6], 0.42),
          cap([-0.4, 0, -8.6], [0.6, 4.2, -8.0], 0.42),
        ],
        { shiny: true },
      ),
    ],
    // Hanging at rest; level and aimed in a shot.
    grip: { hand: "r", pitch: fixedGrip(35, { shoot: [90, 90, 92], attack: [200, 110, 60, 40] }) },
  },
};

// ---- The catalogue -----------------------------------------------------------------------

export const HAIR_STYLES = ["bald", ...Object.keys(HAIR)] as const;
export const BEARDS = ["none", ...Object.keys(BEARD)] as const;
export const SHAPES = {
  head: Object.keys(HEAD),
  torso: ["tunic", "robe", "leather", "mail", "plate"],
  legs: ["trousers", "greaves"],
  feet: ["shoes", "boots", "sabatons"],
  shield: ["buckler", "round", "kite", "tower"],
  weapon: Object.keys(WEAPONS),
} as const;

/**
 * The atlas path of a layer (the client builds the same: packages/renderer look.ts). The
 * body and the torso are drawn per body: a man's keep the paths they had, a woman's end in
 * _female.
 */
export function layerSprite(slot: LayerSlot, shape: string, build?: Build, sex?: Sex): string {
  const her = sex === "female" ? "_female" : "";
  if (slot === "body") return `humans/body_${shape}${her}`;
  if (slot === "hair" || slot === "beard") return `humans/${slot}_${shape}`;
  if (slot === "torso") return `worn/torso_${shape}_${build ?? "sturdy"}${her}`;
  return `worn/${slot}_${shape}`;
}

/** Every layer the engine draws, in a stable order. */
export function layerDefs(): LayerDef[] {
  const out: LayerDef[] = [];
  for (const sex of SEXES)
    for (const build of BUILDS)
      out.push({
        slot: "body",
        shape: build,
        sprite: layerSprite("body", build, build, sex),
        build,
        sex,
        parts: [],
      });
  for (const [style, shapes] of Object.entries(HAIR))
    out.push({
      slot: "hair",
      shape: style,
      sprite: layerSprite("hair", style),
      build: "sturdy",
      sex: "male",
      parts: [part(`hair_${style}`, "head", "lookHair", shapes, { texture: HAIR_TEXTURE })],
    });
  for (const [b, shapes] of Object.entries(BEARD))
    out.push({
      slot: "beard",
      shape: b,
      sprite: layerSprite("beard", b),
      build: "sturdy",
      sex: "male",
      parts: [part(`beard_${b}`, "head", "lookHair", shapes, { texture: HAIR_TEXTURE })],
    });
  for (const [shape, h] of Object.entries(HEAD))
    out.push({
      slot: "head",
      shape,
      sprite: layerSprite("head", shape),
      build: "sturdy",
      sex: "male",
      parts: [
        part(`head_${shape}`, "head", h.material, h.shapes, {
          ...(h.shiny ? { shiny: true } : {}),
          ...(h.texture ? { texture: h.texture } : {}),
        }),
      ],
    });
  for (const shape of SHAPES.torso)
    for (const sex of SEXES)
      for (const build of BUILDS)
        out.push({
          slot: "torso",
          shape,
          sprite: layerSprite("torso", shape, build, sex),
          build,
          sex,
          parts: torsoParts(shape, { build, sex }),
          // A skirt hides the legs: they never pierce it.
          occlude: BODY_PARTS.filter((p) => !LEG_PARTS.includes(p)),
        });
  for (const shape of SHAPES.legs)
    out.push({
      slot: "legs",
      shape,
      sprite: layerSprite("legs", shape),
      build: "sturdy",
      sex: "male",
      parts: legParts(shape),
    });
  for (const shape of SHAPES.feet)
    out.push({
      slot: "feet",
      shape,
      sprite: layerSprite("feet", shape),
      build: "sturdy",
      sex: "male",
      parts: feetParts(shape),
    });
  for (const shape of SHAPES.shield)
    out.push({
      slot: "shield",
      shape,
      sprite: layerSprite("shield", shape),
      build: "sturdy",
      sex: "male",
      parts: shieldParts(shape),
    });
  for (const [shape, w] of Object.entries(WEAPONS))
    out.push({
      slot: "weapon",
      shape,
      sprite: layerSprite("weapon", shape),
      build: "sturdy",
      sex: "male",
      parts: w.parts(`grip_${shape}`),
      grip: w.grip,
    });
  return out;
}
