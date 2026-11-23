import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { createLivingWorld, parseLivingWorldData } from "./index.ts";
import type { PlantSprite, Surface } from "./index.ts";

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
      { item: "tall_grass", reaction: "bend", idle: true },
      { item: "oak_tree", reaction: "rustle", leaves: true },
    ],
  },
);

function mount(surface: Surface, reduced = { on: false }) {
  const stage = { ground: new Container(), air: new Container() };
  const grass: PlantSprite = { x: 5 * 32 + 16, skew: { x: 0 } };
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
  });
  const view = { x: 0, y: 0, width: 20, height: 15, z: 7 };
  return { lw, grass, tree, view, stage };
}

const step = (x: number, durationMs = 400) => ({
  id: 1,
  from: { x: x - 1, y: 5, z: 7 },
  to: { x, y: 5, z: 7 },
  durationMs,
  print: "feet" as const,
});

describe("createLivingWorld", () => {
  it("leaves footprints and, at a run, dust on sand", () => {
    const { lw, view } = mount("sand");
    lw.onTick(0, view);
    lw.onCreatureStep(step(3), 0);
    lw.onCreatureStep(step(4, 200), 200);
    lw.onTick(16, view);
    expect(lw.stats().footprints).toBe(2);
    expect(lw.stats().puffs).toBe(1);
    expect(lw.footstepEvents({ x: 1, y: 1, z: 7 })).toEqual(["step.self.sand", "step.self"]);
  });

  it("spreads ripples on shallow water and no footprints", () => {
    const { lw } = mount("water_shallow");
    lw.onCreatureStep(step(3), 0);
    expect(lw.stats()).toMatchObject({ footprints: 0, puffs: 1 });
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
    lw.onTick(10, view);
    expect(lw.stats().footprints).toBe(2);
    reduced.on = true;
    lw.onTick(20, view);
    expect(lw.stats()).toMatchObject({ footprints: 0, puffs: 0, leaves: 0, sways: 0 });
    expect(grass.skew.x).toBe(0);
    expect(tree.x).toBe(9 * 32 + 16);
    expect(stage.ground.children[0]?.visible).toBe(false);
    lw.onCreatureStep(step(6), 30);
    lw.onTick(40, view);
    expect(lw.stats().footprints).toBe(0);
  });
});
