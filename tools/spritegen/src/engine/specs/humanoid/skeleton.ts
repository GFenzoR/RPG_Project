// The engine humanoid (docs/17 "Humanoides del motor"): one skeleton for players, NPCs and
// humanoid monsters, in two builds, with the actions of today's player (idle, walk, attack,
// shoot, cast, death). Built facing west like every engine creature (its nose toward -x, its
// right side north, +y). Units are sprite pixels; the feet stand on z = 0.
//
// Proportions (the owner, 2026-11-19: "quiero que sea proporcionado"): a figure 36-40 px
// from the feet to the crown, the head about a sixth of it, shoulders 12-13 px across, legs
// half the height, the fingertips at mid-thigh. Both builds share every joint, so one
// drawing of a helmet, a sword or a pair of boots fits both; they differ in the trunk (chest,
// waist, hips) and the thickness of the limbs, and the torso clothes are drawn per build.
//
// A man or a woman (the owner, 2026-11-20: "el personaje principal puede ser hombre o
// mujer"): the same skeleton again, every joint where it is, so every worn layer but the
// torso fits the four bodies. The woman's trunk has narrower shoulders, a waist and a hip
// line wider than it, a chest suggested by two soft swells, slimmer limbs and neck and a
// smaller, rounder jaw; her torso clothes are drawn on her body (layers.ts). Her height
// is the man's: the joints are shared, and a shorter skeleton would ask for a second
// drawing of every helmet, weapon, boot and hair style.
import type { JointPose, KeySpec, PartSpec, ShapeSpec } from "../../spec.ts";

export type Build = "sturdy" | "slender";
export const BUILDS: readonly Build[] = ["sturdy", "slender"];
export type Sex = "male" | "female";
export const SEXES: readonly Sex[] = ["male", "female"];

type V3 = [number, number, number];

/**
 * The trunk and limbs of a body (px): radii of the belly (the waist), the chest, the
 * shoulders' line (its half width and thickness), the hips, the limbs and the neck. The
 * torso clothes fit these (layers.ts trunkShell).
 */
export interface Trunk {
  belly: V3;
  chest: V3;
  shoulderY: number;
  shoulder: number;
  /** The pelvis' half width and half depth. */
  hips: number;
  hipsX: number;
  /** Upper arm and forearm radii (at the shoulder and at the elbow). */
  arm: number;
  arm2: number;
  fore: number;
  fore2: number;
  thigh: number;
  thigh2: number;
  shin: number;
  neck: number;
  /** A woman's chest: two soft swells at the front (none for a man). */
  bust?: { center: V3; radii: V3 };
}

export const TRUNKS: Readonly<Record<Sex, Readonly<Record<Build, Trunk>>>> = {
  male: {
    sturdy: {
      belly: [2.3, 3.5, 2.8],
      chest: [2.8, 4.6, 3.0],
      shoulderY: 3.8,
      shoulder: 1.5,
      hips: 3.8,
      hipsX: 2.5,
      arm: 1.4,
      arm2: 1.2,
      fore: 1.2,
      fore2: 1.0,
      thigh: 2.0,
      thigh2: 1.55,
      shin: 1.45,
      neck: 1.25,
    },
    slender: {
      belly: [2.3, 2.9, 2.8],
      chest: [2.6, 4.1, 3.0],
      shoulderY: 3.0,
      shoulder: 1.2,
      hips: 3.4,
      hipsX: 2.5,
      arm: 1.2,
      arm2: 1.05,
      fore: 1.05,
      fore2: 0.9,
      thigh: 1.8,
      thigh2: 1.45,
      shin: 1.35,
      neck: 1.1,
    },
  },
  female: {
    sturdy: {
      belly: [2.1, 2.4, 2.6],
      chest: [2.5, 3.7, 2.7],
      shoulderY: 2.9,
      shoulder: 1.2,
      hips: 4.0,
      hipsX: 2.7,
      arm: 1.2,
      arm2: 1.05,
      fore: 1.05,
      fore2: 0.88,
      thigh: 2.0,
      thigh2: 1.5,
      shin: 1.38,
      neck: 1.05,
      bust: { center: [-1.95, 1.2, 5.0], radii: [1.2, 1.2, 1.0] },
    },
    slender: {
      belly: [2.0, 2.1, 2.6],
      chest: [2.3, 3.3, 2.7],
      shoulderY: 2.5,
      shoulder: 1.05,
      hips: 3.65,
      hipsX: 2.6,
      arm: 1.08,
      arm2: 0.95,
      fore: 0.95,
      fore2: 0.82,
      thigh: 1.85,
      thigh2: 1.42,
      shin: 1.3,
      neck: 0.98,
      bust: { center: [-1.8, 1.1, 5.0], radii: [1.1, 1.1, 0.95] },
    },
  },
};

