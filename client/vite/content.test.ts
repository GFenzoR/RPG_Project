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
  loadMovement,
  loadClientContent,
  loadForge,
  loadPortals,
  loadSiteContent,
} from "./content.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

describe("client content (T0.5)", () => {
  const content = loadClientContent(REPO);

  it("ships each ground's surface and the living world's data (livingworld/README.md)", () => {
    const byId = Object.fromEntries(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId["sand"]?.surface).toBe("sand");
    expect(byId["dock_planks"]?.surface).toBe("wood");
    expect(byId["bush"]?.surface).toBeUndefined();
    // Every ground walkers stand on says what it is made of.
    for (const d of Object.values(content.items))
      if (d.ground && d.walkable) expect(d.surface, d.id).toBeDefined();
    const lw = content.livingWorld;
    expect(lw?.surfaces.sand?.footprintMs).toBeGreaterThan(0);
    expect(lw?.surfaces.sand?.wind).toBeGreaterThan(0);
    expect(lw?.plants["tall_grass"]).toMatchObject({
      reaction: "bend",
      leaves: false,
      trample: true,
      wind: { kind: "tall_grass" },
    });
    expect(lw?.plants["oak_tree"]?.reaction).toBe("rustle");
    // The wind (data/livingworld/wind.yaml and the sprites' metadata of make spritegen):
    // every tree knows where its trunk ends, and what is left of a cut bush never sways.
    expect(lw?.wind?.field.speed).toBeGreaterThan(0);
    expect(lw?.plants["oak_tree"]?.wind).toMatchObject({ kind: "tree", pivotPx: 28 });
    expect(lw?.plants["bush"]?.wind?.amplitude).toBeLessThan(
      lw?.plants["oak_tree"]?.wind?.amplitude ?? 0,
    );
    expect(lw?.plants["cut_bush"]).toBeUndefined();
    for (const [id, rule] of Object.entries(lw?.plants ?? {})) expect(rule.wind, id).toBeDefined();
    // Day and night (data/livingworld/daynight.yaml): the owner's 180 + 60 minutes.
    expect(lw?.dayNight?.dayMs).toBe(180 * 60_000);
    expect(lw?.dayNight?.nightMs).toBe(60 * 60_000);
    expect(lw?.dayNight?.floor).toBeGreaterThanOrEqual(0.4);
  });

  it("ships the positional ambience: beds and emitters on ambient sounds (livingworld/README.md)", () => {
    const a = content.livingWorld?.ambience;
    expect(a).toBeDefined();
    const beds = Object.fromEntries((a?.beds ?? []).map((b) => [b.id, b]));
    // The owner's list (2026-11-23): waves by the sea, wind in the sand, the forest, caves.
    expect(beds["waves"]?.surfaces.water_shallow).toBe(1);
    expect(beds["desert_wind"]?.surfaces.sand).toBeGreaterThan(0);
    expect(beds["forest"]?.items["oak_tree"]).toBeGreaterThan(0);
    expect(beds["cave"]?.floors).toBe("underground");
    expect(a?.emitters["fountain"]).toBeDefined();
    expect(a?.emitters["cooking_hearth"]).toBeDefined();
    const ids = new Set(Object.values(content.items).map((d) => d.id));
    for (const s of [
      ...(a?.beds ?? []).map((b) => b.sound),
      ...Object.values(a?.emitters ?? {}).map((e) => e.sound),
    ])
      expect(content.sounds.sounds[s]?.channel, s).toBe("ambient");
    for (const id of Object.keys(a?.emitters ?? {})) expect(ids.has(id), id).toBe(true);
    // The island bed is gone: the sea is heard where the sea is.
    expect(Object.keys(content.sounds)).not.toContain("ambient");
  });

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

  it("reads the movement constants, a diagonal at √2 like the server when one is missing", () => {
    expect(loadMovement({ movement: { base_step_ms: 800, diagonal_cost: 1.5 } })).toEqual({
      baseStepMs: 800,
      diagonalCost: 1.5,
      maxPathTiles: 100,
    });
    // server/internal/world DefaultDiagonalCost.
    expect(loadMovement({})).toEqual({ baseStepMs: 1000, diagonalCost: 1.414, maxPathTiles: 100 });
    expect(content.movement.diagonalCost).toBe(1.414); // data/balance.yaml
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

  it("exposes each NPC's sprite like the monsters', and the look choices (docs/06 Looks)", () => {
    expect(content.npcSprites?.["volcan_forge_echo"]).toBe("npcs/forge_echo");
    expect(content.monsterSprites["bilge_rat"]).toMatch(/\//);
    // A person is an engine humanoid: its look comes from the server (Creature.look); its
    // sprite is the still portrait the dialog shows (spritegen draws it from the look).
    expect(content.npcSprites?.["bosque_ferryman"]).toBe("npcs/bosque_ferryman");
    expect(content.monsterSprites["wreck_looter"]).toBeUndefined();
    // A player's choices, in file order, without the creatures-only skins.
    const opts = content.lookOptions;
    expect(opts?.sexes).toEqual(["male", "female"]);
    expect(opts?.builds).toEqual(["sturdy", "slender"]);
    expect(opts?.skins).toContain("fair");
    expect(opts?.skins).not.toContain("drowned");
    expect(opts?.skins).not.toContain("ashen");
    expect(opts?.hairStyles[0]).toBe("bald");
    expect(opts?.beards).toEqual(["none", "short", "full"]);
    expect(opts?.hairColors).toContain("auburn");
    // Every choice has its name in every language (the pickers, ui/LookPickers.tsx).
    const parts: [string, readonly string[]][] = [
      ["sex", opts?.sexes ?? []],
      ["body", opts?.builds ?? []],
      ["skin", opts?.skins ?? []],
      ["hair", opts?.hairStyles ?? []],
      ["hair_color", opts?.hairColors ?? []],
      ["beard", opts?.beards ?? []],
    ];
    for (const lang of ["es", "en"])
      for (const [part, ids] of parts)
        for (const id of ids)
          expect(
            content.i18n[lang]?.[`appearance.${part}.${id}`],
            `${lang} ${part} ${id}`,
          ).toBeTruthy();
    // The colours of data/looks.yaml as numbers, and what a head piece hides.
    expect(content.looks?.skins["fair"]).toBe(0xecc4a2);
    expect(content.looks?.tints["iron"]).toBe(0xa8aeb6);
    expect(content.looks?.hides?.["full_helm"]).toEqual(["hair", "beard"]);
    // A piece of the catalog that shows on the figure says how; jewellery does not.
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("iron_sword")?.worn).toEqual({ shape: "sword", tint: "iron" });
    expect(byId.get("tidestone_ring")?.worn).toBeUndefined();
  });

  it("ships item descriptions: the usual item.<id>.desc and a sign's text (T5.5)", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("cooled_lava")?.desc).toBe("item.cooled_lava.desc");
    expect(byId.get("brasal_dock_sign")?.desc).toBe("text.volcan.dock_sign");
    expect(byId.get("ash")?.desc).toBeUndefined();
    // Every sign of Puerto, Bosque and Karvask has its item (the forge gate's too).
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
      expect(texts["item.border_ash_n.name"]).toBe(texts["item.border_ash.name"]);
      expect(texts["item.brasal_dock_sign.name"]).toBeTruthy();
    }
    expect(content.i18n["es"]?.["item.brasal_dock_sign.name"]).toBe("cartel");
  });

  it('marks the border pieces of data/borders.yaml, and only those (docs/06 "Bordes")', () => {
    const marked = Object.values(content.items)
      .filter((d) => d.border)
      .map((d) => d.id);
    // Ten sets of twelve: nine fringes and the surf.
    expect(marked).toHaveLength(120);
    for (const id of ["border_grass_n", "border_ash_inner_se", "border_surf_w"])
      expect(marked).toContain(id);
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    for (const id of ["grass", "water_shallow", "signpost"])
      expect(byId.get(id)?.border).toBeUndefined();
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

  it("marks what each item is in the living world (data/livingworld), and only those", () => {
    const byId = new Map(Object.values(content.items).map((d) => [d.id, d]));
    expect(byId.get("weathered_crate")?.living).toBe("breakable");
    expect(byId.get("weathered_crate")?.livingEffect).toBe("wood");
    expect(byId.get("weathered_crate_debris")?.living).toBe("debris");
    expect(byId.get("mossy_boulder")?.living).toBe("pushable");
    expect(byId.get("portcullis_open")?.living).toBe("gate");
    expect(byId.get("pressure_plate")?.living).toBe("plate");
    for (const id of ["barrel", "cargo_crate", "boulder", "grass"])
      expect(byId.get(id)?.living, id).toBeUndefined();
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
    // The temple walls of Thimblewick (kind: wall, no blocks_movement).
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
    expect(content.outfits).toContainEqual({
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
        feet: { shape: "shoes", tint: "dark_leather" },
      },
    });
    expect(content.outfits?.find((o) => o.id === "sailor")?.costume).toBe(true);
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
      weight: 1100,
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
