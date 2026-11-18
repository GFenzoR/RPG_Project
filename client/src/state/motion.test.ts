import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import {
  MotionTrail,
  PLAYOUT_MARGIN_MS,
  PLAYOUT_MAX_JITTER_MS,
  PLAYOUT_WINDOW_MS,
  Playout,
  SLIDE_MAX_TILES,
  SLIDE_MS,
  combine,
  ownSlideMaxTiles,
  slideBetween,
  slideLeft,
  stalls,
  stepChoices,
  towardDirection,
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
    // 80 ms later than the first: the delay covers it (and the margin) from now on.
    expect(p.time(20, 1080)).toBe(1080 + PLAYOUT_MARGIN_MS);
    expect(p.time(30, 1500)).toBe(1500 + 80 + PLAYOUT_MARGIN_MS);
  });

  it("settles at the arrivals' jitter plus the margin, after a spike too", () => {
    const p = new Playout(50);
    p.time(0, 300); // a 300 ms spike first
    let start = 0;
    for (let i = 1; i <= 1200; i++) start = p.time(2 * i, 100 * i + 10); // 2 minutes, 10 ms late
    expect(start - (100 * 1200 + 10)).toBeCloseTo(PLAYOUT_MARGIN_MS);
  });

  // A batch every tick, 20 ms one way plus 0-20 ms of jitter, and a cut of the link: what
  // the server sent meanwhile arrives at once when it ends. The worst wait after arrival
  // over each stretch of time after the cut.
  function cut(cutMs: number): { during: number; after5s: number; after20s: number } {
    const p = new Playout(50);
    const rand = (k: number) => ((k * 7919) % 21) / 1; // 0..20, deterministic
    const waits: { at: number; wait: number }[] = [];
    const cutAt = 30_000;
    for (let tick = 0; tick < 1600; tick++) {
      const sent = tick * 50;
      let arrival = sent + 20 + rand(tick);
      if (sent >= cutAt && sent < cutAt + cutMs) arrival = cutAt + cutMs + 20;
      waits.push({ at: arrival, wait: p.time(tick, arrival) - arrival });
    }
    const worst = (from: number, to: number) =>
      Math.max(...waits.filter((w) => w.at >= from && w.at < to).map((w) => w.wait));
    const end = cutAt + cutMs;
    return {
      during: worst(end, end + 1000),
      after5s: worst(end + 5000, end + 6000),
      after20s: worst(end + 20_000, end + 21_000),
    };
  }

  it.each([250, 1000, 3000])("forgets a %i ms cut of the link within seconds", (ms) => {
    const r = cut(ms);
    // Right after it: never more than the jitter it covers and the margin.
    expect(r.during).toBeLessThanOrEqual(PLAYOUT_MAX_JITTER_MS + PLAYOUT_MARGIN_MS);
    // Before the fix a 1 s cut still drew the world 945 ms late 20 s later.
    expect(r.after5s).toBeLessThanOrEqual(150);
    expect(r.after20s).toBeLessThanOrEqual(PLAYOUT_MARGIN_MS + 20);
  });

  it("forgets a late arrival after its window", () => {
    const p = new Playout(50);
    p.time(0, 20);
    p.time(1, 50 + 20 + 150); // 150 ms late: within the jitter it covers
    let wait = 0;
    for (let t = 2; t * 50 < PLAYOUT_WINDOW_MS + 3000; t++)
      wait = p.time(t, t * 50 + 20) - (t * 50 + 20);
    expect(wait).toBeCloseTo(PLAYOUT_MARGIN_MS);
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

  it("let the own creature glide back over all the steps it predicts, and one more", () => {
    expect(ownSlideMaxTiles(4)).toBe(5);
    expect(ownSlideMaxTiles(8)).toBe(9);
    expect(ownSlideMaxTiles(1)).toBe(SLIDE_MAX_TILES);
    // 3.8 tiles ahead with 4 predicted: it glides; anyone else that far jumps.
    expect(slideBetween({ x: 13.8, y: 5 }, { x: 10, y: 5 }, 0, ownSlideMaxTiles(4))?.x).toBeCloseTo(
      3.8,
    );
    expect(slideBetween({ x: 13.8, y: 5 }, { x: 10, y: 5 }, 0)).toBeUndefined();
    expect(slideBetween({ x: 16, y: 5 }, { x: 10, y: 5 }, 0, ownSlideMaxTiles(4))).toBeUndefined();
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

  it("point toward the cursor by its angle, 45° each, and not while it is on the own tile", () => {
    expect(towardDirection(0, 0)).toBe(Direction.UNSPECIFIED);
    expect(towardDirection(0.49, -0.49)).toBe(Direction.UNSPECIFIED);
    expect(towardDirection(0.6, 0)).toBe(Direction.EAST);
    expect(towardDirection(-3, 0.5)).toBe(Direction.WEST);
    expect(towardDirection(0, -0.7)).toBe(Direction.NORTH);
    expect(towardDirection(1, 4)).toBe(Direction.SOUTH);
    // 22.5° is the edge between east and north-east.
    expect(towardDirection(5, -2)).toBe(Direction.EAST);
    expect(towardDirection(5, -2.2)).toBe(Direction.NORTH_EAST);
    expect(towardDirection(2, 2)).toBe(Direction.SOUTH_EAST);
    expect(towardDirection(-1, -1.1)).toBe(Direction.NORTH_WEST);
    expect(towardDirection(-2.2, 5)).toBe(Direction.SOUTH_WEST);
    expect(towardDirection(-2, 5)).toBe(Direction.SOUTH);
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
