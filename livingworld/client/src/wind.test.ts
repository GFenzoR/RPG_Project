import { readFileSync } from "node:fs";
import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import { createLivingWorld, parseLivingWorldData } from "./index.ts";
import type { PlantSprite, Surface } from "./index.ts";
import { BEND } from "./sway.ts";
import { WindMesh } from "./wind-mesh.ts";
import {
  exposureOf,
  gustActive,
  gustAt,
  gustLean,
  gustResponseMs,
  gustShape,
  MAX_STRIPS,
  nextGust,
  parseWind,
  parseWindSprites,
  resolveWind,
  rowWeight,
  snapSteps,
  stripLayout,
  stripOffsets,
  swayAt,
  WIND_KINDS,
} from "./wind.ts";
import type { GustFront, PlantWind, WindData, WindField } from "./wind.ts";

const kind = (stiffness: number, amplitude: number, period_ms: number, drift = 0) => ({
  stiffness,
  amplitude,
  drift,
  period_ms,
  pivot: 0.25,
});

const WIND_YAML = {
  field: {
    direction: 0,
    speed: 8,
    exposure: { sand: 1.4, grass: 1, wood: 0 },
    forest: 0.5,
    night: 0.5,
  },
  gusts: {
    every_s: 40,
    jitter: 0.3,
    strength: [0.7, 1],
    spread: 20,
    travel_tiles: 64,
    rise_ms: 400,
    hold_ms: 1000,
    swings: 2,
    seed: 7,
  },
  kinds: {
    tree: kind(0.45, 3, 2200),
    palm: kind(0.3, 4, 2000),
    bush: kind(0.35, 1.5, 1400),
    tall_grass: kind(0.1, 2.5, 900),
    reed: kind(0.2, 2.5, 1100),
    flower: kind(0.15, 2, 1000),
    vine: kind(0.3, 1.5, 1400),
    cactus: kind(0.9, 0.5, 1600),
    dead_tree: kind(0.8, 0.8, 1600),
  },
};

const wind = parseWind(WIND_YAML) as WindData;
const field = wind.field;
const windOf = (k: (typeof WIND_KINDS)[number]): PlantWind =>
  resolveWind(wind, { kind: k }, undefined) as PlantWind;
const withGusts = (over: Record<string, unknown>): WindField =>
  (parseWind({ ...WIND_YAML, gusts: { ...WIND_YAML.gusts, ...over } }) as WindData).field;

/** The gust fronts that reach a tile from `from` to `to`, in order. */
function fronts(f: WindField, x: number, y: number, from: number, to: number): GustFront[] {
  const out: GustFront[] = [];
  let ms = from;
  for (;;) {
    const g = nextGust(f, x, y, ms);
    if (!g || g.at >= to) return out;
    out.push(g);
    ms = g.at;
  }
}

/** The first front of at least `min` to reach a tile after `from`. */
function strongGust(f: WindField, x: number, y: number, min = 0.6, from = 0): GustFront {
  const g = nextGust(f, x, y, from, min);
  if (!g) throw new Error("no gust");
  return g;
}

/** The largest sway of a plant over five minutes, sampled every 50 ms on a few tiles. */
function peak(w: PlantWind, exposure = 1): number {
  let max = 0;
  for (let tile = 0; tile < 6; tile++)
    for (let ms = 0; ms < 300_000; ms += 50)
      max = Math.max(max, Math.abs(swayAt(field, w, tile * 7, tile * 3, ms, exposure)));
  return max;
}

const HOUR = 3_600_000;

