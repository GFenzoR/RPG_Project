// Lote 11: the compact equipment catalog (docs/02 "Catálogo de equipo"). The owner asked
// for few items (about 60-80 equipables in all), a small clear set per vocation and level
// band from level 1 to 100+, every piece with its level. These checks keep it that way
// when the island lotes add bands: a new piece follows the band formula below (the same as
// docs/02), or the formula and docs/02 change together.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

interface Item {
  id: string;
  kind: string;
  weight?: number;
  value?: number;
  retired?: boolean;
  weapon?: { type: string; attack: number; defense?: number; hands?: number; range?: number };
  armor?: { slot: string; armor: number };
  shield?: { defense: number };
  requires?: { level?: number; vocations?: string[] };
}

type Line =
  | "sword"
  | "axe"
  | "club"
  | "bow"
  | "crossbow"
  | "wand"
  | "staff"
  | "shield"
  | "heavy"
  | "robe"
  | "head"
  | "legs"
  | "feet"
  | "amulet"
  | "ring";

/** The bands: the level a band's weapons and its other pieces ask for. */
const BANDS: { weapons: number; armor: number }[] = [
  { weapons: 1, armor: 1 },
  { weapons: 5, armor: 5 },
  { weapons: 10, armor: 15 },
  { weapons: 30, armor: 30 },
  { weapons: 50, armor: 50 },
  { weapons: 75, armor: 75 },
];

/** Base numbers per band (index 0 = band 1); undefined: the band has no such piece. */
const MELEE = [10, 13, 22, 29, 36, 43];
const BOW = [2, 7, 12, 17, 22, 27];
const WAND = [8, 13, 21, 30, 39, 48];
const SHIELD = [9, 12, 18, 22, 26, 30];
const HEAVY = [undefined, undefined, 6, 8, 10, 12];
const ROBE = [2, undefined, 3, 4, 5, 6];
const LIMB = [1, undefined, 2, 3, 4, 5]; // head, legs and feet
const AMULET = [undefined, undefined, 1, 1, 2, 2];
const RING = [undefined, undefined, 0, 0, 1, 1];
const VALUE = [30, 150, 600, 2000, 5000, 12000]; // a band's weapon

/** Lines each band has (band 1: the starting kit; band 2: weapons and the shield). */
const WEAPON_LINES: Line[] = ["sword", "axe", "club", "bow", "crossbow", "wand", "staff"];
const ARMOR_LINES: Line[] = ["shield", "heavy", "robe", "head", "legs", "feet", "amulet", "ring"];
const BAND_LINES: Line[][] = [
  ["sword", "axe", "club", "bow", "wand", "staff", "shield", "robe", "head", "legs", "feet"],
  ["sword", "axe", "club", "bow", "wand", "staff", "shield"],
  [...WEAPON_LINES, ...ARMOR_LINES],
  [...WEAPON_LINES, ...ARMOR_LINES],
  [...WEAPON_LINES, ...ARMOR_LINES],
  [...WEAPON_LINES, ...ARMOR_LINES],
];

/** Bands up to this one can be had today; the higher ones wait for their islands. */
const OBTAINABLE_BANDS = 4;

/** Rounds a price like the catalog: to 5 under 100, 10 under 1000, 50 under 5000, else 100. */
function nice(v: number): number {
  const step = v < 100 ? 5 : v < 1000 ? 10 : v < 5000 ? 50 : 100;
  return Math.round(v / step) * step;
}

function lineOf(it: Item): Line | undefined {
  const voc = it.requires?.vocations ?? [];
  if (it.weapon) {
    const t = it.weapon.type;
    if (t === "sword" || t === "axe" || t === "club") return t;
    if (t === "distance") return it.weapon.hands === 2 ? "bow" : "crossbow";
    if (t === "wand") return voc.includes("druid") ? "staff" : "wand";
  }
  if (it.shield) return "shield";
  switch (it.armor?.slot) {
    case "body":
      return voc.length > 0 ? "heavy" : "robe";
    case "head":
    case "legs":
    case "feet":
      return it.armor.slot;
    case "neck":
      return "amulet";
    case "ring":
      return "ring";
  }
  return undefined;
}

