// Vite plugin: the game content the client needs, read from the repository at build time.
//
//   virtual:rpg-content  items by numeric ID (data/items + data/ids.lock.yaml), movement
//                        constants (data/balance.yaml), monster/NPC sprites, outfits
//                        (data/outfits.yaml), cosmetics (data/cosmetics.yaml) and the
//                        client's i18n catalogs
//   /audio/<file>        sound files of assets/sounds.yaml (T3.7), served as they are;
//                        `vite build` emits them under audio/
//   virtual:rpg-site     the public website (T4.3): its i18n catalogs, vocations, skill ids
//                        (highscore categories), the posts of data/news and the credits
//                        of /credits (vite/credits.ts)
//   virtual:rpg-credits  the same credits for the game page (docs/17 A1: the desktop app
//                        shows them inside the app), imported only when they are opened
//   /atlas/<file>        sprite atlas built from assets/ with tools/spritepack (dev server);
//                        `vite build` emits the same files under atlas/
//
// The client never reads world/: the map arrives from the server (FullMapView, MapSlice).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readBorders } from "@rpg/map-format";
import { borderItems } from "@rpg/map-format/ops";
import { buildAtlas, writeAtlas } from "@rpg/spritepack";
import { loadCredits } from "./credits.ts";
import type { Plugin } from "vite";
import { parse } from "yaml";
import type {
  AttributeDef,
  ClientContent,
  CosmeticDef,
  LookOptions,
  DialogTopic,
  ForgeRules,
  NameEffectStyle,
  IslandRect,
  ItemDef,
  NewsPost,
  OutfitDef,
  SiteContent,
  LoopRules,
  MusicFades,
  MusicRules,
  QuestMusic,
  RecipeDef,
  SoundDef,
  SoundManifest,
  SpellDef,
} from "../src/content-types.ts";
import type { LayerSlot, Look, LookTables, Worn, WornPiece } from "@rpg/renderer/look";

/** The worn slots (packages/renderer look.ts WORN_SLOTS; types only from there at build time). */
const WORN_SLOTS = ["head", "torso", "legs", "feet", "shield", "weapon"] as const;

const VIRTUAL_ID = "virtual:rpg-content";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const SITE_ID = "virtual:rpg-site";
const CREDITS_ID = "virtual:rpg-credits";
const RESOLVED_CREDITS_ID = "\0" + CREDITS_ID;
/** The site catalog keys the game page carries, for the credits it can show (A1). */
export const GAME_SITE_KEYS = /^site\.credits\./;
const RESOLVED_SITE_ID = "\0" + SITE_ID;
/** i18n catalogs of the website (all keys). */
const SITE_CATALOGS = [
  "client.yaml",
  "vocations.yaml",
  "site.yaml",
  "world.yaml",
  "cosmetics.yaml",
];
const NEWS_FILE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.yaml$/;
const LANGUAGES = ["es", "en"];
/** i18n catalogs the client uses (all keys), and those it only takes names from. */
const CATALOGS = [
  "client.yaml",
  // The texts of the books and scrolls (docs/02 "Libros y cofres"): read without the server.
  "books.yaml",
  "vocations.yaml",
  "dialog.yaml",
  "npcs.yaml",
  "tutorial.yaml",
  "cosmetics.yaml",
  // Every key: the quest log (ui/Quests.tsx) shows each step's text, not only names.
  "quests.yaml",
];
const NAME_CATALOGS = ["monsters.yaml", "items.yaml", "spells.yaml", "world.yaml"];
const ATLAS_FILE = /^atlas(-\d+)?\.(png|json)$/;

