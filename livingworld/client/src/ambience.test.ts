import { describe, expect, it } from "vitest";
import {
  AmbienceMixer,
  BED_PAN,
  Classifier,
  Composition,
  FAST_FADE,
  MAX_PAN,
  OFFSET_GAP,
  PAN_TILES,
  bedTargets,
  createAmbience,
  emitterGain,
  emitterTargets,
  mergeTargets,
  panOf,
  parseAmbience,
} from "./ambience.ts";
import type { AmbienceData, EmitterRule, Target } from "./ambience.ts";
import type { Surface } from "./data.ts";
import { seededRandom } from "./hash.ts";

// Item numbers of a tiny test world: grounds and items.
const WATER = 1;
const SAND = 2;
const GRASS = 3;
const TREE = 10;
const FOUNTAIN = 11;
const TORCH = 12;
const ids: Record<number, string> = {
  [WATER]: "water_shallow",
  [SAND]: "sand",
  [GRASS]: "grass",
  [TREE]: "oak_tree",
  [FOUNTAIN]: "fountain",
  [TORCH]: "wall_torch",
};
const surfaces: Record<number, Surface> = {
  [WATER]: "water_shallow",
  [SAND]: "sand",
  [GRASS]: "grass",
};

const RAW = {
  radius: 4,
  fade_ms: 1000,
  voices: 4,
  voices_lite: 2,
  rescan_ms: 2000,
  beds: {
    waves: { sound: "amb_waves", volume: 0.8, full: 0.5, surfaces: { water_shallow: 1 } },
    wind: { sound: "amb_wind", volume: 0.5, full: 1, surfaces: { sand: 1 } },
    forest: { sound: "amb_forest", volume: 0.6, full: 0.2, items: { oak_tree: 1 } },
    cave: { sound: "amb_cave", volume: 0.5, floors: "underground", base: 1 },
  },
  emitters: {
    fountain: { sound: "amb_fountain", volume: 0.6, radius: 4 },
    wall_torch: { sound: "amb_torch", volume: 0.3, radius: 2, falloff: "linear" },
  },
};
const DATA = parseAmbience(RAW) as AmbienceData;

/** A seeded world: water to the west, sand in the middle, grass and trees to the east. */
function world(seed = 7): (x: number, y: number, z: number) => readonly number[] | undefined {
  const rand = seededRandom(seed);
  const map = new Map<string, number[]>();
  for (let y = -30; y < 30; y++)
    for (let x = -30; x < 30; x++) {
      const ground = x < -5 ? WATER : x < 5 ? SAND : GRASS;
      const stack = [ground];
      const r = rand();
      if (ground === GRASS && r < 0.3) stack.push(TREE);
      else if (r > 0.985) stack.push(FOUNTAIN);
      else if (r > 0.97) stack.push(TORCH);
      map.set(`${x},${y},7`, stack);
    }
  return (x, y, z) => map.get(`${x},${y},${z}`);
}

const classifier = (data = DATA): Classifier =>
  new Classifier(
    data,
    (n) => ids[n],
    (n) => surfaces[n],
  );

const snapshot = (c: Composition) => ({
  sums: [...c.sums],
  sumsX: [...c.sumsX],
  known: c.known,
  emitters: [...c.emitters.values()].map((e) => `${e.x},${e.y},${e.rule.item}`).sort(),
});

describe("parseAmbience", () => {
  it("reads the beds and emitters with their defaults", () => {
    expect(DATA.radius).toBe(4);
    expect(DATA.beds.map((b) => b.id)).toEqual(["waves", "wind", "forest", "cave"]);
    expect(DATA.beds[0]?.floors).toBe("surface");
    expect(DATA.beds[3]).toMatchObject({ floors: "underground", base: 1 });
    expect(DATA.emitters["fountain"]).toMatchObject({ falloff: "smooth", radius: 4 });
    expect(DATA.emitters["wall_torch"]?.falloff).toBe("linear");
  });

  it("is lenient: skips broken entries and clamps numbers", () => {
    const d = parseAmbience({
      radius: 99,
      voices: 3,
      voices_lite: 7,
      beds: { a: { volume: 1 }, b: { sound: "x", surfaces: { lava: 2, nope: 1 } } },
      emitters: { e: { sound: "y", radius: 50 } },
    });
    expect(d?.radius).toBe(16);
    expect(d?.voicesLite).toBe(3); // never more than voices
    expect(d?.beds.map((b) => b.id)).toEqual(["b"]);
    expect(d?.beds[0]?.surfaces).toEqual({ lava: 1 });
    expect(d?.emitters["e"]?.radius).toBe(16); // at most the window
    expect(parseAmbience(undefined)).toBeUndefined();
  });
});

