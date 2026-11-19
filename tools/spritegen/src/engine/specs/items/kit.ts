// Helpers for the item icons (docs/17 "Íconos de items"): every equipable of the catalog,
// its ammunition and the pieces retired from it, drawn by the engine as an `icon` (style.ts
// SIZES: 32x32, centred, the dark outline of an item). A line of the catalog (the swords,
// the shields...) is one builder with a look per level band, so a better band reads as better
// at a glance: its metal (rust, iron, steel, embersteel, wyrm bone and scale, tidesteel), its
// accent (none, ember glow, gold and jade, rune glow) and a bigger, busier silhouette.
//
// Units are sprite pixels; x east (right on screen), y north (away from the camera), z up.
// An icon is built as it is seen: a weapon along +z with its root part turned 45 degrees about
// y (`DIAGONAL`), so its head leans to the top right and its -x side (the one that gets the
// light) faces the top left; armour upright in the x-z plane, facing the camera. `centred`
// then moves the whole model by whole pixels so its figure sits in the middle of the canvas.
import type { MaterialName } from "../../../palette.ts";
import type { Vec3 } from "../../math.ts";
import { renderSpec } from "../../render.ts";
import type { MarkSpec, PartSpec, Profile, ShapeSpec, SpriteSpec } from "../../spec.ts";
import { grow } from "../grow.ts";

/** How far a weapon leans: its length runs from the bottom left to the top right. */
export const DIAGONAL = 45;

/** Light levels added to the lit half of a blade or a plate and to its shaded half. */
export const LIT = 0.18;
export const SHADED = -0.22;

/** The opaque box of an image: [x0, y0, x1, y1], inclusive. */
function opaqueBox(data: Uint8Array, w: number, h: number): [number, number, number, number] {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return [x0, y0, x1, y1];
}

/**
 * The spec moved by whole pixels so its figure is centred on the canvas: every root part's
 * joint shifts right by dx and up by dz. A whole-pixel move only translates the pixels (the
 * rays sit on pixel centres), so the centred icon is the drawn one, unchanged.
 */
export function centred(spec: SpriteSpec): SpriteSpec {
  const img = renderSpec(spec);
  const [x0, y0, x1, y1] = opaqueBox(img.data, img.width, img.height);
  if (x1 < 0) return spec;
  const dx = Math.round(img.width / 2 - (x0 + x1 + 1) / 2);
  const dz = Math.round((y0 + y1 + 1) / 2 - img.height / 2);
  if (dx === 0 && dz === 0) return spec;
  return {
    ...spec,
    parts: spec.parts.map((p) => {
      if (p.parent !== undefined) return p;
      const at = p.at ?? [0, 0, 0];
      return { ...p, at: [at[0] + dx, at[1], at[2] + dz] };
    }),
  };
}

/**
 * An item icon: the icon size class and its parts, `scale` times the size they were built at
 * (to fit a line's biggest piece in the canvas), centred.
 */
export function icon(
  sprite: string,
  parts: readonly PartSpec[],
  look: { scale?: number; figure?: SpriteSpec["figure"] } = {},
): SpriteSpec {
  const spec: SpriteSpec = {
    sprite,
    size: "icon",
    parts,
    ...(look.figure && { figure: look.figure }),
    seenOn: "ground/grass",
  };
  return centred(look.scale && look.scale !== 1 ? grow(spec, look.scale) : spec);
}

/** An icon `k` times its size, centred again (a whole line made to fit the canvas). */
export const resized = (spec: SpriteSpec, k: number): SpriteSpec => centred(grow(spec, k));

/** [x, z] points around an ellipse from angle a0 to a1 (degrees, 0 = +x, 90 = +z). */
export function arc(
  cx: number,
  cz: number,
  rx: number,
  rz: number,
  a0: number,
  a1: number,
  n: number,
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]);
  }
  return out;
}

/** A closed ellipse profile of n points. */
export const ellipse = (cx: number, cz: number, rx: number, rz: number, n = 20): Profile =>
  arc(cx, cz, rx, rz, 90, 450, n).slice(0, n);

/**
 * A profile mirrored about x = 0: give its right half from the top to the bottom ([x, z]
 * with x >= 0, starting and ending on x = 0), get the whole outline.
 */
export function mirrored(half: readonly (readonly [number, number])[]): Profile {
  const left = [...half]
    .reverse()
    .filter(([x]) => x !== 0)
    .map(([x, z]) => [-x, z] as const);
  return [...half, ...left];
}

