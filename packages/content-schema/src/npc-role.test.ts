// What an NPC does (npc-role.ts): the rule itself, and the real NPCs of data/npcs with the
// texts of i18n/: every one ends up with a role in both languages, short enough for its
// label, and no name repeats the role after a comma.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CREATURE_NAME_MAX_CHARS,
  NPC_ROLE_KINDS,
  NPC_ROLE_MAX_CHARS,
  npcRoleDefaultKey,
  npcRoleKey,
  npcRoleKind,
} from "./npc-role.ts";
import { LANGUAGES } from "./validate.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");

const dialog = (...actions: unknown[]) => ({
  start: "greet",
  nodes: { greet: { text: "npc.x.greet", options: actions.map((action) => ({ action })) } },
});

describe("npcRoleKind", () => {
  it("names an NPC by what it offers", () => {
    expect(npcRoleKind({ shop: { id: "s" } })).toBe("merchant");
    expect(npcRoleKind({ dialog: dialog({ open_shop: "s" }) })).toBe("merchant");
    expect(npcRoleKind({ dialog: dialog({ bless: { blessing: "b" } }) })).toBe("healer");
    expect(npcRoleKind({ dialog: dialog({ heal: true }) })).toBe("healer");
    expect(npcRoleKind({ dialog: dialog({ train_skill: { skill: "sword", level: 3 } }) })).toBe(
      "trainer",
    );
    expect(npcRoleKind({ dialog: dialog({ start_quest: "q" }) })).toBe("quest_giver");
    expect(
      npcRoleKind({ dialog: { nodes: { sail: { text: "t", boat_routes: true, options: [] } } } }),
    ).toBe("captain");
  });

  it("reads a list of actions too", () => {
    expect(npcRoleKind({ dialog: dialog([{ give_xp: 5 }, { start_quest: "q" }]) })).toBe(
      "quest_giver",
    );
  });

  it("takes the most telling service of several", () => {
    const npc = {
      shop: { id: "s" },
      dialog: {
        nodes: {
          a: { text: "t", boat_routes: true, options: [{ action: { start_quest: "q" } }] },
        },
      },
    };
    expect(npcRoleKind(npc)).toBe("captain");
    expect(npcRoleKind({ shop: { id: "s" }, dialog: dialog({ bless: {} }) })).toBe("merchant");
  });

  it("has none for an NPC that only talks", () => {
    expect(npcRoleKind({ dialog: dialog({ close: true }, { give_item: "x" }) })).toBeUndefined();
    expect(npcRoleKind({})).toBeUndefined();
    expect(npcRoleKind(undefined)).toBeUndefined();
  });
});

describe("npcRoleKey", () => {
  it("is the NPC's own role when it names one", () => {
    expect(npcRoleKey({ role: "npc.x.role", shop: { id: "s" } })).toBe("npc.x.role");
  });

  it("is the default of its services otherwise", () => {
    expect(npcRoleKey({ shop: { id: "s" } })).toBe("npc_role.merchant");
    for (const kind of NPC_ROLE_KINDS) expect(npcRoleDefaultKey(kind)).toBe(`npc_role.${kind}`);
  });

  it("is undefined with neither", () => {
    expect(npcRoleKey({ dialog: dialog({ close: true }) })).toBeUndefined();
  });
});

