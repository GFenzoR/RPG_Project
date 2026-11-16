// The slice of data/ and i18n/ the map needs: which IDs exist and how items behave on a
// tile. Content correctness itself is @rpg/content-schema's job (make validate runs both).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "@rpg/content-schema";
import { parse } from "yaml";
import type { BorderRule } from "./ops/borders.ts";

export interface ItemInfo {
  id: string;
  kind: string;
  /** Ground items: whether creatures can stand on it. */
  walkable?: boolean;
  blocksMovement: boolean;
  /**
   * A door (a `door` block, docs/02 "Puertas con llave"): it opens in the game, so the
   * reachability check walks through it even when it blocks movement shut.
   */
  door?: boolean;
  /**
   * The key id of a locked door, on both items of its pair (the closed one names it in
   * `door.key`): a locked door has a room behind it (doors.ts).
   */
  lock?: string;
  /** The open item of a door pair (`door.closed`): placed on the map, it starts open. */
  doorOpen?: boolean;
  /** Sprite path (assets/sprites.yaml key), for renders. */
  sprite?: string;
  /**
   * i18n key shown when the item is looked at. A sign item (T5.5) is one whose description
   * is a map text (`text.*`): it must stand where texts.yaml puts a sign with that text.
   */
  description?: string;
}

/** Whether an item is a sign: its description is a map text of texts.yaml. */
export const isSignItem = (info: ItemInfo | undefined): boolean =>
  info?.description?.startsWith("text.") === true;

export interface ContentIndex {
  items: Map<string, ItemInfo>;
  monsters: Set<string>;
  npcs: Set<string>;
  /** Configured language (LANGUAGES of @rpg/content-schema) → keys in i18n/<lang>/*.yaml. */
  i18n: Map<string, Set<string>>;
  /** Autoborder rules of data/borders.yaml (well-formed entries only; content-schema checks the rest). */
  borders: BorderRule[];
  /** Boat routes of data/boat_routes.yaml (T3.5): well-formed entries, with their index in the file. */
  routes: BoatRouteInfo[];
  /**
   * Where NPC dialogs teleport players (`teleport` actions of data/npcs): none may lie in
   * the room behind a locked door. Missing when the index was built without them.
   */
  teleports?: TeleportInfo[];
}

/**
 * A `teleport` action of an NPC dialog: the NPC, its file (relative to the repository
 * root, for diagnostics), the dialog node and the destination.
 */
export interface TeleportInfo {
  npc: string;
  file: string;
  node: string;
  to: { x: number; y: number; z: number };
}

/** File of the boat routes, relative to the repository root. */
export const routesFile = "data/boat_routes.yaml";

/** The map side of a boat route: who sells it, the dock and the arrival tile. */
export interface BoatRouteInfo {
  /** Index in data/boat_routes.yaml (for diagnostics). */
  index: number;
  id: string;
  captain: string;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}

const isPos = (v: unknown): v is { x: number; y: number; z: number } =>
  isObj(v) && [v["x"], v["y"], v["z"]].every((n) => Number.isInteger(n));

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
  const closedOf = new Map<string, string>(); // open door → its closed pair
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
      if (typeof raw["sprite"] === "string") info.sprite = raw["sprite"];
      if (typeof raw["description"] === "string") info.description = raw["description"];
      const door = raw["door"];
      if (isObj(door)) {
        info.door = true;
        if (typeof door["key"] === "string") info.lock = door["key"];
        if (typeof door["closed"] === "string") {
          info.doorOpen = true;
          closedOf.set(info.id, door["closed"]);
        }
      }
      const g = raw["ground"];
      if (isObj(g)) info.walkable = g["walkable"] === true;
      items.set(info.id, info);
    }
  }
  for (const [open, closed] of closedOf) {
    const lock = items.get(closed)?.lock;
    const info = items.get(open);
    if (lock !== undefined && info) info.lock = lock;
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
  const borders: BorderRule[] = [];
  const rules = readYaml(join(root, "data", "borders.yaml"));
  if (Array.isArray(rules))
    for (const r of rules) {
      if (!isObj(r) || !isObj(r["pieces"])) continue;
      const { id, from, to, priority, pieces } = r;
      if (typeof id !== "string" || typeof from !== "string" || typeof to !== "string") continue;
      const p = pieces as Record<string, unknown>;
      const required = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
      if (!Object.values(p).every((v) => typeof v === "string")) continue;
      if (!required.every((k) => typeof p[k] === "string")) continue;
      borders.push({
        id,
        from,
        to,
        ...(typeof priority === "number" ? { priority } : {}),
        pieces: p as BorderRule["pieces"],
      });
    }
  const routes: BoatRouteInfo[] = [];
  const rawRoutes = readYaml(join(root, routesFile));
  if (Array.isArray(rawRoutes))
    for (const [index, r] of rawRoutes.entries()) {
      if (!isObj(r)) continue;
      const { id, captain, from, to } = r;
      if (typeof id !== "string" || typeof captain !== "string" || !isPos(from) || !isPos(to))
        continue;
      routes.push({ index, id, captain, from, to });
    }
  return {
    items,
    monsters: idsIn("monsters"),
    npcs: idsIn("npcs"),
    i18n,
    borders,
    routes,
    teleports: loadTeleports(root),
  };
}

/** The teleport actions of the NPC dialogs of data/npcs (well-formed ones). */
function loadTeleports(root: string): TeleportInfo[] {
  const out: TeleportInfo[] = [];
  for (const file of yamlFiles(join(root, "data", "npcs"))) {
    const rel = `data/npcs/${file.replace(/^.*[\\/]/, "")}`;
    const npc = readYaml(file);
    const id = isObj(npc) ? npc["id"] : undefined;
    if (!isObj(npc) || typeof id !== "string") continue;
    const dialog = npc["dialog"];
    const nodes = isObj(dialog) ? dialog["nodes"] : undefined;
    if (!isObj(nodes)) continue;
    for (const node of Object.keys(nodes).sort()) {
      const n = nodes[node];
      const options = isObj(n) ? n["options"] : undefined;
      if (!Array.isArray(options)) continue;
      for (const o of options) {
        const action = isObj(o) ? o["action"] : undefined;
        for (const a of Array.isArray(action) ? action : [action]) {
          const to = isObj(a) ? a["teleport"] : undefined;
          if (isPos(to)) out.push({ npc: id, file: rel, node, to });
        }
      }
    }
  }
  return out;
}
