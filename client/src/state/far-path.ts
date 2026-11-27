// The route of a click on the minimap (docs/17 "Minimapa", state/steering.ts): A* over the
// explored tiles of the own floor, far beyond the view. When the tile clicked cannot be
// reached (a wall, water, unexplored) it leads to the reachable tile nearest to it. Like
// state/path.ts it is only a good guess: every step is a Walk the server validates.
import { Direction } from "@rpg/protocol";
import { delta } from "./geometry.ts";

const DIRS = [
  Direction.NORTH,
  Direction.EAST,
  Direction.SOUTH,
  Direction.WEST,
  Direction.NORTH_EAST,
  Direction.SOUTH_EAST,
  Direction.SOUTH_WEST,
  Direction.NORTH_WEST,
];

/** Tiles searched around the box that holds the start and the goal. */
export const FAR_MARGIN = 40;
/** Expanded-node cap of one search (the minimap at its widest shows 160x160 tiles). */
export const FAR_MAX_NODES = 40000;
/**
 * How far from the start a far route leads, per axis: the minimap can be dragged any
 * distance, and the search's memory grows with the box that holds both ends.
 */
export const FAR_MAX_REACH = 256;

/**
 * `to` brought within `reach` tiles of `from` on each axis, along the straight line
 * between them (a click farther away walks toward it).
 */
export function clampFarGoal(
  from: { x: number; y: number },
  to: { x: number; y: number },
  reach = FAR_MAX_REACH,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const far = Math.max(Math.abs(dx), Math.abs(dy));
  if (!(far > reach)) return { x: to.x, y: to.y };
  const k = reach / far;
  return { x: from.x + Math.round(dx * k), y: from.y + Math.round(dy * k) };
}

// The search's tables, kept between searches (a far route plans again every few steps)
// and grown when a bigger box asks for it.
let scratch:
  { g: Float64Array; parent: Int32Array; via: Uint8Array; closed: Uint8Array } | undefined;

/** How many cells the kept tables hold (tests). */
export function farScratchCells(): number {
  return scratch?.g.length ?? 0;
}

export interface FarPath {
  /** The steps from the start to `end`, in order (empty: nowhere nearer to go). */
  steps: Direction[];
  /** Where the steps lead: the goal, or the reachable tile nearest to it. */
  end: { x: number; y: number };
  /** Whether `end` is the goal. */
  exact: boolean;
}

/**
 * The way from `from` to `to` over the tiles `passable` accepts (the start is taken as
 * given), within FAR_MARGIN tiles of the box that holds both. Diagonals cost
 * `diagonalCost` and never cut a blocked corner. A goal that cannot be reached gives the
 * way to the reachable tile nearest to it (straight-line distance, then the shorter way).
 * A goal farther than `reach` (FAR_MAX_REACH) tiles on an axis is brought that near first
 * (clampFarGoal), so the tables never grow with the distance; the result is not exact then.
 */
export function findFarPath(
  from: { x: number; y: number },
  target: { x: number; y: number },
  passable: (x: number, y: number) => boolean,
  opts: { diagonalCost: number; margin?: number; maxNodes?: number; reach?: number },
): FarPath {
  const to = clampFarGoal(from, target, opts.reach ?? FAR_MAX_REACH);
  const clamped = to.x !== target.x || to.y !== target.y;
  const margin = opts.margin ?? FAR_MARGIN;
  const maxNodes = opts.maxNodes ?? FAR_MAX_NODES;
  const x0 = Math.min(from.x, to.x) - margin;
  const y0 = Math.min(from.y, to.y) - margin;
  const w = Math.max(from.x, to.x) + margin - x0 + 1;
  const h = Math.max(from.y, to.y) + margin - y0 + 1;
  const size = w * h;
  if (!scratch || scratch.g.length < size) {
    scratch = {
      g: new Float64Array(size),
      parent: new Int32Array(size),
      via: new Uint8Array(size),
      closed: new Uint8Array(size),
    };
  }
  const { g, parent, via, closed } = scratch;
  g.fill(Infinity, 0, size);
  parent.fill(-1, 0, size);
  closed.fill(0, 0, size);
  const idx = (x: number, y: number): number => (y - y0) * w + (x - x0);
  const heur = (x: number, y: number): number => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (opts.diagonalCost - 1) * Math.min(dx, dy);
  };
  // A binary heap of [f, g, index] triples, flat: the lowest f first, then the higher g
  // (the node nearer the goal), then the lower index, so the result is deterministic.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => {
    const fa = heap[a * 3] ?? 0;
    const fb = heap[b * 3] ?? 0;
    if (fa !== fb) return fa < fb;
    const ga = heap[a * 3 + 1] ?? 0;
    const gb = heap[b * 3 + 1] ?? 0;
    if (ga !== gb) return ga > gb;
    return (heap[a * 3 + 2] ?? 0) < (heap[b * 3 + 2] ?? 0);
  };
  const swap = (a: number, b: number): void => {
    for (let k = 0; k < 3; k++) {
      const t = heap[a * 3 + k] ?? 0;
      heap[a * 3 + k] = heap[b * 3 + k] ?? 0;
      heap[b * 3 + k] = t;
    }
  };
  const push = (f: number, gv: number, i: number): void => {
    heap.push(f, gv, i);
    let n = heap.length / 3 - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (!less(n, p)) break;
      swap(n, p);
      n = p;
    }
  };
  const pop = (): number => {
    const top = heap[2] ?? -1;
    const last = heap.length / 3 - 1;
    swap(0, last);
    heap.length -= 3;
    let n = 0;
    for (;;) {
      const l = n * 2 + 1;
      const r = l + 1;
      let m = n;
      if (l < last && less(l, m)) m = l;
      if (r < last && less(r, m)) m = r;
      if (m === n) break;
      swap(n, m);
      n = m;
    }
    return top;
  };

  const start = idx(from.x, from.y);
  const goal = idx(to.x, to.y);
  g[start] = 0;
  push(heur(from.x, from.y), 0, start);
  const dist2 = (x: number, y: number): number => (x - to.x) ** 2 + (y - to.y) ** 2;
  let near = start;
  let nearD = dist2(from.x, from.y);
  let expanded = 0;
  let found = false;
  while (heap.length > 0 && expanded < maxNodes) {
    const cur = pop();
    if (cur < 0 || closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    const cx = (cur % w) + x0;
    const cy = Math.floor(cur / w) + y0;
    const d = dist2(cx, cy);
    const cg = g[cur] ?? Infinity;
    if (d < nearD || (d === nearD && cg < (g[near] ?? Infinity))) {
      near = cur;
      nearD = d;
    }
    if (cur === goal) {
      found = true;
      break;
    }
    for (const dir of DIRS) {
      const [dx, dy] = delta(dir);
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < x0 || ny < y0 || nx >= x0 + w || ny >= y0 + h) continue;
      const ni = idx(nx, ny);
      if (closed[ni] || !passable(nx, ny)) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const ng = cg + (diagonal ? opts.diagonalCost : 1);
      if (ng >= (g[ni] ?? Infinity)) continue;
      g[ni] = ng;
      parent[ni] = cur;
      via[ni] = dir;
      push(ng + heur(nx, ny), ng, ni);
    }
  }
  const endI = found ? goal : near;
  const steps: Direction[] = [];
  for (let n = endI; n !== start && n >= 0; n = parent[n] ?? -1) steps.push(via[n] as Direction);
  steps.reverse();
  return {
    steps,
    end: { x: (endI % w) + x0, y: Math.floor(endI / w) + y0 },
    exact: found && !clamped,
  };
}
