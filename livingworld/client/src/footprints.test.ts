// What erases a footprint (footprints.ts): the wind by how exposed the place is, the
// shore's waves, other creatures' feet and the cap; never a clock of its own. The data is
// the real one (data/livingworld/surfaces.yaml and wind.yaml).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import { parseLivingWorldData } from "./data.ts";
import {
  FootprintSim,
  MAX_FOOTPRINTS,
  nextWash,
  shoreDistance,
  SOFT_FOOTPRINTS,
  waveReach,
  waveTime,
  windErosion,
} from "./footprints.ts";
import type { Footprint, PrintField, PrintRules, PrintSpec } from "./footprints.ts";
import { exposureOf, gustAt, nextGust, parseWind } from "./wind.ts";
import type { WindField } from "./wind.ts";

const read = (name: string): unknown =>
  parseYaml(readFileSync(new URL(`../../../data/livingworld/${name}`, import.meta.url), "utf8"));
const DATA = parseLivingWorldData(read("surfaces.yaml"), { plants: [] });
const WIND = (parseWind(read("wind.yaml")) as { field: WindField }).field;
const FIELD = DATA.prints as PrintField;
const rulesOf = (s: "sand" | "wet_sand" | "snow" | "mud" | "ash"): PrintRules => {
  const r = DATA.surfaces[s]?.prints;
  if (!r) throw new Error(s);
  return r;
};
const T = 32;

const print = (over: Partial<PrintSpec> = {}): PrintSpec => ({
  x: 10 * T,
  y: 10 * T,
  rot: 0,
  kind: "feet",
  surface: "sand",
  tint: 0,
  rules: rulesOf("sand"),
  ...over,
});

/** Runs `sim` for `ms` at 20 fps from `from`; returns when its last print went (or -1). */
function run(sim: FootprintSim, ms: number, from = 0, scale = 1): number {
  for (let t = from; t < from + ms; t += 50) {
    sim.step(50, t + 50, scale);
    if (sim.count === 0) return t + 50 - from;
  }
  return -1;
}

/** The exposure of a place whose 5x5 tiles are all `surface`. */
const exposure = (surface: string): number =>
  exposureOf(
    WIND,
    Array.from({ length: 25 }, () => surface),
    0,
    24,
  );

describe("footprints have no lifetime", () => {
  it("stay as they are when nothing happens there: no wind, no wave, no feet", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    sim.add(print(), 0);
    expect(run(sim, 30 * 60 * 1000)).toBe(-1);
    const p = sim.prints[0] as Footprint;
    expect(p.wear).toBe(0);
    expect(FootprintSim.alpha(p)).toBe(1);
  });

  it("every surface that keeps prints says what erases them, and the rest keep none", () => {
    for (const s of ["sand", "wet_sand", "snow", "mud", "ash"] as const)
      expect(DATA.surfaces[s]?.prints, s).toBeDefined();
    for (const s of ["grass", "dirt", "stone", "wood", "water_shallow"] as const)
      expect(DATA.surfaces[s]?.prints, s).toBeUndefined();
    expect(rulesOf("wet_sand").waves).toBe(true);
    expect(rulesOf("sand").waves).toBe(false);
  });
});

