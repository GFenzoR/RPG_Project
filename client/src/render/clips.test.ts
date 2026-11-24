import { describe, expect, it } from "vitest";
import type { AnimMeta } from "@rpg/renderer";
import { clipTexture, dirIndex, headLift, legacyOutfitClips, spriteClips } from "./clips.ts";

const DIRS: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];

/** An atlas lookup over a set of keys: the "texture" is the key itself. */
const atlasOf =
  (keys: string[]) =>
  (key: string): string | undefined =>
    keys.includes(key) ? key : undefined;

const HERO: AnimMeta = {
  w: 64,
  h: 64,
  anchor: "bc",
  foot: 2,
  top: 46,
  shadow: "ellipse",
  actions: {
    walk: { frames: 2, ms: 0, perTile: 1, dirs: DIRS },
    death: { frames: 2, ms: 100, dirs: ["s"] },
    attack: { frames: 2, ms: 60, dirs: DIRS },
  },
};

const heroKeys = [
  "c/hero",
  ...DIRS.flatMap((d) => [`c/hero/walk_${d}_0`, `c/hero/walk_${d}_1`]),
  "c/hero/death_s_0",
  "c/hero/death_s_1",
  // attack misses its east frames: the action is dropped
  ...["n", "s", "w"].flatMap((d) => [`c/hero/attack_${d}_0`, `c/hero/attack_${d}_1`]),
];

describe("clip sets", () => {
  it("indexes an animated sprite's frames by action, facing and frame", () => {
    const c = spriteClips("c/hero", { "c/hero": HERO }, atlasOf(heroKeys));
    expect(c?.frames.walk?.[dirIndex("e")]).toEqual(["c/hero/walk_e_0", "c/hero/walk_e_1"]);
    // A facing without frames uses the south ones.
    expect(c?.frames.death?.[dirIndex("w")]).toEqual(["c/hero/death_s_0", "c/hero/death_s_1"]);
    expect(c?.frames.attack).toBeUndefined();
    expect(Object.keys(c?.meta?.actions ?? {})).toEqual(["walk", "death"]);
    expect(c?.still).toBe("c/hero");
  });

  it("indexes the bow and the spell of an LPC humanoid too (ANI-2)", () => {
    const meta: AnimMeta = {
      ...HERO,
      actions: {
        walk: { frames: 1, ms: 0, perTile: 1, dirs: DIRS },
        shoot: { frames: 2, ms: 50, dirs: DIRS },
        cast: { frames: 1, ms: 60, dirs: DIRS },
      },
    };
    const keys = DIRS.flatMap((d) => [
      `c/mage/walk_${d}_0`,
      `c/mage/shoot_${d}_0`,
      `c/mage/shoot_${d}_1`,
      `c/mage/cast_${d}_0`,
    ]);
    const c = spriteClips("c/mage", { "c/mage": meta }, atlasOf(keys));
    if (!c) throw new Error("no clips");
    expect(Object.keys(c.meta?.actions ?? {})).toEqual(["walk", "shoot", "cast"]);
    expect(clipTexture(c, "shoot", dirIndex("w"), 1)).toBe("c/mage/shoot_w_1");
    expect(clipTexture(c, "cast", dirIndex("n"), 0)).toBe("c/mage/cast_n_0");
  });

  it("falls back to the stance and the still texture for missing clips", () => {
    const c = spriteClips("c/hero", { "c/hero": HERO }, atlasOf(heroKeys));
    if (!c) throw new Error("no clips");
    expect(clipTexture(c, "attack", dirIndex("n"), 1)).toBe("c/hero/walk_n_0");
    expect(clipTexture(c, "walk", dirIndex("n"), 1)).toBe("c/hero/walk_n_1");
    const still = spriteClips("m/rat", undefined, atlasOf(["m/rat"]));
    expect(still).toEqual({ meta: undefined, frames: {}, still: "m/rat", eight: false });
    if (still) expect(clipTexture(still, "walk", 0, 3)).toBe("m/rat");
    expect(spriteClips("m/none", undefined, atlasOf([]))).toBeUndefined();
  });

  it("draws idle and attack only facing their own ways, the stance elsewhere", () => {
    // A Gemini monster: a bite drawn only to the sides, an idle only facing south.
    const wolf: AnimMeta = {
      ...HERO,
      actions: {
        walk: { frames: 2, ms: 0, perTile: 1, dirs: DIRS },
        idle: { frames: 2, ms: 500, dirs: ["s"] },
        attack: { frames: 2, ms: 110, dirs: ["e", "w"] },
      },
    };
    const keys = [
      ...DIRS.flatMap((d) => [`m/wolf/walk_${d}_0`, `m/wolf/walk_${d}_1`]),
      "m/wolf/idle_s_0",
      "m/wolf/idle_s_1",
      ...["e", "w"].flatMap((d) => [`m/wolf/attack_${d}_0`, `m/wolf/attack_${d}_1`]),
    ];
    const c = spriteClips("m/wolf", { "m/wolf": wolf }, atlasOf(keys));
    if (!c) throw new Error("no clips");
    expect(Object.keys(c.meta?.actions ?? {})).toEqual(["idle", "walk", "attack"]);
    expect(c.frames.attack?.[dirIndex("n")]).toEqual([]);
    expect(clipTexture(c, "attack", dirIndex("e"), 1)).toBe("m/wolf/attack_e_1");
    expect(clipTexture(c, "attack", dirIndex("n"), 1)).toBe("m/wolf/walk_n_0"); // not a side bite
    expect(clipTexture(c, "idle", dirIndex("w"), 1)).toBe("m/wolf/walk_w_0"); // not the south idle
    expect(clipTexture(c, "idle", dirIndex("s"), 1)).toBe("m/wolf/idle_s_1");
    expect(c.still).toBe("m/wolf/idle_s_0");
  });

  it("keeps the hints of a single-frame sprite", () => {
    const bat: AnimMeta = { ...HERO, anchor: "br", shadow: "baked", flying: true, actions: {} };
    const c = spriteClips("m/bat", { "m/bat": bat }, atlasOf(["m/bat"]));
    expect(c?.meta).toMatchObject({ flying: true, actions: {} });
    expect(c?.still).toBe("m/bat");
  });

  it("reads a T0.5 outfit as a standing frame and a walk played within each tile", () => {
    const keys = DIRS.flatMap((d) => [0, 1, 2].map((f) => `o/cit/${d}_${f}`));
    const c = legacyOutfitClips("o/cit", 3, atlasOf(keys), { w: 32, h: 32 });
    expect(c?.frames.idle?.[dirIndex("w")]).toEqual(["o/cit/w_0"]);
    expect(c?.frames.walk?.[dirIndex("w")]).toEqual(["o/cit/w_1", "o/cit/w_2"]);
    expect(c?.meta?.actions.walk).toMatchObject({ frames: 2, perTile: 2 });
    expect(c?.meta).toMatchObject({ anchor: "br", shadow: "baked" });
    expect(legacyOutfitClips("o/cit", 4, atlasOf(keys), { w: 32, h: 32 })).toBeUndefined();
  });

  it("lifts names over figures taller than their tile", () => {
    expect(headLift(HERO, undefined, 32, 4)).toBe(18); // 4 + 46 - 32
    expect(headLift({ ...HERO, anchor: "br", foot: 1, top: 24 }, undefined, 32, 4)).toBe(0);
    expect(headLift(undefined, { w: 64, h: 64 }, 32, 4)).toBe(32);
    expect(headLift(undefined, undefined, 32, 4)).toBe(0);
  });
});

