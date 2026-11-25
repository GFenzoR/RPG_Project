import { describe, expect, it } from "vitest";
import { CritterSim, FLEE_MS, MAX_CRITTERS, RETURN_MS } from "./critters.ts";
import { EMPTY_DATA, groundSurfaces, isSurface, parseLivingWorldData } from "./data.ts";
import type { SurfaceRules } from "./data.ts";
import { FootprintSim, gust, MAX_FOOTPRINTS, stepRotation } from "./footprints.ts";
import { footstepEvents } from "./footsteps.ts";
import { seededRandom } from "./hash.ts";
import { LEAF_FALL_MS, LEAF_REST_MS, LeafSim, MAX_LEAVES } from "./leaves.ts";
import { MAX_PUFFS, PUFF_MS, PuffSim } from "./puffs.ts";
import { BEND, bendPx, MAX_SWAYS, NEIGHBOUR, rustleOffset, SWAY_MS, SwaySim } from "./sway.ts";
import {
  MAX_WEAR_DRAWN,
  MAX_WEAR_LEVEL,
  WEAR_E,
  WEAR_N,
  WEAR_S,
  WEAR_W,
  WearMap,
  wearSprite,
} from "./wear.ts";

/** The first element, which the test expects to be there. */
function first<T>(list: readonly T[]): T {
  const v = list[0];
  if (v === undefined) throw new Error("empty");
  return v;
}

const rules = (over: Partial<SurfaceRules> = {}): SurfaceRules => ({
  footprintMs: 10000,
  wind: 0,
  dust: false,
  ripple: false,
  tint: 0x553311,
  sound: "sand",
  critters: [],
  ...over,
});

describe("data", () => {
  it("parses surfaces and plants, skipping what it does not know", () => {
    const d = parseLivingWorldData(
      {
        surfaces: {
          sand: { footprints: 9000, wind: 2, dust: true, tint: "#7a6440", critters: ["bird", "x"] },
          lava: {},
          marble: { footprints: 1 },
        },
      },
      {
        plants: [
          { item: "bush", reaction: "bend" },
          { item: "oak", reaction: "rustle", leaves: true },
          { reaction: "bend" },
        ],
      },
    );
    expect(d.surfaces.sand).toEqual({
      footprintMs: 9000,
      wind: 2,
      dust: true,
      ripple: false,
      tint: 0x7a6440,
      sound: "sand",
      critters: ["bird"],
    });
    expect(d.surfaces.lava?.footprintMs).toBe(0);
    expect(Object.keys(d.surfaces)).toEqual(["sand", "lava"]);
    expect(d.plants).toEqual({
      bush: { reaction: "bend", leaves: false, trample: false },
      oak: { reaction: "rustle", leaves: true, trample: false },
    });
    expect(parseLivingWorldData(undefined, null)).toEqual(EMPTY_DATA);
  });

  it("builds the ground surface lookup from the client's items", () => {
    const table = groundSurfaces({
      1: { surface: "sand" },
      2: {},
      3: { surface: "marble" },
      4: undefined,
    });
    expect([...table]).toEqual([[1, "sand"]]);
    expect(isSurface("snow")).toBe(true);
    expect(isSurface("Snow")).toBe(false);
  });
});

