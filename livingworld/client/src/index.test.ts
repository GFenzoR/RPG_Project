import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { createLivingWorld, newWalkSample, parseLivingWorldData, TRAMPLE_SCALE } from "./index.ts";
import type { LivingWorld, PlantSprite, Surface } from "./index.ts";

const data = parseLivingWorldData(
  {
    surfaces: {
      sand: { footprints: 8000, wind: 2, dust: true, sound: "sand" },
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
const heard: { events: readonly string[]; self: boolean; x: number }[] = [];

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
    onFootfall: (f, events) => heard.push({ events, self: f.self, x: f.x }),
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
    // foot south of the path's line and the left north of it (2 px across, 0.5 deep).
    expect(right?.position.x).toBe(3.5 * 32 + 8);
    expect(left?.position.x).toBe(3.5 * 32 + 16 + 8);
    expect(right?.position.y).toBe(5 * 32 + 28 + 1);
    expect(left?.position.y).toBe(5 * 32 + 28 - 1);
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
});
