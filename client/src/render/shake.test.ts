import { describe, expect, it } from "vitest";
import { HEAVY_HIT_SHARE, SHAKE_MS, SHAKE_PX, heavyHit, shakeOffset } from "./shake.ts";

describe("camera shake on a heavy hit (docs/17 UI-9)", () => {
  it("only a loss of a tenth of the maximum health or more is heavy", () => {
    expect(HEAVY_HIT_SHARE).toBe(0.1);
    expect(heavyHit(400, 360, 400)).toBe(true);
    expect(heavyHit(400, 361, 400)).toBe(false);
    expect(heavyHit(200, 400, 400)).toBe(false); // a heal
    expect(heavyHit(undefined, 100, 400)).toBe(false); // the first stats of a login
    expect(heavyHit(50, 0, 0)).toBe(false);
  });

  it("moves at most SHAKE_PX, dies down and stops after SHAKE_MS", () => {
    let moved = 0;
    for (let ms = 0; ms < SHAKE_MS; ms += 5) {
      const o = shakeOffset(ms);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(SHAKE_PX);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(SHAKE_PX);
      if (o.x !== 0 || o.y !== 0) moved++;
    }
    expect(moved).toBeGreaterThan(3);
    expect(shakeOffset(0)).toEqual({ x: 2, y: -1 });
    expect(shakeOffset(SHAKE_MS)).toEqual({ x: 0, y: 0 });
    expect(shakeOffset(-1)).toEqual({ x: 0, y: 0 });
  });

  it("is the same every time and keeps whole device pixels", () => {
    expect(shakeOffset(20, 2)).toEqual(shakeOffset(20, 2));
    const o = shakeOffset(10, 3);
    expect(Number.isInteger(o.x) && Number.isInteger(o.y)).toBe(true);
    expect(Math.abs(o.x)).toBeLessThanOrEqual(SHAKE_PX * 3);
  });
});
