import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadClientContent } from "./content.ts";

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
