import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARROW_DIAGONAL,
  ARROW_POSES,
  ARROW_STRAIGHT,
  EFFECT_IDS,
  MAX_EFFECT_FRAMES,
  ORB_FRAME_MS,
  arrowPose,
  effectFolder,
  effectFrame,
  effectFrames,
  missileArt,
  octant,
  orbFrame,
} from "./effects.ts";
import type { ArrowPose } from "./effects.ts";
import {
  EFFECT_BLOCK,
  EFFECT_BUFF,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  EFFECT_MS,
  EFFECT_REFINE,
  EFFECT_SHATTER,
  ELEMENTS,
  PROJECTILE_ELEMENT,
} from "../state/world.ts";

describe("effect folders", () => {
  it("names a folder for every effect id the server sends", () => {
    expect(effectFolder(EFFECT_HIT)).toBe("effects/hit");
    expect(effectFolder(EFFECT_BLOCK)).toBe("effects/block");
    expect(effectFolder(EFFECT_HEAL)).toBe("effects/heal");
    expect(effectFolder(EFFECT_CONJURE)).toBe("effects/conjure");
    expect(effectFolder(EFFECT_GATHER)).toBe("effects/gather");
    expect(effectFolder(EFFECT_GATHER_MISS)).toBe("effects/gather_miss");
    expect(effectFolder(EFFECT_BUFF)).toBe("effects/buff");
    // The forge (docs/02 "Forja"): sparks on a success, a shatter on a break.
    expect(effectFolder(EFFECT_REFINE)).toBe("effects/refine");
    expect(effectFolder(EFFECT_SHATTER)).toBe("effects/shatter");
    // 10 + element index, in the server's order (physical … death).
    expect(effectFolder(EFFECT_ELEMENT)).toBe("effects/physical");
    expect(effectFolder(EFFECT_ELEMENT + 1)).toBe("effects/fire");
    expect(effectFolder(EFFECT_ELEMENT + 4)).toBe("effects/earth");
    expect(effectFolder(EFFECT_ELEMENT + ELEMENTS.length - 1)).toBe("effects/death");
    expect(EFFECT_IDS).toHaveLength(9 + ELEMENTS.length);
  });

  it("knows no other id", () => {
    expect(effectFolder(0)).toBeUndefined();
    expect(effectFolder(99)).toBeUndefined();
    expect(effectFolder(EFFECT_ELEMENT + ELEMENTS.length)).toBeUndefined();
  });

  it("has the art of every folder committed (tools/spritegen, make spritegen)", () => {
    for (const id of EFFECT_IDS) {
      const folder = effectFolder(id) ?? "";
      for (const f of [0, 1]) {
        const png = new URL(`../../../assets/sprites/${folder}/${f}.png`, import.meta.url);
        expect(existsSync(png), `${folder}/${f}`).toBe(true);
      }
    }
  });
});

describe("effect frames", () => {
  const atlas = (sprites: string[]) => (s: string) => sprites.includes(s);

  it("lists the strip up to the first missing frame", () => {
    const has = atlas(["effects/hit/0", "effects/hit/1", "effects/hit/2", "effects/hit/4"]);
    expect(effectFrames(EFFECT_HIT, has)).toEqual([
      "effects/hit/0",
      "effects/hit/1",
      "effects/hit/2",
    ]);
  });

  it("is empty without art or for an unknown id: the procedural shape", () => {
    expect(effectFrames(EFFECT_HIT, atlas([]))).toEqual([]);
    expect(effectFrames(EFFECT_HIT, atlas(["effects/hit/1"]))).toEqual([]);
    expect(effectFrames(99, () => true)).toEqual([]);
  });

  it("stops at MAX_EFFECT_FRAMES", () => {
    expect(effectFrames(EFFECT_HEAL, () => true)).toHaveLength(MAX_EFFECT_FRAMES);
  });
});

describe("frame at a time", () => {
  it("spreads the frames evenly over the effect time", () => {
    expect(effectFrame(0, 6, 600)).toBe(0);
    expect(effectFrame(99, 6, 600)).toBe(0);
    expect(effectFrame(100, 6, 600)).toBe(1);
    expect(effectFrame(250, 6, 600)).toBe(2);
    expect(effectFrame(599, 6, 600)).toBe(5);
  });

  it("holds the first frame before the start and the last from the end on", () => {
    expect(effectFrame(-50, 6, 600)).toBe(0);
    expect(effectFrame(600, 6, 600)).toBe(5);
    expect(effectFrame(10_000, 6, 600)).toBe(5);
  });

  it("uses EFFECT_MS by default and survives odd input", () => {
    expect(effectFrame(EFFECT_MS - 1, 4)).toBe(3);
    expect(effectFrame(EFFECT_MS / 2, 4)).toBe(2);
    expect(effectFrame(300, 1)).toBe(0);
    expect(effectFrame(300, 0)).toBe(0);
    expect(effectFrame(Number.NaN, 6)).toBe(0);
    expect(effectFrame(300, 6, 0)).toBe(0);
  });
});