export const repoRoot = (): string =>
  resolve(process.env["RPG_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url)));

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readYaml = (file: string): unknown => parse(readFileSync(file, "utf8")) as unknown;

/** Builds the content module from data/ and i18n/ under root. Throws on unreadable data. */
export function loadClientContent(root: string): ClientContent {
  const lock = readYaml(join(root, "data", "ids.lock.yaml"));
  const ids = isObj(lock) && isObj(lock["items"]) ? lock["items"] : {};
  const items: Record<number, ItemDef> = {};
  /** i18n keys of the item descriptions: looking at an item shows its text. */
  const descKeys = new Set<string>();
  /**
   * Items whose `name` is a shared key (border pieces, the signs' "sign"): the client names
   * items by item.<id>.name, so that key gets the shared text.
   */
  const sharedNames = new Map<string, string>();
  /** The border pieces of data/borders.yaml (docs/06 "Bordes"): never a tile's top item. */
  const bordersFile = join(root, "data", "borders.yaml");
  const borders = existsSync(bordersFile)
    ? borderItems(readBorders(readYaml(bordersFile)))
    : new Set<string>();
  const dir = join(root, "data", "items");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const list = readYaml(join(dir, file));
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!isObj(raw) || typeof raw["id"] !== "string") continue;
      const num = ids[raw["id"]];
      if (typeof num !== "number") continue; // make validate reports items without an ID
      const ground = isObj(raw["ground"]) ? raw["ground"] : undefined;
      const desc = typeof raw["description"] === "string" ? raw["description"] : "";
      if (desc !== "") descKeys.add(desc);
      const name = raw["name"];
      if (typeof name === "string" && name !== `item.${raw["id"]}.name`)
        sharedNames.set(`item.${raw["id"]}.name`, name);
      items[num] = {
        id: raw["id"],
        sprite: typeof raw["sprite"] === "string" ? raw["sprite"] : "",
        ground: ground !== undefined,
        walkable: ground?.["walkable"] === true,
        // A wall blocks unless it says otherwise, as in packages/map-format, the content
        // validator and mapcompile (content.test.ts checks the parity).
        blocks:
          raw["blocks_movement"] === true ||
          (raw["kind"] === "wall" && raw["blocks_movement"] !== false),
        speed: typeof ground?.["speed"] === "number" ? ground["speed"] : 100,
        stackable: raw["stackable"] === true,
        slots:
          isObj(raw["container"]) && typeof raw["container"]["slots"] === "number"
            ? raw["container"]["slots"]
            : 0,
        useWith: raw["kind"] === "tool",
        tradeable: raw["tradeable"] === true,
        marketable:
          raw["tradeable"] === true && raw["kind"] !== "currency" && raw["pickupable"] !== false,
        toolUse:
          isObj(raw["tool"]) && typeof raw["tool"]["use"] === "string" ? raw["tool"]["use"] : "",
        ...(desc !== "" ? { desc } : {}),
        ...(isObj(raw["portal"]) ? { portal: true as const } : {}),
        ...(isObj(raw["door"]) ? { door: true as const } : {}),
        ...(borders.has(raw["id"]) ? { border: true as const } : {}),
        ...(typeof raw["elevation"] === "number" && raw["elevation"] > 0
          ? { elevation: raw["elevation"] }
          : {}),
        ...cardFields(raw),
      };
    }
  }
  const attributes = loadAttributes(root);
  // The attributes' card lines live in items.yaml (attribute.*): the client takes them too.
  for (const a of Object.values(attributes)) descKeys.add(a.text);
  const balance = readYaml(join(root, "data", "balance.yaml"));
  const mv = isObj(balance) && isObj(balance["movement"]) ? balance["movement"] : {};
  const num = (v: unknown, def: number): number => (typeof v === "number" ? v : def);
  const chat = isObj(balance) && isObj(balance["chat"]) ? balance["chat"] : {};
  const guild = isObj(balance) && isObj(balance["guild"]) ? balance["guild"] : {};
  const xp = isObj(balance) && isObj(balance["experience"]) ? balance["experience"] : {};
  const curve = isObj(xp["curve"]) ? xp["curve"] : {};
  const i18n: Record<string, Record<string, string>> = {};
  for (const lang of LANGUAGES) {
    const texts: Record<string, string> = {};
    for (const name of [...CATALOGS, ...NAME_CATALOGS]) {
      const namesOnly = NAME_CATALOGS.includes(name);
      let cat: unknown;
      try {
        cat = readYaml(join(root, "i18n", lang, name));
      } catch {
        continue; // a catalog that does not exist yet (make validate checks i18n/)
      }
      if (isObj(cat))
        for (const [k, v] of Object.entries(cat))
          if (typeof v === "string" && (!namesOnly || k.endsWith(".name") || descKeys.has(k)))
            texts[k] = v;
    }
    for (const [key, shared] of sharedNames) {
      const text = texts[shared];
      if (text !== undefined) texts[key] ??= text;
    }
    // The credits' sentences (docs/17 A1): the desktop app shows them without the site.
    const site = readYaml(join(root, "i18n", lang, "site.yaml"));
    if (isObj(site))
      for (const [k, v] of Object.entries(site))
        if (typeof v === "string" && GAME_SITE_KEYS.test(k)) texts[k] = v;
    i18n[lang] = texts;
  }
  const monsters: Record<string, string> = {};
  const mdir = join(root, "data", "monsters");
  for (const file of readdirSync(mdir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const m = readYaml(join(mdir, file));
    if (!isObj(m) || typeof m["id"] !== "string") continue;
    if (typeof m["sprite"] === "string") monsters[m["id"]] = m["sprite"];
  }
  const npcs: Record<string, string> = {};
  const ndir = join(root, "data", "npcs");
  for (const file of readdirSync(ndir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const n = readYaml(join(ndir, file));
    if (!isObj(n) || typeof n["id"] !== "string") continue;
    if (typeof n["sprite"] === "string") npcs[n["id"]] = n["sprite"];
  }
  const outfits = loadOutfits(root);
  const looks = loadLooks(root);
  const lookOptions = loadLookOptions(root);
  const vocs = readYaml(join(root, "data", "vocations.yaml"));
  const vocations = Array.isArray(vocs)
    ? vocs.flatMap((v) => (isObj(v) && typeof v["id"] === "string" ? [v["id"]] : []))
    : [];
  let rawSpells: unknown;
  try {
    rawSpells = readYaml(join(root, "data", "spells.yaml"));
  } catch {
    rawSpells = []; // no spells yet
  }
  const spells: SpellDef[] = Array.isArray(rawSpells)
    ? rawSpells.flatMap((s) =>
        isObj(s) && typeof s["id"] === "string"
          ? [
              {
                id: s["id"],
                words: typeof s["words"] === "string" ? s["words"] : "",
                group: typeof s["group"] === "string" ? s["group"] : "",
                level: num(s["level"], 1),
                magicLevel: num(s["magic_level"], 0),
                mana: num(s["mana"], 0),
                vocations: Array.isArray(s["vocations"])
                  ? s["vocations"].filter((v): v is string => typeof v === "string")
                  : [],
                aimsAtPlayer:
                  isObj(s["effect"]) &&
                  isObj(s["effect"]["heal"]) &&
                  num(s["effect"]["heal"]["range"], 0) > 0,
              },
            ]
          : [],
      )
    : [];
  let rawRecipes: unknown;
  try {
    rawRecipes = readYaml(join(root, "data", "recipes.yaml"));
  } catch {
    rawRecipes = []; // no recipes yet
  }
  const stack = (v: unknown): { itemId: number; count: number } | undefined => {
    if (!isObj(v) || typeof v["item"] !== "string") return undefined;
    const n = ids[v["item"]];
    return typeof n === "number" ? { itemId: n, count: num(v["count"], 1) } : undefined;
  };
  const recipes: RecipeDef[] = Array.isArray(rawRecipes)
    ? rawRecipes.flatMap((r) => {
        if (!isObj(r) || typeof r["id"] !== "string" || typeof r["station"] !== "string") return [];
        const station = ids[r["station"]];
        const output = stack(r["output"]);
        const inputs = Array.isArray(r["inputs"]) ? r["inputs"].map(stack) : [];
        if (typeof station !== "number" || !output || inputs.some((i) => !i)) return [];
        return [
          {
            id: r["id"],
            craft: typeof r["craft"] === "string" ? r["craft"] : "",
            station,
            tool: typeof r["tool"] === "string" ? r["tool"] : "",
            level: num(r["level"], 0),
            timeMs: num(r["time_ms"], 0),
            inputs: inputs.filter((i) => i !== undefined),
            output,
            baseSuccess: num(r["base_success"], 0),
            successPerLevel: num(r["success_per_level"], 0),
            maxSuccess: num(r["max_success"], 1),
          },
        ];
      })
    : [];
  const forge = loadForge(balance, ids);
  return {
    items,
    attributes,
    monsterSprites: monsters,
    // A topic conflict is the content test's to report (vite/content.test.ts): the build
    // keeps the first topic.
    dialogTopics: dialogTopics(root).topics,
    npcSprites: npcs,
    outfits,
    ...(looks ? { looks } : {}),
    ...(lookOptions ? { lookOptions } : {}),
    cosmetics: loadCosmetics(root),
    vocations,
    spells,
    recipes,
    ...(forge ? { forge } : {}),
    movement: {
      baseStepMs: num(mv["base_step_ms"], 1000),
      diagonalCost: num(mv["diagonal_cost"], 1.5),
      maxPathTiles: num(mv["max_path_tiles"], 100),
    },
    chat: { maxLength: num(chat["max_length"], 255) },
    experience: {
      a: num(curve["a"], 0),
      b: num(curve["b"], 0),
      c: num(curve["c"], 0),
      d: num(curve["d"], 0),
      maxLevel: num(xp["max_level"], 0),
    },
    guild: {
      foundCost: num(guild["found_cost"], 0),
      foundMinLevel: num(guild["found_min_level"], 1),
      nameMax: num(guild["name_max"], 32),
      motdMax: num(guild["motd_max"], 255),
    },
    sounds: loadSounds(root),
    questMusic: loadQuestMusic(root),
    islands: loadIslands(root),
    houseDoors: loadHouseDoors(root),
    portals: loadPortals(root),
    i18n,
  };
}

/** The website's content (T4.3). make validate checks data/news against its schema. */
export function loadSiteContent(root: string): SiteContent {
  const i18n: Record<string, Record<string, string>> = {};
  for (const lang of LANGUAGES) {
    const texts: Record<string, string> = {};
    for (const name of SITE_CATALOGS) {
      // Every catalog is required: a missing one would publish raw keys.
      const cat = readYaml(join(root, "i18n", lang, name));
      if (isObj(cat))
        for (const [k, v] of Object.entries(cat)) if (typeof v === "string") texts[k] = v;
    }
    i18n[lang] = texts;
  }
  const vocs = readYaml(join(root, "data", "vocations.yaml"));
  const vocations = Array.isArray(vocs)
    ? vocs.flatMap((v) => (isObj(v) && typeof v["id"] === "string" ? [v["id"]] : []))
    : [];
  const balance = readYaml(join(root, "data", "balance.yaml"));
  const base =
    isObj(balance) && isObj(balance["skills"]) && isObj(balance["skills"]["base"])
      ? balance["skills"]["base"]
      : {};
  const texts = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (isObj(v)) for (const [k, t] of Object.entries(v)) if (typeof t === "string") out[k] = t;
    return out;
  };
  const news: NewsPost[] = [];
  const dir = join(root, "data", "news");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    // no news yet
  }
  for (const file of files) {
    const m = NEWS_FILE.exec(file);
    if (!m) continue;
    const raw = readYaml(join(dir, file));
    if (!isObj(raw)) continue;
    news.push({
      slug: file.slice(0, -".yaml".length),
      date: m[1] ?? "",
      title: texts(raw["title"]),
      body: texts(raw["body"]),
    });
  }
  news.sort((a, b) => (a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0));
  return {
    i18n,
    vocations,
    skills: Object.keys(base),
    news,
    cosmetics: loadCosmetics(root),
    outfits: loadOutfits(root),
    credits: loadCredits(root),
  };
}

