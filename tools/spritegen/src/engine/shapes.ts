// The engine's primitives: where an orthographic view ray first meets each one, and the
// surface normal there, in the shape's own (part-local) frame. Analytic for ellipsoids,
// boxes, cylinders and extrusions; a capsule (a limb, a neck, a tail, tapered or not) is a
// dense sweep of spheres, which shades like the real surface at sprite sizes.
import { add, dot, length, normalize, scale, sub } from "./math.ts";
import type { Vec3 } from "./math.ts";
import type { ShapeSpec } from "./spec.ts";

export interface Hit {
  /** Distance along the ray (the ray direction is a unit vector). */
  t: number;
  /** Unit surface normal, shape frame. */
  n: Vec3;
}

/** Axis-aligned bounds of a shape in its frame: [min, max]. */
export function shapeBounds(s: ShapeSpec): [Vec3, Vec3] {
  switch (s.type) {
    case "ellipsoid": {
      const c = s.center ?? [0, 0, 0];
      return [sub(c, s.radii), add(c, s.radii)];
    }
    case "box":
      return [s.min, s.max];
    case "cylinder":
    case "capsule": {
      const r = Math.max(s.radius, s.type === "capsule" ? (s.radius2 ?? s.radius) : s.radius);
      const lo: Vec3 = [
        Math.min(s.a[0], s.b[0]) - r,
        Math.min(s.a[1], s.b[1]) - r,
        Math.min(s.a[2], s.b[2]) - r,
      ];
      const hi: Vec3 = [
        Math.max(s.a[0], s.b[0]) + r,
        Math.max(s.a[1], s.b[1]) + r,
        Math.max(s.a[2], s.b[2]) + r,
      ];
      return [lo, hi];
    }
    case "extrusion":
    case "polygon": {
      const { from, to } = extent(s);
      const us = s.points.map((p) => p[0]);
      const vs = s.points.map((p) => p[1]);
      return [
        unplane(s.axis ?? "y", Math.min(...us), Math.min(...vs), from),
        unplane(s.axis ?? "y", Math.max(...us), Math.max(...vs), to),
      ];
    }
  }
}

/** The first hit of the ray o + t d (|d| = 1) with the shape, if any in front of o. */
export function intersect(s: ShapeSpec, o: Vec3, d: Vec3): Hit | undefined {
  switch (s.type) {
    case "ellipsoid":
      return ellipsoid(s.center ?? [0, 0, 0], s.radii, o, d);
    case "box":
      return box(s.min, s.max, o, d);
    case "cylinder":
      return cylinder(s.a, s.b, s.radius, o, d);
    case "capsule":
      return capsule(s, o, d);
    case "extrusion":
    case "polygon":
      return extrusion(s, o, d);
  }
}

function ellipsoid(c: Vec3, r: Vec3, o: Vec3, d: Vec3): Hit | undefined {
  // In the unit sphere's space: o' = (o - c) / r, d' = d / r.
  const oc: Vec3 = [(o[0] - c[0]) / r[0], (o[1] - c[1]) / r[1], (o[2] - c[2]) / r[2]];
  const dd: Vec3 = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(dd, dd);
  const b = dot(oc, dd);
  const k = dot(oc, oc) - 1;
  const h = b * b - a * k;
  if (h < 0) return undefined;
  const t = (-b - Math.sqrt(h)) / a;
  if (t < 0) return undefined;
  const p = add(o, scale(d, t));
  // The gradient of the implicit surface: (p - c) / r².
  return {
    t,
    n: normalize([
      (p[0] - c[0]) / (r[0] * r[0]),
      (p[1] - c[1]) / (r[1] * r[1]),
      (p[2] - c[2]) / (r[2] * r[2]),
    ]),
  };
}

function box(lo: Vec3, hi: Vec3, o: Vec3, d: Vec3): Hit | undefined {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = 0;
  let sign = -1;
  for (let i = 0; i < 3; i++) {
    const oi = o[i] ?? 0;
    const di = d[i] ?? 0;
    const l = lo[i] ?? 0;
    const h = hi[i] ?? 0;
    if (Math.abs(di) < 1e-9) {
      if (oi < l || oi > h) return undefined;
      continue;
    }
    let t0 = (l - oi) / di;
    let t1 = (h - oi) / di;
    let s = -1;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
      s = 1;
    }
    if (t0 > tNear) {
      tNear = t0;
      axis = i;
      sign = s;
    }
    tFar = Math.min(tFar, t1);
    if (tNear > tFar) return undefined;
  }
  if (tNear < 0) return undefined;
  const n: [number, number, number] = [0, 0, 0];
  n[axis] = sign;
  return { t: tNear, n };
}

