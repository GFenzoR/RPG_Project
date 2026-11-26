import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { createLivingWorld, newWalkSample, parseLivingWorldData, TRAMPLE_SCALE } from "./index.ts";
import type { LivingWorld, PlantSprite, Surface } from "./index.ts";

const data = parseLivingWorldData(
  {
    surfaces: {
      sand: { prints: { wind: 2, tread: 0.5 }, dust: true, sound: "sand" },
      wet_sand: { prints: { waves: true }, sound: "wet_sand" },
      water_shallow: { ripple: true, critters: ["fish"] },
      grass: { critters: ["bird"] },
    },
  },
  {
    plants: [
      { item: "tall_grass", reaction: "bend", trample: true },
      { item: "oak_tree", reaction: "rustle", leaves: true },
    ],
  },
  undefined,
  undefined,
  {
    view: { depth: 0.5 },
    slide_px: 2,
    gaits: {
      biped: {
        print: "feet",
        stance: 2,
        reach: 0.25,
        print_spread: 1,
        contacts: [
          { at: 0, side: "right" },
          { at: 0.5, side: "left" },
        ],
      },
    },
    defaults: { humanoid: "biped", beast: "biped", big_beast: "biped", flying: "biped" },
  },
);
const biped = data.gaits?.gaits["biped"];

/** What the client heard: the events of each footfall, and whose it was. */
const heard: {
  events: readonly string[];
  self: boolean;
  x: number;
  side: number;
  rate: number | undefined;
  take: number | undefined;
}[] = [];

function mount(surface: Surface, reduced = { on: false }) {
  heard.length = 0;
  const stage = { ground: new Container(), air: new Container() };
  const grass: PlantSprite = { x: 5 * 32 + 16, skew: { x: 0 }, scale: { y: 1 } };
  const tree: PlantSprite = { x: 9 * 32 + 16, skew: { x: 0 } };
  const lw = createLivingWorld(stage, () => surface, {
    tileSize: 32,
    data,
    plants: {
      version: () => 1,
      forEach: (fn) => {
        fn(5, 5, "tall_grass", grass);
        fn(9, 5, "oak_tree", tree);
        fn(6, 5, "boulder", { x: 0, skew: { x: 0 } });
      },
    },
    reduced: () => reduced.on,
    onFootfall: (f, events, voice) =>
      heard.push({
        events,
        self: f.self,
        x: f.x,
        side: f.side,
        rate: voice?.rate,
        take: voice?.pick(3),
      }),
  });
  const view = { x: 0, y: 0, width: 20, height: 15, z: 7 };
  return { lw, grass, tree, view, stage };
}

const step = (x: number) => ({
  id: 1,
  from: { x: x - 1, y: 5, z: 7 },
  to: { x, y: 5, z: 7 },
  grounded: true,
});

/**
 * Creature 1 walks `tiles` east from tile x0 on row 5, a walk cycle per tile, a frame
 * every `frameMs`: what the canvas tells the living world while it draws it.
 */
function stride(
  lw: LivingWorld,
  x0: number,
  tiles: number,
  over: { stepMs?: number; sliding?: boolean; self?: boolean; frameMs?: number } = {},
): void {
  const w = newWalkSample();
  const stepMs = over.stepMs ?? 400;
  const frameMs = over.frameMs ?? 20;
  for (let t = 0; t < tiles * stepMs; t += frameMs) {
    const at = t / stepMs;
    w.id = 1;
    w.x = (x0 + at + 0.5) * 32;
    w.y = 5 * 32 + 28;
    w.z = 7;
    w.phase = at % 1;
    w.frames = 8;
    w.dx = 1;
    w.dy = 0;
    w.cyclePx = 32;
    w.gait = biped;
    w.sliding = over.sliding ?? false;
    w.self = over.self ?? true;
    w.stepMs = stepMs;
    lw.onCreatureWalk(w);
  }
  w.phase = -1; // it stands
  lw.onCreatureWalk(w);
}

