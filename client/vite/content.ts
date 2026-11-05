// Vite plugin: the game content the client needs, read from the repository at build time.
//
//   virtual:rpg-content  items by numeric ID (data/items + data/ids.lock.yaml), movement
//                        constants (data/balance.yaml) and the client's i18n catalogs
//   /audio/<file>        sound files of assets/sounds.yaml (T3.7), served as they are;
//                        `vite build` emits them under audio/
//   virtual:rpg-site     the public website (T4.3): its i18n catalogs, vocations, skill ids
//                        (highscore categories) and the posts of data/news
//   /atlas/<file>        sprite atlas built from assets/ with tools/spritepack (dev server);
//                        `vite build` emits the same files under atlas/
//
// The client never reads world/: the map arrives from the server (FullMapView, MapSlice).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAtlas, writeAtlas } from "@rpg/spritepack";
import type { Plugin } from "vite";
import { parse } from "yaml";
import type {
  ClientContent,
  IslandRect,
  ItemDef,
  NewsPost,
  SiteContent,
  LoopRules,
  RecipeDef,
  SoundDef,
  SoundManifest,
  SpellDef,
} from "../src/content-types.ts";

const VIRTUAL_ID = "virtual:rpg-content";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const SITE_ID = "virtual:rpg-site";
const RESOLVED_SITE_ID = "\0" + SITE_ID;
/** i18n catalogs of the website (all keys). */
const SITE_CATALOGS = ["client.yaml", "vocations.yaml", "site.yaml"];
const NEWS_FILE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9-]+\.yaml$/;
const LANGUAGES = ["es", "en"];
/** i18n catalogs the client uses (all keys), and those it only takes names from. */
const CATALOGS = ["client.yaml", "vocations.yaml", "dialog.yaml", "npcs.yaml", "tutorial.yaml"];
const NAME_CATALOGS = ["monsters.yaml", "items.yaml", "spells.yaml", "quests.yaml", "world.yaml"];
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
      items[num] = {
        id: raw["id"],
        sprite: typeof raw["sprite"] === "string" ? raw["sprite"] : "",
        ground: ground !== undefined,
        walkable: ground?.["walkable"] === true,
        blocks: raw["blocks_movement"] === true,
        speed: typeof ground?.["speed"] === "number" ? ground["speed"] : 100,
        stackable: raw["stackable"] === true,
        slots:
          isObj(raw["container"]) && typeof raw["container"]["slots"] === "number"
            ? raw["container"]["slots"]
            : 0,
        useWith: raw["kind"] === "tool",
        toolUse:
          isObj(raw["tool"]) && typeof raw["tool"]["use"] === "string" ? raw["tool"]["use"] : "",
      };
    }
  }
  const balance = readYaml(join(root, "data", "balance.yaml"));
  const mv = isObj(balance) && isObj(balance["movement"]) ? balance["movement"] : {};
  const num = (v: unknown, def: number): number => (typeof v === "number" ? v : def);
  const chat = isObj(balance) && isObj(balance["chat"]) ? balance["chat"] : {};
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
          if (typeof v === "string" && (!namesOnly || k.endsWith(".name"))) texts[k] = v;
    }
    i18n[lang] = texts;
  }
  const monsters: Record<string, string> = {};
  const mdir = join(root, "data", "monsters");
  for (const file of readdirSync(mdir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()) {
    const m = readYaml(join(mdir, file));
    if (isObj(m) && typeof m["id"] === "string" && typeof m["sprite"] === "string")
      monsters[m["id"]] = m["sprite"];
  }
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
  return {
    items,
    monsterSprites: monsters,
    vocations,
    spells,
    recipes,
    movement: {
      baseStepMs: num(mv["base_step_ms"], 1000),
      diagonalCost: num(mv["diagonal_cost"], 1.5),
      maxPathTiles: num(mv["max_path_tiles"], 100),
    },
    chat: { maxLength: num(chat["max_length"], 255) },
    sounds: loadSounds(root),
    islands: loadIslands(root),
    i18n,
  };
}

/** The website's content (T4.3). make validate checks data/news against its schema. */
export function loadSiteContent(root: string): SiteContent {
  const i18n: Record<string, Record<string, string>> = {};
  for (const lang of LANGUAGES) {
    const texts: Record<string, string> = {};
    for (const name of SITE_CATALOGS) {
      let cat: unknown;
      try {
        cat = readYaml(join(root, "i18n", lang, name));
      } catch {
        continue;
      }
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
  return { i18n, vocations, skills: Object.keys(base), news };
}

/** Where the sound files are served: /audio/<path under assets/>. */
export const AUDIO_PREFIX = "audio/";

const loopRules = (v: unknown): LoopRules => {
  const l = isObj(v) ? v : {};
  const islands: Record<string, string> = {};
  if (isObj(l["islands"]))
    for (const [k, id] of Object.entries(l["islands"])) if (typeof id === "string") islands[k] = id;
  return {
    fadeMs: typeof l["fade_ms"] === "number" ? l["fade_ms"] : 2000,
    islands,
    underground: typeof l["underground"] === "string" ? l["underground"] : undefined,
  };
};

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
      sounds[id] = {
        url: AUDIO_PREFIX + s["file"],
        channel: ch,
        volume: typeof s["volume"] === "number" ? s["volume"] : 1,
        maxVoices: typeof s["max_voices"] === "number" ? s["max_voices"] : 3,
      };
    }
  const events: Record<string, string[]> = {};
  if (isObj(m["events"]))
    for (const [ev, v] of Object.entries(m["events"])) {
      const ids = (Array.isArray(v) ? v : [v]).filter(
        (id): id is string => typeof id === "string" && id in sounds,
      );
      if (ids.length > 0) events[ev] = ids;
    }
  return { sounds, events, music: loopRules(m["music"]), ambient: loopRules(m["ambient"]) };
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

const num0 = (v: unknown): number => (typeof v === "number" ? v : 0);

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
      return id === SITE_ID ? RESOLVED_SITE_ID : undefined;
    },
    load(id) {
      // Read once per dev server start, like the game's content: restart to see a new post.
      if (id === RESOLVED_SITE_ID)
        return `export default ${JSON.stringify(loadSiteContent(root))};`;
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(loadClientContent(root))};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://client");
        const path = url.pathname;
        // The game page (T4.3): /play → /play/ like Caddy, keeping ?lang=.
        if (path === "/play") {
          res.statusCode = 308;
          res.setHeader("location", "/play/" + url.search);
          res.end();
          return;
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
