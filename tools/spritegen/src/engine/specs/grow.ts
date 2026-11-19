// Growing a spec: the whole model `k` times its size about its origin (joints, shapes and
// marks). Corpses are drawn at their family's proportions and grown to fill their tile
// (remains.ts); an item icon is grown or shrunk to fit its canvas (items/kit.ts).
import type { Vec3 } from "../math.ts";
import type { MarkSpec, PartSpec, ShapeSpec, SpriteSpec } from "../spec.ts";

const times = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/** A shape `k` times its size about the part's origin. */
function growShape(sh: ShapeSpec, k: number): ShapeSpec {
  switch (sh.type) {
    case "ellipsoid":
      return {
        ...sh,
        ...(sh.center && { center: times(sh.center, k) }),
        radii: times(sh.radii, k),
      };
    case "box":
      return { ...sh, min: times(sh.min, k), max: times(sh.max, k) };
    case "cylinder":
      return { ...sh, a: times(sh.a, k), b: times(sh.b, k), radius: sh.radius * k };
    case "capsule":
      return {
        ...sh,
        a: times(sh.a, k),
        b: times(sh.b, k),
        radius: sh.radius * k,
        ...(sh.radius2 !== undefined && { radius2: sh.radius2 * k }),
      };
    case "extrusion":
      return {
        ...sh,
        points: sh.points.map(([u, v]) => [u * k, v * k] as const),
        from: sh.from * k,
        to: sh.to * k,
      };
    case "polygon":
      return {
        ...sh,
        points: sh.points.map(([u, v]) => [u * k, v * k] as const),
        ...(sh.at !== undefined && { at: sh.at * k }),
        thickness: (sh.thickness ?? 1) * k,
      };
  }
}

/**
 * The model `k` times its size (joints, shapes and marks).
 */
export function grow(spec: SpriteSpec, k: number): SpriteSpec {
  return {
    ...spec,
    parts: spec.parts.map((p): PartSpec => ({
      ...p,
      ...(p.at && { at: times(p.at, k) }),
      shapes: p.shapes.map((sh) => growShape(sh, k)),
      ...(p.marks && { marks: p.marks.map((m): MarkSpec => ({ ...m, at: times(m.at, k) })) }),
    })),
  };
}