describe("the gusts", () => {
  it("leave a plant stock-still in the calm between two of them", () => {
    const tree = windOf("tree");
    const [x, y] = [12, 9];
    const list = fronts(field, x, y, 0, 10 * 60_000);
    expect(list.length).toBeGreaterThan(8);
    let calm = 0;
    for (let i = 1; i < list.length; i++) {
      const last = list[i - 1] as GustFront;
      const next = list[i] as GustFront;
      // From the last swing of one gust to the front of the next: exactly nothing.
      for (let ms = last.at + field.responseMs; ms < next.at; ms += 50) {
        expect(swayAt(field, tree, x, y, ms, 1)).toBe(0);
        expect(gustAt(field, x, y, ms)).toBe(0);
        calm += 50;
      }
      // ...and that calm is long: tens of seconds, never a breath.
      expect(next.at - last.at - field.responseMs).toBeGreaterThan(10_000);
    }
    // Most of the time nothing moves at all.
    expect(calm).toBeGreaterThan(10 * 60_000 * 0.6);
    // No gust on the whole map for most of it either: a frame has nothing to work out.
    let idle = 0;
    for (let ms = 0; ms < HOUR; ms += 500) if (!gustActive(field, ms)) idle++;
    expect(idle / (HOUR / 500)).toBeGreaterThan(0.4);
  });

  it("bend a plant as the front passes: it eases in, leans, swings less and less, settles", () => {
    const tree = windOf("tree");
    const [x, y] = [12, 9];
    const g = strongGust(field, x, y);
    const at = (tau: number): number => swayAt(field, tree, x, y, g.at + tau, 1);
    // Nothing before the front, a start with no jump, then the lean.
    expect(at(-1)).toBe(0);
    expect(Math.abs(at(16))).toBeLessThan(0.1);
    const lean = at(field.riseMs + field.holdMs / 2);
    expect(Math.abs(lean)).toBeGreaterThan(1);
    expect(Math.abs(lean)).toBeLessThanOrEqual(tree.amplitude);
    // It holds while the gust blows over it.
    expect(at(field.riseMs + 10)).toBeCloseTo(lean, 6);
    expect(at(field.riseMs + field.holdMs - 10)).toBeCloseTo(lean, 6);
    // The lean is the largest it gets, and it never jumps from one frame to the next.
    let last = 0;
    let most = 0;
    for (let tau = 0; tau < field.responseMs + 500; tau += 16) {
      const v = at(tau);
      expect(Math.abs(v - last)).toBeLessThan(0.25);
      most = Math.max(most, Math.abs(v));
      last = v;
    }
    expect(most).toBeCloseTo(Math.abs(lean), 6);
    // Still again after its last swing, long before the next gust.
    expect(at(field.responseMs)).toBe(0);
    expect(at(field.responseMs + 3000)).toBe(0);
  });

  it("shape the swings: back past rest and forth again, each smaller, then exactly nothing", () => {
    const P = 2000;
    const after = (u: number): number => gustShape(field, field.riseMs + field.holdMs + u, P);
    expect(gustShape(field, 0, P)).toBe(0);
    expect(gustShape(field, field.riseMs / 2, P)).toBeCloseTo(0.5);
    expect(gustShape(field, field.riseMs + 1, P)).toBe(1);
    // Leaves the lean with no jerk.
    expect(after(16)).toBeGreaterThan(0.99);
    // Half a period later it is on the other side, a whole one later back, and so on.
    const swings = [after(P / 2), after(P), after(1.5 * P), after(2 * P)];
    expect(swings[0]).toBeLessThan(0);
    expect(swings[1]).toBeGreaterThan(0);
    expect(swings[2]).toBeLessThan(0);
    for (let i = 1; i < swings.length; i++)
      expect(Math.abs(swings[i] as number)).toBeLessThan(Math.abs(swings[i - 1] as number) * 0.7);
    expect(Math.abs(swings[0] as number)).toBeLessThan(0.75);
    // `swings` swings and a half: after that, nothing.
    expect(after(1.5 * field.swings * P)).toBe(0);
    expect(after(60_000)).toBe(0);
    // A field with no swings: the plant lets go with the gust.
    const dead = withGusts({ swings: 0 });
    expect(gustShape(dead, dead.riseMs + dead.holdMs + 3 * dead.riseMs, P)).toBe(0);
  });

  it("are the same for every client: the place, the clock and the seed decide", () => {
    const tree = windOf("tree");
    const again = (parseWind(WIND_YAML) as WindData).field;
    const other = withGusts({ seed: 8 });
    let differs = 0;
    for (let i = 0; i < 3000; i++) {
      const [x, y, ms] = [(i * 13) % 97, (i * 7) % 61, i * 977];
      const v = swayAt(field, tree, x, y, ms, 1);
      expect(swayAt(field, tree, x, y, ms, 1)).toBe(v);
      // Another client: its own copy of the data, asked in another order.
      expect(swayAt(again, tree, x, y, ms, 1)).toBe(v);
      expect(gustAt(again, x, y, ms)).toBe(gustAt(field, x, y, ms));
      if (swayAt(other, tree, x, y, ms, 1) !== v) differs++;
    }
    // Another seed is another sequence of gusts.
    expect(differs).toBeGreaterThan(100);
    expect(nextGust(again, 5, 5, 0)).toEqual(nextGust(field, 5, 5, 0));
    expect(nextGust(other, 5, 5, 0)).not.toEqual(nextGust(field, 5, 5, 0));
  });

  it("come as often as the data says, at random: never like a clock", () => {
    const [x, y] = [30, 14];
    const list = fronts(field, x, y, 0, HOUR);
    // One per slot of every_s (40 s): 90 in an hour.
    expect(Math.abs(list.length - 90)).toBeLessThanOrEqual(2);
    const gaps = list.slice(1).map((g, i) => g.at - (list[i] as GustFront).at);
    const every = 40_000;
    // Two starts are 0.7 to 1.3 slots apart, and a front takes up to 8 s to get anywhere.
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(every * 0.7 - field.crossMs - 1);
      expect(gap).toBeLessThan(every * 1.3 + field.crossMs + 1);
    }
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(10_000);
    // Each its own strength, inside the data's range (a front is weaker where it is born
    // and where it dies, and along its length).
    const strengths = list.map((g) => g.strength);
    for (const v of strengths) expect(v).toBeLessThanOrEqual(1);
    expect(Math.max(...strengths)).toBeGreaterThan(0.8);
    expect(new Set(strengths.map((v) => v.toFixed(2))).size).toBeGreaterThan(10);
    // Twice as far apart in the data, half as many; and with no jitter, a metronome.
    const rare = fronts(withGusts({ every_s: 80 }), x, y, 0, HOUR);
    expect(Math.abs(rare.length - 45)).toBeLessThanOrEqual(2);
    expect(field.everyMs).toBe(40_000);
    expect(field.crossMs).toBe(8000);
    expect(field.back).toBe(0);
    expect(field.responseMs).toBeCloseTo(gustResponseMs(400, 1000, 2, 2200));
  });

  it("travel: the front crosses the map at the wind's speed, each from its own direction", () => {
    // Straight east, 8 tiles a second: 8 tiles downwind, a second later.
    const east = withGusts({ spread: 0 });
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const [x, y] = [3 + i * 5, 20];
      const a = strongGust(east, x, y, 0.3, i * 50_000);
      const b = nextGust(east, x + 8, y, a.at - 500) as GustFront;
      // (but where the gust is born or dies between the two tiles)
      if (Math.abs(b.at - a.at - 1000) < 1e-6) hits++;
    }
    expect(hits).toBeGreaterThan(30);
    // Along the front (across the wind) it arrives almost at once: a line, a little wavy.
    const a = strongGust(east, 40, 20, 0.5);
    const b = nextGust(east, 40, 23, a.at - 2000) as GustFront;
    expect(Math.abs(b.at - a.at)).toBeLessThan(1000);
    // With a spread, the gusts come from different sides: the delay between two tiles
    // north and south of each other changes sign from gust to gust.
    let north = 0;
    let south = 0;
    for (const g of fronts(field, 40, 20, 0, HOUR)) {
      const other = nextGust(field, 40, 32, g.at - 3000);
      if (!other || Math.abs(other.at - g.at) > 3000) continue;
      if (other.at > g.at + 150) south++;
      if (other.at < g.at - 150) north++;
    }
    expect(north).toBeGreaterThan(5);
    expect(south).toBeGreaterThan(5);
  });

  it("blow harder on a coast, softer in a forest, not at all indoors, softer at night", () => {
    const sand = Array<string>(25).fill("sand");
    const grass = Array<string>(25).fill("grass");
    const wood = Array<string>(25).fill("wood");
    expect(exposureOf(field, sand, 0, 24)).toBeCloseTo(1.4);
    expect(exposureOf(field, grass, 0, 24)).toBeCloseTo(1);
    expect(exposureOf(field, wood, 0, 24)).toBe(0);
    // A surface the data does not list, and tiles not loaded yet: open air.
    expect(exposureOf(field, ["marble", undefined], 0, 24)).toBeCloseTo(1);
    expect(exposureOf(field, [], 0, 24)).toBeCloseTo(1);
    // The edge of a beach: between both.
    const edge = exposureOf(field, [...sand.slice(0, 10), ...grass.slice(0, 15)], 0, 24);
    expect(edge).toBeGreaterThan(1);
    expect(edge).toBeLessThan(1.4);
    // Trees all round calm it by `forest`; a lone tree in a field feels it whole.
    expect(exposureOf(field, grass, 24, 24)).toBeCloseTo(0.5);
    expect(exposureOf(field, grass, 2, 24)).toBeGreaterThan(0.85);
    expect(field.night).toBe(0.5);
    // The same gust bends the same tree more on the beach than in the wood.
    const tree = windOf("tree");
    const g = strongGust(field, 12, 9);
    const mid = g.at + field.riseMs + field.holdMs / 2;
    const open = Math.abs(swayAt(field, tree, 12, 9, mid, 1));
    expect(Math.abs(swayAt(field, tree, 12, 9, mid, 0.5))).toBeLessThan(open * 0.5);
    expect(Math.abs(swayAt(field, tree, 12, 9, mid, 1.4))).toBeGreaterThan(open);
  });
});