describe("eight facings (docs/17 ANI-1)", () => {
  const ALL = ["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const;
  const PERSON: AnimMeta = {
    ...HERO,
    actions: {
      idle: { frames: 1, ms: 500, dirs: [...ALL] },
      walk: { frames: 2, ms: 0, perTile: 8, perTileNS: 13.86, dirs: [...ALL] },
      death: { frames: 1, ms: 150, dirs: ["s"] },
    },
  };
  const keysOf = (dirs: readonly string[]): string[] => [
    ...dirs.flatMap((d) => [`c/p/idle_${d}_0`, `c/p/walk_${d}_0`, `c/p/walk_${d}_1`]),
    "c/p/death_s_0",
  ];

  it("indexes the diagonals after the straight facings when every action has them", () => {
    const c = spriteClips("c/p", { "c/p": PERSON }, atlasOf(keysOf(ALL)));
    expect(c?.eight).toBe(true);
    expect(c?.frames.walk).toHaveLength(8);
    expect(c?.frames.walk?.[dirIndex("ne")]).toEqual(["c/p/walk_ne_0", "c/p/walk_ne_1"]);
    expect(c?.frames.idle?.[dirIndex("sw")]).toEqual(["c/p/idle_sw_0"]);
    // Death falls facing south whichever way it faces.
    expect(c?.frames.death?.[dirIndex("nw")]).toEqual(["c/p/death_s_0"]);
  });

  it("stays four ways when an action lacks the diagonals, or a diagonal frame is missing", () => {
    const four: AnimMeta = {
      ...PERSON,
      actions: { ...PERSON.actions, idle: { frames: 1, ms: 500, dirs: DIRS } },
    };
    const c = spriteClips("c/p", { "c/p": four }, atlasOf(keysOf(ALL)));
    expect(c?.eight).toBe(false);
    expect(c?.frames.walk).toHaveLength(4);
    const gap = keysOf(ALL).filter((k) => k !== "c/p/walk_se_1");
    const d = spriteClips("c/p", { "c/p": PERSON }, atlasOf(gap));
    expect(d?.eight).toBe(false);
    expect(d?.frames.idle).toHaveLength(4);
    expect(spriteClips("c/hero", { "c/hero": HERO }, atlasOf(heroKeys))?.eight).toBe(false);
  });
});