describe("Composition", () => {
  it("weights the beds by the share of tiles in the window", () => {
    const c = new Composition(4, DATA.beds.length, classifier(), world());
    c.rebuild(-6, 0, 7); // x -10..-2: 5 columns of water, 4 of sand
    expect(c.known).toBe(81);
    expect(c.sums[0]).toBe(5 * 9 * 1000);
    expect(c.sums[1]).toBe(4 * 9 * 1000);
    expect(c.sums[2]).toBe(0);
  });

  it("moves incrementally to the same result as a full count, deterministically", () => {
    const src = world();
    const walk = seededRandom(42);
    const inc = new Composition(4, DATA.beds.length, classifier(), src);
    inc.rebuild(0, 0, 7);
    let x = 0;
    let y = 0;
    for (let i = 0; i < 300; i++) {
      const r = walk();
      // Mostly single steps, sometimes diagonal, now and then a jump (a teleport).
      if (r < 0.25) x++;
      else if (r < 0.5) x--;
      else if (r < 0.7) y++;
      else if (r < 0.9) y--;
      else if (r < 0.97) {
        x++;
        y--;
      } else x += 9;
      x = Math.max(-20, Math.min(20, x));
      y = Math.max(-20, Math.min(20, y));
      inc.moveTo(x, y, 7);
      const full = new Composition(4, DATA.beds.length, classifier(), src);
      full.rebuild(x, y, 7);
      expect(snapshot(inc)).toEqual(snapshot(full));
    }
  });

  it("counts unknown tiles as nothing and takes away only what a tile brought", () => {
    const known = new Set(["0,0", "1,0"]);
    const src = (x: number, y: number) => (known.has(`${x},${y}`) ? [WATER] : undefined);
    const c = new Composition(1, DATA.beds.length, classifier(), src);
    c.rebuild(0, 0, 7);
    expect(c.known).toBe(2);
    known.add("2,0"); // arrives after the count: the step still only removes what it added
    c.moveTo(1, 0, 7);
    expect(c.known).toBe(3);
    c.moveTo(3, 0, 7);
    expect(c.known).toBe(1); // only 2,0 is left in x 2..4
    expect(c.sums[0]).toBe(1000);
  });
});

describe("bed targets", () => {
  it("scales with the share, caps at full, pans towards the tiles", () => {
    const c = new Composition(4, DATA.beds.length, classifier(), world());
    c.rebuild(-6, 0, 7);
    const t = bedTargets(c, DATA.beds);
    const waves = t.find((x) => x.sound === "amb_waves");
    const wind = t.find((x) => x.sound === "amb_wind");
    expect(waves?.gain).toBeCloseTo(0.8); // 5/9 of the window is water, over full 0.5
    expect(wind?.gain).toBeCloseTo(0.5 * (4 / 9));
    expect(waves?.pan).toBeLessThan(0); // the sea is to the west
    expect(wind?.pan).toBeGreaterThan(0);
    expect(Math.abs(waves?.pan ?? 0)).toBeLessThanOrEqual(BED_PAN);
    expect(t.some((x) => x.sound === "amb_cave")).toBe(false); // underground only
  });

  it("plays the sea only near it: none far inland", () => {
    const c = new Composition(4, DATA.beds.length, classifier(), world());
    c.rebuild(15, 0, 7);
    expect(bedTargets(c, DATA.beds).some((x) => x.sound === "amb_waves")).toBe(false);
    expect(bedTargets(c, DATA.beds).some((x) => x.sound === "amb_forest")).toBe(true);
  });

  it("gives a base-level bed underground with no tiles at all", () => {
    const c = new Composition(4, DATA.beds.length, classifier(), () => undefined);
    c.rebuild(0, 0, 9);
    expect(bedTargets(c, DATA.beds)).toEqual([{ sound: "amb_cave", gain: 0.5, pan: 0 }]);
  });
});

