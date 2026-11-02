// Procedural generation (docs/04 "Flujo recomendado", step 2). A recipe turns a seed into
// an op list, so generated terrain goes through the same applyOps path as any edit: it is
// atomic, reversible and reviewable. Browser-safe (no Node imports).
//
// Recipe "island": a size x size landmass centred in the area, from value noise with a
// radial falloff. Water everywhere else in the area, sand on the coast, grass inside, then
// autoborder. Same seed and size, same island.
import { seededRandom } from "./ops/rng.ts";
import type { Cell, MapOp } from "./ops/types.ts";
import type { Rect } from "./types.ts";

export const RECIPES = ["island"] as const;
export type Recipe = (typeof RECIPES)[number];

export interface GenerateOptions {
  recipe: Recipe;
  /** Area to (re)generate, usually the island rect. */
  area: Rect;
  floor: number;
  seed: number;
  /** Side of the landmass in tiles (at most the area's smaller side). */
  size: number;
  /** Ground IDs; defaults: water_shallow, sand, grass. */
  water?: string;
  coast?: string;
  land?: string;
}

/** Smooth value noise on a lattice of `cell` tiles, in [0, 1). */
function valueNoise(seed: number, cell: number): (x: number, y: number) => number {
  const lattice = new Map<string, number>();
  const at = (ix: number, iy: number): number => {
    const k = `${ix},${iy}`;
    let v = lattice.get(k);
    if (v === undefined) {
      // Hash the lattice point into its own seed: independent of the visiting order.
      v = seededRandom((seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)) >>> 0)();
      lattice.set(k, v);
    }
    return v;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = smooth(fx - ix);
    const ty = smooth(fy - iy);
    const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
    const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/** Op list that generates the recipe over `area`. Throws RangeError on bad options. */
export function generate(o: GenerateOptions): MapOp[] {
  if (!RECIPES.includes(o.recipe)) throw new RangeError(`unknown recipe "${String(o.recipe)}"`);
  if (!Number.isSafeInteger(o.seed)) throw new RangeError("seed must be an integer");
  const side = Math.min(o.area.w, o.area.h);
  if (!Number.isInteger(o.size) || o.size < 8 || o.size > side)
    throw new RangeError(`size must be an integer 8..${side} (the area's smaller side)`);
  const water = o.water ?? "water_shallow";
  const coast = o.coast ?? "sand";
  const land = o.land ?? "grass";
  const n1 = valueNoise(o.seed, Math.max(4, Math.round(o.size / 6)));
  const n2 = valueNoise(o.seed + 1, Math.max(2, Math.round(o.size / 16)));
  const cx = o.area.x + o.area.w / 2 - 0.5;
  const cy = o.area.y + o.area.h / 2 - 0.5;
  const radius = o.size / 2;
  // 0 water, 1 coast, 2 land, over the area.
  const kind = new Uint8Array(o.area.w * o.area.h);
  const idx = (x: number, y: number): number => (y - o.area.y) * o.area.w + (x - o.area.x);
  for (let y = o.area.y; y < o.area.y + o.area.h; y++)
    for (let x = o.area.x; x < o.area.x + o.area.w; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius; // 0 centre, 1 edge of the landmass
      if (d >= 1) continue;
      // The falloff wins near the edge, so the landmass never touches the cut-off circle.
      const noise = 0.65 * n1(x, y) + 0.35 * n2(x, y);
      const h = 0.6 * noise + 0.6 * (1 - d ** 4) - 0.42;
      // The centre (where the temple usually goes) is always land.
      kind[idx(x, y)] = d * radius <= 2.5 ? 2 : h > 0.34 ? 2 : h > 0.26 ? 1 : 0;
    }
  // Land never touches water directly: a land tile next to water becomes coast.
  const sand: Cell[] = [];
  const grass: Cell[] = [];
  const at = (x: number, y: number): number =>
    x < o.area.x || y < o.area.y || x >= o.area.x + o.area.w || y >= o.area.y + o.area.h
      ? 0
      : (kind[idx(x, y)] as number);
  for (let y = o.area.y; y < o.area.y + o.area.h; y++)
    for (let x = o.area.x; x < o.area.x + o.area.w; x++) {
      let k = at(x, y);
      if (k === 2)
        for (let dy = -1; dy <= 1 && k === 2; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (at(x + dx, y + dy) === 0) {
              k = 1;
              break;
            }
      if (k === 2) grass.push({ x, y });
      else if (k === 1) sand.push({ x, y });
    }
  const ops: MapOp[] = [{ op: "paint_ground", floor: o.floor, rect: { ...o.area }, item: water }];
  if (sand.length > 0) ops.push({ op: "paint_ground", floor: o.floor, cells: sand, item: coast });
  if (grass.length > 0) ops.push({ op: "paint_ground", floor: o.floor, cells: grass, item: land });
  ops.push({ op: "autoborder", floor: o.floor, rect: { ...o.area } });
  return ops;
}