/** A capped cylinder from a to b (Inigo Quilez's formulation). */
function cylinder(a: Vec3, b: Vec3, r: number, o: Vec3, d: Vec3): Hit | undefined {
  const ba = sub(b, a);
  const oc = sub(o, a);
  const baba = dot(ba, ba);
  const bard = dot(ba, d);
  const baoc = dot(ba, oc);
  const k2 = baba - bard * bard;
  const k1 = baba * dot(oc, d) - baoc * bard;
  const k0 = baba * dot(oc, oc) - baoc * baoc - r * r * baba;
  if (Math.abs(k2) > 1e-9) {
    const h = k1 * k1 - k2 * k0;
    if (h < 0) return undefined;
    const sh = Math.sqrt(h);
    const t = (-k1 - sh) / k2;
    const y = baoc + t * bard;
    if (y > 0 && y < baba && t >= 0) {
      const p = add(oc, scale(d, t));
      return { t, n: normalize(sub(p, scale(ba, y / baba))) };
    }
    // The caps.
    if (Math.abs(bard) < 1e-9) return undefined;
    const tc = ((y < 0 ? 0 : baba) - baoc) / bard;
    if (tc >= 0 && Math.abs(k1 + k2 * tc) < sh)
      return { t: tc, n: scale(normalize(ba), y < 0 ? -1 : 1) };
    return undefined;
  }
  // Looking straight down the axis: only a cap can be hit.
  if (Math.abs(bard) < 1e-9) return undefined;
  const near = bard > 0 ? 0 : baba;
  const tc = (near - baoc) / bard;
  const p = add(oc, scale(d, tc));
  const radial = sub(p, scale(ba, near / baba));
  if (tc < 0 || length(radial) > r) return undefined;
  return { t: tc, n: scale(normalize(ba), bard > 0 ? -1 : 1) };
}

function sphere(c: Vec3, r: number, o: Vec3, d: Vec3): Hit | undefined {
  const oc = sub(o, c);
  const b = dot(oc, d);
  const k = dot(oc, oc) - r * r;
  const h = b * b - k;
  if (h < 0) return undefined;
  const t = -b - Math.sqrt(h);
  if (t < 0) return undefined;
  return { t, n: normalize(sub(add(o, scale(d, t)), c)) };
}

type Capsule = Extract<ShapeSpec, { type: "capsule" }>;
const sweeps = new WeakMap<Capsule, { c: Vec3; r: number }[]>();

/** The spheres of a capsule's sweep, a quarter of the thinner radius apart. */
function sweepOf(s: Capsule): { c: Vec3; r: number }[] {
  const cached = sweeps.get(s);
  if (cached) return cached;
  const r2 = s.radius2 ?? s.radius;
  const len = length(sub(s.b, s.a));
  const step = Math.max(0.15, Math.min(s.radius, r2) / 4);
  const n = Math.max(1, Math.ceil(len / step));
  const out: { c: Vec3; r: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({
      c: add(s.a, scale(sub(s.b, s.a), t)),
      r: s.radius + (r2 - s.radius) * t,
    });
  }
  sweeps.set(s, out);
  return out;
}

function capsule(s: Capsule, o: Vec3, d: Vec3): Hit | undefined {
  let best: Hit | undefined;
  for (const sp of sweepOf(s)) {
    const h = sphere(sp.c, sp.r, o, d);
    if (h && (!best || h.t < best.t)) best = h;
  }
  return best;
}

type Prism = Extract<ShapeSpec, { type: "extrusion" | "polygon" }>;

/** The extent along the extrusion axis: polygons are thin cards centred on `at`. */
function extent(s: Prism): { from: number; to: number } {
  if (s.type === "extrusion") return { from: s.from, to: s.to };
  const half = (s.thickness ?? 1) / 2;
  return { from: (s.at ?? 0) - half, to: (s.at ?? 0) + half };
}

/**
 * The profile plane of an extrusion along `axis`: a 3D point to (u, v, w) with w along the
 * axis. Along y (the default) the profile is drawn as seen from the front (u = x, v = z);
 * along x as seen from the side (u = y, v = z); along z from above (u = x, v = y).
 */
