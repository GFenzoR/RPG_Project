// content_search: a read-only index of data/ (items, monsters, NPCs) with their names in
// every language of i18n/, so an AI can find what to place without reading YAML.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "@rpg/content-schema";
import { parse } from "yaml";

export type ContentKind = "item" | "monster" | "npc";

export interface ContentEntry {
  kind: ContentKind;
  id: string;
  /** Item kind (ground, decoration, weapon...). */
  item_kind?: string;
  /** Name per language. */
  names: Record<string, string>;
  tags?: string[];
  sprite?: string;
  /** Items: blocks movement / walkable ground. */
  blocks_movement?: boolean;
  walkable?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function yamlIn(dir: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }
  return names.map((f) => {
    try {
      return parse(readFileSync(join(dir, f), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  });
}

export function loadContentIndex(root: string): ContentEntry[] {
  const texts = new Map<string, Record<string, string>>();
  for (const lang of LANGUAGES)
    for (const cat of yamlIn(join(root, "i18n", lang)))
      if (isObj(cat))
        for (const [k, v] of Object.entries(cat))
          if (typeof v === "string") texts.set(k, { ...texts.get(k), [lang]: v });
  const names = (key: unknown): Record<string, string> =>
    typeof key === "string" ? (texts.get(key) ?? {}) : {};
  const out: ContentEntry[] = [];
  for (const file of yamlIn(join(root, "data", "items")))
    for (const it of Array.isArray(file) ? file : []) {
      if (!isObj(it) || typeof it["id"] !== "string") continue;
      const e: ContentEntry = { kind: "item", id: it["id"], names: names(it["name"]) };
      if (typeof it["kind"] === "string") e.item_kind = it["kind"];
      if (typeof it["sprite"] === "string") e.sprite = it["sprite"];
      if (Array.isArray(it["tags"])) e.tags = it["tags"].map(String);
      if (
        it["blocks_movement"] === true ||
        (it["kind"] === "wall" && it["blocks_movement"] !== false)
      )
        e.blocks_movement = true;
      if (isObj(it["ground"])) e.walkable = it["ground"]["walkable"] === true;
      out.push(e);
    }
  for (const [dir, kind] of [
    ["monsters", "monster"],
    ["npcs", "npc"],
  ] as const)
    for (const doc of yamlIn(join(root, "data", dir))) {
      if (!isObj(doc) || typeof doc["id"] !== "string") continue;
      const e: ContentEntry = { kind, id: doc["id"], names: names(doc["name"]) };
      if (typeof doc["sprite"] === "string") e.sprite = doc["sprite"];
      if (Array.isArray(doc["tags"])) e.tags = doc["tags"].map(String);
      out.push(e);
    }
  return out;
}

export interface SearchQuery {
  /** Case-insensitive text matched against the ID and the names. */
  text?: string;
  kind?: ContentKind;
  /** Item kind (ground, decoration...). */
  item_kind?: string;
  tag?: string;
  limit?: number;
}

export function searchContent(index: ContentEntry[], q: SearchQuery): ContentEntry[] {
  const text = q.text?.toLowerCase().trim();
  return index
    .filter(
      (e) =>
        (q.kind === undefined || e.kind === q.kind) &&
        (q.item_kind === undefined || e.item_kind === q.item_kind) &&
        (q.tag === undefined || (e.tags ?? []).includes(q.tag)) &&
        (!text ||
          e.id.includes(text) ||
          Object.values(e.names).some((n) => n.toLowerCase().includes(text))),
    )
    .slice(0, q.limit ?? 50);
}