/**
 * What the item card shows of an item of data/items (docs/17 UI-6): kind, weight and the
 * blocks of its kind. Display only: the server keeps the rules. Fields that are empty
 * stay out, so the content module does not grow with zeros.
 */
export function cardFields(raw: Record<string, unknown>): Partial<ItemDef> {
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const out: Partial<ItemDef> = {};
  const worn = wornPiece(raw["worn"]);
  if (worn) out.worn = worn;
  if (typeof raw["kind"] === "string") out.kind = raw["kind"];
  if (n(raw["weight"]) > 0) out.weight = n(raw["weight"]);
  const w = raw["weapon"];
  if (isObj(w))
    out.weapon = {
      type: s(w["type"]),
      attack: n(w["attack"]),
      defense: n(w["defense"]),
      hands: n(w["hands"]) || 1,
      range: n(w["range"]),
      element: s(w["element"]),
      ammo: s(w["ammo"]),
    };
  const a = raw["ammo"];
  if (isObj(a)) out.ammo = { type: s(a["type"]), attack: n(a["attack"]) };
  const ar = raw["armor"];
  if (isObj(ar)) out.armor = { slot: s(ar["slot"]), armor: n(ar["armor"]) };
  const sh = raw["shield"];
  if (isObj(sh)) out.shield = { defense: n(sh["defense"]) };
  const c = raw["consumable"];
  if (isObj(c))
    out.consumable = { healHp: n(c["heal_hp"]), healMp: n(c["heal_mp"]), foodMs: n(c["food_ms"]) };
  const r = raw["rune"];
  if (isObj(r))
    out.rune = { spell: s(r["spell"]), charges: n(r["charges"]), magicLevel: n(r["magic_level"]) };
  const q = raw["requires"];
  if (isObj(q))
    out.requires = {
      level: n(q["level"]),
      vocations: Array.isArray(q["vocations"])
        ? q["vocations"].filter((v): v is string => typeof v === "string")
        : [],
    };
  if (raw["pickupable"] === false) out.fixed = true;
  // A stash chest (docs/02 "Baúl de la cuenta") is used like a board: it opens a window.
  if (raw["market_board"] === true || raw["stash"] === true) out.board = true;
  if (raw["quest"] === true) out.quest = true;
  const b = raw["book"];
  if (isObj(b) && typeof b["title"] === "string" && Array.isArray(b["pages"]))
    out.book = {
      title: b["title"],
      pages: b["pages"].filter((p): p is string => typeof p === "string"),
    };
  if (isObj(raw["chest"])) out.chest = true;
  return out;
}