describe("the sway of a plant", () => {
  it("leans the top of a tree a pixel or two in a gust, never past its amplitude", () => {
    const tree = windOf("tree");
    const p = peak(tree);
    expect(p).toBeGreaterThan(1);
    expect(p).toBeLessThanOrEqual(tree.amplitude);
    // Even on the windiest coast.
    expect(peak(tree, 2)).toBeLessThanOrEqual(tree.amplitude);
    expect(gustLean(field, tree, 3, 4, 900, 1.5)).toBeLessThanOrEqual(tree.amplitude * 1.15 * 3);
  });

  it("moves bushes less than trees, and stiff plants barely", () => {
    const tree = peak(windOf("tree"));
    const bush = peak(windOf("bush"));
    const cactus = peak(windOf("cactus"));
    const dead = peak(windOf("dead_tree"));
    expect(bush).toBeLessThan(tree);
    expect(cactus).toBeLessThanOrEqual(0.5);
    expect(dead).toBeLessThan(0.8);
    expect(cactus).toBeLessThan(bush);
    // A stiff plant ignores a gust that already moves a limp one.
    const stiff = { ...windOf("tree"), stiffness: 0.9 };
    const limp = { ...windOf("tree"), stiffness: 0.1 };
    expect(gustLean(field, stiff, 2, 2, 900, 0.4)).toBeLessThan(
      gustLean(field, limp, 2, 2, 900, 0.4) * 0.5,
    );
  });

  it("does not move in still air or indoors", () => {
    const tree = windOf("tree");
    for (let ms = 0; ms < 300_000; ms += 250) expect(swayAt(field, tree, 2, 2, ms, 0)).toBe(0);
    expect(gustLean(field, tree, 2, 2, 900, 0)).toBe(0);
  });

  it("gives each plant its own size and swing: neighbours never move like a choir", () => {
    const tree = windOf("tree");
    const g = strongGust(field, 10, 10);
    let apart = 0;
    let n = 0;
    for (let tau = 0; tau < field.responseMs; tau += 100, n++)
      apart += Math.abs(
        swayAt(field, tree, 10, 10, g.at + tau, 1) - swayAt(field, tree, 11, 10, g.at + tau, 1),
      );
    expect(apart / n).toBeGreaterThan(0.05);
  });

  it("drifts in the calm only when its kind says so, and by under a pixel", () => {
    const still = windOf("tree");
    const drifting = { ...still, drift: 0.6 };
    const list = fronts(field, 4, 4, 0, 200_000);
    const from = (list[0] as GustFront).at + field.responseMs;
    const to = (list[1] as GustFront).at;
    let most = 0;
    for (let ms = from; ms < to; ms += 100) {
      expect(swayAt(field, still, 4, 4, ms, 1)).toBe(0);
      most = Math.max(most, Math.abs(swayAt(field, drifting, 4, 4, ms, 1)));
    }
    expect(most).toBeGreaterThan(0.3);
    expect(most).toBeLessThanOrEqual(0.6);
    expect(swayAt(field, drifting, 4, 4, from, 0)).toBe(0);
  });
});

