import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "@rpg/map-format";
import {
  GAME_SITE_KEYS,
  dialogTopics,
  loadAttributes,
  loadClientContent,
  loadForge,
  loadPortals,
  loadSiteContent,
} from "./content.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

describe("client content (T0.5)", () => {
  const content = loadClientContent(REPO);

  it("ships the item attributes and their card lines in both languages (docs/02)", () => {
    const attrs = content.attributes ?? {};
    expect(attrs["max_health"]?.text).toBe("attribute.max_health");
    // The caps go along (a refined jewel's card stops at its attribute's).
    expect(attrs["max_health"]?.cap).toBeUndefined();
    expect(attrs["life_leech"]?.cap).toBe(15);
    expect(Object.keys(attrs).length).toBeGreaterThan(10);
    for (const lang of ["es", "en"])
      for (const a of Object.values(attrs))
        expect(content.i18n[lang]?.[a.text]).toContain("{value}");
  });

  it('ships the forge\'s rules with numeric item ids, and its texts (docs/02 "Forja")', () => {
    const f = content.forge;
    const ids = Object.fromEntries(
      Object.entries(content.items).map(([n, d]) => [d.id, Number(n)]),
    );
    expect(f?.station).toBe(ids["anvil"]);
    expect(f?.protection).toBe(ids["warding_amber"]);
    expect(f?.levels.map((l) => l.chance)).toEqual([100, 100, 100, 100, 70, 55, 40, 25, 15, 8]);
    expect(f?.safeLevel).toBe(4);
    // The bonus's skill is data (balance.yaml forge.smithing_bonus.skill), not code.
    expect(f?.smithingBonus).toEqual({ skill: "smithing", perLevels: 6, max: 5 });
    expect(f?.bands[0]).toMatchObject({ level: 1, stone: ids["lesser_temper_stone"] });
    expect(f?.bands.at(-1)).toMatchObject({ level: 75, stone: ids["radiant_temper_stone"] });
    for (const lang of ["es", "en"]) {
      expect(content.i18n[lang]?.["client.item.refined"]).toContain("{level}");
      expect(content.i18n[lang]?.["refine.broken"]).toContain("{item}");
    }
    expect(loadForge({ forge: { enabled: false } }, ids)).toBeUndefined();
    expect(loadForge({ forge: { enabled: true, station: "nowhere" } }, ids)).toBeUndefined();
  });

  it("reads no attributes without the file and fails on a broken one", () => {
    const root = mkdtempSync(join(tmpdir(), "client-attributes-"));
    try {
      expect(loadAttributes(root)).toEqual({});
      mkdirSync(join(root, "data"));
      writeFileSync(
        join(root, "data", "attributes.yaml"),
        "- { id: armor, text: attribute.armor }\n",
      );
      expect(loadAttributes(root)).toEqual({ armor: { text: "attribute.armor" } });
      writeFileSync(join(root, "data", "attributes.yaml"), "- { id: armor, text: [\n");
      expect(() => loadAttributes(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes each NPC's sprite like the monsters'", () => {
    expect(content.npcSprites?.["bosque_ferryman"]).toBe("npcs/ferryman");
    expect(content.monsterSprites["bilge_rat"]).toMatch(/\//);
  });

  it("ships item descriptions: the usual item.<id>.desc and a sign's text (T5.5)", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("cooled_lava")?.desc).toBe("item.cooled_lava.desc");
    expect(byId.get("brasal_dock_sign")?.desc).toBe("text.volcan.dock_sign");
    expect(byId.get("ash")?.desc).toBeUndefined();
    // Every sign of Puerto, Bosque and the Ember Isle has its item (the forge gate's too).
    const signs = [
      "volcan.temple",
      "volcan.dock",
      "volcan.mine",
      "volcan.gate",
      "puerto.temple",
      "puerto.harbour",
      "puerto.mine",
      "bosque.temple",
      "bosque.dock",
      "bosque.cave",
    ];
    expect(byId.get("puerto_harbour_sign")?.desc).toBe("text.puerto.harbour_sign");
    expect(byId.get("volcan_gate_sign")?.desc).toBe("text.volcan.gate_sign");
    for (const lang of ["es", "en"]) {
      const texts = content.i18n[lang] ?? {};
      expect(texts["item.cooled_lava.desc"]).toBeTruthy();
      for (const sign of signs) expect(texts[`text.${sign}_sign`]).toBeTruthy();
      // Only the descriptions items use: other world.yaml texts stay out of the game (the
      // test island's temple sign has no item).
      expect(texts["text.testisle.temple_sign"]).toBeUndefined();
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

  it("marks the items that show a portal (their portal block), and only those", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    for (const id of [
      "stairs_down",
      "stairs_up",
      "ladder_up",
      "ladder_down",
      "hole",
      "rope_spot",
      "teleport",
    ])
      expect(byId.get(id)?.portal, id).toBe(true);
    expect(byId.get("grass")?.portal).toBeUndefined();
    expect(byId.get("backpack")?.portal).toBeUndefined();
  });

  it("ships the portals of world/ by their entrance tile, with their kind", () => {
    expect(content.portals?.["3692,5796,7"]).toBe("stairs");
    expect(content.portals?.["3692,5796,8"]).toBe("stairs");
    expect(content.portals?.["3692,5797,8"]).toBeUndefined(); // a destination
  });

  it("reads the portals of the islands world.yaml lists and fails on a broken file", () => {
    const root = mkdtempSync(join(tmpdir(), "client-portals-"));
    try {
      const island = (id: string, portals: string): void => {
        mkdirSync(join(root, "world", "islands", id), { recursive: true });
        writeFileSync(join(root, "world", "islands", id, "portals.yaml"), portals);
      };
      mkdirSync(join(root, "world"));
      writeFileSync(
        join(root, "world", "world.yaml"),
        [
          "format: 1",
          "islands:",
          "  - { id: a, rect: { x: 0, y: 0, w: 32, h: 32 } }",
          "  - { id: b, rect: { x: 32, y: 0, w: 32, h: 32 } }",
          "",
        ].join("\n"),
      );
      island(
        "a",
        "- { id: a_down, kind: stairs, from: { x: 1, y: 2, z: 7 }, to: { x: 1, y: 3, z: 8 } }",
      );
      mkdirSync(join(root, "world", "islands", "b"), { recursive: true }); // no portals.yaml
      // An island directory world.yaml does not list (an old one): mapcompile skips it too.
      island(
        "old",
        "- { id: gate, kind: teleport, from: { x: 5, y: 5, z: 7 }, to: { x: 6, y: 6, z: 7 } }",
      );
      expect(loadPortals(root)).toEqual({ "1,2,7": "stairs" });
      island("b", "- { id: b_down, kind: stairs, from: { x: 33, y: 2, z: 7 }");
      expect(() => loadPortals(root)).toThrow(/islands[\\/]b[\\/]portals\.yaml/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The client walks by click around what it thinks blocks: it must agree with the map
  // tools (and so with mapcompile, which `make test-parity` compares with map-format) on
  // every item. A wall blocks by default (kind: wall without blocks_movement).
  it("blocks and walks on every item like packages/map-format (playtest M1)", () => {
    const map = loadContent(REPO);
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.size).toBeGreaterThan(0);
    for (const [id, info] of map.items) {
      const def = byId.get(id);
      if (!def) continue; // an item without a numeric ID (make validate reports it)
      expect(def.blocks, `${id} blocks`).toBe(info.blocksMovement);
      if (def.ground) expect(def.walkable, `${id} walkable`).toBe(info.walkable === true);
    }
    // The temple walls of the Isla de Pruebas (kind: wall, no blocks_movement).
    expect(byId.get("stone_wall")?.blocks).toBe(true);
    expect(byId.get("wooden_wall")?.blocks).toBe(true);
  });

  it("marks the map doors, open or shut, and only those (playtest m5)", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("pruebas_gate")?.door).toBe(true);
    expect(byId.get("pruebas_gate_open")?.door).toBe(true);
    expect(byId.get("stone_wall")?.door).toBeUndefined();
    expect(byId.get("backpack")?.door).toBeUndefined();
  });

  it('ships the books with their texts in both languages, and marks the chests (docs/02 "Libros y cofres")', () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    const book = byId.get("book_lantern_rowers")?.book;
    expect(book?.title).toBe("book.book_lantern_rowers.title");
    expect(book?.pages.length).toBeGreaterThan(1);
    for (const def of Object.values(content.items))
      for (const key of def.book ? [def.book.title, ...def.book.pages] : [])
        for (const lang of ["es", "en"])
          expect(content.i18n[lang]?.[key], `${lang} ${key}`).toBeTruthy();
    expect(byId.get("chest_puerto_mine")?.chest).toBe(true);
    expect(byId.get("chest_puerto_mine")?.book).toBeUndefined();
    expect(byId.get("cargo_crate")?.chest).toBeUndefined();
  });

  it("carries the elevation of the items that raise what is on them (docs/17 ART-8)", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("cargo_crate")?.elevation).toBe(8);
    expect(byId.get("anvil")?.elevation).toBeUndefined();
  });

  it("carries the credits' sentences of site.yaml for the desktop app (docs/17 A1)", () => {
    for (const lang of ["es", "en"]) {
      const texts = content.i18n[lang] ?? {};
      expect(texts["site.credits.title"]).toBeTruthy();
      expect(texts["site.credits.licence"]).toBeTruthy();
      expect(
        Object.keys(texts).filter((k) => k.startsWith("site.") && !GAME_SITE_KEYS.test(k)),
      ).toEqual([]);
    }
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

describe("client content (docs/17 UI-6, UI-8)", () => {
  const content = loadClientContent(REPO);
  const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));

  it("ships what the item card shows: kind, weight, stats and requirements", () => {
    expect(byId.get("iron_sword")).toMatchObject({
      kind: "weapon",
      weight: 3150,
      weapon: { type: "sword", attack: 13, defense: 7, hands: 1, range: 0, element: "", ammo: "" },
      requires: { level: 5, vocations: [] },
    });
    expect(byId.get("coral_wand")?.weapon).toMatchObject({ range: 4, element: "ice" });
    expect(byId.get("coral_wand")?.requires?.vocations).toEqual(["arcanist"]);
    expect(byId.get("short_bow")?.weapon).toMatchObject({ hands: 2, ammo: "arrow" });
    expect(byId.get("patched_tunic")?.armor).toEqual({ slot: "body", armor: 2 });
    expect(byId.get("plank_shield")?.shield).toEqual({ defense: 12 });
    expect(byId.get("raw_fish")?.consumable).toEqual({ healHp: 0, healMp: 0, foodMs: 60000 });
    // Fields an item does not have stay out of the bundle.
    expect(byId.get("raw_fish")?.weapon).toBeUndefined();
    expect(byId.get("grass")?.weight).toBeUndefined();
  });

  it("marks the map fixtures nobody carries (pickupable: false)", () => {
    const fixed = Object.values(content.items).filter((d) => d.fixed);
    expect(fixed.length).toBeGreaterThan(0);
    expect(byId.get("backpack")?.fixed).toBeUndefined();
    // The market board says so: the cursor offers its use (docs/17 MOV-7).
    expect(byId.get("market_board")?.board).toBe(true);
    expect(byId.get("oak_tree")?.board).toBeUndefined();
  });

  it("marks the quest items (quest: true), and only those (docs/17 UI-6)", () => {
    for (const id of ["smuggler_tally", "sealed_coffer", "delver_chart", "forge_seal"])
      expect(byId.get(id)?.quest, id).toBe(true);
    expect(byId.get("iron_ore")?.quest).toBeUndefined();
    expect(byId.get("iron_sword")?.quest).toBeUndefined();
  });

  it("files every dialog option under one topic per NPC, with no conflicts", () => {
    const { topics, conflicts } = dialogTopics(REPO);
    expect(conflicts).toEqual([]);
    expect(content.dialogTopics).toEqual(topics);
    // Trade, blessings (one step ahead), healing, travel and a quest, by what they do.
    expect(topics["puerto_armorer"]?.["dialog.trade"]).toBe("trade");
    expect(topics["puerto_priest"]?.["npc.puerto_priest.opt_blessings"]).toBe("services");
    expect(topics["puerto_priest"]?.["npc.puerto_priest.opt_heal"]).toBe("services");
    expect(topics["puerto_priest"]?.["npc.puerto_priest.opt_faith"]).toBe("talk");
    expect(topics["harbor_master"]?.["dialog.ask_travel"]).toBe("travel");
    expect(topics["harbor_master"]?.["npc.harbor_master.to_forest"]).toBe("travel");
    expect(topics["pruebas_ferryman"]?.["npc.pruebas_ferryman.to_harbour"]).toBe("travel");
    expect(topics["bosque_ferryman"]?.["npc.bosque_ferryman.opt_ch2_boat"]).toBe("quests");
    expect(topics["puerto_priest"]?.["dialog.back"]).toBe("back");
    expect(topics["puerto_priest"]?.["dialog.bye"]).toBe("bye");
  });

  it("an option's tag wins, and the same text with two topics in one NPC is a conflict", () => {
    const root = mkdtempSync(join(tmpdir(), "client-topics-"));
    try {
      mkdirSync(join(root, "data", "npcs"), { recursive: true });
      writeFileSync(
        join(root, "data", "npcs", "a.yaml"),
        [
          "id: a",
          "dialog:",
          "  start: greet",
          "  nodes:",
          "    greet:",
          "      text: t",
          "      options:",
          "        - { text: x.heal, action: { heal: true }, tag: talk }",
          "        - { text: x.same, action: { heal: true } }",
          "        - { text: x.same, action: { open_shop: s } }",
          "        - { text: x.camp, goto: camp }",
          "    camp:",
          "      text: t",
          "      options:",
          "        - { text: x.go, action: { start_quest: q } }",
          "",
        ].join("\n"),
      );
      const { topics, conflicts } = dialogTopics(root);
      expect(topics["a"]?.["x.heal"]).toBe("talk");
      expect(topics["a"]?.["x.camp"]).toBe("quests");
      expect(conflicts).toEqual(["a: x.same (services, trade)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