/**
 * data/attributes.yaml by id (docs/02 "Atributos de items"): the text key of each
 * attribute's card line and its cap (what a refined jewel's card may add). No file: no
 * attributes; a file that does not parse fails the build (a card without its lines would
 * go unnoticed).
 */
export function loadAttributes(root: string): Record<string, AttributeDef> {
  const file = join(root, "data", "attributes.yaml");
  if (!existsSync(file)) return {};
  const raw = readYaml(file);
  const out: Record<string, AttributeDef> = {};
  for (const a of Array.isArray(raw) ? raw : []) {
    if (isObj(a) && typeof a["id"] === "string" && typeof a["text"] === "string")
      out[a["id"]] =
        typeof a["cap"] === "number" && a["cap"] > 0
          ? { text: a["text"], cap: a["cap"] }
          : { text: a["text"] };
  }
  return out;
}

/**
 * balance.yaml forge (docs/02 "Forja") with numeric item ids, for the forge window; undefined
 * when it is off or names an item without an id (the server would not start either).
 */
export function loadForge(balance: unknown, ids: Record<string, unknown>): ForgeRules | undefined {
  const f = isObj(balance) ? balance["forge"] : undefined;
  if (!isObj(f) || f["enabled"] !== true) return undefined;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const id = (v: unknown): number | undefined => {
    const x = typeof v === "string" ? ids[v] : undefined;
    return typeof x === "number" ? x : undefined;
  };
  const station = id(f["station"]);
  const protection = id(f["protection"]);
  const bonus = isObj(f["smithing_bonus"]) ? f["smithing_bonus"] : {};
  const levels = (Array.isArray(f["levels"]) ? f["levels"] : []).map((l: unknown) =>
    isObj(l) ? { chance: n(l["chance"]), stones: n(l["stones"]) } : { chance: 0, stones: 0 },
  );
  const bands: ForgeRules["bands"] = [];
  for (const b of Array.isArray(f["bands"]) ? f["bands"] : []) {
    const stone = isObj(b) ? id(b["stone"]) : undefined;
    if (!isObj(b) || stone === undefined) return undefined;
    bands.push({
      level: n(b["level"]),
      stone,
      gold: n(b["gold"]),
      attack: n(b["attack"]),
      armor: n(b["armor"]),
      defense: n(b["defense"]),
    });
  }
  if (
    station === undefined ||
    protection === undefined ||
    levels.length === 0 ||
    bands.length === 0
  )
    return undefined;
  return {
    station,
    safeLevel: n(f["safe_level"]),
    protection,
    smithingBonus: {
      skill: typeof bonus["skill"] === "string" ? bonus["skill"] : "",
      perLevels: n(bonus["per_levels"]),
      max: n(bonus["max"]),
    },
    jewelryPct: n(f["jewelry_pct"]),
    levels,
    bands,
  };
}

/** The topics a dialog option leads to, in the order they win when one looks ahead. */
const LOOKAHEAD: readonly DialogTopic[] = ["quests", "travel", "services"];
const TAGS = new Set<string>(["quests", "trade", "travel", "services", "talk"]);
const QUEST_ACTIONS = ["start_quest", "set_quest_step"];
const QUEST_CONDITIONS = ["quest_state", "quest_not_started"];
const SERVICE_ACTIONS = ["heal", "bless", "train_skill", "restore_mana"];

