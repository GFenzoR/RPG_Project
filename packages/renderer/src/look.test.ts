import { describe, expect, it } from "vitest";
import {
  LAYER_ORDER,
  actionDir,
  attackActionFor,
  layerSprite,
  lookLayers,
  lookSprites,
} from "./look.ts";
import type { Look, LookTables, Worn } from "./look.ts";

const TABLES: LookTables = {
  skins: { fair: 0xecc4a2 },
  hairColors: { brown: 0x7a5232 },
  tints: { iron: 0xa8aeb6, linen: 0xece2c8, oak: 0xb0885c },
  hides: { hood: ["hair"], full_helm: ["hair", "beard"] },
};
const LOOK: Look = {
  body: "sturdy",
  skin: "fair",
  hair: "short",
  hairColor: "brown",
  beard: "full",
};
const WORN: Worn = {
  torso: { shape: "tunic", tint: "linen" },
  shield: { shape: "round", tint: "oak" },
  weapon: { shape: "sword", tint: "iron" },
};

describe("lookLayers", () => {
  it("stacks the paper doll back to front for each facing", () => {
    const slots = (dir: "n" | "e" | "s" | "w"): string[] =>
      lookLayers(LOOK, WORN, dir, "idle", 0, TABLES).map((l) => l.slot);
    // South: everything held comes toward the camera, over the body.
    expect(slots("s")).toEqual(["body", "hair", "torso", "beard", "shield", "weapon"]);
    // North: both hands are in front of the body, away from the camera: under it.
    expect(slots("n")).toEqual(["weapon", "shield", "beard", "body", "torso", "hair"]);
    // East: the right hand (weapon) is near, the left (shield) far.
    expect(slots("e")).toEqual(["shield", "body", "torso", "hair", "beard", "weapon"]);
    // West: the other way round.
    expect(slots("w")).toEqual(["weapon", "body", "torso", "hair", "beard", "shield"]);
  });

  it("names every frame <sprite>/<action>_<dir>_<n> and tints each layer by its colour", () => {
    const layers = lookLayers(LOOK, WORN, "e", "attack", 2, TABLES);
    expect(layers.map((l) => l.frame)).toContain("worn/weapon_sword/attack_e_2");
    expect(layers.find((l) => l.slot === "body")).toMatchObject({
      sprite: "humans/body_sturdy",
      tint: 0xecc4a2,
    });
    expect(layers.find((l) => l.slot === "torso")?.sprite).toBe("worn/torso_tunic_sturdy");
    expect(layers.find((l) => l.slot === "hair")?.tint).toBe(0x7a5232);
    expect(layers.find((l) => l.slot === "beard")?.tint).toBe(0x7a5232);
    expect(layers.find((l) => l.slot === "weapon")?.tint).toBe(0xa8aeb6);
  });

  it("falls facing south whatever way it faced, every layer alike", () => {
    expect(actionDir("death", "w")).toBe("s");
    expect(actionDir("walk", "w")).toBe("w");
    const layers = lookLayers(LOOK, WORN, "w", "death", 3, TABLES);
    expect(layers.map((l) => l.slot)).toEqual(
      LAYER_ORDER.s.filter((s) => layers.some((l) => l.slot === s)),
    );
    for (const l of layers) expect(l.frame).toMatch(/\/death_s_3$/);
  });

  it("draws no layer for a bald head or a shaven face, and hides what a head piece covers", () => {
    const bare = lookSprites({ ...LOOK, hair: "bald", beard: "none" }, {}, TABLES);
    expect(Object.keys(bare)).toEqual(["body"]);
    const hooded = lookSprites(LOOK, { head: { shape: "hood", tint: "linen" } }, TABLES);
    expect(hooded.hair).toBeUndefined();
    expect(hooded.beard).toBeDefined();
    const helmed = lookSprites(LOOK, { head: { shape: "full_helm", tint: "iron" } }, TABLES);
    expect(helmed.hair).toBeUndefined();
    expect(helmed.beard).toBeUndefined();
    expect(helmed.head?.sprite).toBe("worn/head_full_helm");
  });

  it("draws an unknown colour untinted", () => {
    const s = lookSprites(
      { ...LOOK, skin: "green" },
      { legs: { shape: "trousers", tint: "nope" } },
      TABLES,
    );
    expect(s.body?.tint).toBe(0xffffff);
    expect(s.legs).toEqual({ sprite: "worn/legs_trousers", tint: 0xffffff });
  });

  it("builds the same atlas paths as spritegen (humans/... and worn/...)", () => {
    expect(layerSprite("body", "slender", "slender")).toBe("humans/body_slender");
    expect(layerSprite("hair", "long", "sturdy")).toBe("humans/hair_long");
    expect(layerSprite("torso", "plate", "slender")).toBe("worn/torso_plate_slender");
    expect(layerSprite("feet", "boots", "slender")).toBe("worn/feet_boots");
  });
});

describe("attackActionFor", () => {
  it("plays the weapon's clip: bows shoot, wands and staves cast, the rest swing", () => {
    expect(attackActionFor("ranged", "bow")).toBe("shoot");
    expect(attackActionFor("melee", "crossbow")).toBe("shoot");
    expect(attackActionFor("ranged", "wand")).toBe("cast");
    expect(attackActionFor("melee", "staff")).toBe("cast");
    expect(attackActionFor("melee", "axe")).toBe("attack");
    expect(attackActionFor("melee", undefined)).toBe("attack");
    // A throw without a bow is an overhand swing; a spell always casts.
    expect(attackActionFor("ranged", "sword")).toBe("attack");
    expect(attackActionFor("spell", "sword")).toBe("cast");
  });
});
