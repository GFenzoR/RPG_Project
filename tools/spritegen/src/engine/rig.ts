// The rig: where every part of a spec is for one frame of one action and facing. Keyframes
// are interpolated per part (linear in rotation and translation; a looping action wraps from
// its last key to its first), joints compose parent to child, and the whole model turns
// about the vertical for each facing (ANI-1, style.ts FACING_YAW).
import { add, compose, euler, IDENTITY_TRANSFORM, lerp3, mul, rotZ, ZERO } from "./math.ts";
import type { Transform, Vec3 } from "./math.ts";
import type { ActionSpec, JointPose, SpriteSpec } from "./spec.ts";
import { ACTIONS, FACING_YAW } from "./style.ts";
import type { ActionName, Dir } from "./style.ts";

/** Where frame f of n falls in its action: f/n when it loops, f/(n-1) when it plays once. */
export function frameTime(action: ActionName, f: number, frames: number): number {
  if (ACTIONS[action].loop) return f / frames;
  return frames <= 1 ? 0 : f / (frames - 1);
}

/** The pose of every moving part (and "*") at time t of an action. */
export function poseAt(
  a: ActionSpec,
  t: number,
  loop: boolean,
): Map<string, { rot: Vec3; move: Vec3 }> {
  const keys = a.keys;
  const out = new Map<string, { rot: Vec3; move: Vec3 }>();
  if (keys.length === 0) return out;
  // The keys around t.
  let i1 = keys.findIndex((k) => k.at > t);
  let i0: number;
  let span: number;
  let local: number;
  if (i1 === -1 || (i1 === 0 && !loop)) {
    // Past the last key (or before the first one of a one-shot).
    if (!loop) {
      const k = i1 === 0 ? 0 : keys.length - 1;
      i0 = k;
      i1 = k;
      span = 1;
      local = 0;
    } else {
      i0 = keys.length - 1;
      i1 = 0;
      span = (keys[0]?.at ?? 0) + 1 - (keys[i0]?.at ?? 0);
      local = t - (keys[i0]?.at ?? 0);
    }
  } else if (i1 === 0) {
    // Before the first key of a loop: between the last key (a cycle back) and the first.
    i0 = keys.length - 1;
    span = (keys[0]?.at ?? 0) + 1 - (keys[i0]?.at ?? 0);
    local = t + 1 - (keys[i0]?.at ?? 0);
  } else {
    i0 = i1 - 1;
    span = (keys[i1]?.at ?? 0) - (keys[i0]?.at ?? 0);
    local = t - (keys[i0]?.at ?? 0);
  }
  const u = span > 0 ? Math.min(1, Math.max(0, local / span)) : 0;
  const k0 = keys[i0]?.pose ?? {};
  const k1 = keys[i1]?.pose ?? {};
  const parts = new Set([...Object.keys(k0), ...Object.keys(k1)]);
  for (const p of parts) {
    const a0: JointPose = k0[p] ?? {};
    const a1: JointPose = k1[p] ?? {};
    out.set(p, {
      rot: lerp3(a0.rot ?? ZERO, a1.rot ?? ZERO, u),
      move: lerp3(a0.move ?? ZERO, a1.move ?? ZERO, u),
    });
  }
  return out;
}

/**
 * The model-to-view transform of every part (in spec order) for a pose and a facing: each
 * part sits at its joint (`at` plus the pose's `move`) in its parent's frame, turned by its
 * rest rotation and then by the pose's (in the rest-turned frame). Without a facing (an
 * object) the model is drawn as built: x to the right, y away from the camera.
 */
export function partTransforms(
  spec: SpriteSpec,
  pose: Map<string, { rot: Vec3; move: Vec3 }>,
  dir?: Dir,
): Transform[] {
  const yaw = dir ? FACING_YAW[dir] + (spec.views?.[dir] ?? 0) : 0;
  const whole = pose.get("*");
  const view: Transform = { rot: rotZ(yaw), pos: ZERO };
  const model = compose(
    view,
    whole ? { rot: euler(whole.rot), pos: whole.move } : IDENTITY_TRANSFORM,
  );
  const byName = new Map<string, Transform>();
  return spec.parts.map((p) => {
    const parent = p.parent ? (byName.get(p.parent) ?? model) : model;
    const own = pose.get(p.name);
    const local: Transform = {
      rot: own ? mul(euler(p.rot ?? ZERO), euler(own.rot)) : euler(p.rot ?? ZERO),
      pos: add(p.at ?? ZERO, own?.move ?? ZERO),
    };
    const t = compose(parent, local);
    byName.set(p.name, t);
    return t;
  });
}

/** The rest pose of a static sprite (an object) or of a creature with no action given. */
export const REST = new Map<string, { rot: Vec3; move: Vec3 }>();