/** The objects of a field that is one object or a list of them (a dialog's if/action). */
const each = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const hasKey = (v: unknown, keys: readonly string[]): boolean =>
  each(v).some((o) => isObj(o) && keys.some((k) => k in o));

/**
 * The topic of one option by what it does itself (docs/17 UI-8): its `tag`, then "bye"
 * (close, dialog.bye), "back" (dialog.back), "trade" (open_shop), "quests" (a quest
 * condition or action), "services" (heal, bless...), "travel" (a teleport, or to a node with
 * boat routes), else "talk". `nodes` are the NPC's dialog nodes.
 */
export function ownTopic(o: Record<string, unknown>, nodes: Record<string, unknown>): DialogTopic {
  const tag = o["tag"];
  if (typeof tag === "string" && TAGS.has(tag)) return tag as DialogTopic;
  if (o["text"] === "dialog.bye" || each(o["action"]).includes("close")) return "bye";
  if (o["text"] === "dialog.back") return "back";
  if (hasKey(o["action"], ["open_shop"])) return "trade";
  if (hasKey(o["action"], QUEST_ACTIONS) || hasKey(o["if"], QUEST_CONDITIONS)) return "quests";
  if (hasKey(o["action"], SERVICE_ACTIONS)) return "services";
  if (hasKey(o["action"], ["teleport"])) return "travel";
  const to = typeof o["goto"] === "string" ? nodes[o["goto"]] : undefined;
  if (isObj(to) && to["boat_routes"] === true) return "travel";
  return "talk";
}

/**
 * The topic of each option text of each NPC (ClientContent.dialogTopics). A "talk" option
 * that leads to a node looks one step ahead: a quest, travel or service option there makes
 * it that topic ("Blessings?" → services). Trade does not count: a shop button sits in
 * many conversations. The options of a captain's boat routes are "travel". A text with two
 * topics in one NPC is an error (`conflicts`): an option `tag` settles it.
 */
export function dialogTopics(root: string): {
  topics: Record<string, Record<string, DialogTopic>>;
  conflicts: string[];
} {
  const topics: Record<string, Record<string, DialogTopic>> = {};
  const conflicts: string[] = [];
  const put = (npc: string, text: string, topic: DialogTopic): void => {
    const m = (topics[npc] ??= {});
    const had = m[text];
    if (had !== undefined && had !== topic) conflicts.push(`${npc}: ${text} (${had}, ${topic})`);
    else m[text] = topic;
  };
  const dir = join(root, "data", "npcs");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const npc = readYaml(join(dir, file));
    if (!isObj(npc) || typeof npc["id"] !== "string" || !isObj(npc["dialog"])) continue;
    const nodes = isObj(npc["dialog"]["nodes"]) ? npc["dialog"]["nodes"] : {};
    const optionsOf = (node: unknown): Record<string, unknown>[] =>
      isObj(node) && Array.isArray(node["options"]) ? node["options"].filter(isObj) : [];
    for (const node of Object.values(nodes))
      for (const o of optionsOf(node)) {
        if (typeof o["text"] !== "string") continue;
        let topic = ownTopic(o, nodes);
        if (topic === "talk" && typeof o["tag"] !== "string" && typeof o["goto"] === "string") {
          const ahead = optionsOf(nodes[o["goto"]]).map((x) => ownTopic(x, nodes));
          topic = LOOKAHEAD.find((t) => ahead.includes(t)) ?? "talk";
        }
        put(npc["id"], o["text"], topic);
      }
  }
  let routes: unknown;
  try {
    routes = readYaml(join(root, "data", "boat_routes.yaml"));
  } catch {
    routes = [];
  }
  for (const r of each(routes))
    if (isObj(r) && typeof r["captain"] === "string" && typeof r["text"] === "string")
      put(r["captain"], r["text"], "travel");
  return { topics, conflicts };
}

/** data/outfits.yaml (T0.5); [] without the file. The site shop previews them (T5.7). */
/** A data/ worn piece ({shape, tint}), or undefined. */
export function wornPiece(v: unknown): WornPiece | undefined {
  return isObj(v) && typeof v["shape"] === "string" && typeof v["tint"] === "string"
    ? { shape: v["shape"], tint: v["tint"] }
    : undefined;
}

/** A data/ worn set (head, torso, legs, feet, shield, weapon -> {shape, tint}). */
export function wornSet(v: unknown): Worn {
  const out: Worn = {};
  if (!isObj(v)) return out;
  for (const slot of WORN_SLOTS) {
    const p = wornPiece(v[slot]);
    if (p) out[slot] = p;
  }
  return out;
}

/** A data/ look (snake_case), or undefined when it is not one. */
export function lookOf(v: unknown): Look | undefined {
  if (!isObj(v)) return undefined;
  const s = (k: string): string | undefined => (typeof v[k] === "string" ? v[k] : undefined);
  const sex = s("sex");
  const body = s("body");
  const skin = s("skin");
  const hair = s("hair");
  const hairColor = s("hair_color");
  const beard = s("beard");
  if (!sex || !body || !skin || !hair || !hairColor || !beard) return undefined;
  return { sex, body, skin, hair, hairColor, beard };
}

