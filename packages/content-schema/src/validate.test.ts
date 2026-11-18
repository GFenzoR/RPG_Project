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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDiagnostic, SchemaSet, validateContent } from "./index.ts";
import type { SchemaName } from "./index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

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
      "tutorial",
      "news",
      "borders",
      "outfits",
      "cosmetics",
      "sounds",
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
        "  islands: { puerto: song, atlantis: song }",
        "  underground: hit",
      ].join("\n") + "\n",
    );
    const out = messages(root).filter((m) => m.includes("sounds.yaml"));
    const has = (s: string): boolean => out.some((m) => m.includes(s));
    expect(has("assets/sounds/gone.ogg does not exist")).toBe(true);
    expect(has('pack "somepack" has no row in assets/CREDITS.md')).toBe(true);
    expect(has('unknown sound "nope"')).toBe(true);
    expect(has('sound "song" is a music loop, not an event sound')).toBe(true);
    expect(has('sound "hit" is on channel sfx, not music')).toBe(true);
    expect(has('unknown island "atlantis"')).toBe(true);
    expect(has("volume")).toBe(true);
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
        /^error data\/npcs\/puerto_provisioner\.yaml:46:21 shop\.buys\[0\]\.price: shop "provisions_shop" buys "rope" for 45 but shop "pruebas_shop" sells it for 45: buy prices must be lower than every sell price$/,
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
      out.some((m) => m.startsWith("error data/items/weapons.yaml:118:") && m.includes("<= 6")),
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
    edit("data/monsters/wreck_looter.yaml", "  - { item: driftwood_club, chance: 0.06 }", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: forged_shortsword, price: 50 }\n", "");
    edit("data/npcs/puerto_armorer.yaml", "    - { item: quartz_crystal, price: 13 }\n", "");
    edit(
      "data/monsters/coffer_smuggler.yaml",
      "chance: 0.35, each_player: true }",
      "chance: 0.35 }",
    );
    const errors = messages(root).filter((m) => m.startsWith("error"));
    expect(errors).toEqual([
      expect.stringMatching(
        /puerto_armorer\.yaml:.*an NPC buys "driftwood_club" but nothing gives it/,
      ),
      expect.stringMatching(/misc\.yaml:.*material "quartz_crystal" can be had.*no NPC buys it/),
      expect.stringMatching(
        /weapons\.yaml:.*"forged_shortsword" \(weapon\) can be had.*no NPC buys it/,
      ),
      expect.stringMatching(
        /coffer_smuggler\.yaml:.*quest item "smuggler_tally" drops as plain loot/,
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