describe("the game's wind (data/livingworld/wind.yaml)", () => {
  const real = parseWind(
    parseYaml(
      readFileSync(new URL("../../../data/livingworld/wind.yaml", import.meta.url), "utf8"),
    ),
  ) as WindData;

  it("keeps every plant stock-still between gusts, and the calm long", () => {
    const f = real.field;
    // The owner, 2026-11-26: a plant that always moves "looks alive, or on fire".
    for (const k of WIND_KINDS) expect(real.kinds[k].drift, k).toBe(0);
    // Tens of seconds between two gusts, and a gust is over long before the next.
    expect(f.everyMs).toBeGreaterThanOrEqual(30_000);
    expect(f.back).toBe(0);
    expect(f.everyMs * (1 - f.jitter) - f.crossMs - f.responseMs).toBeGreaterThanOrEqual(10_000);
    const tree = resolveWind(real, { kind: "tree" }, undefined) as PlantWind;
    let moving = 0;
    let most = 0;
    const span = 20 * 60_000;
    for (let ms = 0; ms < span; ms += 100) {
      const v = Math.abs(swayAt(f, tree, 20, 20, ms, 1));
      if (v >= 0.25) moving++; // half a screen pixel at zoom 2: what shows
      most = Math.max(most, v);
    }
    // A tree in the open moves under a fifth of the time, and a gust is worth seeing.
    expect(moving / (span / 100)).toBeLessThan(0.2);
    expect(moving).toBeGreaterThan(0);
    expect(most).toBeGreaterThan(1);
  });
});

