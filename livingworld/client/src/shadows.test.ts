import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import { parseLivingWorldData } from "./data.ts";
import {
  MAX_BLOCK_HEIGHT,
  MAX_SHADOW_LENGTH,
  MIN_SHADOW_LENGTH,
  parseObjectShadow,
  parseShadows,
  shadowFamilies,
  shadowOf,
} from "./shadows.ts";
import type { ShadowRules } from "./shadows.ts";

const RULES = parseShadows({
  kinds: { wall: "block", decoration: "silhouette", container: "silhouette" },
  families: {
    gate: { cast: "block", height: 20 },
    remains: { cast: "silhouette", length: 0.4 },
    border: "none",
    cut: "none",
    crate: "silhouette",
  },
  items: { rug: "none", bed: { cast: "silhouette", length: 0.5 }, torch: "silhouette" },
}) as ShadowRules;

const fixed = (id: string, kind = "decoration") => ({ id, kind, fixed: true });

describe("parseObjectShadow", () => {
  it("reads a cast's name or a mapping, and clamps what it carries", () => {
    expect(parseObjectShadow("none")).toBeNull();
    expect(parseObjectShadow("silhouette")).toEqual({ cast: "silhouette", length: 1 });
    expect(parseObjectShadow({ cast: "block", height: 32 })).toEqual({
      cast: "block",
      length: 1,
      height: 32,
    });
    expect(parseObjectShadow({ cast: "silhouette", length: 99 })?.length).toBe(MAX_SHADOW_LENGTH);
    expect(parseObjectShadow({ cast: "silhouette", length: 0 })?.length).toBe(MIN_SHADOW_LENGTH);
    expect(parseObjectShadow({ cast: "block", height: 900 })?.height).toBe(MAX_BLOCK_HEIGHT);
    // Malformed: skipped, never a guess.
    expect(parseObjectShadow("cube")).toBeUndefined();
    expect(parseObjectShadow(3)).toBeUndefined();
    expect(parseObjectShadow({ length: 1 })).toBeUndefined();
  });
});

describe("shadowOf", () => {
  it("gives a map object the shadow of its kind with nothing written for it", () => {
    expect(shadowOf(RULES, fixed("oak_tree"))).toEqual({ cast: "silhouette", length: 1 });
    expect(shadowOf(RULES, fixed("stone_wall", "wall"))).toEqual({ cast: "block", length: 1 });
    expect(shadowOf(RULES, fixed("stash_chest", "container"))?.cast).toBe("silhouette");
    // A kind the file does not name casts none.
    expect(shadowOf(RULES, fixed("ember_key", "key"))).toBeUndefined();
  });

  it("lets a family of the id win over the kind: flat things cast none, gates are boxes", () => {
    expect(shadowOf(RULES, fixed("border_sand_nw"))).toBeUndefined();
    expect(shadowOf(RULES, fixed("morvund_gate_open"))).toEqual({
      cast: "block",
      length: 1,
      height: 20,
    });
    expect(shadowOf(RULES, fixed("remains_fur", "container"))).toEqual({
      cast: "silhouette",
      length: 0.4,
    });
    // The first word with a family: the debris of a cut bush lies flat.
    expect(shadowOf(RULES, fixed("cut_bush"))).toBeUndefined();
    // Plural: stacked_crates is of the family "crate".
    expect(shadowFamilies(RULES.families, "stacked_crates")).toEqual(["crate"]);
    expect(shadowFamilies(RULES.families, "cut_crates_gate")).toEqual(["cut", "crate", "gate"]);
  });

  it("reads only the rules written: a word of Object.prototype is no family, item or kind", () => {
    expect(shadowFamilies(RULES.families, "constructor_crate")).toEqual(["crate"]);
    expect(shadowFamilies(RULES.families, "to_string_value_of")).toEqual([]);
    // Not the "constructor" family (a function, no shadow at all): its kind's.
    expect(shadowOf(RULES, fixed("constructor_stone"))).toEqual({ cast: "silhouette", length: 1 });
    expect(shadowOf(RULES, fixed("constructor"))).toEqual({ cast: "silhouette", length: 1 });
    expect(shadowOf(RULES, fixed("anvil", "toString"))).toBeUndefined();
    expect(shadowOf(RULES, { id: "valueOf", kind: "tool", fixed: false })).toBeUndefined();
  });

  it("lets an item's own line win over all, either way", () => {
    expect(shadowOf(RULES, fixed("rug"))).toBeUndefined();
    expect(shadowOf(RULES, fixed("bed"))).toEqual({ cast: "silhouette", length: 0.5 });
    // A loose item named by its id casts too.
    expect(shadowOf(RULES, { id: "torch", kind: "tool", fixed: false })?.cast).toBe("silhouette");
  });

  it("casts nothing for what a player can pick up: a sword on the ground lies flat", () => {
    expect(shadowOf(RULES, { id: "iron_sword", kind: "decoration", fixed: false })).toBeUndefined();
    expect(shadowOf(RULES, { id: "crate", kind: "container", fixed: false })).toBeUndefined();
  });
});

describe("data/livingworld/shadows.yaml", () => {
  const raw = parseYaml(
    readFileSync(new URL("../../../data/livingworld/shadows.yaml", import.meta.url), "utf8"),
  ) as unknown;
  const rules = parseShadows(raw) as ShadowRules;

  it("is carried by the living world's data", () => {
    expect(parseLivingWorldData({}, {}, undefined, undefined, undefined, raw).shadows).toEqual(
      rules,
    );
    expect(parseLivingWorldData({}, {}).shadows).toBeUndefined();
  });

  it("casts for every object with height and for nothing flat (owner, 2026-11-25)", () => {
    const cast = (id: string, kind = "decoration"): string =>
      shadowOf(rules, fixed(id, kind))?.cast ?? "none";
    for (const id of [
      "oak_tree",
      "pine_tree",
      "bush",
      "thick_bush",
      "boulder",
      "mooring_post",
      "lamp_post",
      "puerto_temple_sign",
      "barrel",
      "cargo_crate",
      "weathered_crate",
      "table",
      "well",
      "fountain",
      "market_stall",
    ])
      expect(cast(id), id).toBe("silhouette");
    for (const id of ["stone_wall", "wooden_wall", "rampart_wall"])
      expect(cast(id, "wall"), id).toBe("block");
    expect(cast("morvund_gate"), "a gate joins the walls' shadow").toBe("block");
    expect(shadowOf(rules, fixed("remains_fur", "container"))?.length).toBeLessThan(1);
    for (const id of [
      "border_grass_n",
      "stairs_down",
      "hole",
      "pressure_plate",
      "grass_tuft",
      "wildflowers",
      "rock_rubble",
      "cut_bush",
      "wall_torch",
      "wall_banner",
      "spider_web",
    ])
      expect(cast(id), id).toBe("none");
  });
});