describe("the NPCs of data/npcs", () => {
  const dir = join(REPO, "data", "npcs");
  const npcs = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
  const texts = Object.fromEntries(
    LANGUAGES.map((lang) => [
      lang,
      parseYaml(readFileSync(join(REPO, "i18n", lang, "npcs.yaml"), "utf8")) as Record<
        string,
        string
      >,
    ]),
  );

  it("all end up with a role text in every language", () => {
    expect(npcs.length).toBeGreaterThanOrEqual(20);
    for (const npc of npcs) {
      const key = npcRoleKey(npc);
      expect(key, String(npc["id"])).toBeDefined();
      for (const lang of LANGUAGES) {
        const text = texts[lang]?.[key ?? ""];
        expect(text, `${String(npc["id"])} ${lang}`).toBeTruthy();
        expect([...(text ?? "")].length).toBeLessThanOrEqual(NPC_ROLE_MAX_CHARS);
      }
    }
  });

  it("have a default text for every kind of service", () => {
    for (const kind of NPC_ROLE_KINDS)
      for (const lang of LANGUAGES) expect(texts[lang]?.[npcRoleDefaultKey(kind)]).toBeTruthy();
  });

  it("are named by their name alone: no role after a comma, nothing the label would cut", () => {
    for (const npc of npcs)
      for (const lang of LANGUAGES) {
        const name = texts[lang]?.[String(npc["name"])] ?? "";
        expect(name, String(npc["id"])).not.toBe("");
        expect(name).not.toContain(",");
        expect([...name].length).toBeLessThanOrEqual(CREATURE_NAME_MAX_CHARS);
      }
  });

  it("use the default for the priests that name none, and say so where a shop would win", () => {
    const by = (id: string) => npcs.find((n) => n["id"] === id);
    expect(by("puerto_priest")?.["role"]).toBeUndefined();
    expect(npcRoleKey(by("puerto_priest"))).toBe("npc_role.healer");
    // She keeps a shop too: the default would call her a merchant.
    expect(npcRoleKind(by("volcan_priest"))).toBe("merchant");
    expect(npcRoleKey(by("volcan_priest"))).toBe("npc_role.healer");
  });
});

describe("the monsters of data/monsters", () => {
  const dir = join(REPO, "data", "monsters");
  const monsters = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);

  it("are named whole on one line: at most CREATURE_NAME_MAX_CHARS, no ellipsis, in every language", () => {
    expect(monsters.length).toBeGreaterThanOrEqual(10);
    for (const lang of LANGUAGES) {
      const texts = parseYaml(
        readFileSync(join(REPO, "i18n", lang, "monsters.yaml"), "utf8"),
      ) as Record<string, string>;
      for (const m of monsters) {
        const name = texts[String(m["name"])] ?? "";
        expect(name, `${String(m["id"])} ${lang}`).not.toBe("");
        expect([...name].length, `${name} (${lang})`).toBeLessThanOrEqual(CREATURE_NAME_MAX_CHARS);
        expect(name).not.toContain("…");
      }
    }
  });
});

describe("the kill steps of data/quests", () => {
  const dir = join(REPO, "data", "quests");
  const quests = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
  const catalog = (lang: string, file: string): Record<string, string> =>
    parseYaml(readFileSync(join(REPO, "i18n", lang, file), "utf8")) as Record<string, string>;

  // The journal says "Mata 10 salamandras ígneas" and the label over the monster says
  // "salamandra ígnea": a monster renamed in monsters.yaml alone left the two apart.
  it("name the monster as its label does, in every language", () => {
    let kills = 0;
    for (const lang of LANGUAGES) {
      const monsters = catalog(lang, "monsters.yaml");
      const texts = catalog(lang, "quests.yaml");
      for (const q of quests)
        for (const step of (q["steps"] ?? []) as Record<string, unknown>[]) {
          const kill = (step["complete_when"] as { kill?: { monster?: string } } | undefined)?.kill;
          if (!kill?.monster) continue;
          kills++;
          const name = monsters[`monster.${kill.monster}.name`] ?? "";
          const text = (texts[String(step["description"])] ?? "").toLowerCase();
          expect(name, kill.monster).not.toBe("");
          // Each word of the name, less its last letter (plurals: "cenizo" in "cenizos").
          for (const word of name
            .toLowerCase()
            .split(" ")
            .filter((w) => w.length > 3))
            expect(text, `${String(step["description"])} (${lang}) names "${name}"`).toContain(
              [...word].slice(0, -1).join(""),
            );
        }
    }
    expect(kills).toBeGreaterThanOrEqual(10);
  });
});
