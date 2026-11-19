import { describe, expect, it } from "vitest";
import { toNextLevel, totalFor } from "./experience.ts";

// data/balance.yaml's curve: 12n³ - 24n² + 12n, 1000 levels (the server's TotalFor).
const curve = { a: 12, b: -24, c: 12, d: 0, maxLevel: 1000 };

describe("the level curve on the client", () => {
  it("gives the server's totals", () => {
    expect(totalFor(curve, 1)).toBe(0);
    expect(totalFor(curve, 2)).toBe(24);
    expect(totalFor(curve, 8)).toBe(4704);
    expect(totalFor(curve, 15)).toBe(35280);
    expect(totalFor({ ...curve, a: 1.5, b: 0, c: 0 }, 3)).toBe(40); // 40.5 cut like int64()
  });

  it("says what the next level is missing, nothing at the top or without a curve", () => {
    expect(toNextLevel(curve, 15, 35280)).toEqual({ next: 16, missing: 7920 });
    expect(toNextLevel(curve, 15, 50_000)).toEqual({ next: 16, missing: 0 });
    expect(toNextLevel(curve, 1000, 1)).toBeUndefined();
    expect(toNextLevel(undefined, 3, 0)).toBeUndefined();
    expect(toNextLevel({ a: 0, b: 0, c: 0, d: 0, maxLevel: 0 }, 3, 0)).toBeUndefined();
  });
});
