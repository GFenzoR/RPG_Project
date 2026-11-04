import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiagnostic, SchemaSet, validateContent } from "./index.ts";
import type { SchemaName } from "./index.ts";

const REPO = new URL("../../../", import.meta.url).pathname;

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

  it("compiles every schema", () => {
    const set = new SchemaSet();
    const names: SchemaName[] = [
      "balance",
      "vocations",
      "items",
      "monster",
      "npc",
      "quest",
      "spells",
      "recipes",
      "boat_routes",
      "borders",
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
      'error data/monsters/wolf.yaml:17:7 loot[0].item: unknown item "wolf_pelts" (did you mean "wolf_pelt"?)',
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
      'error data/npcs/harbor_master.yaml:49:11 dialog.nodes.greet.options[6].goto: unknown dialog node "islnd" (did you mean "island"?)',
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
      "- id: grass_sand\n  from: grass\n  to: rope\n  pieces: { n: grass, s: grass, e: grass, w: grass, ne: grass, nw: grass, se: grass, sw: grass }\n",
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
    expect(out).toContain(
      'error data/npcs/puerto_provisioner.yaml:44:21 shop.buys[0].price: shop "provisions_shop" buys "rope" for 45 but shop "provisions_shop" sells it for 45: buy prices must be lower than every sell price',
    );
    expect(
      out.some(
        (m) =>
          m.startsWith("warning") && m.includes('buys "driftwood_club" for 9, above its value 5'),
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