describe("the wind", () => {
  it("erases nothing under the still air's strength and more and more over it", () => {
    expect(windErosion(0.4, FIELD.still, FIELD.still)).toBe(0);
    expect(windErosion(0.4, 0.2, FIELD.still)).toBe(0);
    const breeze = windErosion(0.4, 0.8, FIELD.still);
    const gale = windErosion(0.4, 1.3, FIELD.still);
    expect(breeze).toBeGreaterThan(0);
    expect(gale).toBeGreaterThan(breeze * 4);
  });

  it("blows the prints off an open beach in a few gusts, and only a gust does it", () => {
    const sim = new FootprintSim(FIELD, WIND, T);
    sim.add(print({ exposure: exposure("sand") }), 0);
    // In the calm between two gusts a print stays exactly as it is.
    let last = 0;
    let gone = -1;
    for (let t = 0; t < 5 * 60_000 && gone < 0; t += 50) {
      const blowing = gustAt(WIND, 10, 10, t + 50) > 0;
      sim.step(50, t + 50);
      const wear = sim.prints[0]?.wear ?? 1;
      if (!blowing) expect(wear).toBe(last);
      last = wear;
      if (sim.count === 0) gone = t + 50;
    }
    expect(gone).toBeGreaterThan(1500); // a gust has to come: never at once
    expect(gone).toBeLessThan(5 * 60_000);
    // A strong gust alone takes most of a print.
    const strong = nextGust(WIND, 10, 10, 0, 0.75);
    if (!strong) throw new Error("no strong gust");
    const one = new FootprintSim(FIELD, WIND, T);
    one.add(print({ exposure: exposure("sand") }), strong.at - 500);
    run(one, 6000, strong.at - 500);
    expect(one.prints[0]?.wear ?? 1).toBeGreaterThan(0.5);
  });

  it("leaves them for very long in a sheltered spot, and for ever underground", () => {
    // A sandy floor between planks: the wind hardly gets in.
    const nook = exposureOf(
      WIND,
      [...Array.from({ length: 5 }, () => "sand"), ...Array.from({ length: 20 }, () => "wood")],
      0,
      24,
    );
    const open = new FootprintSim(FIELD, WIND, T);
    const sheltered = new FootprintSim(FIELD, WIND, T);
    open.add(print({ exposure: exposure("sand") }), 0);
    sheltered.add(print({ exposure: nook }), 0);
    expect(run(open, 60_000)).toBeGreaterThan(0);
    expect(run(sheltered, 20 * 60 * 1000)).toBe(-1);
    expect(sheltered.prints[0]?.wear ?? 1).toBeLessThan(0.05);
    // A cave has no wind at all (the scale the frame passes is 0).
    const cave = new FootprintSim(FIELD, WIND, T);
    cave.add(print({ surface: "ash", rules: rulesOf("ash"), exposure: exposure("ash") }), 0);
    expect(run(cave, 20 * 60 * 1000, 0, 0)).toBe(-1);
    expect(cave.prints[0]?.wear).toBe(0);
  });

  it("takes a trail one print after another, as the gust front crosses it", () => {
    // The front of a gust travels (wind.ts): each print of a trail starts to go when the
    // front reaches its own tile, not all of them at once.
    const y = 40;
    const xs = [30, 36, 42, 48];
    const rules = { wind: 0.05, waves: false, tread: 0 };
    // A gust that blows hard on the whole trail.
    let from = 0;
    let arrivals: number[] = [];
    for (;;) {
      const first = nextGust(WIND, xs[0] as number, y, from, 0.7);
      if (!first) throw new Error("no gust over the trail");
      arrivals = xs.map((x) => nextGust(WIND, x, y, first.at - 6000, 0.7)?.at ?? Infinity);
      if (arrivals.every((t) => Math.abs(t - first.at) < 6000)) break;
      from = first.at;
    }
    const start = Math.min(...arrivals) - 1000;
    const sim = new FootprintSim(FIELD, WIND, T);
    for (const x of xs)
      sim.add(print({ x: x * T, y: y * T, exposure: exposure("sand"), rules }), start);
    const began = xs.map(() => -1);
    for (let t = start; t < start + 12_000; t += 50) {
      sim.step(50, t + 50);
      sim.prints.forEach((q, i) => {
        if (q.wear > 0 && (began[i] as number) < 0) began[i] = t + 50;
      });
    }
    // Each one when the front got to it (a moment later: the gust has to pick up).
    began.forEach((t, i) => {
      expect(t).toBeGreaterThan(arrivals[i] as number);
      expect(t).toBeLessThan((arrivals[i] as number) + WIND.riseMs + 100);
    });
    expect(Math.max(...began) - Math.min(...began)).toBeGreaterThan(500);
    // It comes in gusts: over ten minutes the wear of a print climbs in a few bursts, with
    // long calms in which it stands still.
    const lone = new FootprintSim(FIELD, WIND, T);
    lone.add(print({ exposure: exposure("sand"), rules: { ...rules, wind: 0.001 } }), 0);
    let still = 0;
    let bursts = 0;
    let before = 0;
    for (let t = 0; t < 10 * 60_000; t += 1000) {
      for (let k = 0; k < 20; k++) lone.step(50, t + (k + 1) * 50);
      const wear = lone.prints[0]?.wear ?? 1;
      if (wear === before) still++;
      else bursts++;
      before = wear;
    }
    expect(bursts).toBeGreaterThan(3);
    expect(still).toBeGreaterThan(bursts * 4);
  });

  it("is the same on every client: place and clock decide, nothing else", () => {
    const once = (): number => {
      const sim = new FootprintSim(FIELD, WIND, T);
      sim.add(print({ exposure: 1.3, rules: { wind: 0.01, waves: false, tread: 0 } }), 0);
      run(sim, 180_000);
      return sim.prints[0]?.wear ?? 1;
    };
    expect(once()).toBe(once());
    expect(once()).toBeGreaterThan(0);
    // The gusts' clock is the one every client shares, not the frame's: two clients whose
    // own clocks differ wear the same print alike.
    const shared = (frameClock: number): number => {
      const sim = new FootprintSim(FIELD, WIND, T);
      sim.add(print({ exposure: 1.3, rules: { wind: 0.01, waves: false, tread: 0 } }), frameClock);
      for (let t = 0; t < 180_000; t += 50) sim.step(50, frameClock + t + 50, 1, t + 50);
      return sim.prints[0]?.wear ?? 1;
    };
    expect(shared(5_000_000)).toBe(once());
  });

  it("is calmer at night: the same print wears less", () => {
    const wearAfter = (scale: number): number => {
      const sim = new FootprintSim(FIELD, WIND, T);
      sim.add(print({ exposure: 1.3, rules: { wind: 0.01, waves: false, tread: 0 } }), 0);
      run(sim, 180_000, 0, scale);
      return sim.prints[0]?.wear ?? 1;
    };
    expect(wearAfter(WIND.night)).toBeLessThan(wearAfter(1));
    expect(wearAfter(1)).toBeGreaterThan(0);
  });
});

