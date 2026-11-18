// Motion helpers: they turn a few numbers into keyframes (plain data), so a spec does not
// hand-place every leg of every frame. A spec can always write its keys itself instead.
import type { Vec3 } from "./math.ts";
import type { ActionSpec, JointPose, KeySpec } from "./spec.ts";

type Pose = Record<string, JointPose>;

/** Adds b's rotation and translation onto a's, part by part. */
export function mergePoses(...poses: Pose[]): Pose {
  const out: Record<string, { rot: [number, number, number]; move: [number, number, number] }> = {};
  for (const p of poses)
    for (const [part, j] of Object.entries(p)) {
      const cur = out[part] ?? { rot: [0, 0, 0], move: [0, 0, 0] };
      for (let i = 0; i < 3; i++) {
        cur.rot[i] = (cur.rot[i] ?? 0) + (j.rot?.[i] ?? 0);
        cur.move[i] = (cur.move[i] ?? 0) + (j.move?.[i] ?? 0);
      }
      out[part] = cur;
    }
  return out;
}

/** The legs of a four-legged rig: each turns about its hip (y axis: + swings it forward). */
export interface QuadrupedLegs {
  frontLeft: string;
  frontRight: string;
  backLeft: string;
  backRight: string;
}

/**
 * A four-legged trot (docs/17 ANI-2: 4 frames, two per tile): the legs move in diagonal pairs
 * (front left with back right), each reaching `swing` degrees forward and back, and lifted
 * `lift` px while it swings forward. The body rises `bob` px when the legs pass under it.
 * `extra(t)` adds the pose of other parts at cycle time t (a nodding head, a swaying tail).
 */
export function trot(o: {
  legs: QuadrupedLegs;
  swing: number;
  lift: number;
  bob?: number;
  frames?: number;
  extra?: (t: number) => Pose;
}): ActionSpec {
  const frames = o.frames ?? 4;
  const pairs: [string, number][] = [
    [o.legs.frontLeft, 0],
    [o.legs.backRight, 0],
    [o.legs.frontRight, 0.5],
    [o.legs.backLeft, 0.5],
  ];
  const keys: KeySpec[] = [];
  for (let f = 0; f < frames; f++) {
    const t = f / frames;
    const pose: Pose = {};
    for (const [leg, phase] of pairs) {
      const a = 2 * Math.PI * (t + phase);
      pose[leg] = {
        rot: [0, round(o.swing * Math.cos(a)), 0],
        move: [0, 0, round(o.lift * Math.max(0, -Math.sin(a)))],
      };
    }
    pose["*"] = { move: [0, 0, round((o.bob ?? 0) * Math.abs(Math.sin(2 * Math.PI * t)))] };
    keys.push({ at: t, pose: mergePoses(pose, o.extra?.(t) ?? {}) });
  }
  return { frames, keys };
}

/** A two-legged or legless walk is the same idea with one pair: see the specs. */
export const round = (v: number): number => Math.round(v * 100) / 100;

/** A keyframe list from [at, pose] pairs. */
export const keys = (...list: [number, Pose][]): KeySpec[] =>
  list.map(([at, pose]) => ({ at, pose }));

/** Shorthands for a joint pose. */
export const turn = (x: number, y: number, z: number): JointPose => ({ rot: [x, y, z] });
export const shift = (x: number, y: number, z: number): JointPose => ({ move: [x, y, z] });
export const pose = (rot: Vec3, move: Vec3): JointPose => ({ rot, move });