/** A flat card in the x-z plane (facing the camera), `t` thick on each side of y = y0. */
export const plate = (
  points: Profile,
  t = 0.8,
  look: Partial<Pick<ShapeSpec, "material" | "bias">> & { bulge?: number; y0?: number } = {},
): ShapeSpec => ({
  type: "extrusion",
  axis: "y",
  points,
  from: (look.y0 ?? 0) - t,
  to: (look.y0 ?? 0) + t,
  ...(look.bulge !== undefined && { bulge: look.bulge }),
  ...(look.material && { material: look.material }),
  ...(look.bias !== undefined && { bias: look.bias }),
});

/**
 * A blade along a centre line ([x, z] points from the base to the tip) with a half-width at
 * each point (0 at the tip): two plates, the -x half lit and the +x half shaded, so a ridge
 * runs down the middle the way light catches a real edge.
 */
export function blade(
  line: readonly (readonly [number, number])[],
  half: readonly number[],
  t = 0.8,
  look: { material?: MaterialName; lit?: number; shaded?: number } = {},
): ShapeSpec[] {
  const n = line.length;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p = line[i] ?? [0, 0];
    const a = line[Math.max(0, i - 1)] ?? p;
    const b = line[Math.min(n - 1, i + 1)] ?? p;
    let dx = b[0] - a[0];
    let dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const h = half[i] ?? 0;
    left.push([p[0] - dz * h, p[1] + dx * h]);
    right.push([p[0] + dz * h, p[1] - dx * h]);
  }
  const centre = line.map(([x, z]) => [x, z] as const);
  const tipless = (pts: [number, number][]): [number, number][] =>
    (half[n - 1] ?? 0) === 0 ? pts.slice(0, -1) : pts;
  const mat = look.material ? { material: look.material } : {};
  return [
    plate([...centre, ...tipless(left).reverse()], t, { ...mat, bias: look.lit ?? LIT }),
    plate([...centre, ...tipless(right).reverse()], t, { ...mat, bias: look.shaded ?? SHADED }),
  ];
}

/** A tube along a polyline: one capsule per segment (a bow's limb, a cord, a curled guard). */
export function tube(points: readonly Vec3[], radius: number, radius2 = radius): ShapeSpec[] {
  const out: ShapeSpec[] = [];
  const n = points.length - 1;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const r0 = radius + ((radius2 - radius) * i) / n;
    const r1 = radius + ((radius2 - radius) * (i + 1)) / n;
    out.push({ type: "capsule", a, b, radius: r0, radius2: r1 });
  }
  return out;
}

/** [x, z] points to model points on the plane y = y0. */
export const onPlane = (pts: readonly (readonly [number, number])[], y0 = 0): Vec3[] =>
  pts.map(([x, z]) => [x, y0, z] as const);

/** A round gem or knob: an ellipsoid. */
export const gem = (center: Vec3, r: number, ry = r * 0.8): ShapeSpec => ({
  type: "ellipsoid",
  center,
  radii: [r, ry, r],
});

/** Marks in a row (rivets, nails, stitches) from a to b, n of them. */
export function rivets(
  a: Vec3,
  b: Vec3,
  n: number,
  tone: MarkSpec["tone"] = "deep",
  material?: MaterialName,
): MarkSpec[] {
  const out: MarkSpec[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    out.push({
      at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
      tone,
      ...(material && { material }),
    });
  }
  return out;
}

/** A shape moved by d (a second boot beside the first). */
export function moved(sh: ShapeSpec, d: Vec3): ShapeSpec {
  const add = (v: Vec3): Vec3 => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  switch (sh.type) {
    case "ellipsoid":
      return { ...sh, center: add(sh.center ?? [0, 0, 0]) };
    case "box":
      return { ...sh, min: add(sh.min), max: add(sh.max) };
    case "cylinder":
    case "capsule":
      return { ...sh, a: add(sh.a), b: add(sh.b) };
    case "extrusion":
    case "polygon": {
      const axis = sh.axis ?? "y";
      // In-plane offsets (u, v) and the offset along the axis (w).
      const [u, v, w] = axis === "y" ? [d[0], d[2], d[1]] : axis === "x" ? [d[1], d[2], d[0]] : d;
      const points = sh.points.map(([a, b]) => [a + u, b + v] as const);
      return sh.type === "extrusion"
        ? { ...sh, points, from: sh.from + w, to: sh.to + w }
        : { ...sh, points, at: (sh.at ?? 0) + w };
    }
  }
}

/** A part with no parent, turned to lean on the diagonal. */
export const lean = (part: Omit<PartSpec, "rot" | "parent">): PartSpec => ({
  ...part,
  rot: [0, DIAGONAL, 0],
});
