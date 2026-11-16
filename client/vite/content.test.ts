import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadClientContent, loadSiteContent } from "./content.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

describe("client content (T0.5)", () => {
  const content = loadClientContent(REPO);

  it("exposes each NPC's sprite like the monsters'", () => {
    expect(content.npcSprites?.["bosque_ferryman"]).toBe("npcs/ferryman");
    expect(content.monsterSprites["bilge_rat"]).toMatch(/\//);
  });

  it("ships item descriptions: the usual item.<id>.desc and a sign's text (T5.5)", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("cooled_lava")?.desc).toBe("item.cooled_lava.desc");
    expect(byId.get("brasal_dock_sign")?.desc).toBe("text.volcan.dock_sign");
    expect(byId.get("ash")?.desc).toBeUndefined();
    for (const lang of ["es", "en"]) {
      const texts = content.i18n[lang] ?? {};
      expect(texts["item.cooled_lava.desc"]).toBeTruthy();
      for (const sign of ["temple", "dock", "mine"])
        expect(texts[`text.volcan.${sign}_sign`]).toBeTruthy();
      // Only the descriptions items use: other world.yaml texts stay out of the game.
      expect(texts["text.puerto.temple_sign"]).toBeUndefined();
    }
  });

  it("names items with a shared name key by item.<id>.name, like every other item", () => {
    for (const lang of ["es", "en"]) {
      const texts = content.i18n[lang] ?? {};
      expect(texts["item.brasal_dock_sign.name"]).toBe(texts["item.signpost.name"]);
      expect(texts["item.border_ash_sand_n.name"]).toBe(texts["item.border_ash_sand.name"]);
      expect(texts["item.brasal_dock_sign.name"]).toBeTruthy();
    }
    expect(content.i18n["es"]?.["item.brasal_dock_sign.name"]).toBe("cartel");
  });

  it("exposes data/outfits.yaml with the default citizen outfit", () => {
    expect(content.outfits).toContainEqual({ id: "citizen", sprite: "outfits/citizen", frames: 3 });
  });
});

describe("client content (T5.7)", () => {
  const content = loadClientContent(REPO);

  it("exposes data/cosmetics.yaml with only each kind's field", () => {
    const sailor = content.cosmetics?.find((c) => c.id === "outfit_sailor");
    expect(sailor).toEqual({
      id: "outfit_sailor",
      kind: "outfit",
      price: sailor?.price,
      outfit: "sailor",
    });
    const outfits = new Set(content.outfits?.map((o) => o.id));
    for (const c of content.cosmetics ?? []) {
      expect(c.price).toBeGreaterThan(0);
      if (c.kind === "outfit") expect(outfits.has(c.outfit ?? "")).toBe(true);
      if (c.kind === "outfit_color") expect(c.tint).toMatch(/^#[0-9a-f]{6}$/);
      if (c.kind === "name_effect") expect(c.style).toBeDefined();
    }
  });

  it("ships the cosmetic names to the game and the site in both languages", () => {
    const site = loadSiteContent(REPO);
    expect(site.cosmetics?.length).toBe(content.cosmetics?.length);
    for (const lang of ["es", "en"]) {
      for (const c of content.cosmetics ?? []) {
        expect(content.i18n[lang]?.[`cosmetic.${c.id}.name`]).toBeTruthy();
        expect(site.i18n[lang]?.[`cosmetic.${c.id}.name`]).toBeTruthy();
      }
      expect(site.i18n[lang]?.["premium.amount"]).toContain("{count}");
    }
  });
});