describe("the waves", () => {
  const W = FIELD.waves;

  it("measures how far a tile is from the water's edge", () => {
    const water = (x: number): boolean => x >= 20;
    expect(shoreDistance(19, 5, W.reachTiles, water)).toBe(0.5);
    expect(shoreDistance(18, 5, W.reachTiles, water)).toBe(1.5);
    expect(shoreDistance(17, 5, W.reachTiles, water)).toBe(2.5);
    expect(shoreDistance(16, 5, W.reachTiles, water)).toBeUndefined();
  });

  it("gives every wave its own reach, most of them short", () => {
    const reaches = Array.from({ length: 200 }, (_, n) => waveReach(W, n));
    expect(Math.min(...reaches)).toBeGreaterThanOrEqual(0.75);
    expect(Math.max(...reaches)).toBeLessThanOrEqual(W.reachTiles);
    expect(Math.max(...reaches)).toBeGreaterThan(W.reachTiles * 0.9);
    expect(reaches.filter((r) => r < 1.5).length).toBeGreaterThan(100);
  });

  it("wipes a print at the water's edge with the very next wave, quickly", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    const now = 100_000;
    sim.add(print({ surface: "wet_sand", rules: rulesOf("wet_sand"), shore: 0.5 }), now);
    const at = sim.prints[0]?.waveAt ?? 0;
    expect(at).toBeGreaterThan(now);
    expect(at - now).toBeLessThanOrEqual(W.periodMs);
    // Untouched until the wave comes, gone a wash later.
    sim.step(at - now - 1, at - 1);
    expect(sim.prints[0]?.wear).toBe(0);
    const gone = run(sim, 5000, at);
    expect(gone).toBeGreaterThan(0);
    expect(gone).toBeLessThanOrEqual(W.washMs + 100);
  });

  it("leaves a print higher up the beach for a bigger wave, and one out of reach alone", () => {
    const now = 50_000;
    const near = nextWash(W, 10, 10, 0.5, now);
    const far = nextWash(W, 10, 10, 2.2, now);
    expect(far).toBeGreaterThan(near);
    expect(Number.isFinite(far)).toBe(true);
    // The wave that takes it really runs that far.
    const n = Math.round((far - 20 * W.lagMs) / W.periodMs);
    expect(waveTime(W, n, 10, 10)).toBe(far);
    expect(waveReach(W, n)).toBeGreaterThanOrEqual(2.2);
    expect(nextWash(W, 10, 10, W.reachTiles + 0.5, now)).toBe(Number.POSITIVE_INFINITY);
    // Dry sand has no waves, whatever the distance.
    const sim = new FootprintSim(FIELD, undefined, T);
    sim.add(print({ shore: 0.5 }), now);
    expect(sim.prints[0]?.waveAt).toBe(Number.POSITIVE_INFINITY);
  });

  it("comes with the surf: a whole number of the water's loops, running along the coast", () => {
    // ground/water_shallow: 4 frames of 240 ms (assets/sprites.yaml).
    expect(W.periodMs % (4 * 240)).toBe(0);
    expect(waveTime(W, 3, 11, 10) - waveTime(W, 3, 10, 10)).toBe(W.lagMs);
    // The same wave for every client.
    expect(nextWash(W, 4, 9, 1, 12345)).toBe(nextWash(W, 4, 9, 1, 12345));
  });
});