/**
 * The choices of a player's look (docs/02 "Apariencia"), in the order of data/looks.yaml:
 * the pickers of the creation screen and the Apariencia window. Never a creatures_only
 * skin (the server refuses it too). Undefined without the file.
 */
export function loadLookOptions(root: string): LookOptions | undefined {
  let raw: unknown;
  try {
    raw = readYaml(join(root, "data", "looks.yaml"));
  } catch {
    return undefined;
  }
  if (!isObj(raw)) return undefined;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const skins = isObj(raw["skins"])
    ? Object.entries(raw["skins"]).flatMap(([id, d]) =>
        isObj(d) && d["creatures_only"] === true ? [] : [id],
      )
    : [];
  return {
    sexes: list(raw["sexes"]),
    builds: list(raw["builds"]),
    skins,
    hairStyles: list(raw["hair_styles"]),
    hairColors: isObj(raw["hair_colors"]) ? Object.keys(raw["hair_colors"]) : [],
    beards: list(raw["beards"]),
  };
}

/** "#rrggbb" to 0xrrggbb (white when it is not a colour). */
const hexColor = (v: unknown): number =>
  typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? parseInt(v.slice(1), 16) : 0xffffff;

/** data/looks.yaml (docs/06 "Looks") as the paper doll's tables; undefined without the file. */
export function loadLooks(root: string): LookTables | undefined {
  let raw: unknown;
  try {
    raw = readYaml(join(root, "data", "looks.yaml"));
  } catch {
    return undefined;
  }
  if (!isObj(raw)) return undefined;
  const colors = (v: unknown): Record<string, number> =>
    Object.fromEntries(
      Object.entries(isObj(v) ? v : {}).map(([k, c]) => [k, hexColor(isObj(c) ? c["color"] : c)]),
    );
  const hides: Record<string, LayerSlot[]> = {};
  for (const [shape, list] of Object.entries(isObj(raw["hides"]) ? raw["hides"] : {}))
    if (Array.isArray(list))
      hides[shape] = list.filter((x): x is LayerSlot => x === "hair" || x === "beard");
  return {
    skins: colors(raw["skins"]),
    hairColors: colors(raw["hair_colors"]),
    tints: colors(raw["tints"]),
    hides,
  };
}

/** An outfit's look, clothes and costume flag (docs/06 "Looks"), when it has a look. */
function outfitLook(o: Record<string, unknown>): Partial<OutfitDef> {
  const look = lookOf(o["look"]);
  if (!look) return {};
  const clothes = wornSet(o["clothes"]);
  return { look, clothes, ...(o["costume"] === true ? { costume: true } : {}) };
}

export function loadOutfits(root: string): OutfitDef[] {
  let rawOutfits: unknown;
  try {
    rawOutfits = readYaml(join(root, "data", "outfits.yaml"));
  } catch {
    rawOutfits = []; // no outfits yet
  }
  return Array.isArray(rawOutfits)
    ? rawOutfits.flatMap((o) =>
        isObj(o) && typeof o["id"] === "string" && typeof o["sprite"] === "string"
          ? [
              {
                id: o["id"],
                sprite: o["sprite"],
                frames: typeof o["frames"] === "number" ? o["frames"] : 1,
                ...outfitLook(o),
              },
            ]
          : [],
      )
    : [];
}

const COSMETIC_KINDS = new Set(["outfit", "outfit_color", "name_effect"]);
const NAME_STYLES = new Set(["gold", "ember", "frost"]);

/**
 * The cosmetics of data/cosmetics.yaml (T5.7) in file order; [] without the file. Only the
 * fields of each kind; make validate checks the file against its schema.
 */
export function loadCosmetics(root: string): CosmeticDef[] {
  let raw: unknown;
  try {
    raw = readYaml(join(root, "data", "cosmetics.yaml"));
  } catch {
    return []; // no shop content
  }
  const list = isObj(raw) && Array.isArray(raw["cosmetics"]) ? raw["cosmetics"] : [];
  return list.flatMap((c): CosmeticDef[] => {
    if (!isObj(c) || typeof c["id"] !== "string" || typeof c["kind"] !== "string") return [];
    const kind = c["kind"];
    if (!COSMETIC_KINDS.has(kind)) return [];
    const def: CosmeticDef = {
      id: c["id"],
      kind: kind as CosmeticDef["kind"],
      price: typeof c["price"] === "number" ? c["price"] : 0,
    };
    if (kind === "outfit" && typeof c["outfit"] === "string") def.outfit = c["outfit"];
    if (kind === "outfit_color" && typeof c["tint"] === "string") def.tint = c["tint"];
    if (kind === "name_effect" && typeof c["style"] === "string" && NAME_STYLES.has(c["style"]))
      def.style = c["style"] as NameEffectStyle;
    return [def];
  });
}

/** Where the sound files are served: /audio/<path under assets/>. */
export const AUDIO_PREFIX = "audio/";

const stringMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, id] of Object.entries(v)) if (typeof id === "string") out[k] = id;
  return out;
};

const loopRules = (v: unknown): LoopRules => {
  const l = isObj(v) ? v : {};
  return {
    fadeMs: typeof l["fade_ms"] === "number" ? l["fade_ms"] : 2000,
    islands: stringMap(l["islands"]),
    underground: typeof l["underground"] === "string" ? l["underground"] : undefined,
  };
};