/** A woman's chest swells, `by` px out from the skin (none for a man). */
export function bustShapes(t: Trunk, by: number): ShapeSpec[] {
  if (!t.bust) return [];
  const [x, y, z] = t.bust.center;
  const r: V3 = [t.bust.radii[0] + by, t.bust.radii[1] + by, t.bust.radii[2] + by];
  return [
    { type: "ellipsoid", center: [x, y, z], radii: r },
    { type: "ellipsoid", center: [x, -y, z], radii: r },
  ];
}

/** Joint heights and lengths (px), the same for both builds. */
export const BONES = {
  /** Hip joints above the ground and apart from the middle. */
  hip: 18.1,
  hipY: 2.2,
  thigh: 8.5,
  /** Knee to ankle: the ankle stands 1.9 px up, the sole of the foot on the ground. */
  shin: 7.7,
  /** The torso joint (the waist) above the hips. */
  waist: 1.6,
  /** Shoulder joints above the waist and apart from the middle. */
  shoulderZ: 7.0,
  shoulderY: 4.8,
  upperArm: 5.7,
  forearm: 5.0,
  /** The neck's base above the waist; the head's joint above the neck's base. */
  neckZ: 8.4,
  headZ: 1.8,
} as const;

/** Hip to ankle: the leg the walk's stride is measured against. */
export const LEG = BONES.thigh + BONES.shin;
/** Ankle height over the ground (the foot's sole at z = 0). */
export const ANKLE = BONES.hip - LEG;

/** The body's parts, in declaration order (a parent before its children). */
export const BODY_PARTS = [
  "pelvis",
  "torso",
  "neck",
  "head",
  "arm_r",
  "forearm_r",
  "hand_r",
  "arm_l",
  "forearm_l",
  "hand_l",
  "thigh_r",
  "shin_r",
  "foot_r",
  "thigh_l",
  "shin_l",
  "foot_l",
] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

/** The legs, which a long skirt does not let poke through it (layer.occlude leaves them out). */
export const LEG_PARTS: readonly BodyPart[] = [
  "thigh_r",
  "shin_r",
  "foot_r",
  "thigh_l",
  "shin_l",
  "foot_l",
];

