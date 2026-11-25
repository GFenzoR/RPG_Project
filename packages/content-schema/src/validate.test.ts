import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDiagnostic, SchemaSet, validateContent } from "./index.ts";
import type { SchemaName } from "./index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

// Many of these validate the whole content several times (about half a second each on a
// dev machine, more than twice that on a slow CI runner): over 5 s for the longest ones.
vi.setConfig({ testTimeout: 30_000 });

function messages(root: string): string[] {
  const out = validateContent(root).diagnostics.map(formatDiagnostic);
  if (process.env["DEBUG_CONTENT"]) console.log(out.join("\n"));
  return out;
}

describe("repository content", () => {
  it("validates data/ and i18n/ with no errors or warnings", () => {
    const report = validateContent(REPO);
    expect(report.diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it("names every weapon type a milestone may ask for in the client's languages", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO, "packages/content-schema/schemas/quest.schema.json"), "utf8"),
    ) as unknown;
    const found: string[][] = [];
    JSON.stringify(schema, (k, v: unknown) => {
      if (k === "weapon" && v !== null && typeof v === "object" && "enum" in v)
        found.push((v as { enum: string[] }).enum);
      return v;
    });
    const items = readFileSync(
      join(REPO, "packages/content-schema/schemas/items.schema.json"),
      "utf8",
    );
    expect(found).toHaveLength(1);
    for (const w of found[0] ?? []) {
      expect(items).toContain(`"${w}"`);
      for (const lang of ["es", "en"])
        expect(readFileSync(join(REPO, `i18n/${lang}/client.yaml`), "utf8")).toContain(
          `client.quests.weapon.${w}:`,
        );
    }
  });

  it("compiles every schema", () => {
    const set = new SchemaSet();
    const names: SchemaName[] = [
      "attributes",
      "balance",
      "vocations",
      "items",
      "monster",
      "npc",
      "quest",
      "spells",
      "recipes",
      "boat_routes",
      "tutorial",
      "news",
      "borders",
      "outfits",
      "cosmetics",
      "sounds",
      "livingworld-objects",
      "livingworld-ambience",
      "livingworld-plants",
      "livingworld-wind",
      "livingworld-wind_sprites",
      "i18n",
      "ids-lock",
    ];
    for (const name of names) expect(() => set.validate(name, {})).not.toThrow();
  });
});

