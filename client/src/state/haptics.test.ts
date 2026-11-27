import { describe, expect, it } from "vitest";
import {
  HAPTIC_ERROR_GAP_MS,
  HAPTIC_HIT_GAP_MS,
  Haptics,
  browserVibrate,
  hapticPattern,
} from "./haptics.ts";

describe("haptics", () => {
  it("every pattern is short", () => {
    for (const kind of ["hit", "heavyHit", "levelUp", "error"] as const) {
      const p = hapticPattern(kind);
      const total = typeof p === "number" ? p : p.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(250);
    }
  });

  it("vibrates when on and supported", () => {
    const calls: (number | number[])[] = [];
    const h = new Haptics(
      (p) => {
        calls.push(p);
        return true;
      },
      () => true,
    );
    expect(h.supported).toBe(true);
    expect(h.pulse("levelUp", 0)).toBe(true);
    expect(calls).toEqual([hapticPattern("levelUp")]);
  });

  it("does nothing with the option off or without vibration", () => {
    let called = 0;
    const off = new Haptics(
      () => {
        called++;
        return true;
      },
      () => false,
    );
    expect(off.pulse("hit", 0)).toBe(false);
    expect(called).toBe(0);
    const none = new Haptics(undefined, () => true);
    expect(none.supported).toBe(false);
    expect(none.pulse("error", 0)).toBe(false);
  });

  it("spaces the hits out, not the rest", () => {
    let called = 0;
    const h = new Haptics(
      () => {
        called++;
        return true;
      },
      () => true,
    );
    expect(h.pulse("hit", 1000)).toBe(true);
    expect(h.pulse("heavyHit", 1000 + HAPTIC_HIT_GAP_MS - 1)).toBe(false);
    expect(h.pulse("error", 1001)).toBe(true);
    expect(h.pulse("hit", 1000 + HAPTIC_HIT_GAP_MS)).toBe(true);
    expect(called).toBe(3);
  });

  it("refusals in a row (the pad held against a wall) buzz once per gap, apart from hits", () => {
    const h = new Haptics(
      () => true,
      () => true,
    );
    expect(h.pulse("error", 1000)).toBe(true);
    expect(h.pulse("error", 1300)).toBe(false);
    expect(h.pulse("hit", 1300)).toBe(true);
    expect(h.pulse("error", 1000 + HAPTIC_ERROR_GAP_MS - 1)).toBe(false);
    expect(h.pulse("error", 1000 + HAPTIC_ERROR_GAP_MS)).toBe(true);
    expect(h.pulse("levelUp", 1000 + HAPTIC_ERROR_GAP_MS)).toBe(true);
  });

  it("a vibrate that throws is not an error of the game", () => {
    const h = new Haptics(
      () => {
        throw new Error("blocked");
      },
      () => true,
    );
    expect(h.pulse("error", 0)).toBe(false);
  });

  it("browserVibrate is undefined where navigator has none", () => {
    expect(browserVibrate(undefined, true)).toBeUndefined();
    expect(browserVibrate({}, true)).toBeUndefined();
    // Desktop Chrome has navigator.vibrate and no motor: no vibration, no option.
    expect(browserVibrate({ vibrate: () => true }, false)).toBeUndefined();
    const seen: unknown[] = [];
    const v = browserVibrate(
      {
        vibrate: (p) => {
          seen.push(p);
          return true;
        },
      },
      true,
    );
    expect(v?.(5)).toBe(true);
    expect(seen).toEqual([5]);
  });
});