describe("other feet", () => {
  it("scuff the marks they land on, and never their own", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    sim.add(print({ by: 1 }), 0);
    expect(sim.tread(10 * T + 2, 10 * T - 1, 1)).toBe(0);
    expect(sim.prints[0]?.wear).toBe(0);
    expect(sim.tread(10 * T + 40, 10 * T, 2)).toBe(0); // a tile away
    expect(sim.tread(10 * T + 2, 10 * T - 1, 2)).toBe(1);
    expect(sim.prints[0]?.wear).toBe(rulesOf("sand").tread);
    sim.tread(10 * T, 10 * T, 3);
    sim.step(16, 16);
    expect(sim.count).toBe(0); // two feet over it: gone
  });
});

describe("the cap", () => {
  it("fades the oldest out past the soft cap, never popping one", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    for (let i = 0; i < SOFT_FOOTPRINTS; i++) sim.add(print({ x: i, by: 1 }), i);
    expect(sim.prints.some((p) => p.retiring)).toBe(false);
    sim.add(print({ x: 999, by: 1 }), 100);
    const first = sim.prints.find((p) => p.x === 0);
    expect(first?.retiring).toBe(true);
    expect(sim.prints.filter((p) => p.retiring)).toHaveLength(1);
    // It fades: less and less visible over fade_ms, then gone.
    const alphas: number[] = [];
    for (let t = 0; t < FIELD.fadeMs + 100; t += 50) {
      sim.step(50, 100 + t);
      if (first && sim.prints.includes(first)) alphas.push(FootprintSim.alpha(first));
    }
    expect(alphas.length).toBeGreaterThan(5);
    for (let i = 1; i < alphas.length; i++)
      expect(alphas[i] as number).toBeLessThan(alphas[i - 1] as number);
    expect(alphas[0]).toBeGreaterThan(0.8);
    expect(sim.count).toBe(SOFT_FOOTPRINTS);
    expect(sim.prints.some((p) => p.x === 999 && !p.retiring)).toBe(true);
  });

  it("never holds more than the cap, even in a burst within one frame", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    for (let i = 0; i < MAX_FOOTPRINTS * 3; i++) sim.add(print({ x: i, by: 1 }), 0);
    expect(sim.count).toBe(MAX_FOOTPRINTS);
    expect(sim.prints.some((p) => p.x === MAX_FOOTPRINTS * 3 - 1)).toBe(true);
    // A walk at a normal pace settles round the soft cap.
    for (let i = 0; i < 200; i++) {
      sim.add(print({ x: 5000 + i, by: 1 }), i * 200);
      for (let k = 0; k < 4; k++) sim.step(50, i * 200 + k * 50);
    }
    expect(sim.count).toBeLessThanOrEqual(SOFT_FOOTPRINTS + 4);
    expect(sim.count).toBeGreaterThanOrEqual(SOFT_FOOTPRINTS - 1);
  });

  it("has a hook for the rain to come", () => {
    const sim = new FootprintSim(FIELD, undefined, T);
    sim.add(print(), 0);
    sim.rain = 0.5;
    sim.step(1000, 1000);
    expect(sim.prints[0]?.wear).toBeCloseTo(0.5);
  });
});
