import type { Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { ParticleKind } from "@rpg/renderer";
import {
  MAX_PARTICLES,
  MAX_STEP_MS,
  ParticleLayer,
  ParticleSim,
  SIM_KINDS,
  STEP_PARTICLES,
  STEP_RESERVE,
  STYLES,
  seededRandom,
  stepKindOf,
} from "./particles.ts";

const T = 32;

describe("seededRandom", () => {
  it("repeats for a seed and stays in [0, 1)", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(xs).size).toBe(50);
  });
});

describe("ParticleSim", () => {
  it("spawns in the birth box of its tile, leaving room for the steps' particles", () => {
    const sim = new ParticleSim(seededRandom(1), T);
    for (let i = 0; i < MAX_PARTICLES + 20; i++) sim.spawn("embers", 10, 20);
    expect(sim.count).toBe(MAX_PARTICLES - STEP_RESERVE);
    const s = STYLES.embers;
    for (let i = 0; i < sim.count; i++) {
      expect(sim.x[i]).toBeGreaterThanOrEqual((10 + s.x0) * T);
      expect(sim.x[i]).toBeLessThanOrEqual((10 + s.x0 + s.xw) * T);
      expect(sim.y[i]).toBeGreaterThanOrEqual((20 + s.y0) * T);
      expect(sim.y[i]).toBeLessThanOrEqual((20 + s.y0 + s.yh) * T);
    }
  });

  it("moves particles, embers up and spray back down, and drops them when they die", () => {
    const sim = new ParticleSim(seededRandom(2), T);
    sim.spawn("embers", 0, 0);
    sim.spawn("spray", 5, 5);
    const ember0 = sim.y[0] ?? 0;
    const spray0 = sim.y[1] ?? 0;
    sim.step(100);
    expect(sim.y[0]).toBeLessThan(ember0);
    expect(sim.y[1]).toBeLessThan(spray0);
    // Gravity turns the spray back down before its life (450 ms or more) ends.
    for (let t = 100; t < 440; t += 20) sim.step(20);
    expect(sim.count).toBe(2);
    expect(sim.vy[1]).toBeGreaterThan(0);
    for (let t = 0; t < 5000; t += 50) sim.step(50);
    expect(sim.count).toBe(0);
  });

  it("keeps the survivors when one in the middle dies (the last takes its place)", () => {
    const sim = new ParticleSim(seededRandom(3), T);
    sim.spawn("spray", 0, 0);
    sim.spawn("pollen", 1, 1);
    sim.spawn("embers", 2, 2);
    const emberLife = sim.life[2];
    // Spray lives at most 750 ms; pollen and embers longer.
    sim.step(STYLES.spray.lifeMs + STYLES.spray.lifeSpreadMs);
    expect(sim.count).toBe(2);
    // The ember (PARTICLE_KINDS index 0) took the spray's slot, and was stepped too.
    expect(Array.from(sim.kind.slice(0, 2))).toEqual([0, 1]);
    expect(sim.life[0]).toBe(emberLife);
    expect(sim.age[0]).toBe(sim.age[1]);
  });

  it("fades in and out and turns its colour with age", () => {
    const sim = new ParticleSim(() => 0.5, T);
    sim.spawn("embers", 0, 0);
    expect(sim.alpha(0)).toBe(0);
    sim.step(300);
    expect(sim.alpha(0)).toBe(1);
    expect(sim.color(0)).toBe(STYLES.embers.colors[0]);
    const life = sim.life[0] ?? 0;
    sim.step(life - 300 - 100);
    expect(sim.alpha(0)).toBeLessThan(0.5);
    expect(sim.color(0)).toBe(STYLES.embers.colors[2]);
  });

  it("kicks up a puff of dust at the feet that rises a little and is gone in ~300 ms", () => {
    const sim = new ParticleSim(seededRandom(8), T);
    expect(sim.kick("dust", 100, 200)).toBe(STEP_PARTICLES.dust);
    expect(sim.count).toBe(STEP_PARTICLES.dust);
    for (let i = 0; i < sim.count; i++) {
      expect(SIM_KINDS[sim.kind[i] ?? 0]).toBe("puff");
      expect(Math.abs((sim.x[i] ?? 0) - 100)).toBeLessThanOrEqual(5);
      expect(sim.y[i]).toBeLessThanOrEqual(200);
      expect(sim.y[i]).toBeGreaterThanOrEqual(198);
      expect(sim.vy[i]).toBeLessThan(0); // it rises
    }
    sim.step(40);
    // Seen at once: a step's puff is short, it fades in within a frame or two.
    expect(sim.alpha(0)).toBeGreaterThan(0.8);
    expect(sim.color(0)).toBe(STYLES.puff.colors[0]);
    sim.step(STYLES.puff.lifeMs + STYLES.puff.lifeSpreadMs);
    expect(sim.count).toBe(0);
  });

  it("spreads a ring of ripples flat round the feet on wet ground", () => {
    const sim = new ParticleSim(seededRandom(9), T);
    sim.kick("ripple", 50, 60);
    expect(sim.count).toBe(STEP_PARTICLES.ripple);
    const dist = (i: number): number => Math.hypot((sim.x[i] ?? 0) - 50, (sim.y[i] ?? 0) - 60);
    const before = Array.from({ length: sim.count }, (_, i) => dist(i));
    sim.step(200);
    let left = 0;
    let right = 0;
    for (let i = 0; i < sim.count; i++) {
      expect(SIM_KINDS[sim.kind[i] ?? 0]).toBe("ripple");
      expect(dist(i)).toBeGreaterThan(before[i] ?? 0); // spreading out
      expect(Math.abs((sim.y[i] ?? 0) - 60)).toBeLessThanOrEqual(3.5); // flat: an ellipse
      if ((sim.x[i] ?? 0) < 50) left++;
      else right++;
    }
    expect(left).toBeGreaterThan(1); // all round, not one way
    expect(right).toBeGreaterThan(1);
    sim.step(STYLES.ripple.lifeMs + STYLES.ripple.lifeSpreadMs);
    expect(sim.count).toBe(0);
  });

  it("knows what a step kicks up from the ground's sprite in atlas.json tiles", () => {
    const items = { 1: { sprite: "ground/sand" }, 2: { sprite: "ground/stone" } };
    const tiles = { "ground/sand": { variants: 3, steps: "dust" as const }, "ground/stone": {} };
    expect(stepKindOf(1, items, tiles)).toBe("dust");
    expect(stepKindOf(2, items, tiles)).toBeUndefined();
    expect(stepKindOf(3, items, tiles)).toBeUndefined();
    expect(stepKindOf(1, items, undefined)).toBeUndefined();
  });

  it("kicks up steps in the room ambient particles leave, up to the pool", () => {
    const sim = new ParticleSim(seededRandom(10), T);
    for (let i = 0; i < MAX_PARTICLES; i++) sim.spawn("dust", 1, 1);
    expect(sim.kick("dust", 0, 0)).toBe(STEP_PARTICLES.dust);
    while (sim.count < MAX_PARTICLES - 3) sim.kick("ripple", 0, 0);
    expect(sim.kick("ripple", 0, 0)).toBeLessThanOrEqual(3);
    expect(sim.count).toBe(MAX_PARTICLES);
  });

  it("emits about rate × time from one tile", () => {
    const sim = new ParticleSim(seededRandom(4), T);
    let born = 0;
    for (let f = 0; f < 600; f++) {
      const before = sim.count;
      sim.emit("embers", 0, 0, 16);
      born += sim.count - before;
      sim.clear();
    }
    // 600 frames of 16 ms = 9.6 s at 0.35 per second ≈ 3.4.
    expect(born).toBeGreaterThanOrEqual(1);
    expect(born).toBeLessThanOrEqual(10);
  });
});