describe("the displacement of a sprite", () => {
  it("is zero at the base and grows with the square of the height", () => {
    expect(rowWeight(0, 28, 80)).toBe(0);
    expect(rowWeight(28, 28, 80)).toBe(0);
    expect(rowWeight(54, 28, 80)).toBeCloseTo(0.25);
    expect(rowWeight(80, 28, 80)).toBe(1);
    expect(rowWeight(96, 28, 80)).toBe(1);
    let last = 0;
    for (let h = 28; h <= 80; h++) {
      const w = rowWeight(h, 28, 80);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it("cuts a tree into a planted trunk and a few moving strips", () => {
    // A 64x96 oak: the trunk ends 28 px up, the crown tops out at 81.
    const l = stripLayout(96, 28, 81);
    expect(l.count).toBeLessThanOrEqual(MAX_STRIPS + 1);
    expect(l.count).toBeGreaterThan(8);
    // Top to bottom, covering every row once.
    expect(l.edges[0]).toBe(0);
    expect(l.edges[l.count]).toBe(96);
    for (let i = 0; i < l.count; i++)
      expect(l.edges[i + 1] as number).toBeGreaterThan(l.edges[i] as number);
    // The last strip is the trunk: it never moves. The top one takes the whole sway.
    expect(l.edges[l.count - 1]).toBe(96 - 28);
    expect(l.weights[l.count - 1]).toBe(0);
    expect(l.weights[0]).toBe(1);
    for (let i = 1; i < l.count; i++)
      expect(l.weights[i] as number).toBeLessThan(l.weights[i - 1] as number);
    // A tuft of grass bends from the ground: no rigid base.
    const grass = stripLayout(32, 0, 20);
    expect(grass.weights[grass.count - 1]).toBeGreaterThan(0);
    expect(grass.edges[grass.count]).toBe(32);
  });

  it("snaps every strip to whole screen pixels at the zoom", () => {
    const l = stripLayout(96, 28, 81);
    const out = new Int16Array(l.count);
    // Zoom 1: whole sprite pixels.
    expect(snapSteps(1)).toBe(1);
    expect(snapSteps(0.4)).toBe(1);
    expect(snapSteps(2)).toBe(2);
    expect(snapSteps(2.9)).toBe(3);
    expect(stripOffsets(out, l, 1.7, 1)).toBe(true);
    expect(out[0]).toBe(2);
    expect(out[l.count - 1]).toBe(0);
    for (let i = 1; i < l.count; i++)
      expect(out[i] as number).toBeLessThanOrEqual(out[i - 1] as number);
    // Zoom 2: half sprite pixels, which are whole screen pixels.
    stripOffsets(out, l, 1.7, 2);
    expect(out[0]).toBe(3); // 1.5 sprite px
    // The same pose again changes nothing: nothing to upload.
    expect(stripOffsets(out, l, 1.7, 2)).toBe(false);
    // A sway too small for a screen pixel leaves the sprite alone.
    stripOffsets(out, l, 0.2, 1);
    expect([...out].every((v) => v === 0)).toBe(true);
  });

  it("leaves a plant at rest untouched: nothing to upload while it stands still", () => {
    const l = stripLayout(96, 28, 81);
    const out = new Int16Array(l.count);
    for (let i = 0; i < 100; i++) expect(stripOffsets(out, l, 0, 4)).toBe(false);
    expect(stripOffsets(out, l, 2, 4)).toBe(true);
    expect(out[l.count - 1]).toBe(0);
    expect(stripOffsets(out, l, 0, 4)).toBe(true);
    expect([...out].every((v) => v === 0)).toBe(true);
  });
});

describe("the wind's data", () => {
  it("gives every plant type its defaults, with what a sprite and an item say on top", () => {
    for (const k of WIND_KINDS) expect(wind.kinds[k].periodMs).toBeGreaterThan(0);
    expect(parseWind(undefined)).toBeUndefined();
    const sprites = parseWindSprites({
      sprites: {
        "decor/oak_tree": { kind: "tree", pivot: 28, top: 81 },
        "decor/odd": { kind: "balloon" },
      },
    });
    expect(Object.keys(sprites)).toEqual(["decor/oak_tree"]);
    const oak = resolveWind(wind, sprites["decor/oak_tree"], undefined);
    expect(oak).toMatchObject({ kind: "tree", pivotPx: 28, topPx: 81, amplitude: 3 });
    // The item's own numbers win over the sprite's; the sprite's pivot stays.
    expect(
      resolveWind(wind, sprites["decor/oak_tree"], { kind: "tree", amplitude: 1.2 }),
    ).toMatchObject({ pivotPx: 28, amplitude: 1.2, stiffness: 0.45 });
    // Another type in the item starts over from that type.
    expect(resolveWind(wind, sprites["decor/oak_tree"], { kind: "dead_tree" })).toMatchObject({
      kind: "dead_tree",
      pivotPx: undefined,
      amplitude: 0.8,
    });
    expect(resolveWind(wind, undefined, undefined)).toBeUndefined();
  });

  it("joins plants.yaml, the sprites' metadata and the items", () => {
    const d = parseLivingWorldData(
      {},
      {
        plants: [
          { item: "oak_tree", reaction: "rustle", leaves: true },
          { item: "old_stump", wind: "none" },
          { item: "statue_ivy", reaction: "bend", wind: "none" },
          { item: "potted_fern", wind: { kind: "bush", amplitude: 0.5 } },
          { item: "reeds", wind: "reed" },
        ],
      },
      undefined,
      {
        wind: WIND_YAML,
        sprites: {
          sprites: {
            "decor/oak_tree": { kind: "tree", pivot: 28, top: 81 },
            "plants/jungle_palm": { kind: "palm", pivot: 10 },
            "decor/old_stump": { kind: "dead_tree", pivot: 4 },
          },
        },
        itemSprites: {
          oak_tree: "decor/oak_tree",
          jungle_palm: "plants/jungle_palm",
          old_stump: "decor/old_stump",
          anvil: "decor/anvil",
        },
      },
    );
    expect(d.wind?.field.speed).toBe(8);
    expect(d.plants["oak_tree"]).toMatchObject({
      reaction: "rustle",
      leaves: true,
      wind: { kind: "tree", pivotPx: 28 },
    });
    // A new plant sprite with metadata sways with no line in plants.yaml.
    expect(d.plants["jungle_palm"]).toMatchObject({
      reaction: "rustle",
      wind: { kind: "palm", pivotPx: 10, amplitude: 4 },
    });
    // wind: none wins over the sprite; with no reaction either it is no plant at all.
    expect(d.plants["old_stump"]).toBeUndefined();
    expect(d.plants["statue_ivy"]).toEqual({ reaction: "bend", leaves: false, trample: false });
    expect(d.plants["potted_fern"]).toMatchObject({ reaction: "bend", wind: { amplitude: 0.5 } });
    expect(d.plants["reeds"]?.wind?.kind).toBe("reed");
    expect(d.plants["anvil"]).toBeUndefined();
    // Without the wind files nothing sways, and the plants still react.
    const bare = parseLivingWorldData({}, { plants: [{ item: "oak_tree", reaction: "rustle" }] });
    expect(bare.wind).toBeUndefined();
    expect(bare.plants["oak_tree"]?.wind).toBeUndefined();
  });
});

// The living world over real Pixi sprites, as the map hands them.

const data = parseLivingWorldData(
  { surfaces: { grass: {}, sand: {}, wood: {} } },
  {
    plants: [
      { item: "oak_tree", reaction: "rustle", wind: { kind: "tree", pivot: 28, top: 81 } },
      { item: "bush", reaction: "bend", wind: { kind: "bush", pivot: 5, top: 26 } },
      { item: "grass_tuft", reaction: "bend", wind: "none" },
    ],
  },
  undefined,
  { wind: WIND_YAML, sprites: {}, itemSprites: {} },
);

function texture(w: number, h: number): Texture {
  return new Texture({
    source: Texture.WHITE.source,
    frame: { x: 0, y: 0, width: w, height: h } as never,
  });
}

const TREE = { w: 64, h: 96 };

function forest(
  cols: number,
  rows: number,
  opts: {
    reduced?: () => boolean;
    sheltered?: () => boolean;
    surface?: Surface;
    windClock?: () => number;
  } = {},
) {
  const layer = new Container({ sortableChildren: false });
  const stage = { ground: new Container(), air: new Container() };
  const tex = texture(TREE.w, TREE.h);
  const sprites: { x: number; y: number; sprite: Sprite }[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const sprite = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
      sprite.position.set((x + 0.5) * 32, (y + 1) * 32);
      sprite.zIndex = y * 1000 + x;
      layer.addChild(sprite);
      sprites.push({ x, y, sprite });
    }
  let version = 1;
  const lw = createLivingWorld(stage, () => opts.surface ?? "grass", {
    tileSize: 32,
    data,
    plants: {
      version: () => version,
      forEach: (fn) => {
        for (const s of sprites) fn(s.x, s.y, "oak_tree", s.sprite as unknown as PlantSprite);
      },
    },
    reduced: opts.reduced,
    sheltered: opts.sheltered,
    windClock: opts.windClock,
  });
  const view = { x: 0, y: 0, width: cols, height: rows, z: 7, zoom: 2 };
  return { lw, layer, sprites, view, bump: () => version++ };
}

/** The x of a mesh's top-left vertex minus where it rests: the top strip's offset, px. */
const topOffset = (mesh: Container, anchorLeft: number): number =>
  ((mesh as unknown as { geometry: { positions: Float32Array } }).geometry.positions[0] as number) -
  anchorLeft;

/** How many strip meshes of a layer are off their rest now. */
const movingMeshes = (layer: Container): number =>
  layer.children.filter((c) => !(c instanceof Sprite) && topOffset(c, -32) !== 0).length;

describe("the wind over the map's sprites", () => {
  it("draws a tree as strips in its sprite's place and slides them in screen pixels", () => {
    const { lw, layer, sprites, view } = forest(6, 4);
    lw.onTick(0, view);
    expect(lw.stats()).toMatchObject({ plants: 24, windMeshes: 24 });
    expect(layer.children.length).toBe(48);
    const first = sprites[0]?.sprite as Sprite;
    expect(first.visible).toBe(false);
    const mesh = layer.children.find(
      (c) => c !== first && c.zIndex === first.zIndex && c.x === first.x,
    );
    expect(mesh?.y).toBe(first.y);
    // In draw order, each mesh right after its sprite.
    for (let i = 0; i < layer.children.length; i += 2)
      expect(layer.children[i + 1]?.zIndex).toBe(layer.children[i]?.zIndex);
    // Still until the gust front reaches it, then it moves, then it is still again.
    const g = lw.nextGust(0, 0, 0, 0.6) as GustFront;
    let moved = 0;
    for (let ms = Math.max(100, g.at - 3000); ms < g.at + field.responseMs + 2000; ms += 100) {
      lw.onTick(ms, view);
      const dx = topOffset(mesh as Container, -32);
      // Whole screen pixels at zoom 2, within the tree's amplitude.
      expect(Math.abs(dx * 2 - Math.round(dx * 2))).toBeLessThan(1e-6);
      expect(Math.abs(dx)).toBeLessThanOrEqual(3);
      if (ms < g.at || ms >= g.at + field.responseMs) expect(dx).toBe(0);
      if (dx !== 0) moved++;
      // The trunk's strip, the last one, never moves.
      const p = (mesh as unknown as { geometry: { positions: Float32Array } }).geometry.positions;
      expect(p[p.length - 8]).toBe(-32);
      // The map's sprite is never touched.
      expect(first.skew.x).toBe(0);
      expect(first.x).toBe(16);
    }
    expect(moved).toBeGreaterThan(10);
  });

  it("follows the shared clock of the gusts, not each client's own frame clock", () => {
    // Two clients that started at different moments, with the same server clock.
    const clock = { ms: 0 };
    const a = forest(3, 2, { windClock: () => clock.ms });
    const b = forest(3, 2, { windClock: () => clock.ms });
    const g = a.lw.nextGust(1, 1, 0, 0.6) as GustFront;
    const top = (w: typeof a): number[] =>
      w.layer.children.filter((c) => !(c instanceof Sprite)).map((c) => topOffset(c, -32));
    a.lw.onTick(0, a.view);
    b.lw.onTick(0, b.view);
    let moved = 0;
    for (let t = 0; t < field.responseMs; t += 100) {
      clock.ms = g.at + t;
      a.lw.onTick(1000 + t, a.view);
      b.lw.onTick(777_000 + t, b.view);
      expect(top(a)).toEqual(top(b));
      if (top(a).some((v) => v !== 0)) moved++;
    }
    expect(moved).toBeGreaterThan(10);
    // The shared clock in a calm: nothing moves, whatever the frame clock says.
    clock.ms = g.at - 5000;
    a.lw.onTick(900_000, a.view);
    expect(top(a).every((v) => v === 0)).toBe(true);
    expect(a.lw.nextGust(1, 1, 5, 0.6)?.at).toBeCloseTo(5000);
  });

  it("composes a creature brushing a bush with the wind: one continuous motion", () => {
    const layer = new Container();
    const stage = { ground: new Container(), air: new Container() };
    const sprite = new Sprite({ texture: texture(32, 32), anchor: { x: 1, y: 1 } });
    sprite.position.set(6 * 32, 6 * 32);
    layer.addChild(sprite);
    const lw = createLivingWorld(stage, () => "grass", {
      tileSize: 32,
      data,
      plants: {
        version: () => 1,
        forEach: (fn) => fn(5, 5, "bush", sprite as unknown as PlantSprite),
      },
    });
    const view = { x: 0, y: 0, width: 12, height: 12, z: 7, zoom: 4 };
    lw.onTick(0, view);
    const mesh = layer.children[1] as Container;
    const at = (ms: number): number => {
      lw.onTick(ms, view);
      return topOffset(mesh, -32);
    };
    // In the calm after a gust: the bush stands still until someone walks into it.
    const t0 = (lw.nextGust(5, 5, 0) as GustFront).at + field.responseMs + 1000;
    const before = at(t0);
    expect(before).toBe(0);
    lw.onCreatureStep(
      {
        id: 1,
        from: { x: 4, y: 5, z: 7 },
        to: { x: 5, y: 5, z: 7 },
        grounded: true,
      },
      t0,
    );
    // The push leans it the way the walker goes.
    const pushed = at(t0 + 16);
    expect(pushed - before).toBeGreaterThan(2);
    expect(BEND).toBeGreaterThan(0);
    // It springs back with no jump: frame to frame it never leaps (60 fps).
    let last = pushed;
    for (let ms = t0 + 32; ms < t0 + 1200; ms += 16) {
      const v = at(ms);
      expect(Math.abs(v - last)).toBeLessThan(1.6);
      last = v;
    }
    // Settled: still again.
    expect(at(t0 + 1300)).toBe(0);
    // A gust while it is bent adds to the bend on the same strips, with no jump either.
    const g = lw.nextGust(5, 5, t0 + 2000, 0.6) as GustFront;
    lw.onCreatureStep(
      { id: 1, from: { x: 4, y: 5, z: 7 }, to: { x: 5, y: 5, z: 7 }, grounded: true },
      g.at + 200,
    );
    last = at(g.at + 200);
    let both = 0;
    for (let ms = g.at + 216; ms < g.at + 1200; ms += 16) {
      const v = at(ms);
      expect(Math.abs(v - last)).toBeLessThan(1.6);
      both = Math.max(both, Math.abs(v));
      last = v;
    }
    expect(both).toBeGreaterThan(2);
    expect(sprite.skew.x).toBe(0);
  });

  it("turns off with reduced effects: the still sprites show again, and come back", () => {
    const reduced = { on: false };
    const { lw, layer, sprites, view } = forest(4, 3, { reduced: () => reduced.on });
    lw.onTick(0, view);
    lw.onTick(500, view);
    expect(lw.stats().windMeshes).toBe(12);
    reduced.on = true;
    lw.onTick(516, view);
    expect(lw.stats().windMeshes).toBe(0);
    expect(layer.children.length).toBe(12);
    for (const s of sprites) expect(s.sprite.visible).toBe(true);
    reduced.on = false;
    lw.onTick(532, view);
    expect(lw.stats().windMeshes).toBe(12);
    lw.destroy();
    expect(layer.children.length).toBe(12);
    for (const s of sprites) expect(s.sprite.visible).toBe(true);
  });

  it("does not blow in a cave or on a floor indoors", () => {
    for (const opts of [{ sheltered: () => true }, { surface: "wood" as const }]) {
      const { lw, layer, view } = forest(3, 2, opts);
      for (let ms = 0; ms < 120_000; ms += 200) {
        lw.onTick(ms, view);
        for (const c of layer.children)
          if (!(c instanceof Sprite)) expect(topOffset(c, -32)).toBe(0);
      }
    }
  });

  it("keeps the strips of the sprites that stay and drops those of a chunk that left", () => {
    const { lw, layer, sprites, view, bump } = forest(4, 2);
    lw.onTick(0, view);
    const kept = layer.children.filter((c) => !(c instanceof Sprite));
    // The map drops a chunk: two of its sprites are destroyed.
    for (const gone of sprites.splice(0, 2)) gone.sprite.destroy();
    bump();
    lw.onTick(16, view);
    expect(lw.stats()).toMatchObject({ plants: 6, windMeshes: 6 });
    const now = layer.children.filter((c) => !(c instanceof Sprite));
    expect(now.length).toBe(6);
    for (const m of now) expect(kept).toContain(m);
  });

  it("a plant with wind: none, and a stub sprite, still bend the old way", () => {
    const stage = { ground: new Container(), air: new Container() };
    const tuft: PlantSprite = { x: 5 * 32 + 16, skew: { x: 0 } };
    const lw = createLivingWorld(stage, () => "grass", {
      tileSize: 32,
      data,
      plants: { version: () => 1, forEach: (fn) => fn(5, 5, "grass_tuft", tuft) },
    });
    const view = { x: 0, y: 0, width: 12, height: 12, z: 7 };
    for (let ms = 0; ms < 3000; ms += 100) {
      lw.onTick(ms, view);
      expect(tuft.skew.x).toBe(0);
    }
    lw.onCreatureStep(
      {
        id: 1,
        from: { x: 4, y: 5, z: 7 },
        to: { x: 5, y: 5, z: 7 },
        grounded: true,
      },
      3000,
    );
    lw.onTick(3001, view);
    expect(Math.abs(tuft.skew.x)).toBeGreaterThan(0.1);
    expect(lw.stats().windMeshes).toBe(0);
  });

  it("stays inside the frame budget on a screen full of trees (docs/07)", () => {
    // The worst case: a tree on every tile of the 31x21 view and its margin.
    const { lw, layer, view } = forest(37, 27);
    lw.onTick(0, view);
    expect(lw.stats().windMeshes).toBe(999);
    // The best of many short batches: the machine running the whole suite at once is not
    // the game's frame. A batch is short enough (some 6 ms alone) to fit in one turn of the
    // scheduler: with every core taken by other test files, a batch of 60 frames was always
    // cut in the middle and read 2.04 ms for a frame that costs 0.64 ms.
    // The frames are those of a gust crossing the screen: every tree leaning or swinging.
    // (In the calm between two gusts a frame asks nothing of any plant.)
    const g = lw.nextGust(18, 13, 0, 0.7) as GustFront;
    const from = g.at - 1500;
    const FRAMES = 10;
    let perFrame = Infinity;
    let f = 1;
    let moving = 0;
    for (let batch = 0; batch < 60; batch++) {
      const start = performance.now();
      for (let n = 0; n < FRAMES; n++) lw.onTick(from + f++ * 16.7, view);
      perFrame = Math.min(perFrame, (performance.now() - start) / FRAMES);
      moving = Math.max(moving, movingMeshes(layer));
    }
    expect(moving).toBeGreaterThan(300);
    expect(perFrame).toBeLessThan(2);
    // And the calm costs next to nothing: no strip is rewritten.
    const calm = g.at + 8000 + field.responseMs + field.crossMs;
    expect(lw.nextGust(18, 13, calm)?.at ?? 0).toBeGreaterThan(2000);
    lw.onTick(calm, view);
    expect(movingMeshes(layer)).toBe(0);
  });
});

describe("the strip mesh", () => {
  it("draws the texture exactly as the sprite does while at rest", () => {
    const m = new WindMesh(texture(64, 96), 0.5, 28, 81);
    const g = m.view.geometry;
    const p = g.positions;
    const uv = g.uvs;
    expect(g.batchMode).toBe("batch");
    // Top-left of the first strip and bottom-right of the last: the sprite's own box.
    expect([p[0], p[1]]).toEqual([-32, -96]);
    expect([p[p.length - 4], p[p.length - 3]]).toEqual([32, 0]);
    expect([uv[0], uv[1]]).toEqual([0, 0]);
    expect([uv[uv.length - 4], uv[uv.length - 3]]).toEqual([1, 1]);
    // Every strip samples the rows it covers, whatever its offset: texels never stretch.
    for (let i = 0; i < m.layout.count; i++) {
      expect(uv[i * 8 + 1]).toBeCloseTo(((p[i * 8 + 1] as number) + 96) / 96);
      expect(uv[i * 8 + 5]).toBeCloseTo(((p[i * 8 + 5] as number) + 96) / 96);
    }
    expect(m.reach).toBe(53);
    m.offsets[0] = 3;
    m.apply(2);
    expect(p[0]).toBe(-30.5);
    expect(p[2]).toBe(33.5);
    expect(p[1]).toBe(-96);
    m.destroy();
  });
});
