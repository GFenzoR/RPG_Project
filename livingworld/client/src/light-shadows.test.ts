import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIGHT_SHADOWS,
  SIDE_BOTH,
  SIDE_IN,
  SIDE_OUT,
  lightBreath,
  lightCast,
  parseLightShadows,
} from "./light-shadows.ts";
import type { LightCast } from "./light-shadows.ts";

const R = DEFAULT_LIGHT_SHADOWS;
const cast = (
  lights: number[],
  x: number,
  y: number,
  side = SIDE_OUT,
): LightCast & { ok: boolean } => {
  const out = { x: 0, y: 0, strength: 0 };
  const ok = lightCast(R, lights, x, y, side, out);
  return { ...out, ok };
};
const lamp = (x: number, y: number, radius = 3, side = SIDE_OUT): number[] => [x, y, radius, side];

describe("lightCast (README 'Sombras de las luces')", () => {
  it("points away from the light: east of a lamp the shadow falls east, south of it south", () => {
    const east = cast(lamp(10, 10), 12, 10);
    expect(east.ok).toBe(true);
    expect(east.x).toBeGreaterThan(0);
    expect(east.y).toBeCloseTo(0, 9);
    const south = cast(lamp(10, 10), 10, 12);
    expect(south.x).toBeCloseTo(0, 9);
    // y is north-positive: a shadow to the south is negative.
    expect(south.y).toBeLessThan(0);
    const north = cast(lamp(10, 10), 10, 8);
    expect(north.y).toBeGreaterThan(0);
  });

  it("grows longer and weaker with the distance, and ends at the light's reach", () => {
    const near = cast(lamp(10, 10), 11, 10);
    const mid = cast(lamp(10, 10), 13, 10);
    const far = cast(lamp(10, 10), 14.5, 10);
    expect(mid.x).toBeGreaterThan(near.x);
    expect(far.x).toBeGreaterThan(mid.x);
    expect(near.strength).toBe(1);
    expect(far.strength).toBeLessThan(mid.strength);
    expect(far.strength).toBeGreaterThan(0);
    // reach 1.6 x radius 3 = 4.8 tiles.
    expect(cast(lamp(10, 10), 14.9, 10).ok).toBe(false);
    expect(cast(lamp(10, 10), 14.9, 10).strength).toBe(0);
  });

  it("shrinks to nothing right under the light (no direction there)", () => {
    const at = cast(lamp(10, 10), 10, 10);
    expect(Math.hypot(at.x, at.y)).toBe(0);
    expect(cast(lamp(10, 10), 10.2, 10).x).toBeLessThan(cast(lamp(10, 10), 10.8, 10).x);
  });

  it("takes the nearest light, and blends the two nearest between them", () => {
    const two = [...lamp(10, 10), ...lamp(16, 10)];
    // West of the west lamp the shadow falls west...
    expect(cast(two, 9, 10).x).toBeLessThan(0);
    // ...between the two, nearer the west one, it falls east (away from the nearest)...
    expect(cast(two, 11.5, 10).x).toBeGreaterThan(0);
    // ...nearer the east one, west; and half way the two cancel.
    expect(cast(two, 14.5, 10).x).toBeLessThan(0);
    expect(cast(two, 13, 10).x).toBeCloseTo(0, 9);
    expect(cast(two, 13, 10).strength).toBeGreaterThan(0);
  });

  it("never jumps while the caster walks among several lamps (no popping)", () => {
    const lamps = [...lamp(10, 10), ...lamp(16, 10), ...lamp(13, 15), ...lamp(20, 14)];
    let prev = cast(lamps, 6, 9);
    let moved = 0;
    for (let i = 1; i <= 2000; i++) {
      // A walk across all of them, 0.01 tile a step, on a slant.
      const now = cast(lamps, 6 + i * 0.01, 9 + i * 0.004);
      const step = Math.hypot(now.x - prev.x, now.y - prev.y);
      // Where no light reaches there is no shadow to jump (it comes in from strength 0).
      if (prev.ok && now.ok) expect(step).toBeLessThan(0.05);
      expect(Math.abs(now.strength - prev.strength)).toBeLessThan(0.05);
      moved += step;
      prev = now;
    }
    expect(moved).toBeGreaterThan(1);
  });

  it("blends at most the two nearest: a third lamp only takes weight off the second", () => {
    const two = [...lamp(10, 10), ...lamp(13, 10)];
    const withFar = [...two, ...lamp(10, 14.7)];
    const a = cast(two, 11, 10);
    const b = cast(withFar, 11, 10);
    // The third is off the row; the shadow stays on the row, the first two's.
    expect(Math.sign(b.x)).toBe(Math.sign(a.x));
    expect(Math.abs(b.y)).toBeLessThan(1e-9);
  });

  it("keeps the street's lamps out of a house and a hearth out of the street", () => {
    const street = lamp(10, 10, 3, SIDE_OUT);
    const hearth = lamp(10, 10, 3, SIDE_IN);
    const torch = lamp(10, 10, 3, SIDE_BOTH);
    expect(cast(street, 12, 10, SIDE_IN).ok).toBe(false);
    expect(cast(hearth, 12, 10, SIDE_OUT).ok).toBe(false);
    expect(cast(hearth, 12, 10, SIDE_IN).ok).toBe(true);
    expect(cast(torch, 12, 10, SIDE_IN).ok).toBe(true);
    expect(cast(torch, 12, 10, SIDE_OUT).ok).toBe(true);
  });

  it("casts nothing without lights", () => {
    expect(cast([], 5, 5)).toMatchObject({ ok: false, x: 0, y: 0, strength: 0 });
  });
});

describe("parseLightShadows and lightBreath", () => {
  it("reads the lights of shadows.yaml, clamped, with defaults for what is missing", () => {
    expect(parseLightShadows(undefined)).toBeUndefined();
    expect(parseLightShadows({})).toEqual(R);
    const got = parseLightShadows({
      reach: 2,
      alpha: 7,
      min_length: 1,
      max_length: 0.5,
      unlit_contact: 0.2,
    });
    expect(got).toMatchObject({
      reach: 2,
      alpha: 1,
      minLength: 1,
      maxLength: 1,
      unlitContact: 0.2,
    });
  });

  it("breathes a little around 1, and not at all with breathe 0", () => {
    let min = 9;
    let max = 0;
    for (let t = 0; t < 5000; t += 16) {
      const b = lightBreath(R, t);
      min = Math.min(min, b);
      max = Math.max(max, b);
    }
    expect(min).toBeGreaterThanOrEqual(1 - R.breathe);
    expect(max).toBeLessThanOrEqual(1 + R.breathe);
    expect(max - min).toBeGreaterThan(R.breathe / 2);
    expect(lightBreath({ ...R, breathe: 0 }, 1234)).toBe(1);
  });
});