describe("validator diagnostics", () => {
  let root: string;
  const file = (rel: string): string => join(root, rel);
  const edit = (rel: string, from: string, to: string): void => {
    const text = readFileSync(file(rel), "utf8");
    expect(text).toContain(from);
    writeFileSync(file(rel), text.replace(from, to));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "content-"));
    cpSync(join(REPO, "data"), join(root, "data"), { recursive: true });
    cpSync(join(REPO, "i18n"), join(root, "i18n"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The real world's islands, zones and portals (and the files in extra) next to the
  // copied content.
  const realWorld = (...extra: string[]): void => {
    cpSync(join(REPO, "world", "world.yaml"), file("world/world.yaml"));
    for (const island of readdirSync(join(REPO, "world", "islands"))) {
      mkdirSync(file(`world/islands/${island}`), { recursive: true });
      for (const f of ["island.yaml", "zones.yaml", "portals.yaml", ...extra]) {
        const src = join(REPO, "world", "islands", island, f);
        if (existsSync(src)) cpSync(src, file(`world/islands/${island}/${f}`));
      }
    }
  };
  it('checks each vocation\'s start_kit (docs/02 "Equipo inicial")', () => {
    const kitErrors = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("vocations.yaml"));
    expect(kitErrors()).toEqual([]);
    // The guardian's kit: another vocation's wand, a level 5 sword, a count on a weapon,
    // more arrows than a stack, a two-handed weapon with the shield and an unknown item.
    edit(
      "data/vocations.yaml",
      "    - { item: rusty_cutlass }\n",
      "    - { item: rusty_cutlass, count: 2 }\n    - { item: spark_wand }\n    - { item: iron_sword }\n" +
        "    - { item: arrow, count: 500 }\n    - { item: no_such_item }\n",
    );
    const errs = kitErrors();
    expect(errs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/rusty_cutlass does not stack/),
        expect.stringMatching(/spark_wand is for arcanist, not guardian/),
        expect.stringMatching(/guardian does not wield wand/),
        expect.stringMatching(/iron_sword asks for level 5/),
        expect.stringMatching(/500 arrow is more than its stack \(100\)/),
        expect.stringMatching(/unknown item "no_such_item"/),
      ]),
    );
    // The ranger's two-handed bow with a shield.
    edit(
      "data/vocations.yaml",
      "    - { item: short_bow }\n",
      "    - { item: short_bow }\n    - { item: barrel_lid_shield }\n",
    );
    expect(kitErrors()).toEqual(
      expect.arrayContaining([expect.stringMatching(/two-handed weapon and a shield/)]),
    );
    // A second weapon is carried, not worn: a warning.
    expect(
      messages(root).filter((m) => m.startsWith("warning") && m.includes("vocations.yaml")),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/spark_wand is a second piece for the weapon slot/),
      ]),
    );
    expect(kitErrors().join("\n")).not.toMatch(/do not fit the starting backpack/);
    // The schema: an unknown field and a count of 0.
    edit("data/vocations.yaml", "{ item: sapling_staff }", "{ item: sapling_staff, slot: 3 }");
    edit(
      "data/vocations.yaml",
      "{ item: seaweed_poultice, count: 1 }",
      "{ item: seaweed_poultice, count: 0 }",
    );
    expect(kitErrors().join("\n")).toMatch(/slot/);
    expect(kitErrors().join("\n")).toMatch(/count/);
  });

  it("refuses a start_kit with more carried piles than the backpack and pockets hold", () => {
    const fit = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("do not fit"));
    // A starting backpack of one cell: with the four pockets, five cells. Every kit
    // carries two piles (biscuits and a poultice), so they still fit.
    edit("data/items/tools.yaml", "container: { slots: 24 }", "container: { slots: 1 }");
    expect(fit()).toEqual([]);
    // Four spare wands for the arcanist: six piles. The biscuits named twice are one pile.
    edit(
      "data/vocations.yaml",
      "    - { item: spark_wand }\n",
      "    - { item: spark_wand }\n" +
        "    - { item: spark_wand }\n".repeat(4) +
        "    - { item: ship_biscuit, count: 2 }\n",
    );
    const errs = fit();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(
      /6 carried piles do not fit the starting backpack and the pockets \(5 cells\)/,
    );
  });

  it("refuses a start_kit heavier than a level 1 of the vocation carries", () => {
    const heavy = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("the kit weighs"));
    expect(heavy()).toEqual([]);
    // The druid carries 41 kg; at 5 kg it cannot hold its own kit and backpack.
    edit(
      "data/vocations.yaml",
      "start: { health: 140, mana: 75, capacity: 41000, speed: 205 }\n  per_level: { health: 6, mana: 27,",
      "start: { health: 140, mana: 75, capacity: 5000, speed: 205 }\n  per_level: { health: 6, mana: 27,",
    );
    const errs = heavy();
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/more than the 5000 g a level 1 druid carries/);
  });

  const reachErrors = (): string[] =>
    messages(root).filter((m) => m.startsWith("error") && m.includes("reach"));
  // The reach step of ch3_gate, on the volcano's mine floor.
  const gateReach = "complete_when: { reach: { x: 3692, y: 5826, z: 8, radius: 4 } }";
  // The reach tests validate the whole content up to six times each: one test with all of
  // them (nine) ran past its 30 s with the whole suite running.

  it('checks a reach point against the islands and their stairs (docs/06 "Quest")', () => {
    realWorld();
    expect(reachErrors()).toEqual([]);
    // A floor the island does not list, then outside every island.
    edit("data/quests/ch3_gate.yaml", gateReach, gateReach.replace("z: 8", "z: 9"));
    expect(reachErrors()).toEqual([
      expect.stringMatching(/reach point 3692,5826,9 is on no island/),
    ]);
    edit("data/quests/ch3_gate.yaml", "x: 3692, y: 5826, z: 9", "x: 10, y: 10, z: 7");
    expect(reachErrors()).toEqual([expect.stringMatching(/reach point 10,10,7 is on no island/)]);
    // A place whose every tile is the entrance of stairs (the volcano mine's, portals.yaml):
    // a step onto them lands below, nobody stands there. With a tile around, it is fine.
    edit(
      "data/quests/ch3_gate.yaml",
      "{ x: 10, y: 10, z: 7, radius: 4 }",
      "{ x: 3692, y: 5796, z: 7 }",
    );
    expect(reachErrors()).toEqual([
      expect.stringMatching(
        /every tile of reach point 3692,5796,7 radius 0 is the entrance of stairs/,
      ),
    ]);
    edit("data/quests/ch3_gate.yaml", "z: 7 }", "z: 7, radius: 1 }");
    expect(reachErrors()).toEqual([]);
  });

  it('checks a reach zone: a real one, none of a dev_only island, not all stairs (docs/06 "Quest")', () => {
    realWorld();
    // A zone: a real one, one of the sandbox island only (dev_only) and an unknown one.
    edit(
      "data/quests/ch3_gate.yaml",
      "{ x: 3692, y: 5826, z: 8, radius: 4 }",
      "{ zone: volcan_town }",
    );
    expect(reachErrors()).toEqual([]);
    edit("data/quests/ch3_gate.yaml", "zone: volcan_town", "zone: pruebas_town");
    expect(reachErrors()).toEqual([
      expect.stringMatching(
        /reach zone "pruebas_town" is no zone of an island that is not dev_only/,
      ),
    ]);
    // A zone whose only tile is the entrance of the volcano mine's stairs.
    edit(
      "world/islands/volcan/zones.yaml",
      "- id: volcan_temple",
      "- id: volcan_stairs\n  type: protection\n  floors: [7]\n  rects:\n    - { x: 3692, y: 5796, w: 1, h: 1 }\n\n- id: volcan_temple",
    );
    edit("data/quests/ch3_gate.yaml", "{ zone: pruebas_town }", "{ zone: volcan_stairs }");
    expect(reachErrors()).toEqual([
      expect.stringMatching(/every tile of reach zone "volcan_stairs" is the entrance of stairs/),
    ]);
  });

  it('refuses a reach with a zone and a point, a radius too wide, a repeatable without a cooldown and an unknown quest_state (docs/06 "Quest")', () => {
    realWorld();
    edit(
      "data/quests/ch3_gate.yaml",
      "{ x: 3692, y: 5826, z: 8, radius: 4 }",
      "{ zone: volcan_town, x: 1 }",
    );
    edit(
      "data/quests/ch1_shipwreck.yaml",
      "min_level: 1\n",
      "min_level: 1\nrepeatable: { cooldown_hours: 0 }\n",
    );
    edit(
      "data/quests/pruebas_rats.yaml",
      "complete_when: { kill: { monster: bilge_rat, count: 3 } }",
      "complete_when: { reach: { x: 2060, y: 2060, z: 7, radius: 40 } }",
    );
    const out = messages(root);
    const has = (file: string, s: string): boolean =>
      out.some((m) => m.startsWith("error") && m.includes(file) && m.includes(s));
    expect(has("ch3_gate.yaml", "reach")).toBe(true);
    expect(has("ch1_shipwreck.yaml", "cooldown_hours")).toBe(true);
    expect(has("pruebas_rats.yaml", "radius")).toBe(true);
    // quest_state tells a repeatable quest's turns apart; any other state is refused.
    edit("data/npcs/pruebas_trainer.yaml", "state: cooling_down", "state: resting");
    expect(
      messages(root).some((m) => m.includes("pruebas_trainer.yaml") && m.includes("state")),
    ).toBe(true);
  });

  it('refuses a repeatable quest that pays with no effort (docs/06 "Quests repetibles")', () => {
    const errors = (): string[] =>
      messages(root).filter(
        (m) =>
          m.startsWith("error") &&
          /repeatable quest|own rewards set|talk range/.test(m) &&
          !m.includes("i18n"),
      );
    // The real world, with where its NPCs stand.
    realWorld("npcs.yaml");
    expect(errors()).toEqual([]);
    // A task of the volcano keeper whose first step is a reach two tiles from him: taking
    // it completes it. Four tiles away is a walk.
    const gate = "data/quests/ch3_gate.yaml";
    edit(gate, "min_level: 35\n", "min_level: 35\nrepeatable: { cooldown_hours: 1 }\n");
    edit(
      gate,
      "complete_when: { kill: { monster: obsidian_delver, count: 10 } }",
      "complete_when: { reach: { x: 3664, y: 5798, z: 7 } }",
    );
    expect(errors()).toEqual([
      expect.stringMatching(/reach whose place comes within talk range of npc "volcan_keeper"/),
    ]);
    edit(gate, "x: 3664, y: 5798, z: 7", "x: 3666, y: 5798, z: 7");
    expect(errors()).toEqual([]);
    const rats = "data/quests/pruebas_rats.yaml";
    // Tails shown to the instructor, who takes none of them: the same tails every turn.
    edit(
      rats,
      "complete_when: { kill: { monster: bilge_rat, count: 3 } }",
      "complete_when: { has_item: { item: bilge_rat_tail, count: 3 } }",
    );
    expect(errors()).toEqual([
      expect.stringMatching(/has_item must be followed by its delivery.*take_item of 3/),
    ]);
    // After a flag that may hold already, talking on to the instructor ends the turn.
    edit(
      rats,
      "complete_when: { has_item: { item: bilge_rat_tail, count: 3 } }",
      "complete_when: { flag_equals: { key: rats_cleared, value: 1 } }",
    );
    const talk = /cannot start with a dialog_action of npc "pruebas_trainer"/;
    expect(errors()).toEqual([expect.stringMatching(talk)]);
    // A flag its own rewards set holds from the second turn on.
    edit(
      rats,
      "  - { gold: 50 }",
      "  - { gold: 50 }\n  - { set_flag: { key: rats_cleared, value: 1 } }",
    );
    const out = errors();
    expect(out).toHaveLength(2);
    expect(out).toContainEqual(expect.stringMatching(/flag_equals rats_cleared = 1.*own rewards/));
    expect(out).toContainEqual(expect.stringMatching(talk));
  });

  it("warns of quest_not_started of a repeatable quest", () => {
    const warnings = (): string[] =>
      messages(root).filter((m) => m.startsWith("warning") && m.includes("not_started of"));
    expect(warnings()).toEqual([]);
    edit(
      "data/npcs/pruebas_trainer.yaml",
      "if: { quest_state: { quest: pruebas_rats, state: available } }",
      "if: { quest_not_started: pruebas_rats }",
    );
    expect(warnings()).toEqual([
      expect.stringMatching(/not_started of repeatable quest "pruebas_rats" holds only before/),
    ]);
    edit(
      "data/npcs/pruebas_trainer.yaml",
      "if: { quest_not_started: pruebas_rats }",
      "if: { quest_state: { quest: pruebas_rats, state: not_started } }",
    );
    expect(warnings()).toHaveLength(1);
  });

  it("refuses a quest_state that means nothing", () => {
    const stateErrors = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("quest_state:"));
    expect(stateErrors()).toEqual([]);
    // A step only goes with in_progress: available would ignore it.
    edit(
      "data/npcs/pruebas_trainer.yaml",
      "quest: pruebas_rats, state: available }",
      "quest: pruebas_rats, state: available, step: hunt_rats }",
    );
    expect(stateErrors()).toEqual([
      expect.stringMatching(/a step only goes with state in_progress, not available/),
    ]);
    edit("data/npcs/pruebas_trainer.yaml", ", step: hunt_rats }", " }");
    // cooling_down of a quest that is not repeatable never holds.
    edit(
      "data/npcs/pruebas_trainer.yaml",
      "quest: pruebas_rats, state: cooling_down",
      "quest: ch1_shipwreck, state: cooling_down",
    );
    expect(stateErrors()).toEqual([
      expect.stringMatching(/cooling_down of quest "ch1_shipwreck", which is not repeatable/),
    ]);
  });

  it("checks a monster's corpse: a known container item that stays on its tile", () => {
    const monster = (id: string, corpse: string): void =>
      edit(
        `data/monsters/${id}.yaml`,
        /^corpse: .*$/m.exec(readFileSync(file(`data/monsters/${id}.yaml`), "utf8"))?.[0] ??
          "corpse:",
        `corpse: ${corpse}`,
      );
    monster("wolf", "copper_coin");
    monster("bilge_rat", "backpack");
    monster("tide_crab", "no_such_remains");
    const out = messages(root);
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(
      has("wolf.yaml") && has('item "copper_coin" must be a container with pickupable: false'),
    ).toBe(true);
    expect(has('item "backpack" must be a container with pickupable: false')).toBe(true);
    expect(has('unknown item "no_such_remains"')).toBe(true);
  });

  it("checks the attribute pool: bands, fields of the effect, texts and stacking equipables", () => {
    edit(
      "data/attributes.yaml",
      "    - { level: 1, min: 4, max: 10 }",
      "    - { level: 2, min: 12, max: 10 }",
    );
    edit("data/attributes.yaml", "  effect: max_mana\n", "  effect: max_mana\n  skill: sword\n");
    edit(
      "data/attributes.yaml",
      "    - { level: 25, min: 2, max: 4 }",
      "    - { level: 5, min: 2, max: 4 }",
    );
    edit("data/attributes.yaml", "text: attribute.speed", "text: attribute.nowhere");
    edit("data/attributes.yaml", "- id: ice_protection", "- id: fire_protection");
    edit("data/items/weapons.yaml", "  weight: 1150\n", "  weight: 1150\n  stackable: true\n");
    const out = messages(root);
    expect(out.some((m) => m.includes("the first band is level 1"))).toBe(true);
    expect(out.some((m) => m.includes("min is greater than max"))).toBe(true);
    expect(out.some((m) => m.includes("band levels must grow"))).toBe(true);
    expect(out.some((m) => m.includes('i18n key "attribute.nowhere" is missing'))).toBe(true);
    expect(out.some((m) => m.includes('duplicate id "fire_protection"'))).toBe(true);
    expect(out.some((m) => m.includes("never stacks"))).toBe(true);
    expect(out.some((m) => m.includes("[1].skill: not allowed here"))).toBe(true);
  });

  it('checks the forge: its items, stones that are spent and a protection no NPC sells (docs/02 "Forja")', () => {
    const forgeErrors = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("the forge's"));
    expect(forgeErrors()).toEqual([]);
    // The real world (where each NPC stands): the sandbox merchant sells the amber, but
    // stands only on the sandbox island.
    cpSync(join(REPO, "world", "world.yaml"), file("world/world.yaml"));
    for (const island of readdirSync(join(REPO, "world", "islands"))) {
      const npcs = join(REPO, "world", "islands", island, "npcs.yaml");
      if (!existsSync(npcs)) continue;
      mkdirSync(file(`world/islands/${island}`), { recursive: true });
      cpSync(npcs, file(`world/islands/${island}/npcs.yaml`));
    }
    expect(forgeErrors()).toEqual([]);
    // A smith of a real island selling it.
    const radiant = "    - { item: radiant_temper_stone, price: 600 }\n";
    edit(
      "data/npcs/volcan_smith.yaml",
      radiant,
      `${radiant}    - { item: warding_amber, price: 3000 }\n`,
    );
    expect(forgeErrors()).toEqual([
      expect.stringMatching(
        /volcan_smith\.yaml:.*"warding_amber" is the forge's rare protection: no NPC sells it/,
      ),
    ]);
    // A stone that does not stack, a station people carry, an unknown stone, and a stone
    // nothing gives.
    edit(
      "data/items/forge.yaml",
      "  weight: 300\n  stackable: true\n  max_stack: 100\n",
      "  weight: 300\n",
    );
    edit(
      "data/items/decoration.yaml",
      "  description: item.anvil.desc\n  pickupable: false\n",
      "  description: item.anvil.desc\n",
    );
    edit(
      "data/balance.yaml",
      "stone: radiant_temper_stone, gold: 700",
      "stone: no_such_stone, gold: 700",
    );
    edit("data/npcs/volcan_smith.yaml", radiant, "");
    edit("data/npcs/pruebas_merchant.yaml", radiant, "");
    edit(
      "data/monsters/slagbound_warden.yaml",
      "  - { item: radiant_temper_stone, chance: 0.3 } # the forge\n",
      "",
    );
    const out = messages(root);
    const has = (s: string): boolean => out.some((m) => m.startsWith("error") && m.includes(s));
    expect(has(`the forge's "lesser_temper_stone" must be a stackable material`)).toBe(true);
    expect(has(`the forge's station "anvil" needs pickupable: false`)).toBe(true);
    expect(has(`unknown item "no_such_stone"`)).toBe(true);
    expect(has(`nothing gives the forge's "radiant_temper_stone" in production`)).toBe(true);
  });

  it("checks the living world: surfaces, plants and a schema for each file (livingworld/README.md)", () => {
    edit("data/items/ground.yaml", "surface: sand }", "surface: marble }");
    edit(
      "data/livingworld/surfaces.yaml",
      "  mud: { footprints: 40000,",
      "  mud: { footprints: -1,",
    );
    edit("data/livingworld/surfaces.yaml", "  lava: {}", "  lava: {}\n  marsh: {}");
    appendFileSync(
      file("data/livingworld/plants.yaml"),
      "  - { item: bush, reaction: bend }\n  - { item: no_such_plant, reaction: wiggle }\n",
    );
    writeFileSync(file("data/livingworld/geysers.yaml"), "geysers: []\n");
    const out = messages(root).filter((m) => m.startsWith("error"));
    expect(out.some((m) => m.includes("ground.yaml") && m.includes("surface"))).toBe(true);
    expect(out.some((m) => m.includes("surfaces.yaml") && m.includes("marsh"))).toBe(true);
    expect(out.some((m) => m.includes("surfaces.yaml") && m.includes("footprints"))).toBe(true);
    expect(out.some((m) => m.includes('plant "bush" already listed'))).toBe(true);
    expect(out.some((m) => m.includes('unknown item "no_such_plant"'))).toBe(true);
    expect(out.some((m) => m.includes("plants.yaml") && m.includes("reaction"))).toBe(true);
    expect(out.some((m) => m.includes("geysers.yaml") && m.includes("no schema"))).toBe(true);
  });

  it('lets no plant be added and forgotten: wind metadata or wind: none (livingworld/README.md "Viento")', () => {
    const wind = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && /wind|pivot/.test(m));
    expect(wind()).toEqual([]);
    // A new plant item whose sprite says nothing of the wind.
    const fern =
      "\n- id: jungle_fern\n  kind: decoration\n  sprite: decor/jungle_fern\n  name: item.grass_tuft.name\n  pickupable: false\n";
    appendFileSync(file("data/items/plants.yaml"), fern);
    let out = wind();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("plants.yaml");
    expect(out[0]).toContain('plant "jungle_fern" has no wind metadata');
    expect(out[0]).toContain("make spritegen");
    // Saying none is an answer; so is a type; so is the sprite's own metadata.
    appendFileSync(file("data/livingworld/plants.yaml"), "  - { item: jungle_fern, wind: none }\n");
    expect(wind()).toEqual([]);
    edit(
      "data/livingworld/plants.yaml",
      "{ item: jungle_fern, wind: none }",
      "{ item: jungle_fern, wind: bush }",
    );
    expect(wind()).toEqual([]);
    edit("data/livingworld/plants.yaml", "  - { item: jungle_fern, wind: bush }\n", "");
    appendFileSync(
      file("data/livingworld/wind_sprites.yaml"),
      "  decor/jungle_fern: { kind: bush, pivot: 4, top: 20 }\n",
    );
    expect(wind()).toEqual([]);
    // A plant by its sprite's folder or by a word inside its name, not only by its id.
    edit(
      "data/items/plants.yaml",
      "- id: jungle_fern\n  kind: decoration\n  sprite: decor/jungle_fern",
      "- id: green_thing\n  kind: decoration\n  sprite: flora/plants/green_thing",
    );
    out = wind();
    expect(out.some((m) => m.includes('plant "green_thing" has no wind metadata'))).toBe(true);
    // ...and the metadata of a sprite no item uses is stale.
    expect(
      out.some((m) => m.includes("wind_sprites.yaml") && m.includes("decor/jungle_fern")),
    ).toBe(true);
  });

  it("wants the pivot of a tree, the generated file and a listed plant's wind", () => {
    const wind = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && /wind|pivot/.test(m));
    // A listed plant loses its sprite's metadata: it is still a plant.
    edit("data/livingworld/wind_sprites.yaml", "  decor/bush:", "  # decor/bush:");
    let out = wind();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('plant "bush" has no wind metadata');
    // A tree declared by hand must say where its trunk ends.
    edit(
      "data/livingworld/plants.yaml",
      "{ item: bush, reaction: bend }",
      "{ item: bush, reaction: bend, wind: dead_tree }",
    );
    out = wind();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("a dead_tree needs its pivot");
    edit(
      "data/livingworld/plants.yaml",
      "wind: dead_tree }",
      "wind: { kind: dead_tree, pivot: 5 } }",
    );
    expect(wind()).toEqual([]);
    // Schema: an unknown type, a flutter of a pixel or more, a plant with nothing to say.
    edit(
      "data/livingworld/plants.yaml",
      "{ item: reeds, reaction: bend }",
      "{ item: reeds, wind: kite }",
    );
    edit("data/livingworld/plants.yaml", "{ item: cut_bush, wind: none }", "{ item: cut_bush }");
    edit("data/livingworld/wind.yaml", "flutter: 0.7,", "flutter: 1.0,");
    out = messages(root).filter((m) => m.startsWith("error"));
    expect(out.some((m) => m.includes("plants.yaml") && m.includes("wind"))).toBe(true);
    expect(out.some((m) => m.includes("wind.yaml") && m.includes("flutter"))).toBe(true);
    expect(out.filter((m) => m.includes("plants.yaml")).length).toBeGreaterThanOrEqual(2);
    // Without the generated file every plant sprite is undeclared: say how to make it.
    rmSync(file("data/livingworld/wind_sprites.yaml"));
    out = wind();
    expect(
      out.some((m) => m.includes("wind_sprites.yaml is missing") && m.includes("make spritegen")),
    ).toBe(true);
    expect(out.some((m) => m.includes('plant "oak_tree" has no wind metadata'))).toBe(true);
  });

  it('checks the ambience: ambient sounds, items, radius and caps (livingworld/README.md "Ambiente")', () => {
    mkdirSync(file("assets"), { recursive: true });
    writeFileSync(
      file("assets/sounds.yaml"),
      [
        "format: 1",
        "sounds:",
        "  amb_waves: { file: livingworld/sounds/ambience/waves.ogg, channel: ambient }",
        "  hit: { file: sounds/sfx/hit.ogg, channel: sfx }",
        "",
      ].join("\n"),
    );
    writeFileSync(
      file("data/livingworld/ambience.yaml"),
      [
        "radius: 6",
        "voices: 3",
        "voices_lite: 4",
        "beds:",
        "  waves: { sound: amb_waves, surfaces: { water_shallow: 1 }, items: { no_such_tree: 1 } }",
        "  bad: { sound: hit, floors: sky }",
        "emitters:",
        "  fountain: { sound: amb_nowhere, radius: 9 }",
        "  no_such_well: { sound: amb_waves, radius: 2 }",
        "",
      ].join("\n"),
    );
    const out = messages(root).filter((m) => m.startsWith("error") && m.includes("ambience"));
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has('unknown item "no_such_tree"')).toBe(true);
    expect(has('unknown item "no_such_well"')).toBe(true);
    expect(has('sound "hit" is on channel sfx, not ambient')).toBe(true);
    expect(has('unknown sound "amb_nowhere"')).toBe(true);
    expect(has("radius 9 is past the window's (6)")).toBe(true);
    expect(has("voices_lite 4 > voices 3")).toBe(true);
    expect(has("floors")).toBe(true); // the schema: sky is no floor
    // The real file is clean.
    rmSync(file("data/livingworld/ambience.yaml"));
    cpSync(join(REPO, "data/livingworld/ambience.yaml"), file("data/livingworld/ambience.yaml"));
    cpSync(join(REPO, "assets/sounds.yaml"), file("assets/sounds.yaml"));
    expect(
      messages(root).filter((m) => m.startsWith("error") && m.includes("ambience.yaml")),
    ).toEqual([]);
  });

  it("wants every ground surface described in data/livingworld/surfaces.yaml", () => {
    edit("data/livingworld/surfaces.yaml", "  snow: {", "  # snow: {");
    edit("data/items/ground.yaml", "surface: sand }", "surface: snow }");
    expect(messages(root).some((m) => m.includes('surface "snow" is not described'))).toBe(true);
  });

  it("checks boat routes: references, fields and the boat_routes node flag (T3.5)", () => {
    writeFileSync(
      file("data/boat_routes.yaml"),
      [
        "- id: to_nowhere",
        "  captain: ghost_captain",
        "  text: dialog.bye",
        "  from: { x: 1, y: 1, z: 7 }",
        "  to: { x: 2, y: 2, z: 7 }",
        "  price: 10",
        "  requires: { quest: no_such_quest, item: { item: rope, consume: yes_please } }",
        "  speed: 3",
      ].join("\n") + "\n",
    );
    const out = messages(root);
    expect(out.some((m) => m.includes('unknown npc "ghost_captain"'))).toBe(true);
    expect(out.some((m) => m.includes('unknown quest "no_such_quest"'))).toBe(true);
    expect(out.some((m) => m.includes("consume") && m.includes("boolean"))).toBe(true);
    expect(out.some((m) => m.includes('unknown field "speed"'))).toBe(true);
  });

  it('checks the border ladder: grounds, lower grounds, pieces and the surf (docs/06 "Bordes")', () => {
    writeFileSync(
      file("data/borders.yaml"),
      [
        "ladder:",
        "  - { ground: water_shallow }",
        "  - { ground: water_shoal, pieces: border_sand }",
        "  - { ground: sand, pieces: border_sand, over: [grass, lava] }",
        "  - { ground: dirt, edge: clods }",
        "  - { ground: grass, pieces: border_nothing, edge: tufts }",
        "  - { ground: sand }",
        "  - { ground: ash, pieces: border_ash, edge: zigzag }",
        "shore:",
        "  water: [water_shallow, water_shoal, dirt]",
        "  pieces: border_surf",
      ].join("\n") + "\n",
    );
    const out = messages(root).filter((m) => m.includes("borders.yaml"));
    const has = (text: string): boolean => out.some((m) => m.includes(text));
    expect(has('pieces "border_sand" are already the ones of the fringe of "water_shoal"')).toBe(
      true,
    );
    expect(has('"grass" is not below "sand"')).toBe(true);
    expect(has('"lava" is not on the ladder')).toBe(true);
    expect(has("edge needs pieces")).toBe(true);
    expect(has("none of the 12 pieces border_nothing_n ... border_nothing_inner_sw")).toBe(true);
    expect(out.filter((m) => m.includes("border_nothing"))).toHaveLength(1);
    expect(has('"sand" is already on the ladder')).toBe(true);
    expect(has("ladder[6].edge: must be one of")).toBe(true); // zigzag is no edge style
    expect(has('water "water_shoal" cannot have a fringe')).toBe(true);
    expect(has('"dirt" is not on the ladder')).toBe(false); // it is, as a plain rung
    // A piece that blocks, and one that can be picked up.
    edit(
      "data/items/borders.yaml",
      "  sprite: borders/ash/n\n",
      "  sprite: borders/ash/n\n  blocks_movement: true\n",
    );
    edit(
      "data/items/borders.yaml",
      "  sprite: borders/ash/e\n  name: item.border_ash.name\n  pickupable: false\n",
      "  sprite: borders/ash/e\n  name: item.border_ash.name\n",
    );
    writeFileSync(
      file("data/borders.yaml"),
      "ladder:\n  - { ground: sand }\n  - { ground: ash, pieces: border_ash }\n",
    );
    const again = messages(root).filter((m) => m.includes("borders.yaml"));
    expect(again.filter((m) => m.includes('"border_ash_n" must be a decoration'))).toHaveLength(1);
    expect(again.filter((m) => m.includes('"border_ash_e" must have pickupable'))).toHaveLength(1);
    expect(again).toHaveLength(2);
  });

  it("checks outfits: ids, sprite folder and frame count (T0.5)", () => {
    writeFileSync(
      file("data/outfits.yaml"),
      [
        "- { id: citizen, sprite: outfits/citizen, frames: 3 }",
        "- { id: citizen, sprite: outfits/other, frames: 4 }",
        "- { id: sailor, sprite: Outfits/Sailor, frames: 2, colour: blue }",
      ].join("\n") + "\n",
    );
    const out = messages(root);
    expect(out.some((m) => m.includes('duplicate id "citizen"'))).toBe(true);
    expect(out.some((m) => m.includes("[1].frames: must be <= 3"))).toBe(true);
    expect(out.some((m) => m.includes("[2].sprite: must match"))).toBe(true);
    expect(out.some((m) => m.includes('unknown field "colour"'))).toBe(true);
  });

  it("checks the cosmetic shop: kinds, fields, outfits, tints and texts (T5.7)", () => {
    writeFileSync(
      file("data/cosmetics.yaml"),
      [
        "currency: { id: gems }",
        "limits: { daily_premium: 1000, equip_burst: 5, equip_refill_ms: 500, max_premium_grant: 100000 }",
        "packs:",
        "  - { id: pack_small, amount: 100, price: 1990, currency: CLP }",
        "  - { id: pack_whale, amount: 5000, price: 99990, currency: CLP }",
        "  - { id: pack_small, amount: 0, price: 19.9, currency: clp }",
        "  - { id: pack_unnamed, amount: 10, price: 100, currency: USD }",
        "cosmetics:",
        "  - { id: outfit_sailor, kind: outfit, price: 300, outfit: sailer }",
        "  - { id: outfit_citizen, kind: outfit, price: 10, outfit: citizen }",
        "  - { id: outfit_bare, kind: outfit, price: 10 }",
        "  - { id: color_tide, kind: outfit_color, price: 120, tint: '#7fa8d8', style: gold }",
        "  - { id: color_ember, kind: outfit_color, price: 120, tint: '#7fa8d8' }",
        "  - { id: color_moss, kind: outfit_color, price: 120, tint: 'green' }",
        "  - { id: name_gilded, kind: name_effect, price: 200, style: rainbow }",
        "  - { id: mount_horse, kind: mount, price: 900 }",
        "  - { id: speed_boots, kind: outfit, price: 50, outfit: sailor, speed: 20 }",
      ].join("\n") + "\n",
    );
    const out = messages(root);
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has('currency.id: must be "premium"')).toBe(true);
    expect(has('duplicate id "pack_small"')).toBe(true);
    expect(has("packs[1].amount: amount 5000 is over limits.daily_premium 1000")).toBe(true);
    expect(has("packs[2].amount: must be >= 1")).toBe(true);
    expect(has("packs[2].price: must be integer")).toBe(true);
    expect(has("packs[2].currency: must match")).toBe(true);
    expect(has('i18n key "cosmetic_pack.pack_unnamed.name" is missing')).toBe(true);
    expect(has('unknown outfit "sailer" in data/outfits.yaml (did you mean "sailor"?)')).toBe(true);
    expect(has(`"citizen" is every player's free look`)).toBe(true);
    expect(has('cosmetics[2]: missing required field "outfit"')).toBe(true);
    expect(has('cosmetics[3].style: "style" is only allowed with kind: name_effect')).toBe(true);
    expect(has('tint #7fa8d8 is already sold as "color_tide"')).toBe(true);
    expect(has("cosmetics[5].tint: must match")).toBe(true);
    expect(has("cosmetics[6].style: must be one of")).toBe(true);
    expect(has("cosmetics[7].kind: must be one of")).toBe(true);
    expect(has('cosmetics[8].speed: unknown field "speed"')).toBe(true);
    expect(has('i18n key "cosmetic.outfit_citizen.desc" is missing')).toBe(true);
  });

  it("requires the cosmetic shop limits (T5.7)", () => {
    writeFileSync(
      file("data/cosmetics.yaml"),
      [
        "currency: { id: premium }",
        "limits: { daily_premium: 0, equip_burst: 5, equip_refill_ms: 10 }",
        "packs:",
        "  - { id: pack_small, amount: 100, price: 1990, currency: CLP }",
        "cosmetics:",
        "  - { id: name_gilded, kind: name_effect, price: 200, style: gold }",
      ].join("\n") + "\n",
    );
    const out = messages(root);
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has('limits: missing required field "max_premium_grant"')).toBe(true);
    expect(has("limits.daily_premium: must be >= 1")).toBe(true);
    expect(has("limits.equip_refill_ms: must be >= 50")).toBe(true);
  });

  it("warns about cosmetic texts no cosmetic uses (T5.7)", () => {
    appendFileSync(file("i18n/es/cosmetics.yaml"), 'cosmetic.gone.name: "x"\n');
    appendFileSync(file("i18n/en/cosmetics.yaml"), 'cosmetic.gone.name: "x"\n');
    const out = messages(root);
    expect(out.some((m) => m.startsWith("warning") && m.includes('"cosmetic.gone.name"'))).toBe(
      true,
    );
  });

  it("checks the tutorial: events, refs by event, recipes, islands and rewards (T4.2)", () => {
    mkdirSync(file("world"), { recursive: true });
    writeFileSync(file("world/world.yaml"), "format: 1\nislands:\n  - id: puerto\n");
    writeFileSync(
      file("data/tutorial.yaml"),
      [
        "island: atlantis",
        "steps:",
        "  - { id: a, text: dialog.bye, when: { event: walk, ref: wolf } }",
        "  - { id: b, text: dialog.bye, when: { event: kill, ref: no_such_monster } }",
        "  - { id: c, text: dialog.bye, when: { event: craft, ref: no_such_recipe } }",
        "  - { id: c, text: dialog.bye, when: { event: dance } }",
        "  - { id: e, text: dialog.bye, when: { event: target }, highlight: everything }",
        "rewards:",
        "  - { gold: 5000 }",
      ].join("\n") + "\n",
    );
    const out = messages(root);
    expect(out.some((m) => m.includes('unknown island "atlantis"'))).toBe(true);
    expect(out.some((m) => m.includes("steps[0].when"))).toBe(true);
    expect(out.some((m) => m.includes('unknown monster "no_such_monster"'))).toBe(true);
    expect(out.some((m) => m.includes('unknown recipe "no_such_recipe"'))).toBe(true);
    expect(out.some((m) => m.includes('duplicate id "c"'))).toBe(true);
    expect(out.some((m) => m.includes("steps[3].when.event"))).toBe(true);
    expect(out.some((m) => m.includes("steps[4].highlight"))).toBe(true);
    expect(out.some((m) => m.includes("rewards[0]"))).toBe(true);
  });

  it("checks news posts: file name, date and both languages (T4.3)", () => {
    mkdirSync(file("data/news"), { recursive: true });
    const post = (date: string, en = true): string =>
      [
        `date: "${date}"`,
        "title:",
        "  es: Hola",
        ...(en ? ["  en: Hello"] : []),
        "body:",
        "  es: Texto",
        "  en: Text",
      ].join("\n") + "\n";
    writeFileSync(file("data/news/2026-01-02-ok.yaml"), post("2026-01-02"));
    writeFileSync(file("data/news/2026-01-03-wrong-date.yaml"), post("2026-01-04"));
    writeFileSync(file("data/news/2026-01-05-no-en.yaml"), post("2026-01-05", false));
    writeFileSync(file("data/news/Bad_Name.yaml"), post("2026-01-06"));
    const out = messages(root);
    expect(out.some((m) => m.includes("2026-01-02-ok.yaml"))).toBe(false);
    expect(out.some((m) => m.includes('date "2026-01-04" must match'))).toBe(true);
    expect(out.some((m) => m.includes("2026-01-05-no-en.yaml") && m.includes("title"))).toBe(true);
    expect(out.some((m) => m.includes("Bad_Name.yaml") && m.includes("file names"))).toBe(true);
  });

  it("checks data/livingworld: never walls nor doors, blocking rules, sounds (livingworld/README.md)", () => {
    mkdirSync(file("assets"), { recursive: true });
    writeFileSync(file("assets/sounds.yaml"), "format: 1\nsounds: {}\n");
    writeFileSync(
      file("data/livingworld/objects.yaml"),
      [
        "- item: rock_wall",
        "  breakable: { hp: 5, by: [melee], becomes: none }",
        "- item: weathered_crate",
        "  breakable: { hp: 5, by: [melee], becomes: none }",
        "- item: weathered_crate",
        "  pushable: {}",
        "- item: cracked_rock",
        "  breakable: { hp: 5, by: [kick], becomes: mossy_boulder, sound: nope }",
        "- item: pressure_plate",
        "  breakable: { hp: 1, by: [melee], becomes: none }",
        "  plate: { radius: 3 }",
        "- item: thick_bush",
        "  gate: { open: portcullis_closed }",
        "- item: mossy_boulder",
        "  pushable: { reset_seconds: 0 }",
      ].join("\n") + "\n",
    );
    const out = messages(root).filter((m) => m.includes("livingworld"));
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has('"rock_wall" is a wall')).toBe(true);
    expect(has('item "weathered_crate" already has an entry')).toBe(true);
    expect(has("must be one of")).toBe(true); // by: kick
    expect(has('debris "mossy_boulder" must not block movement')).toBe(true);
    expect(has('sound "nope" is not declared')).toBe(true);
    expect(has('the open gate "portcullis_closed" must not block movement')).toBe(true);
    expect(has("must NOT have more than 2 properties")).toBe(true); // two behaviours
    expect(has("reset_seconds")).toBe(true); // a boulder that never goes home
    expect(validateContent(REPO).diagnostics.filter((d) => d.file.includes("livingworld"))).toEqual(
      [],
    );
  });

  it("checks assets/sounds.yaml: files, credits, references and islands (T3.7)", () => {
    mkdirSync(file("assets/sounds"), { recursive: true });
    mkdirSync(file("world"), { recursive: true });
    writeFileSync(file("world/world.yaml"), "format: 1\nislands:\n  - id: puerto\n");
    writeFileSync(file("assets/sounds/hit.ogg"), "x");
    writeFileSync(file("assets/sounds/song.ogg"), "x");
    writeFileSync(
      file("assets/sounds.yaml"),
      [
        "format: 1",
        "sounds:",
        "  hit: { file: sounds/hit.ogg, channel: sfx }",
        "  gone: { file: sounds/gone.ogg, channel: sfx }",
        "  borrowed: { file: vendor/somepack/x.ogg, channel: ui }",
        "  song: { file: sounds/song.ogg, channel: music, volume: 2 }",
        "events:",
        "  effect.hit: [hit, nope]",
        "  ui.click: song",
        "music:",
        "  pools: { town: [song, hit] }",
        "  islands: { puerto: town, atlantis: town }",
        "  underground: nowhere",
      ].join("\n") + "\n",
    );
    const out = messages(root).filter((m) => m.includes("sounds.yaml"));
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has("assets/sounds/gone.ogg does not exist")).toBe(true);
    expect(has('pack "somepack" has no row in assets/CREDITS.md')).toBe(true);
    expect(has('unknown sound "nope"')).toBe(true);
    expect(has('sound "song" is a music loop, not an event sound')).toBe(true);
    expect(has('sound "hit" is on channel sfx, not music')).toBe(true);
    expect(has('unknown pool "nowhere"')).toBe(true);
    expect(has('unknown island "atlantis"')).toBe(true);
    expect(has("volume")).toBe(true);
  });

  it("checks the music: pools of music, the title's and the bosses' pools, a track's measures and a quest's pool", () => {
    mkdirSync(file("assets/sounds"), { recursive: true });
    for (const f of ["hit", "song", "other", "boss"])
      writeFileSync(file(`assets/sounds/${f}.ogg`), "x");
    const write = (sounds: string[], music: string[]): string[] => {
      writeFileSync(
        file("assets/sounds.yaml"),
        [
          "format: 1",
          "sounds:",
          "  hit: { file: sounds/hit.ogg, channel: sfx }",
          "  boss: { file: sounds/boss.ogg, channel: music }",
          ...sounds,
          "music:",
          ...music,
        ].join("\n") + "\n",
      );
      return messages(root).filter((m) => m.includes("sounds.yaml") || m.includes("quests"));
    };
    const good = [
      "  song: { file: sounds/song.ogg, channel: music, seconds: 180, end: 170, entries: [12, 40.5] }",
      "  other: { file: sounds/other.ogg, channel: music }",
    ];
    expect(
      write(good, [
        "  fades: { zone: 5000, boss_in: 1500, boss_out: 6000, title: 3000, next: 4000 }",
        "  dwell_ms: 3000",
        "  boss_hold_ms: 5000",
        "  resume_ms: 180000",
        "  gap_ms: [6000, 15000]",
        "  pools: { menu: [song, other], forge: [boss] }",
        "  title: menu",
        "  bosses: { slagbound_warden: forge }",
      ]),
    ).toEqual([]);
    const out = write(
      [
        "  song: { file: sounds/song.ogg, channel: music, seconds: 180, end: 190, entries: [0, 40, 30, 200] }",
        "  other: { file: sounds/other.ogg, channel: music, entries: [10] }",
        "  hit2: { file: sounds/hit.ogg, channel: sfx, seconds: 3 }",
      ],
      [
        "  gap_ms: [9000, 1000]",
        "  pools: { menu: [song, hit, nope], forge: [boss] }",
        "  title: song",
        "  combat: forge",
        "  bosses: { no_such_beast: forge, slagbound_warden: lair }",
      ],
    );
    const has = (m: string): boolean => out.some((o) => o.includes(m));
    expect(has('sound "hit" is on channel sfx, not music')).toBe(true);
    expect(has('unknown sound "nope"')).toBe(true);
    expect(has('unknown pool "song"')).toBe(true); // the title names a pool, not a sound
    expect(has('unknown pool "lair"')).toBe(true);
    expect(has('unknown monster "no_such_beast"')).toBe(true);
    expect(has("combat")).toBe(true); // fights have no music any more (the owner, 2026-11-18)
    expect(has("gap_ms is [min, max]")).toBe(true);
    expect(has("end 190 is past the track's 180 s")).toBe(true);
    expect(has("entries")).toBe(true); // 0, then 40 → 30 going down
    expect(out.filter((m) => m.includes("entries go up, after 0"))).toHaveLength(2);
    expect(has("entry 200 is past the body's end")).toBe(true);
    expect(has("a track with end or entries needs its seconds")).toBe(true);
    expect(has("seconds, end and entries are a music track's")).toBe(true);

    // An important quest's music names a pool of sounds.yaml.
    write(good, ["  pools: { forge: [boss] }"]);
    const quest = file("data/quests/ch3_warden.yaml");
    const text = readFileSync(quest, "utf8");
    const withMusic = (pool: string): string[] => {
      writeFileSync(
        quest,
        text +
          `music: { pool: ${pool}, floors: [9], rects: [{ x: 3690, y: 5790, w: 12, h: 10 }] }\n`,
      );
      return messages(root).filter((m) => m.includes("ch3_warden"));
    };
    expect(withMusic("forge")).toEqual([]);
    expect(withMusic("shrine").some((m) => m.includes('unknown pool "shrine"'))).toBe(true);
  });

  it("accepts a third-party sound pack with its CREDITS row and LICENSE, as spritepack does", () => {
    const pack = file("assets/vendor/kenney-impact");
    mkdirSync(join(pack, "Audio"), { recursive: true });
    writeFileSync(join(pack, "Audio", "impactMetal_heavy_000.ogg"), "x");
    writeFileSync(join(pack, "License.txt"), "CC0");
    mkdirSync(file("assets/vendor/nolicence"), { recursive: true });
    writeFileSync(file("assets/vendor/nolicence/x.ogg"), "x");
    // The table form of the template, with no trailing slash after the folder.
    writeFileSync(
      file("assets/CREDITS.md"),
      [
        "| Pack | Autor | Licencia | Fuente | Carpeta | Atribución |",
        "|---|---|---|---|---|---|",
        "| Impact Sounds | Kenney | CC0 | https://example.com | `assets/vendor/kenney-impact` | No |",
        "| Something | Someone | CC0 | https://example.com | `assets/vendor/nolicence` | No |",
        "See also assets/vendor/notatable/ (prose, not a row).",
      ].join("\n") + "\n",
    );
    const write = (sounds: string[]): string[] => {
      writeFileSync(
        file("assets/sounds.yaml"),
        ["format: 1", "sounds:", ...sounds].join("\n") + "\n",
      );
      return messages(root).filter((m) => m.includes("sounds.yaml"));
    };
    expect(
      write([
        "  metal: { file: vendor/kenney-impact/Audio/impactMetal_heavy_000.ogg, channel: sfx }",
      ]),
    ).toEqual([]);
    expect(
      write(['  spaced: { file: "vendor/kenney-impact/Sound Pack 1.2/x y.ogg", channel: sfx }']),
    ).toEqual([expect.stringContaining("does not exist")]);
    const bare = write(["  bare: { file: vendor/nolicence/x.ogg, channel: sfx }"]);
    expect(bare).toEqual([
      expect.stringContaining('pack "nolicence" has no LICENSE or COPYING file'),
    ]);
    const prose = write(["  prose: { file: vendor/notatable/x.ogg, channel: sfx }"]);
    expect(prose.some((m) => m.includes('pack "notatable" has no row'))).toBe(true);
    for (const bad of [
      "vendor/kenney-impact/../x.ogg",
      "vendor/kenney-impact/.hidden.ogg",
      "sounds/../x.ogg",
    ]) {
      const out = write([`  bad: { file: "${bad}", channel: sfx }`]);
      expect(
        out.some((m) => m.includes("file: must match ^")),
        bad,
      ).toBe(true);
    }
  });

  it("checks the i18n keys the server and client code use", () => {
    mkdirSync(file("server/internal/session"), { recursive: true });
    mkdirSync(file("client/src/ui"), { recursive: true });
    writeFileSync(
      file("server/internal/session/x.go"),
      'package session\n\nconst (\n\tmsgOk = "chat.flood"\n\tmsgBad = "chat.nope"\n\tpath = "island.yaml"\n)\n',
    );
    writeFileSync(file("server/internal/session/x_test.go"), 'const k = "chat.ignored_in_tests"\n');
    writeFileSync(
      file("client/src/ui/X.tsx"),
      'const a = t("client.title");\nconst b = { key: "client.chat.missing" };\nconst c = t(`skill.${id}.name`);\nimport "./x.css";\n',
    );
    const out = messages(root).filter((m) => m.startsWith("error"));
    expect(out).toEqual([
      'error server/internal/session/x.go:5 i18n key "chat.nope" is missing in: es, en',
      'error client/src/ui/X.tsx:2 i18n key "client.chat.missing" is missing in: es, en',
    ]);
  });

  it("points at file:line:col and suggests the closest id for unknown references", () => {
    edit("data/monsters/wolf.yaml", "item: wolf_pelt,", "item: wolf_pelts,");
    expect(messages(root)).toContain(
      'error data/monsters/wolf.yaml:18:7 loot[0].item: unknown item "wolf_pelts" (did you mean "wolf_pelt"?)',
    );
  });

  it("reports unknown fields and missing required fields", () => {
    edit("data/monsters/wolf.yaml", "speed: 190\n", "sped: 190\n");
    const out = messages(root);
    expect(out).toContain('error data/monsters/wolf.yaml:6:1 sped: unknown field "sped"');
    expect(out).toContain('error data/monsters/wolf.yaml:1:1 missing required field "speed"');
  });

  it("checks dialog graphs and shop references", () => {
    edit("data/npcs/harbor_master.yaml", "goto: island", "goto: islnd");
    edit("data/npcs/puerto_armorer.yaml", "open_shop: armorer_shop", "open_shop: armorr_shop");
    const out = messages(root);
    expect(out).toContain(
      'error data/npcs/harbor_master.yaml:65:11 dialog.nodes.greet.options[6].goto: unknown dialog node "islnd" (did you mean "island"?)',
    );
    expect(
      out.some((m) => m.includes('unknown shop "armorr_shop" (did you mean "armorer_shop"?)')),
    ).toBe(true);
    expect(
      out.some((m) => m.startsWith("warning") && m.includes('"island" is never reached')),
    ).toBe(true);
  });

  it("requires the same keys and placeholders in every language", () => {
    edit("i18n/en/monsters.yaml", 'monster.bilge_rat.name: "bilge rat"\n', "");
    edit("i18n/es/npcs.yaml", "{name}", "{nombre}");
    appendFileSync(file("i18n/en/dialog.yaml"), 'dialog.extra: "extra"\n');
    const out = messages(root);
    expect(out).toContain(
      'error data/monsters/bilge_rat.yaml:2:1 name: i18n key "monster.bilge_rat.name" is missing in: en',
    );
    expect(out.some((m) => m.includes("placeholders {name} differ from es {nombre}"))).toBe(true);
    expect(out.some((m) => m.includes("dialog.extra: missing in es"))).toBe(true);
  });

  it("rejects duplicate ids, file name mismatches and kind-specific blocks on other kinds", () => {
    appendFileSync(
      file("data/items/tools.yaml"),
      "\n- id: grass\n  kind: decoration\n  sprite: deco/grass\n  name: item.grass.name\n  weapon: { type: sword, attack: 1 }\n",
    );
    edit("data/monsters/tide_crab.yaml", "id: tide_crab", "id: crab");
    const out = messages(root);
    expect(
      out.some((m) =>
        m.includes('duplicate item id "grass" (first defined in data/items/ground.yaml:2)'),
      ),
    ).toBe(true);
    expect(out.some((m) => m.includes('"weapon" is only allowed on items with kind: weapon'))).toBe(
      true,
    );
    expect(out.some((m) => m.includes('id "crab" must match the file name "tide_crab.yaml"'))).toBe(
      true,
    );
  });

  it("checks doors and keys: pairs, blocking, pickup and locks (docs/02 Puertas con llave)", () => {
    writeFileSync(
      file("data/items/zz_doors.yaml"),
      [
        "- { id: bad_gate, kind: decoration, sprite: doors/forge_gate, name: item.forge_gate.name,",
        "    pickupable: false, door: { key: nobody, open: bad_gate_open } }",
        "- { id: bad_gate_open, kind: decoration, sprite: doors/forge_gate_open,",
        "    name: item.forge_gate_open.name, blocks_movement: true, key: forge_gate,",
        "    door: { closed: forge_gate } }",
        "- { id: two_way, kind: decoration, sprite: doors/forge_gate, name: item.forge_gate.name,",
        "    pickupable: false, blocks_movement: true, door: { open: bad_gate_open, closed: bad_gate } }",
        "- { id: fixed_key, kind: material, sprite: quest/ember_key, name: item.ember_key.name,",
        "    pickupable: false, key: forge_gate }",
        "",
      ].join("\n"),
    );
    const out = messages(root);
    for (const want of [
      "a closed door needs blocks_movement: true",
      'no item has key "nobody", so nothing opens this door',
      '"bad_gate_open" is not an open door that closes into "bad_gate"',
      "a door cannot be a key",
      "a door needs pickupable: false",
      '"forge_gate" is not a closed door that opens into "bad_gate_open"',
      "an open door cannot block movement",
      "a key needs to be pickupable (a player carries it)",
    ])
      expect(out.some((m) => m.includes(want))).toBe(true);
    // Exactly one of open and closed (the schema).
    expect(
      out.some((m) => m.includes("zz_doors.yaml:7:47 [2].door: does not match any of the")),
    ).toBe(true);
    // The repository's own gate is fine.
    expect(out.some((m) => m.includes("data/items/doors.yaml"))).toBe(false);
  });

  it("checks portal items: fixed, walkable and a way that fits the kind (docs/03)", () => {
    writeFileSync(
      file("data/items/zz_portals.yaml"),
      [
        "- { id: loose_hole, kind: decoration, sprite: decor/hole, name: item.hole.name,",
        "    portal: { kind: hole } }",
        "- { id: wall_ladder, kind: decoration, sprite: decor/ladder_up, name: item.ladder_up.name,",
        "    pickupable: false, blocks_movement: true, portal: { kind: ladder, leads: up } }",
        "- { id: up_hole, kind: decoration, sprite: decor/hole, name: item.hole.name,",
        "    pickupable: false, portal: { kind: hole, leads: up } }",
        "- { id: down_rope, kind: decoration, sprite: decor/rope_spot, name: item.rope_spot.name,",
        "    pickupable: false, portal: { kind: rope_spot, leads: down } }",
        "- { id: boat_look, kind: decoration, sprite: decor/hole, name: item.hole.name,",
        "    pickupable: false, portal: { kind: boat } }",
        "",
      ].join("\n"),
    );
    const out = messages(root);
    for (const want of [
      "zz_portals.yaml:2:5 [0].portal: a portal item needs pickupable: false",
      "zz_portals.yaml:4:47 [1].portal: a portal item cannot block movement",
      "zz_portals.yaml:6:46 [2].portal.leads: a hole only leads down",
      "zz_portals.yaml:8:51 [3].portal.leads: a rope spot only leads up",
      '[4].portal.kind: must be one of: "stairs", "ladder", "hole", "rope_spot", "teleport"',
    ])
      expect(out.some((m) => m.includes(want))).toBe(true);
    // The repository's own portal items are fine.
    expect(out.some((m) => m.includes("data/items/decoration.yaml"))).toBe(false);
  });

  it("rejects loot counts above 1 for items that do not stack", () => {
    edit(
      "data/monsters/wolf.yaml",
      "{ item: wolf_pelt, chance: 0.25 }",
      "{ item: iron_sword, chance: 0.25, count: [1, 3] }",
    );
    expect(messages(root).some((m) => m.includes('item "iron_sword" is not stackable'))).toBe(true);
  });

  it("validates optional files and quest step references", () => {
    mkdirSync(file("data/quests"), { recursive: true });
    writeFileSync(
      file("data/quests/lost_net.yaml"),
      [
        "id: lost_net",
        "name: quest.lost_net.name",
        "steps:",
        "  - id: find_net",
        "    description: quest.lost_net.step_find",
        "    complete_when: { kill: { monster: tide_crab, count: 3 } }",
        "rewards:",
        "  - { xp: 50 }",
        "",
      ].join("\n"),
    );
    for (const lang of ["es", "en"]) {
      writeFileSync(
        file(`i18n/${lang}/quests.yaml`),
        'quest.lost_net.name: "x"\nquest.lost_net.step_find: "x"\n',
      );
    }
    edit(
      "data/npcs/puerto_provisioner.yaml",
      "action: { open_shop: provisions_shop }",
      "action: [{ open_shop: provisions_shop }, { set_quest_step: { quest: lost_net, step: find_nett } }]",
    );
    writeFileSync(
      file("data/spells.yaml"),
      '- id: spark\n  name: spell.spark.name\n  words: "ignis parva"\n  vocations: [arcanist, monk]\n  level: 1\n  mana: 5\n  group: attack\n  cooldown_ms: 2000\n  effect: { damage: { base: 5, element: fire, power: 2 } }\n',
    );
    writeFileSync(
      file("data/recipes.yaml"),
      "- id: fish_stew\n  craft: cooking\n  level: 1\n  inputs: [{ item: raw_fish, count: 2 }]\n  output: { item: fish_stew, count: 1 }\n  base_success: 0.8\n  xp: 3\n",
    );
    writeFileSync(
      file("data/borders.yaml"),
      "ladder:\n  - { ground: rope }\n  - { ground: grass, pieces: border_grass }\n",
    );
    const out = messages(root);
    expect(out.some((m) => m.includes('quest "lost_net" has no step "find_nett"'))).toBe(true);
    expect(
      out.some((m) => m.startsWith("warning") && m.includes('quest "lost_net" is never started')),
    ).toBe(true);
    expect(out.some((m) => m.includes('unknown vocation "monk"'))).toBe(true);
    expect(out.some((m) => m.includes('effect.damage.power: unknown field "power"'))).toBe(true);
    expect(out.some((m) => m.includes('i18n key "spell.spark.name" is missing in: es, en'))).toBe(
      true,
    );
    expect(out.some((m) => m.includes('unknown item "fish_stew"'))).toBe(true);
    expect(out.some((m) => m.includes('"rope" must be a ground item'))).toBe(true);
  });

  it("rejects quest completions that point at a missing dialog node", () => {
    edit("data/quests/ch1_shipwreck.yaml", "node: ch1_logbook_read", "node: ch1_logbook_red");
    expect(
      messages(root).some((m) =>
        m.includes('npc "harbor_master" has no dialog node "ch1_logbook_red"'),
      ),
    ).toBe(true);
  });

  it("only lets an NPC open its own shop", () => {
    edit("data/npcs/puerto_priest.yaml", "goto: faith\n", "action: { open_shop: armorer_shop }\n");
    expect(
      messages(root).some(
        (m) =>
          m.startsWith("error data/npcs/puerto_priest.yaml:") &&
          m.includes('opens shop "armorer_shop" of data/npcs/puerto_armorer.yaml'),
      ),
    ).toBe(true);
  });

  it("only lets NPCs placed on dev_only islands use dev-only actions (train_skill, restore_mana) or be dev_only", () => {
    const devErrors = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("dev-only"));
    // The real world: once the instructor stands nowhere, an error.
    mkdirSync(file("world"), { recursive: true });
    cpSync(join(REPO, "world", "world.yaml"), file("world/world.yaml"));
    expect(devErrors()).toEqual([
      expect.stringMatching(
        /pruebas_trainer\.yaml:.*dev_only NPC .*: NPC "pruebas_trainer" is placed on no dev_only island/,
      ),
    ]);
    // On the sandbox island, which is dev_only.
    const npcs = (island: string, list: string): void => {
      mkdirSync(file(`world/islands/${island}`), { recursive: true });
      writeFileSync(file(`world/islands/${island}/npcs.yaml`), list);
    };
    npcs("pruebas", "- { npc: pruebas_trainer, pos: { x: 2093, y: 2085, z: 7 } }\n");
    expect(devErrors()).toEqual([]);
    // Placed (also) in Puerto, or the sandbox island no longer dev_only.
    npcs("puerto", "- { npc: pruebas_trainer, pos: { x: 3200, y: 6400, z: 7 } }\n");
    expect(devErrors()).toEqual([
      expect.stringMatching(/pruebas_trainer\.yaml:.*dev_only NPC.*stands on island "puerto"/),
    ]);
    // Without dev_only only her dev-only actions would be caught, not her free gold and
    // experience (review of lote 5).
    edit("data/npcs/pruebas_trainer.yaml", "dev_only: true\n", "");
    expect(devErrors()).toEqual([
      expect.stringMatching(/pruebas_trainer\.yaml:.*dev-only action.*stands on island "puerto"/),
    ]);
    edit("data/npcs/pruebas_trainer.yaml", "\ndialog:\n", "\ndev_only: true\ndialog:\n");
    npcs("puerto", "[]\n");
    // (testisle is dev_only too, content audit m11: flip the sandbox island's own flag.)
    const sandbox = "level_hint: [1, 60]\n    dev_only:";
    edit("world/world.yaml", `${sandbox} true`, `${sandbox} false`);
    expect(devErrors()).toEqual([expect.stringContaining('stands on island "pruebas"')]);
    edit("world/world.yaml", `${sandbox} false`, `${sandbox} true`);
    // Puerto's priest refilling mana for free.
    npcs("puerto", "- { npc: puerto_priest, pos: { x: 3200, y: 6400, z: 7 } }\n");
    edit(
      "data/npcs/puerto_priest.yaml",
      "action: { heal: true }",
      "action: [{ heal: true }, { restore_mana: true }]",
    );
    expect(devErrors()).toEqual([
      expect.stringMatching(/puerto_priest\.yaml:.*"restore_mana".*stands on island "puerto"/),
    ]);
    // A dev_only NPC is caught even with no dev-only action.
    edit(
      "data/npcs/puerto_priest.yaml",
      "action: [{ heal: true }, { restore_mana: true }]",
      "action: { heal: true }",
    );
    edit("data/npcs/puerto_priest.yaml", "\ndialog:\n", "\ndev_only: true\ndialog:\n");
    expect(devErrors()).toEqual([
      expect.stringMatching(/puerto_priest\.yaml:.*dev_only NPC.*stands on island "puerto"/),
    ]);
    // The schema: a known skill and a level in 1..500.
    edit(
      "data/npcs/pruebas_trainer.yaml",
      "{ skill: sword, level: 45 }",
      "{ skill: juggling, level: 0 }",
    );
    const out = messages(root);
    expect(out.some((m) => m.includes("train_skill.skill"))).toBe(true);
    expect(out.some((m) => m.includes("train_skill.level") && m.includes(">= 1"))).toBe(true);
  });

  it("wants a target in the production map for every tool a player can get there (m1)", () => {
    const toolErrors = (): string[] =>
      messages(root)
        .filter((m) => m.startsWith("error") && m.includes("nothing in the production map"))
        .map((m) => /tool "([a-z_]+)"/.exec(m)?.[1] ?? m)
        .sort();
    const put = (rel: string, lines: string[]): void => {
      mkdirSync(file(dirname(rel)), { recursive: true });
      writeFileSync(file(rel), lines.join("\n") + "\n");
    };
    const ropeSpot =
      "- { id: r, kind: rope_spot, from: { x: 1, y: 1, z: 8 }, to: { x: 1, y: 2, z: 7 } }";
    // Puerto (production) with its provisioner and nothing else; the sandbox (dev_only)
    // has a rope spot, which does not count.
    put("world/world.yaml", [
      "format: 1",
      "islands:",
      "  - id: puerto",
      "  - id: pruebas",
      "    dev_only: true",
    ]);
    put("world/islands/puerto/npcs.yaml", [
      "- { npc: puerto_provisioner, pos: { x: 1, y: 1, z: 7 } }",
    ]);
    put("world/islands/pruebas/portals.yaml", [ropeSpot]);
    expect(toolErrors()).toEqual([
      "felling_axe",
      "fishing_rod",
      "pickaxe",
      "rope",
      "smithing_hammer",
    ]);
    // A rope spot, a vein and an anvil in Puerto: the rope, the pickaxe and the hammer.
    put("world/islands/puerto/portals.yaml", [ropeSpot]);
    put("world/islands/puerto/chunks/z07/c0000_0000.json", [
      JSON.stringify({ palette: ["grass", "iron_vein", "anvil"] }),
    ]);
    expect(toolErrors()).toEqual(["felling_axe", "fishing_rod"]);
    // The shovel back in the shop: nothing in the world is dug.
    edit(
      "data/npcs/puerto_provisioner.yaml",
      "    - { item: rope, price: 45 }",
      "    - { item: rope, price: 45 }\n    - { item: shovel, price: 40 }",
    );
    expect(toolErrors()).toEqual(["felling_axe", "fishing_rod", "shovel"]);
  });

  it("rejects buy prices that reach a sell price and warns on buys above the item value", () => {
    edit(
      "data/npcs/puerto_provisioner.yaml",
      "{ item: rope, price: 14 }",
      "{ item: rope, price: 45 }",
    );
    edit(
      "data/npcs/puerto_armorer.yaml",
      "{ item: driftwood_club, price: 1 }",
      "{ item: driftwood_club, price: 9 }",
    );
    const out = messages(root);
    // The cheapest seller is named: the first file, pruebas_merchant.yaml before
    // puerto_provisioner.yaml, when both sell rope for 45. Buy prices on the real islands
    // stay below the sandbox shop's too (its ferry takes players there).
    expect(out).toContainEqual(
      expect.stringMatching(
        /^error data\/npcs\/puerto_provisioner\.yaml:57:21 shop\.buys\[0\]\.price: shop "provisions_shop" buys "rope" for 45 but shop "pruebas_shop" sells it for 45: buy prices must be lower than every sell price$/,
      ),
    );
    expect(
      out.some(
        (m) =>
          m.startsWith("warning") && m.includes('buys "driftwood_club" for 9, above its value 5'),
      ),
    ).toBe(true);
  });

  // Hands reach the half-height of the classic 15x11 window (6 tiles up and down, server
  // content.MaxReach): the 31x21 view did not stretch it.
  it("caps inventory.reach and resource.reach at the classic window's half-height", () => {
    edit("data/balance.yaml", "  reach: 1 ", "  reach: 7 ");
    edit("data/items/ground.yaml", "    reach: 3\n", "    reach: 7\n");
    const out = messages(root);
    expect(out.some((m) => m.startsWith("error data/balance.yaml:") && m.includes("<= 6"))).toBe(
      true,
    );
    expect(
      out.some((m) => m.startsWith("error data/items/ground.yaml:") && m.includes("<= 6")),
    ).toBe(true);
  });

  // Aimed ranges stop at the same 6 tiles (server content.MaxRange), what a monster
  // notices: a monster hit from that far always fights back, never a free kill.
  it("caps weapon, spell and condition ranges at the classic window's half-height", () => {
    edit("data/items/weapons.yaml", "attack: 7, range: 6,", "attack: 7, range: 7,");
    edit("data/spells.yaml", "{ element: energy, range: 4,", "{ element: energy, range: 7,");
    edit("data/spells.yaml", "heal: { range: 5,", "heal: { range: 7,");
    edit("data/spells.yaml", "{ id: slowed, range: 4,", "{ id: slowed, range: 7,");
    const out = messages(root);
    expect(
      out.some((m) => m.startsWith("error data/items/weapons.yaml:128:") && m.includes("<= 6")),
    ).toBe(true);
    const spells = out.filter((m) => m.startsWith("error data/spells.yaml:") && m.includes("<= 6"));
    expect(new Set(spells.map((m) => m.split(":")[1])).size).toBe(3);
  });

  // An area spell's radius too: a monster hit 7 tiles straight north would not notice.
  it("caps an area spell's radius at the classic window's half-height", () => {
    edit("data/spells.yaml", "{ element: earth, radius: 1,", "{ element: earth, radius: 7,");
    expect(
      messages(root).some((m) => m.startsWith("error data/spells.yaml:160:") && m.includes("<= 6")),
    ).toBe(true);
  });

  // Review of the monster pursuit: what the server refuses to start with, make validate
  // reports (docs/06 "Monstruo", "Persecución y regeneración").
  it("asks for the balance's roll_ms and an interval_ms with a persistence or a regeneration", () => {
    edit("data/balance.yaml", "    roll_ms: 3000\n", "");
    edit(
      "data/balance.yaml",
      "monster_regen: { delay_ms: 10000, interval_ms: 5000, pct: 1 }",
      "monster_regen: { delay_ms: 10000, pct: 1 }",
    );
    edit("data/monsters/slagbound_warden.yaml", "regen: {", "regen: { interval_ms: 8000,");
    const out = messages(root).filter((m) => m.startsWith("error "));
    const has = (file: string, text: string): boolean =>
      out.some((m) => m.includes(file) && m.includes(text));
    expect(
      has("data/balance.yaml", "combat.monster_pursuit.persistence: a persistence needs roll_ms"),
    ).toBe(true);
    expect(has("data/balance.yaml", "combat.monster_regen.pct: a pct needs interval_ms")).toBe(
      true,
    );
    expect(
      has("data/monsters/wolf.yaml", "pursuit.persistence: a persistence needs balance.yaml"),
    ).toBe(true);
    // Its own interval is enough for the warden; no monster without a regen block is named.
    expect(out.some((m) => m.includes("regen.pct: a pct needs an interval_ms"))).toBe(false);
    edit("data/monsters/slagbound_warden.yaml", "regen: { interval_ms: 8000,", "regen: {");
    expect(
      messages(root).some(
        (m) =>
          m.includes("data/monsters/slagbound_warden.yaml") &&
          m.includes("regen.pct: a pct needs an interval_ms"),
      ),
    ).toBe(true);
  });

  // Monster abilities (docs/06 "Monstruo"): areas, heal_self, summon and phases.
  it("checks monster areas, heals, summons and phases", () => {
    writeFileSync(
      file("data/monsters/wolf.yaml"),
      [
        "id: wolf",
        "name: monster.wolf.name",
        "sprite: creatures/wolf",
        "health: 25",
        "experience: 28",
        "speed: 190",
        "attacks:",
        "  - { type: spell, min: 1, max: 2, interval_ms: 2000, area: { shape: beam, length: 4, radius: 1 } }",
        "  - { type: spell, min: 1, max: 2, interval_ms: 2000, area: { shape: circle, center: target } }",
        "  - { type: spell, min: 1, max: 2, interval_ms: 2000, area: { shape: circle, radius: 7 } }",
        "  - { type: heal_self, min: 5, max: 9, interval_ms: 2000, area: { shape: circle, radius: 1 } }",
        "  - { type: summon, min: 1, max: 1, interval_ms: 2000, summon: { monster: slagbound_warden, count: 1 } }",
        "  - { type: summon, interval_ms: 2000, summon: { monster: no_such_beast, count: 9 } }",
        "  - { type: distance, min: 1, max: 2, interval_ms: 2000, range: 7 }",
        "  - { type: distance, min: 1, max: 2, interval_ms: 2000, range: 5, area: { shape: circle, radius: 2, center: target } }",
        "  - { type: melee, min: 1, max: 2, interval_ms: 2000, area: { shape: circle, radius: 5, center: target } }",
        "  - { type: spell, min: 1, max: 2, interval_ms: 2000, range: 4, area: { shape: beam, length: 3 } }",
        "  - { type: distance, min: 1, max: 2, interval_ms: 2000, range: 3, area: { shape: circle, radius: 1 } }",
        "phases:",
        "  - { below_hp_pct: 50, attacks_add: [ { type: melee, min: 4, max: 2, interval_ms: 2000 } ] }",
        "  - { below_hp_pct: 50, speed_mult: 0 }",
      ].join("\n") + "\n",
    );
    const out = messages(root).filter((m) => m.startsWith("error data/monsters/"));
    const at = (path: string, text: string): boolean =>
      out.some((m) => m.includes(` ${path}: `) && m.includes(text));
    expect(at("attacks[0].area.radius", "not allowed here")).toBe(true);
    expect(at("attacks[1].area", 'missing required field "radius"')).toBe(true);
    expect(at("attacks[2].area.radius", "<= 6")).toBe(true);
    expect(at("attacks[3].area", "not allowed here")).toBe(true);
    expect(at("attacks[4].min", "not allowed here")).toBe(true);
    expect(at("attacks[5].summon.count", "<= 8")).toBe(true);
    expect(at("attacks[5].summon.monster", 'unknown monster "no_such_beast"')).toBe(true);
    // What a monster notices (MaxRange 6): its range, and range + radius around the target.
    expect(at("attacks[6].range", "<= 6")).toBe(true);
    expect(at("attacks[7].area.radius", "reach 5 + radius 2")).toBe(true);
    expect(out.some((m) => m.includes(" attacks[8]."))).toBe(false);
    // A beam or a circle around the monster reaches its length or radius: no range.
    expect(at("attacks[9].range", "not allowed here")).toBe(true);
    expect(at("attacks[10].range", "not allowed here")).toBe(true);
    expect(at("phases[0].attacks_add[0].min", "min (4) is greater than max (2)")).toBe(true);
    expect(at("phases[1].below_hp_pct", "another phase is already below 50 %")).toBe(true);
    expect(at("phases[1].speed_mult", "> 0")).toBe(true);
    // The warden summons: nothing may summon it.
    expect(
      out.some((m) =>
        m.includes('attacks[4].summon.monster: "slagbound_warden" summons monsters itself'),
      ),
    ).toBe(true);
  });

  it("limits the number of different blessings to balance.yaml max_blessings", () => {
    edit("data/balance.yaml", "max_blessings: 5", "max_blessings: 4");
    expect(
      messages(root).some((m) =>
        m.includes("5 different blessings are sold, but balance.yaml death.max_blessings is 4"),
      ),
    ).toBe(true);
  });

  it("requires a way to obtain the item of every has_item quest step", () => {
    edit("data/monsters/wreck_looter.yaml", "  - { item: tarnished_locket, chance: 0.08 }\n", "");
    edit("data/monsters/drowned_miner.yaml", "  - { item: tarnished_locket, chance: 0.08 }\n", "");
    edit(
      "data/npcs/puerto_provisioner.yaml",
      "{ item: tarnished_locket, price: 40 }",
      "{ item: rope, price: 1 }",
    );
    expect(
      messages(root).some(
        (m) =>
          m.startsWith("error data/quests/diver_locket.yaml:") &&
          m.includes('no way to obtain "tarnished_locket"'),
      ),
    ).toBe(true);
  });

  it("wants a source for what NPCs buy, a buyer for gear and materials, and quest drops each_player (m4)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    // The armorer stops selling the belaying pin and the looters stop dropping it, but the
    // armorer still buys it; the forged axe loses its buyer (its recipe still makes it).
    edit("data/monsters/wreck_looter.yaml", "  - { item: belaying_pin, chance: 0.04 }", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: belaying_pin, price: 30 }\n", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: forged_axe, price: 150 }\n", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: forged_axe, price: 50 }\n", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: quartz_crystal, price: 13 }\n", "");
    edit(
      "data/monsters/coffer_smuggler.yaml",
      "chance: 0.35, each_player: true }",
      "chance: 0.35 }",
    );
    const errors = messages(root).filter((m) => m.startsWith("error"));
    expect(errors).toEqual([
      expect.stringMatching(
        /puerto_armorer\.yaml:.*an NPC buys "belaying_pin" but nothing gives it/,
      ),
      expect.stringMatching(/misc\.yaml:.*material "quartz_crystal" can be had.*no NPC buys it/),
      expect.stringMatching(/weapons\.yaml:.*"forged_axe" \(weapon\) can be had.*no NPC buys it/),
      expect.stringMatching(
        /coffer_smuggler\.yaml:.*quest item "smuggler_tally" drops as plain loot/,
      ),
    ]);
  });

  it("refuses every source of a retired item and lets an NPC buy it (lote 11)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    // The armorer buys the retired driftwood club with no source: no error (above).
    edit(
      "data/monsters/wreck_looter.yaml",
      "  - { item: belaying_pin, chance: 0.04 }",
      "  - { item: driftwood_club, chance: 0.04 }",
    );
    edit(
      "data/npcs/puerto_armorer.yaml",
      "    - { item: rusty_cutlass, price: 30 }\n",
      "    - { item: rusty_cutlass, price: 30 }\n    - { item: hide_vest, price: 45 }\n",
    );
    edit(
      "data/recipes.yaml",
      "  output: { item: forged_axe, count: 1 }",
      "  output: { item: forged_shortsword, count: 1 }",
    );
    edit(
      "data/npcs/harbor_master.yaml",
      "- { give_item: iron_sword }",
      "- { give_item: thornwood_blade }",
    );
    edit("data/quests/foreman_ore.yaml", "  - { item: pickaxe }", "  - { item: leather_jerkin }");
    // The tutorial's reward is a source too (review of lote 11).
    edit(
      "data/tutorial.yaml",
      "  - { gold: 20 }",
      "  - { gold: 20 }\n  - { item: riveted_round_shield }",
    );
    const errors = messages(root).filter((m) => m.startsWith("error"));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /wreck_looter\.yaml:.*"driftwood_club" is retired.*no monster drops it/,
        ),
        expect.stringMatching(/puerto_armorer\.yaml:.*"hide_vest" is retired.*no shop sells it/),
        expect.stringMatching(/recipes\.yaml:.*"forged_shortsword" is retired.*no recipe makes it/),
        expect.stringMatching(
          /harbor_master\.yaml:.*"thornwood_blade" is retired.*no dialog gives it/,
        ),
        expect.stringMatching(
          /foreman_ore\.yaml:.*"leather_jerkin" is retired.*no quest rewards it/,
        ),
        expect.stringMatching(
          /tutorial\.yaml:.*"riveted_round_shield" is retired.*no tutorial rewards it/,
        ),
      ]),
    );
    expect(errors.filter((m) => m.includes("is retired"))).toHaveLength(6);
  });

  /**
   * Appends a map item to data/items/decoration.yaml with its numeric id (at the end of the
   * lock) and, for a chest whose id is not locked yet, its chest (at the end of the lock's
   * chests, before its items).
   */
  const addItem = (id: string, n: number, block: string, extra = "pickupable: false"): void => {
    appendFileSync(
      file("data/items/decoration.yaml"),
      [
        "",
        `- id: ${id}`,
        "  kind: decoration",
        "  sprite: decor/cargo_crate",
        "  name: item.cargo_crate.name",
        `  ${extra}`,
        `  ${block}`,
        "",
      ].join("\n"),
    );
    const lock = `${readFileSync(file("data/ids.lock.yaml"), "utf8")}  ${id}: ${n}\n`;
    const items = lock.search(/^items:/m);
    const head = lock.slice(0, items);
    const cid = /chest: \{ id: (\w+)/.exec(block)?.[1];
    const chest =
      cid === undefined || new RegExp(`^  ${cid}: `, "m").test(head)
        ? ""
        : `${head.includes("\nchests:\n") ? "" : "chests:\n"}  ${cid}: ${id}\n`;
    writeFileSync(file("data/ids.lock.yaml"), head + chest + lock.slice(items));
  };

  it("checks reward chests: fixed, unique ids, one stack of what a backpack holds, never retired nor the forge's amber", () => {
    const chest = (id: string, n: number, rewards: string, extra?: string): void =>
      addItem(
        id,
        n,
        `chest: { id: ${id.replace("test_chest", "cache")}, rewards: [${rewards}] }`,
        extra,
      );
    chest(
      "test_chest_a",
      60001,
      "{ item: silver_coin, count: 100 }, { item: iron_sword, count: 1 }",
    );
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    addItem(
      "test_chest_b",
      60002,
      "chest: { id: cache_a, rewards: [{ item: warding_amber, count: 1 }] }",
    );
    chest(
      "test_chest_c",
      60003,
      "{ item: silver_coin, count: 101 }, { item: iron_sword, count: 2 }",
    );
    chest("test_chest_d", 60004, "{ item: driftwood_club, count: 1 }", "blocks_movement: true");
    chest("test_chest_e", 60005, "{ item: nothing_here, count: 1 }");
    chest("test_chest_f", 60006, "{ item: test_chest_a, count: 1 }");
    const errors = messages(root).filter((m) => m.startsWith("error"));
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/chest id "cache_a" is also the one of "test_chest_a"/),
        expect.stringMatching(/"warding_amber" is the forge's rare protection: no chest gives it/),
        expect.stringMatching(/101 "silver_coin" do not make one stack \(at most 100\)/),
        expect.stringMatching(/2 "iron_sword" do not make one stack \(at most 1\)/),
        expect.stringMatching(/chest "test_chest_d" needs pickupable: false/),
        expect.stringMatching(/"driftwood_club" is retired.*no chest gives it/),
        expect.stringMatching(/nothing_here/),
        expect.stringMatching(/"test_chest_a" cannot be picked up \(pickupable: false\)/),
      ]),
    );
    expect(errors).toHaveLength(8);
  });

  it('checks milestone quests and sigil plates (docs/02 "Quests de hito")', () => {
    const quest = (id: string, body: string): void =>
      writeFileSync(
        file(`data/quests/${id}.yaml`),
        `id: ${id}
name: quest.${id}.name
${body}`,
      );
    const sigils =
      "complete_when: { sigils: { x: 1, y: 1, z: 7, radius: 1, to: { x: 5, y: 5, z: 7 } } }";
    quest(
      "test_ms_a",
      `milestone: true
requires: { level: 5, players: 2, vocations: [guardian] }
steps:
  - { id: s, description: d.d, ${sigils} }
`,
    );
    quest(
      "test_ms_b",
      `steps:
  - { id: s, description: d.d, ${sigils} }
`,
    );
    quest(
      "test_ms_c",
      `milestone: true
title: t.t
requires: { level: 5, players: 1, gear: { item: no_such_item } }
steps:
  - { id: s, description: d.d, ${sigils} }
  - { id: k, description: d.d, complete_when: { kill: { monster: wolf, count: 1 } } }
`,
    );
    quest(
      "test_ms_d",
      `milestone: true
title: t.t
requires: { level: 5, players: 1, gear: { weapon: spear } }
steps:
  - { id: s, description: d.d, ${sigils} }
`,
    );
    addItem("test_plate", 60000, "sigil: { vocation: guardian }", "blocks_movement: true");
    const errors = messages(root).filter((m) => m.startsWith("error"));
    // A weapon type that does not exist would never be met.
    expect(errors.filter((m) => m.includes("test_ms_d.yaml"))).not.toEqual([]);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/test_ms_a\.yaml.*a milestone needs a title/),
        expect.stringMatching(/test_ms_a\.yaml.*one vocation per player/),
        expect.stringMatching(/test_ms_b\.yaml.*sigils step belongs to a milestone quest/),
        expect.stringMatching(/test_ms_c\.yaml.*exactly one sigils step, its last/),
        expect.stringMatching(/test_ms_c\.yaml.*no_such_item/),
        expect.stringMatching(
          /sigil plate "test_plate" needs pickupable: false and must not block/,
        ),
      ]),
    );
  });

  it("counts a chest's rewards as a source of what NPCs buy", () => {
    edit("data/monsters/wreck_looter.yaml", "  - { item: belaying_pin, chance: 0.04 }", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: belaying_pin, price: 30 }\n", "");
    expect(messages(root).filter((m) => m.includes('buys "belaying_pin"'))).toHaveLength(1);
    addItem(
      "test_chest",
      60000,
      "chest: { id: test_cache, rewards: [{ item: belaying_pin, count: 1 }] }",
    );
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
  });

  it("checks a book's texts in every language and warns about book texts no item reads", () => {
    addItem(
      "test_book",
      60000,
      "book: { title: book.test_book.title, pages: [book.test_book.page_1, book.test_book.page_2] }",
    );
    for (const lang of ["es", "en"])
      writeFileSync(
        file(`i18n/${lang}/test_books.yaml`),
        [
          'book.test_book.title: "T"',
          'book.test_book.page_1: "P"',
          'book.test_book.unused: "U"',
          "",
        ].join("\n"),
      );
    const out = messages(root);
    expect(out.filter((m) => m.startsWith("error"))).toEqual([
      expect.stringMatching(/i18n key "book\.test_book\.page_2" is missing in: es, en/),
    ]);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/warning.*"book\.test_book\.unused" is not used/),
      ]),
    );
  });

  it("counts the tutorial's reward as a source of what NPCs buy (review of lote 11)", () => {
    edit("data/monsters/wreck_looter.yaml", "  - { item: belaying_pin, chance: 0.04 }", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: belaying_pin, price: 30 }\n", "");
    expect(messages(root).filter((m) => m.includes('buys "belaying_pin"'))).toHaveLength(1);
    edit("data/tutorial.yaml", "  - { gold: 20 }", "  - { gold: 20 }\n  - { item: belaying_pin }");
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
  });

  it("wants a level on every weapon, armor and shield (lote 11)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    edit(
      "data/items/weapons.yaml",
      "  requires: { level: 1 }\n  value: 30\n",
      "  requires: { vocations: [guardian] }\n  value: 30\n",
    );
    edit(
      "data/items/equipment.yaml",
      "  shield: { defense: 9 }\n  worn: { shape: buckler, tint: weathered }\n  requires: { level: 1 }\n",
      "  shield: { defense: 9 }\n  worn: { shape: buckler, tint: weathered }\n",
    );
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([
      expect.stringMatching(/equipment\.yaml:.*shield "barrel_lid_shield" has no requires\.level/),
      expect.stringMatching(/weapons\.yaml:.*weapon "rusty_cutlass" has no requires\.level/),
    ]);
  });

  it("checks every look, worn piece and outfit against data/looks.yaml (docs/06 Looks)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    edit(
      "data/items/weapons.yaml",
      "worn: { shape: sword, tint: rust }",
      "worn: { shape: plate, tint: rust }",
    );
    edit(
      "data/items/weapons.yaml",
      "worn: { shape: axe, tint: rust }",
      "worn: { shape: axe, tint: rost }",
    );
    edit(
      "data/items/equipment.yaml",
      "  armor: { slot: neck, armor: 1 }\n",
      "  armor: { slot: neck, armor: 1 }\n  worn: { shape: circlet, tint: gold }\n",
    );
    edit("data/npcs/harbor_master.yaml", "  sex: female\n", "  sex: woman\n");
    edit("data/npcs/harbor_master.yaml", "  skin: tan\n", "  skin: tann\n");
    edit("data/npcs/harbor_master.yaml", "legs: { shape: trousers", "legs: { shape: robe");
    edit(
      "data/outfits.yaml",
      "skin: fair, hair: short, hair_color: brown",
      "skin: ashen, hair: short, hair_color: brown",
    );
    const out = messages(root).filter((m) => m.startsWith("error"));
    expect(out).toEqual([
      expect.stringMatching(
        /equipment\.yaml:.*worn: only weapons, shields and head, body, legs and feet armour/,
      ),
      expect.stringMatching(/weapons\.yaml:.*worn\.shape: unknown weapon shape "plate"/),
      expect.stringMatching(
        /weapons\.yaml:.*worn\.tint: unknown tint "rost" in data\/looks\.yaml \(did you mean "rust"\?\)/,
      ),
      expect.stringMatching(/harbor_master\.yaml:.*look\.sex: unknown sex "woman" in data\/looks/),
      expect.stringMatching(
        /harbor_master\.yaml:.*look\.skin: unknown skin "tann" in data\/looks\.yaml \(did you mean "tan"\?\)/,
      ),
      expect.stringMatching(
        /harbor_master\.yaml:.*look\.worn\.legs\.shape: unknown legs shape "robe"/,
      ),
      expect.stringMatching(
        /outfits\.yaml:.*\[0\]\.look\.skin: skin "ashen" is creatures_only: not for a player/,
      ),
    ]);
  });

  it("checks quest drops as the server does: worthless, asked for and taken by the next step (m9)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    // A step between the tallies and their delivery.
    edit(
      "data/quests/ch2_coffer.yaml",
      "  - id: deliver_tallies\n",
      "  - id: count_tallies\n    description: quest.ch2_coffer.step_gather_tallies\n" +
        "    complete_when: { kill: { monster: coffer_smuggler, count: 1 } }\n  - id: deliver_tallies\n",
    );
    // A tradeable seal, and a keeper who reads it and gives it back.
    edit(
      "data/items/misc.yaml",
      "  tradeable: false\n  notes: Chapter 3 quest item (ch3_warden).",
      "  tradeable: true\n  notes: Chapter 3 quest item (ch3_warden).",
    );
    edit(
      "data/npcs/volcan_keeper.yaml",
      "          action: { take_item: { item: forge_seal } }\n          goto: ch3_seal_read",
      "          goto: ch3_seal_read",
    );
    // A drop for each player that no quest asks for, with a value.
    edit(
      "data/monsters/slagbound_warden.yaml",
      "{ item: wyrm_scale, chance: 0.2 }",
      "{ item: wyrm_scale, chance: 0.2, each_player: true }",
    );
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([
      expect.stringMatching(
        /coffer_smuggler\.yaml:.*quest "ch2_coffer" step "gather_tallies": the has_item of quest drop "smuggler_tally" must be followed by its delivery/,
      ),
      expect.stringMatching(
        /slagbound_warden\.yaml:.*quest drop "forge_seal" needs tradeable: false and value: 0/,
      ),
      expect.stringMatching(
        /slagbound_warden\.yaml:.*quest "ch3_warden" step "return_seal": its delivery must take quest drop "forge_seal": every option of npc "volcan_keeper" that leads to node "ch3_seal_read"/,
      ),
      expect.stringMatching(
        /slagbound_warden\.yaml:.*quest drop "wyrm_scale" needs tradeable: false and value: 0/,
      ),
      expect.stringMatching(
        /slagbound_warden\.yaml:.*quest drop "wyrm_scale" is the has_item of no quest step/,
      ),
    ]);
  });

  it("wants every way into a quest drop's delivery to take it, and no delivery at the dialog's start (m9 review)", () => {
    const deliveryErrors = (): string[] =>
      messages(root).filter((m) => m.startsWith("error") && m.includes("its delivery must take"));
    expect(deliveryErrors()).toEqual([]);
    // A second way into the keeper's ch3_seal_read that keeps the seal.
    edit(
      "data/npcs/volcan_keeper.yaml",
      "        - { text: npc.volcan_keeper.opt_north, goto: ch3_north }",
      "        - { text: npc.volcan_keeper.opt_north, goto: ch3_north }\n        - { text: dialog.back, goto: ch3_seal_read }",
    );
    expect(deliveryErrors()).toEqual([
      expect.stringMatching(
        /slagbound_warden\.yaml:.*"forge_seal".*"volcan_keeper".*"ch3_seal_read"/,
      ),
    ]);
    edit(
      "data/npcs/volcan_keeper.yaml",
      "\n        - { text: dialog.back, goto: ch3_seal_read }",
      "",
    );
    // The druid's dialog starting at the tallies' delivery.
    edit("data/npcs/bosque_druid.yaml", "  start: greet", "  start: ch2_tallies");
    expect(deliveryErrors()).toEqual([
      expect.stringMatching(
        /coffer_smuggler\.yaml:.*"smuggler_tally".*"bosque_druid".*"ch2_tallies"/,
      ),
    ]);
  });

  it("keeps bless and give_xp out of one option, and reference sellers within votes (M6, m13 review)", () => {
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([]);
    edit(
      "data/npcs/puerto_priest.yaml",
      "action: { bless: { blessing: shore_light, price: 50, per_level: 20 } }",
      "action: [{ give_xp: 5 }, { bless: { blessing: shore_light, price: 50, per_level: 20 } }]",
    );
    edit("data/balance.yaml", "reference_min_sellers: 2", "reference_min_sellers: 4");
    expect(messages(root).filter((m) => m.startsWith("error"))).toEqual([
      expect.stringMatching(
        /balance\.yaml:.*reference_min_sellers \(4\) is more than reference_min_votes \(3\)/,
      ),
      expect.stringMatching(/puerto_priest\.yaml:.*bless and give_xp cannot go in one option/),
    ]);
  });

  it("accepts lacks_item and checks its item reference", () => {
    edit(
      "data/npcs/puerto_foreman.yaml",
      "lacks_item: { item: bosun_logbook }",
      "lacks_item: { item: bosun_logbok }",
    );
    expect(
      messages(root).some((m) =>
        m.includes('unknown item "bosun_logbok" (did you mean "bosun_logbook"?)'),
      ),
    ).toBe(true);
  });

  it("reports YAML syntax errors with their position", () => {
    writeFileSync(file("data/monsters/wolf.yaml"), "id: wolf\nid: wolf2\n");
    expect(
      messages(root).some((m) => m.startsWith("error data/monsters/wolf.yaml:2:1 invalid YAML")),
    ).toBe(true);
  });

  it("rejects files that have no schema", () => {
    writeFileSync(file("data/effects.yaml"), "[]\n");
    expect(messages(root)).toContain(
      "error data/effects.yaml unexpected file: there is no schema for it (see docs/06-content-data.md)",
    );
  });
});