/** The bare body of a sex and build: skin (tinted at runtime), eyes, nothing worn. */
export function bodyParts(build: Build, sex: Sex = "male"): PartSpec[] {
  const t = TRUNKS[sex][build];
  const female = sex === "female";
  const arm = (side: 1 | -1): PartSpec[] => {
    const k = side === 1 ? "r" : "l";
    return [
      {
        name: `arm_${k}`,
        parent: "torso",
        at: [0, side * BONES.shoulderY, BONES.shoulderZ],
        // The arms hang a little away from the body.
        rot: [side * 5, 0, 0],
        material: "lookSkin",
        shapes: [
          {
            type: "capsule",
            a: [0, 0, 0],
            b: [0, 0, -BONES.upperArm],
            radius: t.arm,
            radius2: t.arm2,
          },
        ],
      },
      {
        name: `forearm_${k}`,
        parent: `arm_${k}`,
        at: [0, 0, -BONES.upperArm],
        rot: [0, 8, 0],
        material: "lookSkin",
        shapes: [
          {
            type: "capsule",
            a: [0, 0, 0],
            b: [0, 0, -BONES.forearm],
            radius: t.fore,
            radius2: t.fore2,
          },
        ],
      },
      {
        name: `hand_${k}`,
        parent: `forearm_${k}`,
        at: [0, 0, -BONES.forearm],
        material: "lookSkin",
        shapes: [
          {
            type: "ellipsoid",
            center: [0, 0, -0.9],
            radii: female ? [1.0, 0.82, 1.15] : [1.1, 0.9, 1.25],
          },
        ],
      },
    ];
  };
  const leg = (side: 1 | -1): PartSpec[] => {
    const k = side === 1 ? "r" : "l";
    return [
      {
        name: `thigh_${k}`,
        parent: "pelvis",
        at: [0, side * BONES.hipY, 0],
        material: "lookSkin",
        shapes: [
          {
            type: "capsule",
            a: [0, 0, 0],
            b: [0, 0, -BONES.thigh],
            radius: t.thigh,
            radius2: t.thigh2,
          },
        ],
      },
      {
        name: `shin_${k}`,
        parent: `thigh_${k}`,
        at: [0, 0, -BONES.thigh],
        material: "lookSkin",
        shapes: [
          {
            type: "capsule",
            a: [0, 0, 0],
            b: [0, 0, -BONES.shin],
            radius: t.shin,
            radius2: female ? 1.02 : 1.1,
          },
        ],
      },
      {
        name: `foot_${k}`,
        parent: `shin_${k}`,
        at: [0, 0, -BONES.shin],
        material: "lookSkin",
        // Heel under the ankle, toes forward (-x); the sole on the ground.
        shapes: [
          { type: "capsule", a: [0.5, 0, -ANKLE / 2], b: [-2.3, 0, -ANKLE / 2], radius: 0.95 },
        ],
      },
    ];
  };
  return [
    {
      name: "pelvis",
      at: [0, 0, BONES.hip],
      material: "lookSkin",
      shapes: [{ type: "ellipsoid", center: [0, 0, 0.6], radii: [t.hipsX, t.hips, 2.3] }],
    },
    {
      name: "torso",
      parent: "pelvis",
      at: [0, 0, BONES.waist],
      material: "lookSkin",
      shapes: [
        // The belly and the waist, narrower on the slender build (and on a woman).
        { type: "ellipsoid", center: [0, 0, 2.0], radii: t.belly },
        // The chest, and the shoulders' line across it.
        { type: "ellipsoid", center: [-0.2, 0, 5.2], radii: t.chest },
        {
          type: "capsule",
          a: [0, -t.shoulderY, BONES.shoulderZ],
          b: [0, t.shoulderY, BONES.shoulderZ],
          radius: t.shoulder,
        },
        ...bustShapes(t, 0),
      ],
    },
    {
      name: "neck",
      parent: "torso",
      at: [-0.2, 0, BONES.neckZ],
      material: "lookSkin",
      shapes: [{ type: "capsule", a: [0, 0, -0.6], b: [-0.2, 0, 1.6], radius: t.neck }],
    },
    {
      name: "head",
      parent: "neck",
      at: [-0.2, 0, BONES.headZ],
      material: "lookSkin",
      shapes: [
        // The skull, the jaw and chin, the nose and the ears. A woman's jaw is smaller and
        // rounder, her nose a little smaller.
        {
          type: "ellipsoid",
          center: [-0.2, 0, 3.2],
          radii: female ? [2.95, 2.7, 2.9] : [3.0, 2.75, 2.95],
        },
        female
          ? { type: "ellipsoid", center: [-1.0, 0, 1.75], radii: [1.8, 1.75, 1.3] }
          : { type: "ellipsoid", center: [-1.1, 0, 1.5], radii: [2.0, 2.05, 1.4] },
        {
          type: "ellipsoid",
          center: female ? [-3.0, 0, 2.45] : [-3.1, 0, 2.4],
          radii: female ? [0.5, 0.38, 0.55] : [0.6, 0.45, 0.7],
          bias: 0.08,
        },
        { type: "ellipsoid", center: [0, 2.7, 2.6], radii: [0.7, 0.5, 0.9] },
        { type: "ellipsoid", center: [0, -2.7, 2.6], radii: [0.7, 0.5, 0.9] },
      ],
      marks: [
        { at: [-2.8, 1.1, 3.5], material: "eye" },
        { at: [-2.8, -1.1, 3.5], material: "eye" },
      ],
    },
    ...arm(1),
    ...arm(-1),
    ...leg(1),
    ...leg(-1),
  ];
}