describe("ParticleLayer", () => {
  const view = { x: 0, y: 0, width: 31, height: 21 };
  const sprites = (l: ParticleLayer): Sprite[] => l.view.children as Sprite[];
  const visible = (l: ParticleLayer): number => sprites(l).filter((s) => s.visible).length;

  it("has a fixed pool and draws one sprite per live particle", () => {
    const l = new ParticleLayer(T, seededRandom(5));
    expect(sprites(l)).toHaveLength(MAX_PARTICLES);
    const lava = (fn: (x: number, y: number, kind: ParticleKind) => void): void => {
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) fn(x, y, "embers");
    };
    l.update(0, view, lava, false, false);
    for (let t = 16; t < 3000; t += 16) l.update(t, view, lava, false, false);
    expect(l.sim.count).toBeGreaterThan(0);
    expect(l.sim.count).toBeLessThanOrEqual(MAX_PARTICLES);
    expect(visible(l)).toBe(l.sim.count);
    const before = sprites(l).slice();
    l.update(3016, view, lava, false, false);
    expect(sprites(l)).toEqual(before); // the same sprites, none made
  });

  it("spawns only from emitters in view (with one tile of margin)", () => {
    const l = new ParticleLayer(T, () => 0);
    const far = (fn: (x: number, y: number, kind: ParticleKind) => void): void => {
      fn(100, 100, "embers");
      fn(-5, 3, "embers");
    };
    l.update(0, view, far, false, false);
    l.update(16, view, far, false, false);
    expect(l.sim.count).toBe(0);
    const near = (fn: (x: number, y: number, kind: ParticleKind) => void): void =>
      fn(31, 21, "embers");
    l.update(32, view, near, false, false);
    expect(l.sim.count).toBe(1);
  });

  it("fills the dark with dust, and clamps a long frame", () => {
    const l = new ParticleLayer(T, seededRandom(6));
    const none = (): void => {};
    l.update(0, view, none, true, false);
    l.update(10_000, view, none, true, false);
    // One frame of at most MAX_STEP_MS: 30 per 32x32 tiles per second over 31x21 tiles.
    const expected = (STYLES.dust.rate * ((31 * 21) / (32 * 32)) * MAX_STEP_MS) / 1000;
    expect(l.sim.count).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    for (let t = 10_016; t < 14_000; t += 16) l.update(t, view, none, true, false);
    expect(l.sim.count).toBeGreaterThan(5);
    expect(Array.from(l.sim.kind.slice(0, l.sim.count)).every((k) => k === 3)).toBe(true);
  });

  it("kicks up steps unless motion is reduced", () => {
    const l = new ParticleLayer(T, seededRandom(11));
    const none = (): void => {};
    l.update(0, view, none, false, false);
    l.kick("dust", 64, 90);
    expect(l.sim.count).toBe(STEP_PARTICLES.dust);
    l.update(16, view, none, false, false);
    expect(visible(l)).toBe(STEP_PARTICLES.dust);
    l.update(32, view, none, false, true);
    l.kick("ripple", 64, 90);
    expect(l.sim.count).toBe(0);
  });

  it("shows nothing with reduced motion", () => {
    const l = new ParticleLayer(T, seededRandom(7));
    const lava = (fn: (x: number, y: number, kind: ParticleKind) => void): void =>
      fn(3, 3, "embers");
    for (let t = 0; t < 5000; t += 16) l.update(t, view, lava, true, false);
    expect(l.sim.count).toBeGreaterThan(0);
    l.update(5016, view, lava, true, true);
    expect(l.sim.count).toBe(0);
    expect(l.view.visible).toBe(false);
    l.update(5032, view, lava, true, true);
    expect(l.sim.count).toBe(0);
  });
});
