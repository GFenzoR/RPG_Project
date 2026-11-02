// Vite plugin: the game content the client needs, read from the repository at build time.
//
//   virtual:rpg-content  items by numeric ID (data/items + data/ids.lock.yaml), movement
//                        constants (data/balance.yaml) and the client's i18n catalogs
//   /atlas/<file>        sprite atlas built from assets/ with tools/spritepack (dev server);
//                        `vite build` emits the same files under atlas/
//
// The client never reads world/: the map arrives from the server (FullMapView, MapSlice).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAtlas, writeAtlas } from "@rpg/spritepack";
import type { Plugin } from "vite";
import { parse } from "yaml";
import type { ClientContent, ItemDef, SpellDef } from "../src/content-types.ts";

const VIRTUAL_ID = "virtual:rpg-content";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
const LANGUAGES = ["es", "en"];
/** i18n catalogs the client uses (all keys), and those it only takes names from. */
const CATALOGS = ["client.yaml", "vocations.yaml", "dialog.yaml", "npcs.yaml"];
const NAME_CATALOGS = ["monsters.yaml", "items.yaml", "spells.yaml", "quests.yaml"];
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
              },
            ]
          : [],
      )
    : [];
  return {
    items,
    monsterSprites: monsters,
    vocations,
    spells,
    movement: {
      baseStepMs: num(mv["base_step_ms"], 1000),
      diagonalCost: num(mv["diagonal_cost"], 1.5),
      maxPathTiles: num(mv["max_path_tiles"], 100),
    },
    chat: { maxLength: num(chat["max_length"], 255) },
    i18n,
  };
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
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      return `export default ${JSON.stringify(loadClientContent(root))};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://client").pathname;
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
    },
  };
}
