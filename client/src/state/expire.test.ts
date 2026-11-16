import { describe, expect, it } from "vitest";
import { dropFinished } from "./world.ts";

describe("dropFinished", () => {
  it("drops what started ms or more ago, in place and in order", () => {
    const a = { start: 0 };
    const b = { start: 500 };
    const c = { start: 100 };
    const d = { start: 900 };
    const list = [a, b, c, d];
    dropFinished(list, 1000, 600);
    // Same array and same objects: the canvas keys its display objects on them.
    expect(list).toEqual([b, d]);
    expect(list[0]).toBe(b);
    expect(list[1]).toBe(d);
    dropFinished(list, 1099, 600);
    expect(list).toEqual([b, d]);
    dropFinished(list, 1100, 600);
    expect(list).toEqual([d]);
  });

  it("leaves an empty or fresh list alone", () => {
    const empty: { start: number }[] = [];
    dropFinished(empty, 5000, 600);
    expect(empty).toEqual([]);
    const fresh = [{ start: 4999 }, { start: 5000 }];
    dropFinished(fresh, 5000, 600);
    expect(fresh).toHaveLength(2);
  });
});
