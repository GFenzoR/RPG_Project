import { Container, Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import {
  BREAK_MS,
  BURST_COUNT,
  burst,
  createLivingObjects,
  FADE_MS,
  ghostAt,
  keepInPlace,
  MATERIAL_COLORS,
  materialOf,
  particleAt,
} from "./index.ts";
import type { LivingEvent } from "./index.ts";

/** A seeded random (LCG) so the bursts are the same on every run. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const at = (x: number, y: number, z = 7) => ({ x, y, z });

const event = (kind: LivingEvent["kind"], extra: Partial<LivingEvent> = {}): LivingEvent => ({
  kind,
  pos: at(10, 10),
  itemId: 500,
  effect: "wood",
  sound: "",
  hpPermille: 0,
  ...extra,
});

describe("keepInPlace", () => {
  it("trims the same array, in order", () => {
    const list = [1, 2, 3, 4, 5];
    const same = list;
    keepInPlace(list, (v) => v % 2 === 1);
    expect(list).toBe(same);
    expect(list).toEqual([1, 3, 5]);
    keepInPlace(list, () => false);
    expect(list).toEqual([]);
  });
});

describe("effects", () => {
  it("throws the material's colours, more on a break than on a hit", () => {
    const hit = burst("hit", "stone", 3, 4, 0, seeded());
    const brk = burst("break", "stone", 3, 4, 0, seeded());
    expect(hit).toHaveLength(BURST_COUNT.hit);
    expect(brk.length).toBeGreaterThan(hit.length);
    for (const p of brk) expect(MATERIAL_COLORS.stone).toContain(p.color);
  });

  it("falls back to wood for an unknown material", () => {
    expect(materialOf("lava")).toBe("wood");
    expect(materialOf("web")).toBe("web");
    expect(materialOf(undefined)).toBe("wood");
  });

  it("particles start on their tile, land and die at the end of their life", () => {
    const [p] = burst("break", "wood", 3, 4, 1000, seeded());
    if (!p) throw new Error("no particle");
    const first = particleAt(p, 1000);
    expect(first?.x).toBeGreaterThan(3);
    expect(first?.x).toBeLessThan(4);
    expect(first?.alpha).toBe(1);
    expect(particleAt(p, 1000 + BREAK_MS)).toBeUndefined();
    expect(particleAt(p, 999)).toBeUndefined();
  });

  it("a ghost glides from its tile to the next and fades", () => {
    const g = {
      itemId: 1,
      fromX: 2,
      fromY: 2,
      toX: 3,
      toY: 2,
      start: 0,
      ms: 200,
      alpha0: 1,
      alpha1: 0,
    };
    expect(ghostAt(g, 0)).toEqual({ x: 2, y: 2, alpha: 1 });
    const mid = ghostAt(g, 100);
    expect(mid?.x).toBeGreaterThan(2.5); // eased out: past half way at half time
    expect(mid?.alpha).toBeCloseTo(0.5);
    expect(ghostAt(g, 200)).toBeUndefined();
  });
});

describe("createLivingObjects", () => {
  const mount = (opts: { reduced?: boolean; texture?: boolean; debris?: string } = {}) => {
    const stage = new Container();
    const sounds: string[] = [];
    const lw = createLivingObjects(
      stage,
      (x, y) =>
        x === 4 && y === 4 ? { elevation: 0, debris: opts.debris ?? "plant" } : { elevation: 0 },
      {
        tileSize: 32,
        random: seeded(),
        reducedMotion: () => opts.reduced === true,
        playSound: (id) => sounds.push(id),
        ...(opts.texture === false ? {} : { texture: () => Texture.WHITE }),
      },
    );
    return { stage, lw, sounds };
  };

  it("mounts one layer on the stage and takes it off on destroy", () => {
    const { stage, lw } = mount();
    expect(stage.children).toHaveLength(1);
    lw.destroy();
    expect(stage.children).toHaveLength(0);
  });

  it("a break throws a burst and dust that are gone after their life", () => {
    const { lw, sounds } = mount();
    lw.onObjectEvent(event("break", { sound: "woodcutting" }), 0);
    lw.onTick(10, 7);
    expect(lw.alive).toBe(BURST_COUNT.break + BURST_COUNT.dust);
    expect(sounds).toEqual(["woodcutting"]);
    lw.onTick(BREAK_MS + 1, 7);
    expect(lw.alive).toBe(0);
  });

  it("a push glides a ghost of the object, a fade shows the debris going", () => {
    const { lw } = mount();
    lw.onObjectEvent(event("push", { to: at(11, 10), effect: "stone" }), 0);
    lw.onObjectEvent(event("fade", { itemId: 501 }), 0);
    lw.onTick(5, 7);
    expect(lw.alive).toBe(2 + BURST_COUNT.dust);
    lw.onTick(FADE_MS + 1, 7);
    expect(lw.alive).toBe(0);
  });

  it("draws nothing of another floor and nothing with reduced motion", () => {
    const { lw } = mount({ reduced: true });
    lw.onObjectEvent(event("break"), 0);
    lw.onTick(1, 7);
    expect(lw.alive).toBe(0);
    const other = mount();
    other.lw.onObjectEvent(event("hit"), 0);
    expect(() => other.lw.onTick(1, 6)).not.toThrow();
  });

  it("a step on debris crunches it; a step elsewhere does nothing", () => {
    const { lw } = mount();
    lw.onStep(at(3, 4), at(4, 5), 0);
    lw.onTick(1, 7);
    expect(lw.alive).toBe(0);
    lw.onStep(at(3, 4), at(4, 4), 0);
    lw.onTick(1, 7);
    expect(lw.alive).toBe(BURST_COUNT.hit);
  });

  it("plays a sound even with reduced motion", () => {
    const play = vi.fn();
    const lw = createLivingObjects(new Container(), () => undefined, {
      tileSize: 32,
      playSound: play,
      reducedMotion: () => true,
    });
    lw.onObjectEvent(event("hit", { sound: "hit" }), 0);
    expect(play).toHaveBeenCalledWith("hit", at(10, 10));
  });
});