// ---- Poses -------------------------------------------------------------------------------

type Pose = Record<string, JointPose>;
const deg = (r: number): number => (r * 180) / Math.PI;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Where a foot goes, relative to its hip: `fwd` px forward (+) or back (-) and `lift` px off
 * the ground (its sole); `pitch` tilts it (+ toes up).
 */
export interface FootTarget {
  fwd: number;
  lift?: number;
  pitch?: number;
}

/**
 * Two-bone inverse kinematics for both legs (sagittal plane, knees forward): the thigh and
 * shin turns that put each ankle where its foot target says with the hips `drop` px lower
 * than standing, and the foot turned back flat (plus its pitch). Returns the pelvis move and
 * the joint turns, as key poses.
 */
export function legsTo(right: FootTarget, left: FootTarget, drop = 0): Pose {
  const out: Pose = { pelvis: { move: [0, 0, r2(-drop)] } };
  const leg = (k: "r" | "l", t: FootTarget): void => {
    const L1 = BONES.thigh;
    const L2 = BONES.shin;
    // The ankle relative to the hip: forward and down.
    const f = t.fwd;
    const h = BONES.hip - drop - (ANKLE + (t.lift ?? 0));
    let d = Math.hypot(f, h);
    const reach = (L1 + L2) * 0.999;
    const scaleBy = d > reach ? reach / d : 1;
    const ff = f * scaleBy;
    const hh = h * scaleBy;
    d = Math.min(d, reach);
    const phi = Math.atan2(ff, hh);
    const alpha = Math.acos(Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
    const a1 = phi + alpha;
    // The knee, then the shin's global angle down to the ankle.
    const kf = L1 * Math.sin(a1);
    const kh = L1 * Math.cos(a1);
    const s = Math.atan2(ff - kf, hh - kh);
    out[`thigh_${k}`] = { rot: [0, r2(deg(a1)), 0] };
    out[`shin_${k}`] = { rot: [0, r2(deg(s - a1)), 0] };
    out[`foot_${k}`] = { rot: [0, r2(-deg(s) + (t.pitch ?? 0)), 0] };
  };
  leg("r", right);
  leg("l", left);
  return out;
}

/** Adds poses part by part (rotations and moves add up). */
export function addPoses(...poses: Pose[]): Pose {
  const out: Record<string, { rot: [number, number, number]; move: [number, number, number] }> = {};
  for (const p of poses)
    for (const [part, j] of Object.entries(p)) {
      const cur = out[part] ?? { rot: [0, 0, 0], move: [0, 0, 0] };
      for (let i = 0; i < 3; i++) {
        cur.rot[i] = r2((cur.rot[i] ?? 0) + (j.rot?.[i] ?? 0));
        cur.move[i] = r2((cur.move[i] ?? 0) + (j.move?.[i] ?? 0));
      }
      out[part] = cur;
    }
  return out;
}

const pitch = (deg: number): JointPose => ({ rot: [0, deg, 0] });

/**
 * The walk (docs/17 "La regla de la zancada"): a full cycle per tile walked, `frames` frames.
 * Each foot is planted for half the cycle, during which the body passes over it by half a
 * tile (`STRIDE` px); frames are sampled half a frame off the contact, so every frame has
 * exactly one foot planted, at fwd = +6, +2, -2, -6 of the hip with 8 frames: it moves back
 * exactly as far as the body moves forward between two frames (the spritegen test measures
 * it). The hips drop where the planted leg reaches furthest (the dip at contact) and rise as
 * it passes under them; the arms swing against the legs; the trunk leans a little forward.
 */
export const WALK_FRAMES = 8;
/** Px the body travels while one foot is planted: half a tile (two steps per tile). */
export const STRIDE = 16;
/** A tile, px: the distance one step moves a creature (a straight one). */
export const TILE = 32;
/** Frames per tile walked: one cycle covers two strides (with STRIDE 16, a tile). */
export const walkPerTile = (frames: number, stride: number): number =>
  (frames * TILE) / (2 * stride);

export function walkKeys(frames = WALK_FRAMES): KeySpec[] {
  const keys: KeySpec[] = [];
  const half = STRIDE / 2;
  const lift = 2.2;
  for (let f = 0; f < frames; f++) {
    const t = (f + 0.5) / frames;
    const foot = (phase: number): FootTarget & { fwd: number; planted: boolean } => {
      const p = (t + phase) % 1;
      if (p < 0.5) return { fwd: half - STRIDE * (p / 0.5), planted: true };
      // Swinging: forward with an ease, lifted most halfway, toes a little down at first.
      const u = (p - 0.5) / 0.5;
      const ease = u * u * (3 - 2 * u);
      return {
        fwd: -half + STRIDE * ease,
        lift: lift * Math.sin(Math.PI * u),
        pitch: -14 * Math.sin(Math.PI * u) * (1 - u),
        planted: false,
      };
    };
    const right = foot(0);
    const left = foot(0.5);
    // The hips as high as the planted leg lets them, the knee a hair bent.
    const planted = right.planted ? right : left;
    const reach = LEG * 0.985;
    const drop = BONES.hip - ANKLE - Math.sqrt(reach * reach - planted.fwd * planted.fwd);
    // Arms against the legs: the right arm back when the right foot is forward.
    const swing = 22;
    const armR = -swing * (right.fwd / half);
    const armL = -swing * (left.fwd / half);
    keys.push({
      at: f / frames,
      pose: addPoses(legsTo(right, left, drop), {
        torso: pitch(-4),
        head: pitch(3),
        arm_r: pitch(armR),
        arm_l: pitch(armL),
        forearm_r: pitch(Math.max(0, armR) * 0.6 + 4),
        forearm_l: pitch(Math.max(0, armL) * 0.6 + 4),
      }),
    });
  }
  return keys;
}

/** Breathing: the trunk rises a little, the arms follow. */
export const IDLE_KEYS: KeySpec[] = [
  { at: 0, pose: {} },
  { at: 0.5, pose: { torso: { move: [0, 0, 0.6] }, arm_r: pitch(-2), arm_l: pitch(-2) } },
];

const stance = (fwdR: number, fwdL: number, drop: number): Pose =>
  legsTo({ fwd: fwdR }, { fwd: fwdL }, drop);

/**
 * A melee blow with the right hand (4 frames): wind-up with the arm raised behind the head,
 * the strike forward and down with a half step and the trunk following, the follow-through
 * low, and back. The left arm brings its shield forward. The weapon's own arc (an axe's
 * chop, a spear's thrust) is its grip's turn per frame (layers.ts).
 */
export const ATTACK_KEYS: KeySpec[] = [
  {
    at: 0,
    pose: addPoses(stance(-3, 3, 0.4), {
      torso: pitch(7),
      head: pitch(-4),
      arm_r: pitch(195),
      forearm_r: pitch(40),
      arm_l: pitch(35),
      forearm_l: pitch(55),
    }),
  },
  {
    at: 1 / 3,
    pose: addPoses(stance(-4, 4, 0.9), {
      "*": { move: [-1, 0, 0] },
      torso: pitch(-9),
      head: pitch(6),
      arm_r: pitch(105),
      forearm_r: pitch(0),
      arm_l: pitch(20),
      forearm_l: pitch(45),
    }),
  },
  {
    at: 2 / 3,
    pose: addPoses(stance(-4, 4, 0.9), {
      "*": { move: [-1, 0, 0] },
      torso: pitch(-12),
      head: pitch(8),
      arm_r: pitch(40),
      forearm_r: pitch(-6),
      arm_l: pitch(12),
      forearm_l: pitch(35),
    }),
  },
  {
    at: 1,
    pose: addPoses(stance(-2, 2, 0.3), {
      torso: pitch(-3),
      arm_r: pitch(14),
      forearm_r: pitch(12),
      arm_l: pitch(8),
      forearm_l: pitch(20),
    }),
  },
];

/**
 * A shot (3 frames): the left arm brings the bow (or the crossbow's front) up and forward,
 * the right hand draws back to the cheek, and lets go. A crossbow sits at the right hand,
 * level, its front over the left (layers.ts).
 */
export const SHOOT_KEYS: KeySpec[] = [
  {
    at: 0,
    pose: addPoses(stance(-3, 3, 0.4), {
      arm_l: pitch(82),
      forearm_l: pitch(4),
      arm_r: pitch(70),
      forearm_r: pitch(35),
    }),
  },
  {
    at: 0.5,
    pose: addPoses(stance(-3, 3, 0.5), {
      torso: pitch(2),
      arm_l: pitch(90),
      forearm_l: pitch(-4),
      arm_r: pitch(-70),
      forearm_r: pitch(150),
    }),
  },
  {
    at: 1,
    pose: addPoses(stance(-3, 3, 0.5), {
      torso: pitch(4),
      head: pitch(-3),
      arm_l: pitch(90),
      forearm_l: pitch(-4),
      arm_r: pitch(-95),
      forearm_r: pitch(125),
    }),
  },
];

/** A spell (3 frames): both arms rise forward, high, and thrust out. */
export const CAST_KEYS: KeySpec[] = [
  {
    at: 0,
    pose: addPoses(stance(-2, 2, 0.3), {
      torso: pitch(3),
      arm_r: pitch(125),
      forearm_r: pitch(20),
      arm_l: pitch(125),
      forearm_l: pitch(20),
    }),
  },
  {
    at: 0.5,
    pose: addPoses(stance(-2, 2, 0.2), {
      torso: pitch(7),
      head: pitch(-8),
      arm_r: { rot: [-12, 165, 0] },
      forearm_r: pitch(8),
      arm_l: { rot: [12, 165, 0] },
      forearm_l: pitch(8),
    }),
  },
  {
    at: 1,
    pose: addPoses(stance(-4, 4, 0.9), {
      "*": { move: [-1, 0, 0] },
      torso: pitch(-8),
      head: pitch(5),
      arm_r: pitch(92),
      forearm_r: pitch(-6),
      arm_l: pitch(92),
      forearm_l: pitch(-6),
    }),
  },
];

/**
 * Death (4 frames, drawn in the four straight facings: index.ts HUMANOID_DEATH_DIRS): it
 * reels back with its arms thrown out, the knees give way, it tips over and lies on its side.
 */
export const DEATH_KEYS: KeySpec[] = [
  {
    at: 0,
    pose: addPoses(stance(1, -1, 1.2), {
      torso: pitch(12),
      head: pitch(-14),
      arm_r: { rot: [35, 20, 0] },
      arm_l: { rot: [-35, 20, 0] },
      forearm_r: pitch(20),
      forearm_l: pitch(20),
    }),
  },
  {
    at: 1 / 3,
    pose: addPoses(legsTo({ fwd: 2 }, { fwd: -1 }, 5), {
      torso: pitch(-16),
      head: pitch(14),
      arm_r: { rot: [12, -8, 0] },
      arm_l: { rot: [-12, -8, 0] },
    }),
  },
  {
    at: 2 / 3,
    pose: addPoses(legsTo({ fwd: 2 }, { fwd: -1 }, 5), {
      "*": { rot: [48, 0, 0], move: [0, 6, 3.6] },
      torso: pitch(-14),
      head: { rot: [-10, 10, 0] },
      arm_r: { rot: [30, -20, 0] },
      arm_l: { rot: [-20, 15, 0] },
    }),
  },
  {
    at: 1,
    pose: addPoses(legsTo({ fwd: 3 }, { fwd: 1 }, 1), {
      // On its left side: the arms fold over the body (+y is up once it lies down).
      "*": { rot: [90, 0, 0], move: [0, 15.5, 5.6] },
      torso: pitch(-6),
      head: { rot: [12, 6, 0] },
      arm_r: { rot: [10, 35, 0] },
      arm_l: { rot: [30, 20, 0] },
      forearm_l: pitch(30),
    }),
  },
];