/** What the formula of docs/02 says a piece of line in band b (1-based) is. */
function expected(line: Line, b: number): Record<string, number | undefined> {
  const i = b - 1;
  const a = MELEE[i] ?? NaN;
  const value = (f: number): number => nice((VALUE[i] ?? NaN) * f);
  switch (line) {
    case "sword":
      return { attack: a, defense: Math.round(0.5 * a), weight: 1000 + 100 * i, value: value(1) };
    case "club":
      return {
        attack: a + 1,
        defense: Math.round(0.4 * a),
        weight: 700 + 350 * i,
        value: value(1),
      };
    case "axe":
      return {
        attack: a + 2,
        defense: Math.round(0.3 * a),
        weight: 900 + 250 * i,
        value: value(1),
      };
    case "bow":
      return { attack: BOW[i], range: b === 1 ? 5 : 6, weight: 700 + 100 * i, value: value(1) };
    case "crossbow":
      return {
        attack: (BOW[i] ?? NaN) - 4,
        range: 5,
        weight: 3000 + 250 * (b - 3),
        value: value(0.9),
      };
    case "wand":
      return { attack: WAND[i], range: 4, weight: 300 + 20 * i, value: value(1) };
    case "staff":
      return { attack: WAND[i], range: 4, weight: 1500 + 100 * i, value: value(1) };
    case "shield":
      return { defense: SHIELD[i], weight: 3000 + 600 * i, value: value(0.75) };
    case "heavy":
      return { armor: HEAVY[i], weight: 4000 + 5000 * (b - 3), value: value(0.9) };
    case "robe":
      return { armor: ROBE[i], weight: 1400 + 100 * i, value: value(0.6) };
    case "head":
      return { armor: LIMB[i], weight: 200 + 480 * i, value: value(0.4) };
    case "legs":
      return { armor: LIMB[i], weight: 700 + 750 * i, value: value(0.4) };
    case "feet":
      return { armor: LIMB[i], weight: 1000 + 300 * i, value: value(0.4) };
    case "amulet":
      return { armor: AMULET[i], weight: 60, value: value(0.8) };
    case "ring":
      return { armor: RING[i], weight: 15, value: value(0.6) };
  }
}

function actual(it: Item): Record<string, number | undefined> {
  return {
    ...(it.weapon
      ? it.weapon.type === "sword" || it.weapon.type === "axe" || it.weapon.type === "club"
        ? { attack: it.weapon.attack, defense: it.weapon.defense ?? 0 }
        : { attack: it.weapon.attack, range: it.weapon.range }
      : {}),
    ...(it.shield ? { defense: it.shield.defense } : {}),
    ...(it.armor ? { armor: it.armor.armor } : {}),
    weight: it.weight,
    value: it.value,
  };
}

function readList<T>(dir: string, root = REPO): T[] {
  const out: T[] = [];
  for (const f of readdirSync(join(root, dir))
    .filter((n) => n.endsWith(".yaml"))
    .sort()) {
    const data: unknown = parse(readFileSync(join(root, dir, f), "utf8"));
    if (Array.isArray(data)) out.push(...(data as T[]));
    else if (data && typeof data === "object") out.push(data as T);
  }
  return out;
}

const items = readList<Item>("data/items");
const equip = items.filter((it) => ["weapon", "armor", "shield"].includes(it.kind));
const catalog = equip.filter((it) => !it.retired);

/** Band (1-based) of an item from its level, or 0 if no band starts there for its kind. */
function bandOf(it: Item): number {
  const lvl = it.requires?.level ?? 0;
  const i = BANDS.findIndex((b) => (it.weapon ? b.weapons : b.armor) === lvl);
  return i + 1;
}

/**
 * Every item some source gives: shops, dialogs, loot, resources, reward chests, recipes,
 * quest and tutorial rewards, conjuring spells and the starting container (the sources the
 * validator refuses for a retired item, checkRetiredItems), in the data/ under root.
 */
function sources(root = REPO): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: unknown, where: string): void => {
    if (typeof id !== "string") return;
    out.set(id, [...(out.get(id) ?? []), where]);
  };
  const npcs = readList<Record<string, unknown>>("data/npcs", root);
  for (const npc of npcs) {
    const shop = npc["shop"] as { sells?: { item: string }[] } | undefined;
    for (const o of shop?.sells ?? []) add(o.item, `shop of ${String(npc["id"])}`);
    for (const m of JSON.stringify(npc["dialog"] ?? {}).matchAll(/"give_item":"([a-z0-9_]+)"/g))
      add(m[1], `dialog of ${String(npc["id"])}`);
  }
  for (const m of readList<{ id: string; loot?: { item: string }[] }>("data/monsters", root))
    for (const l of m.loot ?? []) add(l.item, `loot of ${m.id}`);
  for (const q of readList<{ id: string; rewards?: { item?: string }[] }>("data/quests", root))
    for (const r of q.rewards ?? []) add(r.item, `reward of ${q.id}`);
  const recipes = parse(readFileSync(join(root, "data/recipes.yaml"), "utf8")) as {
    id: string;
    output: { item: string };
  }[];
  for (const r of recipes) add(r.output.item, `recipe ${r.id}`);
  for (const it of readList<
    Item & {
      resource?: { drops?: { item: string }[] };
      chest?: { rewards?: { item: string }[] };
    }
  >("data/items", root)) {
    for (const d of it.resource?.drops ?? []) add(d.item, `resource ${it.id}`);
    for (const r of it.chest?.rewards ?? []) add(r.item, `chest ${it.id}`);
  }
  const yamlAt = <T>(file: string): T => parse(readFileSync(join(root, "data", file), "utf8")) as T;
  for (const r of yamlAt<{ rewards?: { item?: string }[] }>("tutorial.yaml").rewards ?? [])
    add(r.item, "tutorial reward");
  for (const sp of yamlAt<{ id: string; effect?: { conjure?: { item: string } } }[]>("spells.yaml"))
    add(sp.effect?.conjure?.item, `spell ${sp.id}`);
  const balance = yamlAt<{ inventory?: { start_container?: string } }>("balance.yaml");
  add(balance.inventory?.start_container, "start_container");
  return out;
}