describe("createLivingWorld", () => {
  it("leaves a footprint at each footfall on sand and, at a run, dust", () => {
    const { lw, view } = mount("sand");
    lw.onTick(0, view);
    stride(lw, 3, 2);
    lw.onTick(16, view);
    // Two tiles, a cycle each: right, left, right, left.
    expect(lw.stats().footprints).toBe(4);
    expect(lw.stats().puffs).toBe(0);
    stride(lw, 5, 1, { stepMs: 200 });
    expect(lw.stats().footprints).toBe(6);
    expect(lw.stats().puffs).toBe(2);
    expect(lw.footstepEvents({ x: 1, y: 1, z: 7 })).toEqual(["step.self.sand", "step.self"]);
  });

  it("draws each print under its foot: either side of the path, turned the way it walks", () => {
    const { lw, view, stage } = mount("sand");
    lw.onTick(0, view);
    stride(lw, 3, 1);
    lw.onTick(16, view);
    const ground = stage.ground.children.find((c) => c.label === "living world: ground");
    const shown = ground?.children.filter((c) => c.visible) ?? [];
    expect(shown).toHaveLength(2);
    const [right, left] = shown;
    // Walking east: half a stride (8 px) ahead of the body at each contact, the right
    // foot south of the path's line and the left north of it (2 px across, 0.5 deep),
    // and each mark drawn a pixel further out to its side (print_spread): two rows.
    expect(right?.position.x).toBe(3.5 * 32 + 8);
    expect(left?.position.x).toBe(3.5 * 32 + 16 + 8);
    expect(right?.position.y).toBe(5 * 32 + 28 + 2);
    expect(left?.position.y).toBe(5 * 32 + 28 - 2);
    expect(right?.rotation).toBeCloseTo(Math.PI / 2);
  });

  it("spreads ripples on shallow water at each footfall and no footprints", () => {
    const { lw } = mount("water_shallow");
    stride(lw, 3, 1);
    expect(lw.stats()).toMatchObject({ footprints: 0, puffs: 2 });
  });

  it("sounds the step on the footfall: the surface's events, one beat per foot", () => {
    const { lw } = mount("sand");
    stride(lw, 3, 2);
    expect(heard).toHaveLength(4);
    expect(heard.every((h) => h.self)).toBe(true);
    expect(heard[0]?.events).toEqual(["step.self.sand", "step.self"]);
    // The same list every time (no list made per footfall).
    expect(heard[1]?.events).toBe(heard[0]?.events);
    // Another creature's footfalls come too, marked as not the own player's.
    stride(lw, 5, 1, { self: false });
    expect(heard.slice(4).map((h) => h.self)).toEqual([false, false]);
  });

  it("leaves no mark while the drawing glides over a correction, but the beat goes on", () => {
    const { lw } = mount("sand");
    stride(lw, 3, 2, { sliding: true });
    expect(lw.stats().footprints).toBe(0);
    expect(heard).toHaveLength(4);
  });

  it("leaves nothing while it stands, and forgets a creature that left", () => {
    const { lw } = mount("sand");
    const w = newWalkSample();
    w.id = 1;
    w.gait = biped;
    for (let i = 0; i < 100; i++) lw.onCreatureWalk(w);
    expect(lw.stats().footprints).toBe(0);
    stride(lw, 3, 1);
    lw.forgetCreature(1);
    // Seen again in the middle of a cycle: only what it steps from then on.
    w.phase = 0.7;
    w.cyclePx = 32;
    w.dx = 1;
    lw.onCreatureWalk(w);
    expect(lw.stats().footprints).toBe(2);
  });

  it("bends the plants a step brushes and finds only the plants of its data", () => {
    const { lw, grass, view } = mount("grass");
    lw.onTick(0, view);
    expect(lw.stats().plants).toBe(2);
    lw.onCreatureStep(step(5), 0);
    lw.onTick(1, view);
    expect(Math.abs(grass.skew.x)).toBeGreaterThan(0.1);
  });

  it("does nothing with reduced effects and puts the plants back", () => {
    const reduced = { on: false };
    const { lw, grass, tree, view, stage } = mount("sand", reduced);
    lw.onTick(0, view);
    lw.onCreatureStep(step(5), 0);
    lw.onCreatureStep(step(9), 0);
    stride(lw, 4, 1);
    lw.onTick(10, view);
    expect(lw.stats().footprints).toBe(2);
    reduced.on = true;
    lw.onTick(20, view);
    expect(lw.stats()).toMatchObject({ footprints: 0, puffs: 0, leaves: 0, sways: 0 });
    expect(grass.skew.x).toBe(0);
    expect(tree.x).toBe(9 * 32 + 16);
    const effects = stage.ground.children.find((c) => c.label === "living world: ground");
    expect(effects?.visible).toBe(false);
    lw.onCreatureStep(step(6), 30);
    heard.length = 0;
    stride(lw, 5, 1);
    lw.onTick(40, view);
    expect(lw.stats()).toMatchObject({ footprints: 0, puffs: 0, sways: 0 });
    // The step still sounds: the sound is not an animation.
    expect(heard).toHaveLength(2);
  });

  it("draws the server's trail wear, flattens trampled plants, and keeps both reduced", () => {
    const reduced = { on: false };
    const { lw, grass, view, stage } = mount("grass", reduced);
    const layer = stage.ground.children.find((c) => c.label === "living world: trail wear");
    const shown = (): number => layer?.children.filter((c) => c.visible).length ?? -1;
    lw.onTick(0, view);
    expect(shown()).toBe(0);
    lw.applyWear([
      { x: 5, y: 5, z: 7, level: 2 },
      { x: 6, y: 5, z: 7, level: 3 },
      { x: 40, y: 40, z: 7, level: 3 }, // out of view
    ]);
    lw.onTick(16, view);
    expect(lw.stats().wear).toBe(3);
    expect(shown()).toBe(2);
    expect(grass.scale?.y).toBe(TRAMPLE_SCALE[2]);
    reduced.on = true;
    lw.onTick(32, view);
    expect(shown()).toBe(2);
    expect(grass.scale?.y).toBe(TRAMPLE_SCALE[2]);
    reduced.on = false;
    lw.applyWear([{ x: 6, y: 5, z: 7, level: 1 }], true); // the whole wear: (5, 5) recovered
    lw.onTick(48, view);
    expect(shown()).toBe(1);
    expect(grass.scale?.y).toBe(1);
  });

  it("both feet leave their print and both feet sound, a little apart, no take twice running", () => {
    const { lw, view } = mount("sand");
    lw.onTick(0, view);
    stride(lw, 3, 6);
    lw.onTick(16, view);
    // Six tiles, a cycle each: twelve footfalls, right and left in turn.
    expect(heard).toHaveLength(12);
    expect(heard.filter((h) => h.side === 1)).toHaveLength(6);
    expect(heard.filter((h) => h.side === -1)).toHaveLength(6);
    for (let i = 1; i < heard.length; i++) {
      expect(heard[i]?.side).toBe(-(heard[i - 1]?.side ?? 0));
      expect(heard[i]?.take).not.toBe(heard[i - 1]?.take);
      // Every beat the same stride after the one before: no limp.
      expect((heard[i]?.x ?? 0) - (heard[i - 1]?.x ?? 0)).toBeCloseTo(16, 5);
    }
    for (const h of heard) {
      expect(h.events).toEqual(["step.self.sand", "step.self"]);
      expect(h.rate).toBeDefined();
    }
    // And both leave a mark: as many prints of the left foot as of the right.
    const prints = lw.footprints();
    expect(prints).toHaveLength(12);
    expect(prints.filter((p) => p.side === 1)).toHaveLength(6);
    expect(prints.filter((p) => p.side === -1)).toHaveLength(6);
    // Two rows on the ground: the right foot's south of the left's, walking east.
    const ys = (side: number): number[] => prints.filter((p) => p.side === side).map((p) => p.y);
    expect(Math.min(...ys(1))).toBeGreaterThan(Math.max(...ys(-1)) + 2);
  });

  it("another creature's feet leave prints too, without a voice; and scuff the marks they cross", () => {
    const { lw, view } = mount("sand");
    lw.onTick(0, view);
    stride(lw, 3, 2);
    const mine = lw.footprints().length;
    expect(mine).toBe(4);
    // Creature 2 walks the same tiles: its own four prints, and mine are scuffed.
    const w = newWalkSample();
    for (let t = 0; t < 800; t += 20) {
      const at = t / 400;
      Object.assign(w, {
        id: 2,
        x: (3 + at + 0.5) * 32,
        y: 5 * 32 + 28,
        z: 7,
        phase: at % 1,
        frames: 8,
        dx: 1,
        dy: 0,
        cyclePx: 32,
        gait: biped,
        sliding: false,
        self: false,
        stepMs: 400,
      });
      lw.onCreatureWalk(w);
    }
    const others = heard.filter((h) => !h.self);
    expect(others).toHaveLength(4);
    expect(others.filter((h) => h.side === 1)).toHaveLength(2);
    expect(others.filter((h) => h.side === -1)).toHaveLength(2);
    for (const h of others) expect(h.rate).toBeUndefined();
    const prints = lw.footprints();
    expect(prints.filter((p) => p.by === 2)).toHaveLength(4);
    expect(prints.filter((p) => p.by === 1).every((p) => p.wear > 0)).toBe(true);
    expect(prints.filter((p) => p.by === 2).every((p) => p.wear === 0)).toBe(true);
  });

  it("names the sound of the ground under that foot, not of the tile the body is on", () => {
    // Grass west of x = 5 tiles, sand from there on: the foot lands half a stride ahead.
    heard.length = 0;
    const stage = { ground: new Container(), air: new Container() };
    const lw = createLivingWorld(stage, (x) => (x < 5 ? "grass" : "sand"), {
      tileSize: 32,
      data,
      onFootfall: (f, events) =>
        heard.push({ events, self: f.self, x: f.x, side: f.side, rate: 1, take: 0 }),
    });
    stride(lw, 3, 3);
    expect(heard.length).toBe(6);
    for (const h of heard)
      expect(h.events[0], `foot at ${h.x}`).toBe(
        Math.floor(h.x / 32) < 5 ? "step.self.grass" : "step.self.sand",
      );
    expect(new Set(heard.map((h) => h.events[0])).size).toBe(2);
    // Prints only where the ground keeps them.
    expect(lw.footprints().every((p) => p.x >= 5 * 32)).toBe(true);
  });

  it("on wet sand by the water the next waves wipe the prints, the nearest first; dry sand keeps its own", () => {
    // Water from x = 8 on; wet sand west of it, and dry sand on the rows above row 5.
    heard.length = 0;
    const stage = { ground: new Container(), air: new Container() };
    const lw = createLivingWorld(
      stage,
      (x, y) => (y < 5 ? "sand" : x >= 8 ? "water_shallow" : "wet_sand"),
      { tileSize: 32, data },
    );
    const view = { x: 0, y: 0, width: 20, height: 15, z: 7 };
    lw.onTick(1000, view);
    stride(lw, 5, 2);
    const all = lw.footprints().filter((p) => p.surface === "wet_sand");
    expect(all).toHaveLength(4);
    // Those the waves reach know which wave takes them; the one at the very limit of the
    // biggest wave (2.5 tiles up the beach) is left to the wind and the cap.
    const wet = all.filter((p) => Number.isFinite(p.waveAt));
    expect(wet).toHaveLength(3);
    expect(wet.every((p) => p.waveAt > 1000 && p.x >= 6 * 32)).toBe(true);
    const nearest = Math.max(...wet.map((p) => p.x));
    const furthest = Math.min(...wet.map((p) => p.x));
    const waveOf = (x: number): number => wet.find((p) => p.x === x)?.waveAt ?? 0;
    expect(waveOf(furthest)).toBeGreaterThanOrEqual(waveOf(nearest));
    // Nothing happens before the first wave; after it, the print by the water is gone.
    const first = Math.min(...wet.map((p) => p.waveAt));
    for (let t = 1100; t < first - 50; t += 100) lw.onTick(t, view);
    expect(lw.footprints().filter((p) => p.surface === "wet_sand")).toHaveLength(4);
    expect(lw.footprints().every((p) => p.wear === 0)).toBe(true);
    for (let t = first; t < first + 1500; t += 100) lw.onTick(t, view);
    expect(lw.footprints().some((p) => p.x === nearest)).toBe(false);
    // And in the end every wave-washed print goes, with no clock of its own.
    const last = Math.max(...wet.map((p) => p.waveAt));
    for (let t = first + 1500; t < last + 1500; t += 100) lw.onTick(t, view);
    const left = lw.footprints().filter((p) => p.surface === "wet_sand");
    expect(left).toHaveLength(1);
    expect(left[0]?.wear).toBe(0);
  });
});
