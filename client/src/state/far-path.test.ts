import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { findFarPath } from "./far-path.ts";
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
});