describe("compact equipment catalog (lote 11)", () => {
  it("has about 60-80 pieces, retired ones apart", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(60);
    expect(catalog.length).toBeLessThanOrEqual(80);
  });

  it("has one piece per line and band, at the level of its band", () => {
    const seen = new Map<string, string>();
    for (const it of catalog) {
      const line = lineOf(it);
      const b = bandOf(it);
      expect(line, `${it.id}: no line`).toBeDefined();
      expect(b, `${it.id}: level ${String(it.requires?.level)} starts no band`).toBeGreaterThan(0);
      expect(BAND_LINES[b - 1], `${it.id}: band ${b} has no ${String(line)}`).toContain(line);
      const key = `${String(line)}@${b}`;
      expect(
        seen.get(key),
        `${it.id} and ${String(seen.get(key))} are both ${key}`,
      ).toBeUndefined();
      seen.set(key, it.id);
    }
    BAND_LINES.forEach((lines, i) => {
      for (const line of lines)
        expect(seen.has(`${line}@${i + 1}`), `band ${i + 1} ${line}`).toBe(true);
    });
  });

  it("follows the band formula of docs/02", () => {
    for (const it of catalog) {
      const line = lineOf(it);
      if (!line) continue;
      const want = expected(line, bandOf(it));
      const got = actual(it);
      for (const [k, v] of Object.entries(want)) expect(got[k], `${it.id}.${k}`).toBe(v);
    }
  });

  it("keeps the weight classes: heavy torso for the guardian and the ranger, the rest for all", () => {
    for (const it of catalog) {
      const line = lineOf(it);
      const voc = it.requires?.vocations;
      if (line === "heavy") expect(voc, it.id).toEqual(["guardian", "ranger"]);
      else if (line === "bow" || line === "crossbow") expect(voc, it.id).toEqual(["ranger"]);
      else if (line === "wand") expect(voc, it.id).toEqual(["arcanist"]);
      else if (line === "staff") expect(voc, it.id).toEqual(["druid"]);
      else expect(voc, it.id).toBeUndefined();
    }
  });

  it("gives the bands of today a source and none to the bands still without an island", () => {
    const src = sources();
    for (const it of catalog) {
      const b = bandOf(it);
      if (b <= OBTAINABLE_BANDS) expect(src.get(it.id), `${it.id} (band ${b})`).toBeDefined();
      else expect(src.get(it.id), `${it.id} (band ${b})`).toBeUndefined();
    }
  });

  it("finds every kind of source: tutorial rewards, conjuring, chests and the start container too", () => {
    // Review of lote 11: a band without an island must have no source at all, the ones the
    // validator refuses for a retired item included.
    const root = mkdtempSync(join(tmpdir(), "catalog-"));
    try {
      cpSync(join(REPO, "data"), join(root, "data"), { recursive: true });
      const tutorial = join(root, "data/tutorial.yaml");
      const text = readFileSync(tutorial, "utf8");
      expect(text).toContain("  - { gold: 20 }");
      writeFileSync(
        tutorial,
        text.replace("  - { gold: 20 }", "  - { gold: 20 }\n  - { item: wyrmfang_blade }"),
      );
      // A reward chest too (docs/02 "Libros y cofres").
      writeFileSync(
        join(root, "data/items/zz_chest.yaml"),
        "- { id: test_chest, kind: decoration, chest: { id: c, rewards: [{ item: tidesteel_sword, count: 1 }] } }",
      );
      const src = sources(root);
      expect(src.get("wyrmfang_blade")).toEqual(["tutorial reward"]);
      expect(src.get("tidesteel_sword")).toEqual(["chest test_chest"]);
      expect(src.get("arrow")).toContain("spell conjure_arrows");
      expect(src.get("backpack")).toContain("start_container");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is sold at its value or more and bought at a third or less (docs/02 'Economía')", () => {
    const value = new Map(equip.map((it) => [it.id, it.value ?? 0]));
    for (const npc of readList<{
      id: string;
      shop?: Record<string, { item: string; price: number }[]>;
    }>("data/npcs")) {
      for (const o of npc.shop?.["sells"] ?? []) {
        const v = value.get(o.item);
        if (v !== undefined) expect(o.price, `${npc.id} sells ${o.item}`).toBeGreaterThanOrEqual(v);
      }
      for (const o of npc.shop?.["buys"] ?? []) {
        const v = value.get(o.item);
        if (v !== undefined) expect(o.price, `${npc.id} buys ${o.item}`).toBeLessThanOrEqual(v / 3);
      }
    }
  });
});