describe("emitters", () => {
  const fountain = DATA.emitters["fountain"] as EmitterRule;
  const torch = DATA.emitters["wall_torch"] as EmitterRule;

  it("attenuates with distance, smooth or linear, and culls beyond the radius", () => {
    expect(emitterGain(fountain, 0, 0)).toBeCloseTo(0.6);
    expect(emitterGain(fountain, 2, 0)).toBeCloseTo(0.6 * 0.25);
    expect(emitterGain(torch, 1, 0)).toBeCloseTo(0.15);
    expect(emitterGain(fountain, 3, 3)).toBeUndefined(); // 4.24 > 4
    expect(emitterGain(torch, 0, 3)).toBeUndefined();
    const near = emitterGain(fountain, 1, 1) ?? 0;
    expect(near).toBeGreaterThan(emitterGain(fountain, 2, 1) ?? 1);
  });

  it("pans by the x against the player's, never one ear only", () => {
    expect(panOf(0)).toBe(0);
    expect(panOf(3)).toBeCloseTo((3 / PAN_TILES) * MAX_PAN);
    expect(panOf(-20)).toBeCloseTo(-MAX_PAN);
  });

  it("finds the emitters in the window and leaves out the far ones", () => {
    const stacks = new Map([
      ["2,0", [GRASS, FOUNTAIN]],
      ["-1,0", [GRASS, TORCH]],
      ["0,4", [GRASS, TORCH]], // in the window, beyond the torch's radius
    ]);
    const c = new Composition(4, DATA.beds.length, classifier(), (x, y) => stacks.get(`${x},${y}`));
    c.rebuild(0, 0, 7);
    expect(c.emitters.size).toBe(3);
    const t = emitterTargets(c);
    expect(t).toHaveLength(2);
    expect(t.find((x) => x.sound === "amb_fountain")?.pan).toBeGreaterThan(0);
    expect(t.find((x) => x.sound === "amb_torch")?.pan).toBeLessThan(0);
    c.moveTo(-4, 0, 7); // the fountain (x 2) leaves the window
    expect(emitterTargets(c).some((x) => x.sound === "amb_fountain")).toBe(false);
  });

  it("merges the targets of one sound as power, loudest first", () => {
    const m = mergeTargets([
      { sound: "f", gain: 0.3, pan: -0.8 },
      { sound: "f", gain: 0.4, pan: 0.8 },
      { sound: "w", gain: 0.45, pan: 0 },
    ]);
    expect(m[0]?.sound).toBe("f");
    expect(m[0]?.gain).toBeCloseTo(0.5);
    expect(m[0]?.pan).toBeCloseTo((0.3 * -0.8 + 0.4 * 0.8) / 0.7);
    expect(m[1]?.sound).toBe("w");
  });
});

