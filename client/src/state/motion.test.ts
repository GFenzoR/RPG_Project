import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import {
  MotionTrail,
  PLAYOUT_FALL,
  PLAYOUT_FORGET,
  PLAYOUT_MARGIN_MS,
  PLAYOUT_RISE,
  Playout,
  SLIDE_MAX_TILES,
  SLIDE_MS,
  combine,
  slideBetween,
  slideLeft,
  stalls,
  stepChoices,
} from "./motion.ts";

describe("Playout", () => {
  it("draws steps the server took back to back back to back, whatever the jitter", () => {
    const p = new Playout(50);
    const jitter = [30, 5, 20, 0, 28, 12, 3, 30, 17];
    const starts = jitter.map((j, k) => {
      const arrival = 50_000 + 500 * k + j; // tick 1000 + 10k, 500 ms apart on the server
      const start = p.time(1000 + 10 * k, arrival);
      expect(start).toBeGreaterThanOrEqual(arrival);
      return start;
    });
    for (let k = 1; k < starts.length; k++)
      expect(Math.abs((starts[k] ?? 0) - (starts[k - 1] ?? 0) - 500)).toBeLessThan(5);
  });

  it("never starts a step before its batch arrived; a later batch moves the delay up at once", () => {
    const p = new Playout(50);
    expect(p.time(10, 500)).toBe(500 + PLAYOUT_MARGIN_MS);
    expect(p.time(20, 1080)).toBe(1080); // 80 ms late: starts now
    // Early again: it waits, by the late one (forgotten slowly) and the margin it regains.
    expect(p.time(30, 1500)).toBeCloseTo(1500 + 80 + 420 * PLAYOUT_RISE);
    p.reset();
    expect(p.time(5000, 3)).toBe(3 + PLAYOUT_MARGIN_MS);
  });

  it("settles at the arrivals' jitter plus the margin, after a spike too", () => {
    const p = new Playout(50);
    p.time(0, 300); // a 300 ms spike first
    let start = 0;
    for (let i = 1; i <= 1200; i++) start = p.time(2 * i, 100 * i + 10); // 2 minutes, 10 ms late
    expect(start - (100 * 1200 + 10)).toBeCloseTo(PLAYOUT_MARGIN_MS);
    expect(PLAYOUT_FALL).toBeGreaterThan(PLAYOUT_FORGET);
  });
});

describe("slides", () => {
  it("glide a correction out, easing, and leave teleports alone", () => {
    expect(slideBetween({ x: 10, y: 5 }, { x: 10, y: 5 }, 0)).toBeUndefined();
    expect(slideBetween({ x: 10, y: 5 }, { x: 10 + SLIDE_MAX_TILES + 1, y: 5 }, 0)).toBeUndefined();
    const s = slideBetween({ x: 10.5, y: 5 }, { x: 10, y: 5 }, 100);
    expect(s).toEqual({ x: 0.5, y: 0, start: 100 });
    expect(slideLeft(s, 100)).toEqual({ x: 0.5, y: 0 });
    expect(slideLeft(s, 100 + SLIDE_MS / 2)?.x).toBeCloseTo(0.125);
    expect(slideLeft(s, 100 + SLIDE_MS)).toBeUndefined();
    expect(slideLeft(undefined, 0)).toBeUndefined();
  });
});

describe("directions", () => {
  it("try a blocked diagonal's halves, horizontal first", () => {
    expect(stepChoices(Direction.EAST)).toEqual([Direction.EAST]);
    expect(stepChoices(Direction.NORTH_EAST)).toEqual([
      Direction.NORTH_EAST,
      Direction.EAST,
      Direction.NORTH,
    ]);
    expect(stepChoices(Direction.SOUTH_WEST)).toEqual([
      Direction.SOUTH_WEST,
      Direction.WEST,
      Direction.SOUTH,
    ]);
  });

  it("combine two perpendicular directions into their diagonal", () => {
    expect(combine(Direction.NORTH, Direction.EAST)).toBe(Direction.NORTH_EAST);
    expect(combine(Direction.WEST, Direction.SOUTH)).toBe(Direction.SOUTH_WEST);
    expect(combine(Direction.NORTH, Direction.SOUTH)).toBeUndefined();
    expect(combine(Direction.EAST, Direction.EAST)).toBeUndefined();
    expect(combine(Direction.NORTH_EAST, Direction.EAST)).toBeUndefined();
  });
});

describe("MotionTrail and stalls", () => {
  it("keeps the last frames in a ring and counts the frames that stood still", () => {
    const trail = new MotionTrail(4);
    for (let i = 0; i < 6; i++) trail.record(i * 16, 100 + i * 0.03, 200);
    const got = trail.since(0);
    expect(got.map((s) => s.t)).toEqual([32, 48, 64, 80]);
    expect(trail.since(60).map((s) => s.t)).toEqual([64, 80]);
    expect(stalls(got, 1, 0)).toBe(0);
    const still = [
      { t: 0, x: 1, y: 0 },
      { t: 16, x: 1.1, y: 0 },
      { t: 32, x: 1.1, y: 0 }, // stood still
      { t: 32.5, x: 1.1, y: 0 }, // same millisecond: not a frame
      { t: 48, x: 1.05, y: 0 }, // went back
      { t: 64, x: 1.2, y: 0 },
    ];
    expect(stalls(still, 1, 0)).toBe(2);
  });
});
