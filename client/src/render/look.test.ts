import { describe, expect, it } from "vitest";
import type { LookTables } from "@rpg/renderer";
import type { ItemDef, OutfitDef } from "../content-types.ts";
import { dollSprites, dressPlayer, mulTint, wornFromVisible, wornKey, wornSlotOf } from "./look.ts";

const item = (id: string, extra: Partial<ItemDef>): ItemDef => ({
  id,
  sprite: `x/${id}`,
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
  ...extra,
});

const ITEMS: Record<number, ItemDef> = {
  1: item("iron_sword", {
    weapon: { type: "sword", attack: 13, defense: 7, hands: 1, range: 0, element: "", ammo: "" },
    worn: { shape: "sword", tint: "iron" },
  }),
  2: item("elmwood_shield", {
    kind: "shield",
    shield: { defense: 12 },
    worn: { shape: "round", tint: "elm" },
  }),
  3: item("tidesteel_plate", {
    armor: { slot: "body", armor: 12 },
    worn: { shape: "plate", tint: "tidesteel" },
  }),
  4: item("tidestone_ring", { armor: { slot: "ring", armor: 1 } }),
  5: item("tidesteel_helm", {
    armor: { slot: "head", armor: 5 },
    worn: { shape: "full_helm", tint: "tidesteel" },
  }),
  6: item("plain_hat", { armor: { slot: "head", armor: 1 } }),
};

const CITIZEN: OutfitDef = {
  id: "citizen",
  sprite: "outfits/citizen",
  frames: 1,
  look: {
    sex: "male",
    body: "sturdy",
    skin: "fair",
    hair: "short",
    hairColor: "brown",
    beard: "none",
  },
  clothes: {
    torso: { shape: "tunic", tint: "linen" },
    legs: { shape: "trousers", tint: "brown" },
    feet: { shape: "shoes", tint: "tar" },
  },
};
const SAILOR: OutfitDef = {
  ...CITIZEN,
  id: "sailor",
  costume: true,
  clothes: { torso: { shape: "tunic", tint: "white" } },
};

describe("the figure's equipment", () => {
  it("shows each visible piece with `worn` at its slot, whatever hand it is in", () => {
    const eq = {
      head: 6, // no worn: nothing on the figure
      torso: 3,
      legs: 99, // unknown to this client: nothing
      feet: 0,
      leftHand: 1, // the sword in the left hand: still the weapon
      rightHand: 2,
    };
    expect(wornFromVisible(eq, ITEMS)).toEqual({
      weapon: { shape: "sword", tint: "iron" },
      shield: { shape: "round", tint: "elm" },
      torso: { shape: "plate", tint: "tidesteel" },
    });
    expect(wornSlotOf(ITEMS[4] as ItemDef)).toBeUndefined();
    expect(wornSlotOf(ITEMS[5] as ItemDef)).toBe("head");
  });

  it("dresses the empty clothes slots in the default outfit; armour shows over it", () => {
    const d = dressPlayer(CITIZEN, { torso: { shape: "plate", tint: "tidesteel" } });
    expect(d.worn.torso).toEqual({ shape: "plate", tint: "tidesteel" });
    expect(d.worn.legs).toEqual({ shape: "trousers", tint: "brown" });
    expect([...d.clothes].sort()).toEqual(["feet", "legs"]);
  });

  it("a costume covers the torso even over armour, the helmet and the weapon still show", () => {
    const d = dressPlayer(SAILOR, {
      torso: { shape: "plate", tint: "tidesteel" },
      head: { shape: "full_helm", tint: "tidesteel" },
      weapon: { shape: "sword", tint: "iron" },
    });
    expect(d.worn.torso).toEqual({ shape: "tunic", tint: "white" });
    expect(d.worn.head?.shape).toBe("full_helm");
    expect(d.worn.weapon?.shape).toBe("sword");
    expect([...d.clothes]).toEqual(["torso"]);
  });

  it("keys what is worn, so the figure is built again only when it changes", () => {
    const a = wornKey({
      weapon: { shape: "sword", tint: "iron" },
      torso: { shape: "tunic", tint: "linen" },
    });
    const b = wornKey({
      torso: { shape: "tunic", tint: "linen" },
      weapon: { shape: "sword", tint: "iron" },
    });
    expect(a).toBe(b);
    expect(wornKey({ weapon: { shape: "sword", tint: "rust" } })).not.toBe(
      wornKey({ weapon: { shape: "sword", tint: "iron" } }),
    );
    expect(wornKey({})).toBe("");
  });

  it("tints the outfit's clothes with the outfit colour cosmetic, and only them", () => {
    expect(mulTint(0xffffff, 0x123456)).toBe(0x123456);
    expect(mulTint(0x808080, 0xff0000)).toBe(0x800000);
    const tables: LookTables = {
      skins: { fair: 0xecc4a2 },
      hairColors: { brown: 0x7a5232 },
      tints: { linen: 0xece2c8, brown: 0x977049, tar: 0x5c4a3b, iron: 0xa8aeb6 },
    };
    const d = dressPlayer(CITIZEN, { weapon: { shape: "sword", tint: "iron" } });
    const look = CITIZEN.look;
    if (!look) throw new Error("look");
    // What the canvas stacks (game-canvas.ts dollOf).
    const layers = dollSprites(look, d, tables, 0xff8080);
    expect(layers.find((l) => l.slot === "torso")).toEqual({
      slot: "torso",
      sprite: "worn/torso_tunic_sturdy",
      tint: mulTint(0xece2c8, 0xff8080),
    });
    expect(layers.find((l) => l.slot === "weapon")?.tint).toBe(0xa8aeb6);
    expect(layers.find((l) => l.slot === "body")?.tint).toBe(0xecc4a2);
    // Armour over the outfit's clothes is not the outfit's: the colour leaves it alone.
    const armoured = dressPlayer(CITIZEN, { torso: { shape: "plate", tint: "iron" } });
    const plate = dollSprites(look, armoured, tables, 0xff8080).find((l) => l.slot === "torso");
    expect(plate?.tint).toBe(0xa8aeb6);
    // Without a colour cosmetic every layer keeps its own.
    expect(dollSprites(look, d, tables).find((l) => l.slot === "torso")?.tint).toBe(0xece2c8);
  });
});
