import { describe, expect, it } from "vitest";
import type { CosmeticDef, OutfitDef } from "../content-types.ts";
import {
  cosmeticOf,
  equippedOf,
  NAME_EFFECTS,
  nameStyleFor,
  NO_TINT,
  outfitFor,
  ownedByKind,
  parseTint,
  playerLook,
  tintFor,
} from "./cosmetics.ts";
import type { CosmeticContent } from "./cosmetics.ts";

const outfits: OutfitDef[] = [
  { id: "citizen", sprite: "outfits/citizen", frames: 3 },
  { id: "sailor", sprite: "outfits/sailor", frames: 3 },
];
const cosmetics: CosmeticDef[] = [
  { id: "outfit_sailor", kind: "outfit", price: 300, outfit: "sailor" },
  { id: "outfit_ghost", kind: "outfit", price: 300, outfit: "no_such_look" },
  { id: "color_tide", kind: "outfit_color", price: 120, tint: "#7fa8d8" },
  { id: "name_gilded", kind: "name_effect", price: 200, style: "gold" },
];
const content: CosmeticContent = { outfits, cosmetics };
const WHITE = 0xffffff;

describe("cosmetics (T5.7)", () => {
  it("draws the equipped outfit, falling back to citizen", () => {
    expect(outfitFor({ outfit: "outfit_sailor" }, content)?.id).toBe("sailor");
    expect(outfitFor(undefined, content)?.id).toBe("citizen");
    expect(outfitFor({ outfit: "" }, content)?.id).toBe("citizen");
    expect(outfitFor({ outfit: "unknown" }, content)?.id).toBe("citizen");
    // An outfit cosmetic whose look is missing, or an id of another kind.
    expect(outfitFor({ outfit: "outfit_ghost" }, content)?.id).toBe("citizen");
    expect(outfitFor({ outfit: "color_tide" }, content)?.id).toBe("citizen");
    expect(outfitFor({ outfit: "outfit_sailor" }, {})).toBeUndefined();
  });

  it("tints with the equipped colour only", () => {
    expect(tintFor({ color: "color_tide" }, content)).toBe(0x7fa8d8);
    expect(tintFor({ color: "" }, content)).toBe(NO_TINT);
    expect(tintFor({ color: "outfit_sailor" }, content)).toBe(NO_TINT);
    expect(tintFor(undefined, {})).toBe(NO_TINT);
    expect(parseTint("#A0b1C2")).toBe(0xa0b1c2);
    expect(parseTint("red")).toBe(NO_TINT);
    expect(parseTint("#fff")).toBe(NO_TINT);
  });

  it("styles the name label with the name effect, else the plain fill", () => {
    expect(nameStyleFor(undefined, content, WHITE)).toEqual({
      fill: WHITE,
      stroke: { color: 0x000000, width: 3 },
    });
    const gold = nameStyleFor({ nameEffect: "name_gilded" }, content, WHITE);
    expect(gold.fill).toBe(NAME_EFFECTS.gold.fill);
    expect(gold.stroke).toEqual(NAME_EFFECTS.gold.stroke);
    expect(gold.dropShadow?.color).toBe(NAME_EFFECTS.gold.glow);
    expect(gold.dropShadow?.distance).toBe(0);
    // A copy: changing the result never changes the table.
    gold.stroke.width = 9;
    expect(NAME_EFFECTS.gold.stroke.width).toBe(3);
    expect(nameStyleFor({ nameEffect: "color_tide" }, content, 0x123456).fill).toBe(0x123456);
  });

  it("puts it together for the renderer", () => {
    const look = playerLook(
      { outfit: "outfit_sailor", color: "color_tide", nameEffect: "name_gilded" },
      content,
      WHITE,
    );
    expect(look.outfit?.sprite).toBe("outfits/sailor");
    expect(look.tint).toBe(0x7fa8d8);
    expect(look.name.fill).toBe(NAME_EFFECTS.gold.fill);
  });

  it("finds cosmetics by kind and groups what the account owns", () => {
    expect(cosmeticOf(content, "color_tide", "outfit_color")?.tint).toBe("#7fa8d8");
    expect(cosmeticOf(content, "color_tide", "outfit")).toBeUndefined();
    expect(equippedOf({ outfit: "a", color: "b", nameEffect: "c" }, "outfit_color")).toBe("b");
    expect(equippedOf(undefined, "name_effect")).toBe("");
    const by = ownedByKind(["name_gilded", "outfit_sailor", "removed_long_ago"], content);
    expect(by.outfit.map((c) => c.id)).toEqual(["outfit_sailor"]);
    expect(by.outfit_color).toEqual([]);
    expect(by.name_effect.map((c) => c.id)).toEqual(["name_gilded"]);
  });

  it("every name effect style has a distinct fill", () => {
    const fills = Object.values(NAME_EFFECTS).map((s) => s.fill);
    expect(new Set(fills).size).toBe(fills.length);
  });
});
