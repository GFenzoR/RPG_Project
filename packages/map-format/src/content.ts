// The slice of data/ and i18n/ the map needs: which IDs exist and how items behave on a
// tile. Content correctness itself is @rpg/content-schema's job (make validate runs both).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "@rpg/content-schema";
import { parse } from "yaml";

export interface ItemInfo {
  id: string;
  kind: string;
  /** Ground items: whether creatures can stand on it. */
  walkable?: boolean;
  blocksMovement: boolean;
}

export interface ContentIndex {
  items: Map<string, ItemInfo>;
  monsters: Set<string>;
  npcs: Set<string>;
  /** Configured language (LANGUAGES of @rpg/content-schema) → keys in i18n/<lang>/*.yaml. */
  i18n: Map<string, Set<string>>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** .yaml files directly in dir; none when dir is missing or not a directory. */
function yamlFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing or not a directory: the content validator reports it
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".yaml") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort()
    .map((f) => join(dir, f));
}

function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined; // reported by the content validator
  }
}

export function loadContent(root: string): ContentIndex {
  const items = new Map<string, ItemInfo>();
  for (const file of yamlFiles(join(root, "data", "items"))) {
    const list = readYaml(file);
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!isObj(raw) || typeof raw["id"] !== "string") continue;
      const kind = typeof raw["kind"] === "string" ? raw["kind"] : "";
      const info: ItemInfo = {
        id: raw["id"],
        kind,
        blocksMovement:
          raw["blocks_movement"] === true || (kind === "wall" && raw["blocks_movement"] !== false),
      };
      const g = raw["ground"];
      if (isObj(g)) info.walkable = g["walkable"] === true;
      items.set(info.id, info);
    }
  }
  const idsIn = (dir: string): Set<string> =>
    new Set(
      yamlFiles(join(root, "data", dir)).map((f) =>
        f.replace(/^.*[\\/]/, "").replace(/\.yaml$/, ""),
      ),
    );
  const i18n = new Map<string, Set<string>>();
  for (const lang of LANGUAGES) {
    const keys = new Set<string>();
    for (const file of yamlFiles(join(root, "i18n", lang))) {
      const cat = readYaml(file);
      if (isObj(cat)) for (const k of Object.keys(cat)) keys.add(k);
    }
    i18n.set(lang, keys);
  }
  return { items, monsters: idsIn("monsters"), npcs: idsIn("npcs"), i18n };
}