describe("AmbienceMixer", () => {
  const T = (sound: string, gain: number, pan = 0): Target => ({ sound, gain, pan });

  it("fades in and out over fade_ms, never jumping", () => {
    const m = new AmbienceMixer(1000, seededRandom(1));
    m.update(0, [T("a", 1)], 4);
    expect(m.voices()[0]?.gain).toBe(0);
    m.update(250, [T("a", 1)], 4);
    expect(m.voices()[0]?.gain).toBeCloseTo(0.25);
    m.update(1250, [T("a", 1)], 4); // a step is at most MAX_STEP_MS
    expect(m.voices()[0]?.gain).toBeCloseTo(0.75);
    m.update(1500, [T("a", 1)], 4);
    expect(m.voices()[0]?.gain).toBe(1);
    m.update(1750, [], 4);
    expect(m.voices()[0]?.gain).toBeCloseTo(0.75);
    for (let t = 2000; t <= 2750; t += 250) m.update(t, [], 4);
    expect(m.voices()).toHaveLength(0);
  });

  it("brings a fading voice back up instead of restarting it", () => {
    const m = new AmbienceMixer(1000, seededRandom(1));
    for (let t = 0; t <= 1000; t += 250) m.update(t, [T("a", 1)], 4);
    const first = m.voices()[0];
    m.update(1250, [], 4);
    m.update(1500, [T("a", 1)], 4);
    expect(m.voices()).toHaveLength(1);
    expect(m.voices()[0]?.id).toBe(first?.id);
    expect(m.voices()[0]?.offset).toBe(first?.offset);
  });

  it("starts a loop again away from where it started last", () => {
    // A random source that keeps answering the same number: the gap rule still moves it.
    const m = new AmbienceMixer(100, () => 0.3);
    const offsets: number[] = [];
    for (let round = 0; round < 4; round++) {
      const base = round * 10_000;
      m.update(base, [T("a", 1)], 4);
      offsets.push(m.voices()[0]?.offset ?? -1);
      for (let t = base + 250; t < base + 2000; t += 250) m.update(t, [], 4);
      expect(m.voices()).toHaveLength(0);
    }
    for (let i = 1; i < offsets.length; i++) {
      const d = Math.abs((offsets[i] ?? 0) - (offsets[i - 1] ?? 0));
      expect(Math.min(d, 1 - d)).toBeGreaterThanOrEqual(OFFSET_GAP);
    }
  });

  it("never plays more voices than the cap, the loudest first", () => {
    const m = new AmbienceMixer(1000, seededRandom(3));
    const many = [T("a", 0.9), T("b", 0.8), T("c", 0.7), T("d", 0.6)];
    for (let t = 0; t <= 2000; t += 250) {
      m.update(t, many, 2);
      expect(m.voices().length).toBeLessThanOrEqual(2);
    }
    expect(m.voices().map((v) => v.sound)).toEqual(["a", "b"]);
    // A louder layer comes: the one it displaces fades out fast, then it starts.
    const next = [T("e", 1), T("a", 0.9), T("b", 0.1)];
    let t = 2250;
    m.update(t, next, 2);
    expect(m.voices().map((v) => v.sound)).not.toContain("e"); // b fades first
    for (; m.voices().every((v) => v.sound !== "e"); t += 250) {
      m.update(t, next, 2);
      expect(m.voices().length).toBeLessThanOrEqual(2);
    }
    expect(t - 2250).toBeLessThanOrEqual(1000 / FAST_FADE + 500);
    expect(
      m
        .voices()
        .map((v) => v.sound)
        .sort(),
    ).toEqual(["a", "e"]);
  });

  it("drops to a lower cap by fading the quietest out", () => {
    const m = new AmbienceMixer(1000, seededRandom(3));
    const three = [T("a", 0.9), T("b", 0.8), T("c", 0.7)];
    for (let t = 0; t <= 1000; t += 250) m.update(t, three, 3);
    expect(m.voices()).toHaveLength(3);
    for (let t = 1250; t <= 2000; t += 250) m.update(t, three, 2);
    expect(m.voices().map((v) => v.sound)).toEqual(["a", "b"]);
  });

  it("pans smoothly", () => {
    const m = new AmbienceMixer(1000, seededRandom(1));
    m.update(0, [T("a", 1, -0.8)], 4);
    m.update(200, [T("a", 1, 0.8)], 4);
    expect(m.voices()[0]?.pan).toBeCloseTo(-0.3);
  });
});

describe("createAmbience", () => {
  it("is deterministic: the same walk gives the same voices", () => {
    const run = () => {
      const a = createAmbience({
        data: DATA,
        tile: world(),
        itemId: (n) => ids[n],
        surface: (n) => surfaces[n],
        lite: () => false,
      });
      const out: string[] = [];
      for (let i = 0; i < 80; i++) {
        const vs = a.update(i * 250, { x: -12 + Math.floor(i / 3), y: 0, z: 7 });
        out.push(vs.map((v) => `${v.sound}:${v.gain.toFixed(4)}:${v.offset.toFixed(4)}`).join("|"));
      }
      return out;
    };
    const a = run();
    expect(run()).toEqual(a);
    // It walks from the sea into the forest: waves first, the forest last.
    expect(a[10]).toContain("amb_waves");
    expect(a.at(-1)).toContain("amb_forest");
    expect(a.at(-1)).not.toContain("amb_waves");
  });

  it("uses the lite cap on a phone or with reduced animations", () => {
    const a = createAmbience({
      data: DATA,
      tile: world(),
      itemId: (n) => ids[n],
      surface: (n) => surfaces[n],
      lite: () => true,
    });
    for (let t = 0; t < 5000; t += 250) {
      expect(a.update(t, { x: 0, y: 0, z: 7 }).length).toBeLessThanOrEqual(DATA.voicesLite);
    }
  });
});
