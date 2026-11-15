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