describe("missile art", () => {
  const atlas = (sprites: string[]) => (s: string) => sprites.includes(s);
  const ARROW = PROJECTILE_ELEMENT; // physical
  const FIRE = PROJECTILE_ELEMENT + 1;

  it("is the arrow for a physical projectile, with both of its drawings", () => {
    expect(missileArt(ARROW, atlas([ARROW_STRAIGHT, ARROW_DIAGONAL]))).toEqual({
      kind: "arrow",
      straight: ARROW_STRAIGHT,
      diagonal: ARROW_DIAGONAL,
    });
    expect(missileArt(ARROW, atlas([ARROW_STRAIGHT]))).toBeUndefined();
  });

  it("is the orb loop of an element up to the first missing frame, with its trail if any", () => {
    const has = atlas(["missiles/fire/0", "missiles/fire/1", "missiles/fire/3"]);
    expect(missileArt(FIRE, has)).toEqual({
      kind: "orb",
      frames: ["missiles/fire/0", "missiles/fire/1"],
      trail: undefined,
    });
    expect(missileArt(FIRE, atlas(["missiles/fire/0", "missiles/fire/trail"]))).toEqual({
      kind: "orb",
      frames: ["missiles/fire/0"],
      trail: "missiles/fire/trail",
    });
    expect(missileArt(PROJECTILE_ELEMENT + 6, () => true)).toMatchObject({
      kind: "orb",
      trail: "missiles/death/trail",
    });
  });

  it("is nothing without art or for an unknown id: the procedural dot", () => {
    expect(missileArt(FIRE, atlas(["missiles/fire/trail"]))).toBeUndefined();
    expect(missileArt(0, () => true)).toBeUndefined();
    expect(missileArt(PROJECTILE_ELEMENT + ELEMENTS.length, () => true)).toBeUndefined();
  });

  it("has every drawing committed (tools/spritegen, make spritegen)", () => {
    const file = (s: string) => new URL(`../../../assets/sprites/${s}.png`, import.meta.url);
    for (const s of [ARROW_STRAIGHT, ARROW_DIAGONAL]) expect(existsSync(file(s)), s).toBe(true);
    for (const e of ELEMENTS.slice(1))
      for (const s of ["0", "1", "2", "trail"])
        expect(existsSync(file(`missiles/${e}/${s}`)), `${e}/${s}`).toBe(true);
  });

  it("loops an orb every ORB_FRAME_MS", () => {
    expect(orbFrame(0, 3)).toBe(0);
    expect(orbFrame(ORB_FRAME_MS - 1, 3)).toBe(0);
    expect(orbFrame(ORB_FRAME_MS, 3)).toBe(1);
    expect(orbFrame(ORB_FRAME_MS * 3, 3)).toBe(0);
    expect(orbFrame(-20, 3)).toBe(0);
    expect(orbFrame(500, 1)).toBe(0);
  });
});

describe("arrow orientation", () => {
  /** Pixi's local transform of a vector: the scale first, then the turn (clockwise, y down). */
  const apply = (p: ArrowPose, [x, y]: readonly [number, number]): [number, number] => {
    const sx = x * p.scaleX;
    const sy = y * p.scaleY;
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    return [Math.round(sx * c - sy * s), Math.round(sx * s + sy * c)];
  };
  // The drawings: the straight one flies east, the diagonal one south-east; both have their
  // lit side to the north (straight) or north-east (diagonal).
  const art = (p: ArrowPose) => (p.diagonal ? ([1, 1] as const) : ([1, 0] as const));
  const lit = (p: ArrowPose) => (p.diagonal ? ([1, -1] as const) : ([0, -1] as const));
  const DIRS: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];

  it("splits the circle in eight 45 degree steps clockwise from east", () => {
    DIRS.forEach(([x, y], i) => expect(octant(x, y), `${x},${y}`).toBe(i));
    expect(octant(0, 0)).toBe(0);
    expect(octant(5, 1)).toBe(0); // 11 degrees: east
    expect(octant(5, 3)).toBe(1); // 31 degrees: south-east
    expect(octant(-4, -1)).toBe(4);
    expect(octant(1, -7)).toBe(6);
  });

  it("points the arrow at every octant, lit from above or the left, in quarter turns", () => {
    expect(ARROW_POSES).toHaveLength(8);
    DIRS.forEach((dir, i) => {
      const pose = arrowPose(dir[0] * 3, dir[1] * 3);
      expect(pose).toBe(ARROW_POSES[i]);
      expect(pose.diagonal).toBe(i % 2 === 1);
      expect(apply(pose, art(pose)), `octant ${i}`).toEqual(dir);
      const [lx, ly] = apply(pose, lit(pose));
      // The lit side is the one that faces up, or the left one of an arrow flying up or down.
      expect(ly < 0 || (ly === 0 && lx < 0), `octant ${i} lit`).toBe(true);
      // Pixel-perfect: only whole quarter turns and mirrors.
      expect(Math.abs(pose.rotation % (Math.PI / 2))).toBeLessThan(1e-9);
      expect([1, -1]).toContain(pose.scaleX);
      expect([1, -1]).toContain(pose.scaleY);
    });
  });
});