/** The music's timings when sounds.yaml says nothing (audio/director.ts). */
export const MUSIC_DEFAULTS = {
  fades: { zone: 5000, bossIn: 1500, bossOut: 6000, title: 3000, next: 4000 },
  dwellMs: 3000,
  bossHoldMs: 5000,
  resumeMs: 180_000,
  gapMs: [6000, 15000] as [number, number],
};

const ms = (v: unknown, def: number): number => (typeof v === "number" && v >= 0 ? v : def);

const poolMap = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  if (isObj(v))
    for (const [id, list] of Object.entries(v)) {
      const ids = (Array.isArray(list) ? list : [list]).filter(
        (s): s is string => typeof s === "string",
      );
      if (ids.length > 0) out[id] = ids;
    }
  return out;
};

/** The music's rules: pools, the places that name them, and the director's timings. */
const musicRules = (v: unknown): MusicRules => {
  const l = isObj(v) ? v : {};
  const f = isObj(l["fades"]) ? l["fades"] : {};
  const d = MUSIC_DEFAULTS;
  const fades: MusicFades = {
    zone: ms(f["zone"], d.fades.zone),
    bossIn: ms(f["boss_in"], d.fades.bossIn),
    bossOut: ms(f["boss_out"], d.fades.bossOut),
    title: ms(f["title"], d.fades.title),
    next: ms(f["next"], d.fades.next),
  };
  const gap = Array.isArray(l["gap_ms"]) ? l["gap_ms"] : [];
  const gapMin = ms(gap[0], d.gapMs[0]);
  return {
    pools: poolMap(l["pools"]),
    islands: stringMap(l["islands"]),
    underground: typeof l["underground"] === "string" ? l["underground"] : undefined,
    title: typeof l["title"] === "string" ? l["title"] : undefined,
    bosses: stringMap(l["bosses"]),
    fades,
    dwellMs: ms(l["dwell_ms"], d.dwellMs),
    bossHoldMs: ms(l["boss_hold_ms"], d.bossHoldMs),
    resumeMs: ms(l["resume_ms"], d.resumeMs),
    gapMs: [gapMin, Math.max(gapMin, ms(gap[1], d.gapMs[1]))],
  };
};

const seconds = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && x >= 0) : undefined;

/** assets/sounds.yaml (make validate checks it); empty when there is none. */
export function loadSounds(root: string): SoundManifest {
  let raw: unknown;
  try {
    raw = readYaml(join(root, "assets", "sounds.yaml"));
  } catch {
    raw = {};
  }
  const m = isObj(raw) ? raw : {};
  const sounds: Record<string, SoundDef> = {};
  if (isObj(m["sounds"]))
    for (const [id, s] of Object.entries(m["sounds"])) {
      if (!isObj(s) || typeof s["file"] !== "string") continue;
      const ch = s["channel"];
      if (ch !== "sfx" && ch !== "ui" && ch !== "music" && ch !== "ambient") continue;
      const def: SoundDef = {
        url: AUDIO_PREFIX + s["file"],
        channel: ch,
        volume: typeof s["volume"] === "number" ? s["volume"] : 1,
        maxVoices: typeof s["max_voices"] === "number" ? s["max_voices"] : 3,
      };
      // A music track's measures (make music-gemini); none: a loop file.
      if (ch === "music" && typeof s["seconds"] === "number" && s["seconds"] > 0) {
        def.seconds = s["seconds"];
        def.end = typeof s["end"] === "number" ? Math.min(s["end"], s["seconds"]) : s["seconds"];
        def.entries = seconds(s["entries"]) ?? [];
      }
      sounds[id] = def;
    }
  const events: Record<string, string[]> = {};
  if (isObj(m["events"]))
    for (const [ev, v] of Object.entries(m["events"])) {
      const ids = (Array.isArray(v) ? v : [v]).filter(
        (id): id is string => typeof id === "string" && id in sounds,
      );
      if (ids.length > 0) events[ev] = ids;
    }
  return { sounds, events, music: musicRules(m["music"]), ambient: loopRules(m["ambient"]) };
}

/**
 * The music areas of important quests: the `music` block of data/quests/<id>.yaml (pool,
 * floors, rects; make validate checks it against the quest schema and sounds.yaml).
 */
export function loadQuestMusic(root: string): QuestMusic[] {
  const dir = join(root, "data", "quests");
  if (!existsSync(dir)) return [];
  const out: QuestMusic[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const q = readYaml(join(dir, file));
    if (!isObj(q) || typeof q["id"] !== "string" || !isObj(q["music"])) continue;
    const m = q["music"];
    if (typeof m["pool"] !== "string") continue;
    const floors = Array.isArray(m["floors"])
      ? m["floors"].filter((z): z is number => typeof z === "number")
      : [];
    const rects = (Array.isArray(m["rects"]) ? m["rects"] : []).flatMap((r) =>
      isObj(r) ? [{ x: num0(r["x"]), y: num0(r["y"]), w: num0(r["w"]), h: num0(r["h"]) }] : [],
    );
    if (floors.length > 0 && rects.length > 0)
      out.push({ quest: q["id"], pool: m["pool"], floors, rects });
  }
  return out;
}

function loadIslands(root: string): IslandRect[] {
  const w = readYaml(join(root, "world", "world.yaml"));
  const list = isObj(w) && Array.isArray(w["islands"]) ? w["islands"] : [];
  return list.flatMap((i) => {
    if (!isObj(i) || typeof i["id"] !== "string" || !isObj(i["rect"])) return [];
    const r = i["rect"];
    return [{ id: i["id"], x: num0(r["x"]), y: num0(r["y"]), w: num0(r["w"]), h: num0(r["h"]) }];
  });
}

