import { describe, expect, it } from "vitest";
import { MARK_MS } from "../state/steering.ts";
import { markRing } from "./walk-mark.ts";

describe("markRing (docs/17 MOV-7)", () => {
  it("closes in on the tile and fades for 300 ms, then is gone", () => {
    expect(MARK_MS).toBe(300);
    expect(markRing(-1)).toBeUndefined();
    expect(markRing(0)).toEqual({ radius: 0.5, alpha: 1 });
    const mid = markRing(150);
    expect(mid?.radius).toBeCloseTo(0.375);
    expect(mid?.alpha).toBeCloseTo(0.75);
    const late = markRing(299);
    expect(late?.radius).toBeGreaterThan(0.25);
    expect(late?.alpha).toBeLessThan(0.01);
    expect(markRing(300)).toBeUndefined();
  });
});
