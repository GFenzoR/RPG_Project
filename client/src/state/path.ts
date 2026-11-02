// Click-to-walk: A* over the tiles the client knows, producing the WalkPath steps. The
// server re-validates every step (and re-plans around creatures), so this only has to be
// a good guess; it never leaves the known area.
import { Direction } from "@rpg/protocol";
import { delta } from "./geometry.ts";
import type { Pos } from "./geometry.ts";

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

/** Expanded-node cap: the known area is ~17x13 per floor, this is plenty. */
const MAX_NODES = 4000;

/**
 * Steps from `from` to `to` on one floor, or undefined when there is no known path.
 * Diagonals cost `diagonalCost` and never cut a blocked corner. `passable` decides each
 * tile; the destination must be passable too.
 */
export function findPath(
  from: Pos,
  to: Pos,
  passable: (x: number, y: number) => boolean,
  opts: { diagonalCost: number; maxSteps: number },
): Direction[] | undefined {
  if (from.z !== to.z) return undefined;
  if (from.x === to.x && from.y === to.y) return [];
  if (!passable(to.x, to.y)) return undefined;
  const key = (x: number, y: number): string => `${x},${y}`;
  const h = (x: number, y: number): number => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (opts.diagonalCost - 1) * Math.min(dx, dy);
  };
  interface Node {
    x: number;
    y: number;
    g: number;
    f: number;
    steps: number;
    parent: Node | undefined;
    dir: Direction;
  }
  const open: Node[] = [
    { x: from.x, y: from.y, g: 0, f: h(from.x, from.y), steps: 0, parent: undefined, dir: 0 },
  ];
  const best = new Map<string, number>([[key(from.x, from.y), 0]]);
  let expanded = 0;
  while (open.length > 0 && expanded < MAX_NODES) {
    // Small open sets: a linear scan beats a heap here and keeps ties deterministic.
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i];
      const b = open[bi];
      if (a && b && (a.f < b.f || (a.f === b.f && a.g > b.g))) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (!cur) break;
    expanded++;
    if (cur.x === to.x && cur.y === to.y) {
      const steps: Direction[] = [];
      for (let n: Node | undefined = cur; n?.parent; n = n.parent) steps.push(n.dir);
      return steps.reverse();
    }
    if (cur.steps >= opts.maxSteps) continue;
    for (const d of DIRS) {
      const [dx, dy] = delta(d);
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!passable(nx, ny)) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && (!passable(cur.x + dx, cur.y) || !passable(cur.x, cur.y + dy))) continue;
      const g = cur.g + (diagonal ? opts.diagonalCost : 1);
      const k = key(nx, ny);
      if (g >= (best.get(k) ?? Infinity)) continue;
      best.set(k, g);
      open.push({ x: nx, y: ny, g, f: g + h(nx, ny), steps: cur.steps + 1, parent: cur, dir: d });
    }
  }
  return undefined;
}