/** Door tiles of every houses.yaml (T5.4), as "x,y,z"; make validate checks the files. */
function loadHouseDoors(root: string): string[] {
  const dir = join(root, "world", "islands");
  let islands: string[];
  try {
    islands = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of islands.sort()) {
    let raw: unknown;
    try {
      raw = readYaml(join(dir, id, "houses.yaml"));
    } catch {
      continue; // no houses on this island
    }
    if (!Array.isArray(raw)) continue;
    for (const h of raw)
      if (isObj(h) && Array.isArray(h["doors"]))
        for (const d of h["doors"])
          if (isObj(d)) out.push(`${num0(d["x"])},${num0(d["y"])},${num0(d["z"])}`);
  }
  return out;
}

const num0 = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * Entrance tile ("x,y,z") → kind of every portal of the islands world.yaml lists
 * (world/islands/<id>/portals.yaml, like mapcompile): the client keeps its paths off
 * stairs, holes and teleports and uses a bare ladder's ground (state/portals.ts). An island
 * without the file has no portals; a file that does not parse fails the build (make
 * validate names the error), rather than ship a client that walks onto stairs.
 */
export function loadPortals(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { id } of loadIslands(root)) {
    const file = join(root, "world", "islands", id, "portals.yaml");
    if (!existsSync(file)) continue;
    let raw: unknown;
    try {
      raw = readYaml(file);
    } catch (e) {
      throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!Array.isArray(raw)) continue;
    for (const p of raw)
      if (isObj(p) && isObj(p["from"]) && typeof p["kind"] === "string") {
        const f = p["from"];
        out[`${num0(f["x"])},${num0(f["y"])},${num0(f["z"])}`] = p["kind"];
      }
  }
  return out;
}

/**
 * The sound files to serve or emit: published path (as in SoundDef.url, not encoded) →
 * file on disk. Only what sounds.yaml lists, inside assets/ (make validate checks it too).
 */
export function soundFiles(root: string): Map<string, string> {
  const assets = resolve(root, "assets");
  const out = new Map<string, string>();
  for (const s of Object.values(loadSounds(root).sounds)) {
    const file = resolve(assets, s.url.slice(AUDIO_PREFIX.length));
    if (file.startsWith(assets + sep)) out.set(s.url, file);
  }
  return out;
}

/** Builds the sprite atlas into a fresh temporary directory and returns its files. */
function buildAtlasFiles(root: string): Map<string, Buffer> {
  const result = buildAtlas(root);
  for (const d of result.diagnostics)
    if (d.severity === "error") console.error(`[client] atlas: ${d.where}: ${d.message}`);
  if (!result.atlas) throw new Error("the sprite atlas has errors; run `make sprites` to see them");
  const out = mkdtempSync(join(tmpdir(), "rpg-client-atlas-"));
  try {
    writeAtlas(result.atlas, out);
    const files = new Map<string, Buffer>();
    for (const name of readdirSync(out))
      if (ATLAS_FILE.test(name)) files.set(name, readFileSync(join(out, name)));
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

export function rpgContent(): Plugin {
  const root = repoRoot();
  let atlas: Map<string, Buffer> | undefined;
  return {
    name: "rpg-client-content",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id === CREDITS_ID) return RESOLVED_CREDITS_ID;
      return id === SITE_ID ? RESOLVED_SITE_ID : undefined;
    },
    load(id) {
      // Read once per dev server start, like the game's content: restart to see a new post.
      if (id === RESOLVED_SITE_ID)
        return `export default ${JSON.stringify(loadSiteContent(root))};`;
      if (id === RESOLVED_CREDITS_ID) return `export default ${JSON.stringify(loadCredits(root))};`;
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(loadClientContent(root))};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://client");
        const path = url.pathname;
        // The game page (T4.3): /play serves play/index.html as it is, like Caddy (no
        // redirect; the page only uses root-absolute URLs).
        if (path === "/play") {
          req.url = "/play/" + url.search;
          return next();
        }
        if (req.method === "GET" && path.startsWith("/" + AUDIO_PREFIX)) {
          // Only files listed in sounds.yaml, read on each request (make sounds updates them).
          // The page encodes the URL (spaces in pack names); the lookup is an allowlist, so a
          // "../" in the request cannot reach anything else.
          let wanted = "";
          try {
            wanted = decodeURIComponent(path.slice(1));
          } catch {
            // malformed escape: 404 below
          }
          const file = soundFiles(root).get(wanted);
          if (!file) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("content-type", "audio/ogg");
          res.end(readFileSync(file));
          return;
        }
        if (req.method !== "GET" || !path.startsWith("/atlas/")) return next();
        atlas ??= buildAtlasFiles(root);
        const name = path.slice("/atlas/".length);
        const file = atlas.get(name);
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", name.endsWith(".png") ? "image/png" : "application/json");
        res.end(file);
      });
    },
    generateBundle() {
      for (const [name, source] of buildAtlasFiles(root))
        this.emitFile({ type: "asset", fileName: `atlas/${name}`, source });
      for (const [fileName, file] of soundFiles(root))
        this.emitFile({ type: "asset", fileName, source: readFileSync(file) });
    },
  };
}