function plane(axis: "x" | "y" | "z", p: Vec3): [number, number, number] {
  if (axis === "y") return [p[0], p[2], p[1]];
  if (axis === "x") return [p[1], p[2], p[0]];
  return [p[0], p[1], p[2]];
}
function unplane(axis: "x" | "y" | "z", u: number, v: number, w: number): Vec3 {
  if (axis === "y") return [u, w, v];
  if (axis === "x") return [w, u, v];
  return [u, v, w];
}

const centroids = new WeakMap<Prism, { cu: number; cv: number; hu: number; hv: number }>();
function centroidOf(s: Prism): { cu: number; cv: number; hu: number; hv: number } {
  const cached = centroids.get(s);
  if (cached) return cached;
  const us = s.points.map((p) => p[0]);
  const vs = s.points.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const out = {
    cu: (u0 + u1) / 2,
    cv: (v0 + v1) / 2,
    hu: Math.max(0.5, (u1 - u0) / 2),
    hv: Math.max(0.5, (v1 - v0) / 2),
  };
  centroids.set(s, out);
  return out;
}

/**
 * A 2D profile (u, v points) swept along an axis between `from` and `to`. The ray enters
 * either through the near cap or through a side wall; `bulge` tilts the cap's normal out
 * toward the profile's rim, so a flat card (a leaf, an ear, a flame) shades as if rounded.
 */
function extrusion(s: Prism, o3: Vec3, d3: Vec3): Hit | undefined {
  const axis = s.axis ?? "y";
  const { from, to } = extent(s);
  const o = plane(axis, o3);
  const d = plane(axis, d3);
  // The slab along the axis.
  let w0 = -Infinity;
  let w1 = Infinity;
  if (Math.abs(d[2]) < 1e-9) {
    if (o[2] < from || o[2] > to) return undefined;
  } else {
    const ta = (from - o[2]) / d[2];
    const tb = (to - o[2]) / d[2];
    w0 = Math.min(ta, tb);
    w1 = Math.max(ta, tb);
  }
  // Where the projected ray crosses the profile's edges (even-odd inside test).
  const pts = s.points;
  const crossings: { t: number; edge: number }[] = [];
  const moving = Math.abs(d[0]) > 1e-9 || Math.abs(d[1]) > 1e-9;
  if (moving) {
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i] ?? [0, 0];
      const [bx, by] = pts[(i + 1) % pts.length] ?? [0, 0];
      // Solve o + t d = a + s (b - a), 0 <= s < 1.
      const ex = bx - ax;
      const ey = by - ay;
      const den = d[0] * ey - d[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = ax - o[0];
      const qy = ay - o[1];
      const t = (qx * ey - qy * ex) / den;
      const u = (qx * d[1] - qy * d[0]) / den;
      if (u >= 0 && u < 1) crossings.push({ t, edge: i });
    }
    crossings.sort((p, q) => p.t - q.t);
  }
  const insideAt = (t: number): boolean => inPolygon(pts, o[0] + d[0] * t, o[1] + d[1] * t);
  // Candidate entry points: the slab's near face if the profile holds it there, then each
  // edge crossing that enters the profile within the slab.
  const tEnter = w0;
  if (Number.isFinite(tEnter) && tEnter >= 0 && insideAt(tEnter)) {
    const nCap: [number, number, number] = [0, 0, d[2] > 0 ? -1 : 1];
    const bulge = s.bulge ?? 0;
    if (bulge > 0) {
      const c = centroidOf(s);
      nCap[0] = (bulge * (o[0] + d[0] * tEnter - c.cu)) / c.hu;
      nCap[1] = (bulge * (o[1] + d[1] * tEnter - c.cv)) / c.hv;
    }
    return { t: tEnter, n: normalize(unplane(axis, nCap[0], nCap[1], nCap[2])) };
  }
  for (const c of crossings) {
    if (c.t < 0 || c.t < w0 || c.t > w1) continue;
    // Entering: just past the crossing the ray is inside.
    if (!insideAt(c.t + 1e-6)) continue;
    const [ax, ay] = pts[c.edge] ?? [0, 0];
    const [bx, by] = pts[(c.edge + 1) % pts.length] ?? [0, 0];
    // The edge normal pointing against the ray.
    let nx = by - ay;
    let ny = -(bx - ax);
    if (nx * d[0] + ny * d[1] > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { t: c.t, n: normalize(unplane(axis, nx, ny, 0)) };
  }
  return undefined;
}

/** Even-odd point-in-polygon. */
export function inPolygon(
  pts: readonly (readonly [number, number])[],
  x: number,
  y: number,
): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i] ?? [0, 0];
    const [xj, yj] = pts[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