describe("footprints", () => {
  it("fade out over the end of their life and are gone after it", () => {
    const sim = new FootprintSim();
    sim.add(0, 0, 0, "feet", "mud", rules());
    const p = sim.prints[0];
    expect(p && FootprintSim.alpha(p)).toBe(1);
    sim.step(5000, 5000);
    expect(p && FootprintSim.alpha(p)).toBe(1);
    sim.step(2500, 7500);
    expect(p && FootprintSim.alpha(p)).toBeCloseTo(0.5);
    sim.step(2500, 10000);
    expect(sim.count).toBe(0);
  });

  it("leaves none on a surface without footprints", () => {
    const sim = new FootprintSim();
    sim.add(0, 0, 0, "feet", "stone", rules({ footprintMs: 0 }));
    expect(sim.count).toBe(0);
  });

  it("never holds more than the cap: the most worn gives way", () => {
    const sim = new FootprintSim();
    for (let i = 0; i < MAX_FOOTPRINTS; i++) {
      sim.add(i, 0, 0, "paw", "snow", rules());
      sim.step(10, i * 10);
    }
    expect(sim.count).toBe(MAX_FOOTPRINTS);
    sim.add(999, 0, 0, "big_paw", "snow", rules());
    expect(sim.count).toBe(MAX_FOOTPRINTS);
    expect(sim.prints.some((p) => p.x === 0)).toBe(false); // the first one, most worn, went
    expect(sim.prints.some((p) => p.x === 999)).toBe(true);
  });

  it("wind wears sand faster, in gusts, the same way every run", () => {
    const run = (): number[] => {
      const still = new FootprintSim();
      const windy = new FootprintSim();
      still.add(40, 40, 0, "feet", "mud", rules({ footprintMs: 1e6 }));
      windy.add(40, 40, 0, "feet", "sand", rules({ footprintMs: 1e6, wind: 3 }));
      const out: number[] = [];
      for (let t = 0; t < 4000; t += 50) {
        still.step(50, t);
        windy.step(50, t);
      }
      out.push(still.prints[0]?.wear ?? -1, windy.prints[0]?.wear ?? -1);
      return out;
    };
    const [still, windy] = run();
    expect(still).toBe(4000);
    expect(windy).toBeGreaterThan(4000);
    expect(run()).toEqual([still, windy]);
    // Gusts come and go: calm somewhere, strong somewhere else.
    const samples = Array.from({ length: 200 }, (_, i) => gust(64, 64, i * 250));
    expect(Math.min(...samples)).toBeLessThan(0.05);
    expect(Math.max(...samples)).toBeGreaterThan(0.8);
  });

  it("point the way the creature walks", () => {
    expect(stepRotation(0, -1)).toBe(0);
    expect(stepRotation(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(stepRotation(0, 1)).toBeCloseTo(Math.PI);
    expect(stepRotation(-1, 0)).toBeCloseTo(-Math.PI / 2);
  });
});

describe("plants", () => {
  it("bend on and next to a step, spring back and settle", () => {
    const sim = new SwaySim();
    sim.trigger(10, 10, 1, 1000);
    expect(sim.bendAt(10, 10, 1000)).toBeCloseTo(BEND);
    expect(sim.bendAt(11, 10, 1000)).toBeCloseTo(BEND * 0.45);
    expect(sim.bendAt(12, 10, 1000)).toBe(0); // two tiles away: still
    // It swings back the other way, then settles.
    const later = [...Array(9).keys()].map((i) => sim.bendAt(10, 10, 1000 + i * 100));
    expect(Math.min(...later)).toBeLessThan(0);
    expect(sim.bendAt(10, 10, 1000 + SWAY_MS)).toBe(0);
    sim.prune(1000 + SWAY_MS);
    expect(sim.active).toBe(0);
  });

  // A bush or a tree is solid (docs/06 "Qué bloquea el paso"): nobody steps on its tile, so
  // all it ever gets is the brush of a walker on a tile next to it.
  it("bend when a walker brushes past a solid plant, never stepping on it", () => {
    const sim = new SwaySim();
    const bush = { x: 10, y: 10 };
    // Walking east along the row below it: two tiles away it stays still.
    sim.trigger(8, 11, 1, 0);
    expect(sim.bendAt(bush.x, bush.y, 0)).toBe(0);
    // Diagonally next to it, right below it and past it: each step brushes it, leaning the
    // way the walker goes, enough to see (a pixel or more of a 32 px sprite).
    for (const [i, x] of [9, 10, 11].entries()) {
      const now = 400 * (i + 1);
      sim.trigger(x, 11, 1, now);
      expect(sim.bendAt(bush.x, bush.y, now)).toBeCloseTo(BEND * NEIGHBOUR);
      expect(Math.tan(sim.bendAt(bush.x, bush.y, now)) * 32).toBeGreaterThan(1);
    }
    // A tree shakes when brushed too.
    expect(Math.abs(rustleOffset(BEND * NEIGHBOUR))).toBeGreaterThanOrEqual(1);
    // Walking straight past its side (north along the column next to it) pushes it away.
    const side = new SwaySim();
    side.trigger(11, 10, 0, 0);
    expect(side.bendAt(bush.x, bush.y, 0)).toBeCloseTo(-BEND * NEIGHBOUR);
  });

  it("lean the way the walker goes, and away from it when it walks up or down", () => {
    const sim = new SwaySim();
    sim.trigger(5, 5, -1, 0);
    expect(sim.bendAt(5, 5, 0)).toBeLessThan(0);
    const up = new SwaySim();
    up.trigger(5, 5, 0, 0);
    expect(up.bendAt(4, 5, 0)).toBeLessThan(0);
    expect(up.bendAt(6, 5, 0)).toBeGreaterThan(0);
  });

  it("cap the plants moving at once", () => {
    const sim = new SwaySim();
    for (let i = 0; i < 20; i++) sim.trigger(i * 3, 0, 1, 0);
    expect(sim.active).toBe(MAX_SWAYS);
  });

  it("shake a tree a pixel or so, and turn a bend into pixels at the top", () => {
    expect(rustleOffset(BEND)).toBe(1);
    expect(rustleOffset(0)).toBe(0);
    // A tree only shakes; a bush leans by its moving rows.
    expect(bendPx(BEND, 60, true)).toBeCloseTo(1.4);
    expect(bendPx(BEND, 26, false)).toBeGreaterThan(3);
    expect(bendPx(-BEND, 26, false)).toBeCloseTo(-bendPx(BEND, 26, false));
    expect(bendPx(0, 26, false)).toBe(0);
  });
});

describe("puffs and leaves", () => {
  it("puffs play their frames and end; the oldest gives way at the cap", () => {
    const sim = new PuffSim();
    sim.add("ripple", 0, 0, 0xffffff);
    expect(PuffSim.frame(first(sim.puffs)).frame).toBe(0);
    sim.step(PUFF_MS.ripple - 1);
    expect(PuffSim.frame(first(sim.puffs)).frame).toBe(3);
    sim.step(1);
    expect(sim.puffs.length).toBe(0);
    for (let i = 0; i < MAX_PUFFS + 5; i++) {
      sim.add("dust", i, 0, 0);
      sim.step(1);
    }
    expect(sim.puffs.length).toBe(MAX_PUFFS);
  });

  it("leaves fall, rest, fade and are capped", () => {
    const sim = new LeafSim(seededRandom(1));
    expect(sim.drop(100, 100)).toBe(true);
    const start = LeafSim.pose(first(sim.leaves));
    sim.step(LEAF_FALL_MS);
    const landed = LeafSim.pose(first(sim.leaves));
    expect(landed.y).toBeGreaterThan(start.y);
    expect(landed.alpha).toBe(1);
    sim.step(LEAF_REST_MS);
    expect(sim.leaves.length).toBe(0);
    for (let i = 0; i < MAX_LEAVES + 3; i++) sim.drop(0, 0);
    expect(sim.leaves.length).toBe(MAX_LEAVES);
  });
});

describe("critters", () => {
  const meadow = {
    grass: rules({ critters: ["bird", "butterfly", "firefly"] }),
    water_shallow: rules({ critters: ["fish"] }),
  };
  const view = { x: 0, y: 0, width: 60, height: 60 };

  it("live on their surfaces only, by their hour, capped", () => {
    const day = new CritterSim(32);
    day.update(0, view, undefined, () => "grass", meadow, false);
    expect(day.critters.length).toBeGreaterThan(0);
    expect(day.critters.length).toBeLessThanOrEqual(MAX_CRITTERS);
    expect(day.critters.every((c) => c.kind === "bird" || c.kind === "butterfly")).toBe(true);
    const night = new CritterSim(32);
    night.update(0, view, undefined, () => "grass", meadow, true);
    expect(night.critters.every((c) => c.kind === "firefly")).toBe(true);
    const stone = new CritterSim(32);
    stone.update(0, view, undefined, () => "stone", meadow, false);
    expect(stone.critters.length).toBe(0);
  });

  it("flee from a player who comes close and stay away a while", () => {
    const sim = new CritterSim(32);
    sim.update(0, view, undefined, () => "grass", meadow, false);
    const c = first(sim.critters);
    const home = { x: c.hx, y: c.hy };
    // From now on only its home is grass, so the others do not fill the cap.
    const only = (x: number, y: number) => (x === home.x && y === home.y ? "grass" : "stone");
    sim.update(100, view, { x: home.x + 1, y: home.y }, only, meadow, false);
    expect(c.fled).toBe(100);
    sim.update(100 + FLEE_MS / 2, view, undefined, only, meadow, false);
    expect(c.x).toBeLessThan((home.x + 0.5) * 32); // away from the player, east of it
    sim.update(100 + FLEE_MS + 1000, view, undefined, only, meadow, false);
    expect(sim.critters.some((k) => k.hx === home.x && k.hy === home.y)).toBe(false);
    sim.update(100 + RETURN_MS + 2000, view, undefined, only, meadow, false);
    expect(sim.critters.some((k) => k.hx === home.x && k.hy === home.y)).toBe(true);
  });
});

describe("wear and footsteps", () => {
  it("wear keeps levels 1 to 3, forgets 0 and keeps the most worn in view", () => {
    const w = new WearMap();
    w.apply([
      { x: 1, y: 1, z: 7, level: 1 },
      { x: 2, y: 1, z: 7, level: 9 },
      { x: 3, y: 1, z: 6, level: 2 },
    ]);
    expect(w.level(2, 1, 7)).toBe(MAX_WEAR_LEVEL);
    expect(
      w
        .inView(7, 0, 0, 5, 5)
        .map((t) => t.level)
        .sort(),
    ).toEqual([1, 3]);
    const v = w.version;
    w.apply([{ x: 1, y: 1, z: 7, level: 1 }]);
    expect(w.version).toBe(v); // no change, no rebuild of the view list
    w.apply([{ x: 1, y: 1, z: 7, level: 0 }]);
    expect(w.size).toBe(2);
    expect(w.version).toBeGreaterThan(v);
    w.apply([{ x: 5, y: 5, z: 7, level: 2 }], true);
    expect(w.size).toBe(1);
    w.apply(
      Array.from({ length: MAX_WEAR_DRAWN + 10 }, (_, i) => ({
        x: i * 2,
        y: 0,
        z: 7,
        level: i < 5 ? 3 : 1,
      })),
    );
    const shown = w.inView(7, 0, 0, 1000, 1000);
    expect(shown.length).toBe(MAX_WEAR_DRAWN);
    expect(shown.slice(0, 5).every((t) => t.level === 3)).toBe(true);
  });

  it("wear picks each tile's overlay by its level and its worn neighbours", () => {
    const w = new WearMap();
    // A path east-west with a branch north at x = 5, and one lone tile.
    const path = [3, 4, 5, 6].map((x) => ({ x, y: 5, z: 7, level: 3 }));
    w.apply([...path, { x: 5, y: 4, z: 7, level: 2 }, { x: 10, y: 10, z: 7, level: 1 }]);
    const shown = new Map(w.inView(7, 0, 0, 20, 20).map((t) => [`${t.x},${t.y}`, t]));
    const sprite = (x: number, y: number): string => {
      const t = shown.get(`${x},${y}`);
      return t ? wearSprite(t.level, t.mask) : "";
    };
    expect(sprite(3, 5)).toBe(`trail_3_${WEAR_E}`);
    expect(sprite(4, 5)).toBe(`trail_3_${WEAR_E | WEAR_W}`);
    expect(sprite(5, 5)).toBe(`trail_3_${WEAR_N | WEAR_E | WEAR_W}`);
    expect(sprite(6, 5)).toBe(`trail_3_${WEAR_W}`);
    expect(sprite(5, 4)).toBe(`trail_2_${WEAR_S}`);
    expect(sprite(10, 10)).toBe("trail_1_0");
    // Another floor's wear joins nothing.
    w.apply([{ x: 4, y: 4, z: 6, level: 3 }]);
    expect(w.mask(4, 5, 7)).toBe(WEAR_E | WEAR_W);
  });

  it("name the surface's step sound first, then the plain step", () => {
    const d = parseLivingWorldData({ surfaces: { wet_sand: { sound: "sand" } } }, {});
    expect(footstepEvents("wet_sand", d)).toEqual(["step.self.sand", "step.self"]);
    expect(footstepEvents("snow", d)).toEqual(["step.self.snow", "step.self"]);
    expect(footstepEvents(undefined, d)).toEqual(["step.self"]);
  });
});
