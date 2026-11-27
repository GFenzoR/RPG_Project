import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { FAR_MAX_REACH, clampFarGoal, farScratchCells, findFarPath } from "./far-path.ts";
import { delta } from "./geometry.ts";

/** A grid from rows of text ('.' open, '#' closed, anything else open), its corner at 0, 0. */
function grid(rows: string[]): (x: number, y: number) => boolean {
  return (x, y) => {
    const c = rows[y]?.[x];
    return c !== undefined && c !== "#";
  };
}

/** Where `steps` lead from `from`, failing on a step `passable` refuses or a cut corner. */
function walk(
  from: { x: number; y: number },
  steps: Direction[],
  passable: (x: number, y: number) => boolean,
): { x: number; y: number } {
  let { x, y } = from;
  for (const d of steps) {
    const [dx, dy] = delta(d);
    if (dx !== 0 && dy !== 0) {
      expect(passable(x + dx, y)).toBe(true);
      expect(passable(x, y + dy)).toBe(true);
    }
    x += dx;
    y += dy;
    expect(passable(x, y)).toBe(true);
  }
  return { x, y };
}

const opts = { diagonalCost: 1.414 };

describe("findFarPath", () => {
  it("finds the way round a wall to the tile clicked", () => {
    const g = grid([".....#....", ".....#....", ".....#....", ".........."]);
    const p = findFarPath({ x: 0, y: 0 }, { x: 9, y: 0 }, g, opts);
    expect(p.exact).toBe(true);
    expect(p.end).toEqual({ x: 9, y: 0 });
    expect(walk({ x: 0, y: 0 }, p.steps, g)).toEqual({ x: 9, y: 0 });
  });

  it("crosses a map far wider than a view", () => {
    const row = ".".repeat(150);
    const g = grid([row, row, row]);
    const p = findFarPath({ x: 0, y: 1 }, { x: 149, y: 1 }, g, opts);
    expect(p.exact).toBe(true);
    expect(p.steps).toHaveLength(149);
    expect(p.steps.every((d) => d === Direction.EAST)).toBe(true);
  });

  it("a blocked tile leads to the reachable tile nearest to it", () => {
    const g = grid(["........", "....###.", "....#X#.", "....###."]);
    const p = findFarPath({ x: 0, y: 0 }, { x: 5, y: 2 }, g, opts);
    expect(p.exact).toBe(false);
    // The closed room's tile cannot be reached; the nearest open tiles are 2 away.
    const end = walk({ x: 0, y: 0 }, p.steps, g);
    expect(end).toEqual(p.end);
    expect(Math.hypot(end.x - 5, end.y - 2)).toBe(2);
  });

  it("an unexplored tile (off what is passable) leads to the edge of what is known", () => {
    const g = grid(["......"]);
    const p = findFarPath({ x: 0, y: 0 }, { x: 30, y: 0 }, g, opts);
    expect(p.exact).toBe(false);
    expect(p.end).toEqual({ x: 5, y: 0 });
    expect(p.steps).toHaveLength(5);
  });

  it("gives no steps when nothing is nearer than where the player stands", () => {
    const g = grid(["#####", "#.###", "#####"]);
    expect(findFarPath({ x: 1, y: 1 }, { x: 4, y: 1 }, g, opts).steps).toEqual([]);
    expect(findFarPath({ x: 1, y: 1 }, { x: 1, y: 1 }, g, opts)).toEqual({
      steps: [],
      end: { x: 1, y: 1 },
      exact: true,
    });
  });

  it("is deterministic and stops at its node cap", () => {
    const row = ".".repeat(60);
    const g = grid(Array.from({ length: 60 }, () => row));
    const a = findFarPath({ x: 3, y: 3 }, { x: 50, y: 40 }, g, opts);
    const b = findFarPath({ x: 3, y: 3 }, { x: 50, y: 40 }, g, opts);
    expect(a).toEqual(b);
    const capped = findFarPath({ x: 3, y: 3 }, { x: 50, y: 40 }, g, { ...opts, maxNodes: 5 });
    expect(capped.exact).toBe(false);
    expect(walk({ x: 3, y: 3 }, capped.steps, g)).toEqual(capped.end);
  });

  it("a goal farther than FAR_MAX_REACH is brought that near: memory never grows with it", () => {
    expect(clampFarGoal({ x: 10, y: 10 }, { x: 14, y: 3 })).toEqual({ x: 14, y: 3 });
    expect(clampFarGoal({ x: 0, y: 0 }, { x: 1000, y: -500 }, 100)).toEqual({ x: 100, y: -50 });
    expect(clampFarGoal({ x: 5, y: 5 }, { x: 5, y: 5 + FAR_MAX_REACH + 1 })).toEqual({
      x: 5,
      y: 5 + FAR_MAX_REACH,
    });
    // A click with the minimap dragged an ocean away: no table the size of the way there.
    const open = (x: number, y: number): boolean => y === 0 && x >= 0;
    const p = findFarPath({ x: 0, y: 0 }, { x: 50_000_000, y: 30_000_000 }, open, opts);
    expect(p.exact).toBe(false);
    expect(p.end.y).toBe(0);
    expect(p.end.x).toBeGreaterThan(0);
    expect(p.end.x).toBeLessThanOrEqual(FAR_MAX_REACH);
    expect(farScratchCells()).toBeLessThanOrEqual((FAR_MAX_REACH + 81) ** 2);
  });

  it("keeps its tables between searches without one search leaking into the next", () => {
    const rows = ["@....", ".###.", "....."];
    const first = findFarPath({ x: 0, y: 0 }, { x: 4, y: 2 }, grid(rows), opts);
    const cells = farScratchCells();
    // A search over other ground in the same tables, then the first one again.
    findFarPath({ x: 0, y: 0 }, { x: 4, y: 2 }, () => true, opts);
    expect(findFarPath({ x: 0, y: 0 }, { x: 4, y: 2 }, grid(rows), opts)).toEqual(first);
    expect(farScratchCells()).toBe(cells);
  });
});
