// Small 3D helpers for the sprite engine: vectors as [x, y, z] tuples and rotation matrices
// as 9 numbers, row-major. Model space: x east (right on screen), y north (away from the
// camera), z up. Angles are degrees in specs and radians only inside these helpers.

export type Vec3 = readonly [number, number, number];
/** A 3x3 rotation, row-major: [m00, m01, m02, m10, ..., m22]. */
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const ZERO: Vec3 = [0, 0, 0];
export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
}

export const rad = (deg: number): number => (deg * Math.PI) / 180;

/** a * b */
export function mul(a: Mat3, b: Mat3): Mat3 {
  const at = (m: Mat3, i: number, j: number): number => m[i * 3 + j] ?? 0;
  const c = (i: number, j: number): number =>
    at(a, i, 0) * at(b, 0, j) + at(a, i, 1) * at(b, 1, j) + at(a, i, 2) * at(b, 2, j);
  return [c(0, 0), c(0, 1), c(0, 2), c(1, 0), c(1, 1), c(1, 2), c(2, 0), c(2, 1), c(2, 2)];
}

/** m * v */
export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** transpose(m) * v: the inverse of a rotation applied to v. */
export function applyT(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** Rotation about x (roll for a model facing west), y (pitch), z (yaw), degrees. */
export function rotX(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(deg: number): Mat3 {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Euler angles [x, y, z] in degrees, applied x first, then y, then z: Rz * Ry * Rx. */
export function euler(r: Vec3): Mat3 {
  return mul(rotZ(r[2]), mul(rotY(r[1]), rotX(r[0])));
}

/** A rigid transform: p -> rot * p + pos. */
export interface Transform {
  rot: Mat3;
  pos: Vec3;
}

export const IDENTITY_TRANSFORM: Transform = { rot: IDENTITY, pos: ZERO };

/** parent ∘ child: child coordinates to the parent's parent. */
export function compose(parent: Transform, child: Transform): Transform {
  return { rot: mul(parent.rot, child.rot), pos: add(parent.pos, apply(parent.rot, child.pos)) };
}

export const toWorld = (t: Transform, p: Vec3): Vec3 => add(apply(t.rot, p), t.pos);
export const toLocal = (t: Transform, p: Vec3): Vec3 => applyT(t.rot, sub(p, t.pos));
