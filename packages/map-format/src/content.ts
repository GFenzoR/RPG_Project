// The slice of data/ and i18n/ the map needs: which IDs exist and how items behave on a
// tile. Content correctness itself is @rpg/content-schema's job (make validate runs both).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "@rpg/content-schema";
import { parse } from "yaml";
import { EDGE_STYLES } from "./ops/borders.ts";
import type { BorderSet, EdgeStyle, LadderStep } from "./ops/borders.ts";

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
   * docs/17 ART-8: sprite pixels it raises what is stacked on it (a table, a crate), for
   * renders. Absent when it raises nothing.
   */
  elevation?: number;
  /**
   * i18n key shown when the item is looked at. A sign item (T5.5) is one whose description
   * is a map text (`text.*`): it must stand where texts.yaml puts a sign with that text.
   */
  description?: string;
  /**
   * The portal the item shows (its `portal` block, docs/03 "Validación"): the kind and,
   * when given, the way it leads. Every portal but a boat needs such an item on its
   * entrance; one where no portal of its kind leaves is a warning.
   */
  portal?: PortalLook;
  /**
   * The chest id of a reward chest (its `chest` block, docs/02 "Libros y cofres"): it gives
   * once per character under that id, so it stands once in the world, and it is used from
   * a tile next to it, so one of those must be reached.
   */
  chest?: string;
  /**
   * A sigil plate of a milestone quest (its `sigil` block, docs/02 "Quests de hito"): the
   * vocation it is marked for, "" for any. A player stands on it: it must be reached.
   */
  sigil?: string;
  /**
   * What it is in the living world (data/livingworld, livingworld/README.md): a breakable
   * object or its debris, a pushable object, a gate (closed or open) or a pressure plate.
   * The map validator keeps the objects off protection zones, houses, doors and walls.
   */
  living?: "breakable" | "debris" | "pushable" | "gate" | "plate";
  /**
   * A breakable object anyone breaks without a tool (by melee, any_attack or fire): the
   * reachability check walks through it, like a door. One that needs a tool, a pushable
   * object and a gate still block it (they are never a guaranteed way).
   */
  breaksFreely?: true;
}

/** What a portal item shows: a kind of portals.yaml and, optionally, the way it leads. */
export interface PortalLook {
  kind: string;
  leads?: "up" | "down";
}

/**
 * Whether an item shows the portal of kind `kind` from `from` to `to`: same kind, and the
 * way it leads (if the item says one) is the way the portal changes floor (z grows going
 * down). A teleport within one floor matches only an item without `leads`.
 */
export function showsPortal(
  info: ItemInfo | undefined,
  kind: string,
  from: { z: number },
  to: { z: number },
): boolean {
  const look = info?.portal;
  if (look?.kind !== kind) return false;
  if (look.leads === undefined) return true;
  return look.leads === "down" ? to.z > from.z : to.z < from.z;
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
  /** The ladder of data/borders.yaml (well-formed entries only; content-schema checks the rest). */
  borders: BorderSet;
  /** Boat routes of data/boat_routes.yaml (T3.5): well-formed entries, with their index in the file. */
  routes: BoatRouteInfo[];
  /**
   * Where NPC dialogs teleport players (`teleport` actions of data/npcs): none may lie in
   * the room behind a locked door. Missing when the index was built without them.
   */
  teleports?: TeleportInfo[];
  /**
   * travel.arrival_radius of data/balance.yaml: how far from a taken arrival tile a portal
   * (or a boat) lands. Missing when the index was built without it.
   */
  arrivalRadius?: number;
  /**
   * The reach steps of data/quests (docs/06 "Quest"): each place needs a tile reached on
   * foot from its island's temple where a player can stand. Missing when the index was built
   * without them.
   */
  reaches?: ReachInfo[];
  /**
   * The sigils steps of the milestone quests of data/quests (docs/02 "Quests de hito"):
   * their plates and the reward room they move players to. Missing when the index was
   * built without them.
   */
  sigils?: SigilInfo[];
}

/**
 * A milestone's sigils step: the quest, its file (relative to the repository root, for
 * diagnostics), the step's index, the square of its plates (radius around `at`), the
 * reward room it moves players to, how many players and which vocations (one per player,
 * or none).
 */
export interface SigilInfo {
  quest: string;
  file: string;
  step: number;
  at: { x: number; y: number; z: number };
  radius: number;
  to: { x: number; y: number; z: number };
  players: number;
  vocations: string[];
}

/**
 * A reach step of a quest: the quest, its file (relative to the repository root, for
 * diagnostics), the step's index and its place, a zone or the tiles within radius
 * (Chebyshev) of a point.
 */
export interface ReachInfo {
  quest: string;
  file: string;
  step: number;
  zone?: string;
  at?: { x: number; y: number; z: number };
  radius?: number;
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
      if (typeof raw["elevation"] === "number" && raw["elevation"] > 0)
        info.elevation = raw["elevation"];
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
      const portal = raw["portal"];
      if (isObj(portal) && typeof portal["kind"] === "string") {
        const leads = portal["leads"];
        info.portal = { kind: portal["kind"] };
        if (leads === "up" || leads === "down") info.portal.leads = leads;
      }
      const chest = raw["chest"];
      if (isObj(chest) && typeof chest["id"] === "string") info.chest = chest["id"];
      const sigil = raw["sigil"];
      if (isObj(sigil)) info.sigil = typeof sigil["vocation"] === "string" ? sigil["vocation"] : "";
      items.set(info.id, info);
    }
  }
  addLiving(root, items);
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
  const borders = readBorders(readYaml(join(root, "data", "borders.yaml")));
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
  const balance = readYaml(join(root, "data", "balance.yaml"));
  const travel = isObj(balance) ? balance["travel"] : undefined;
  const radius = isObj(travel) ? travel["arrival_radius"] : undefined;
  return {
    items,
    monsters: idsIn("monsters"),
    npcs: idsIn("npcs"),
    i18n,
    borders,
    routes,
    teleports: loadTeleports(root),
    reaches: loadReaches(root),
    sigils: loadSigils(root),
    ...(Number.isInteger(radius) && (radius as number) >= 0
      ? { arrivalRadius: radius as number }
      : {}),
  };
}

/** The sigils steps of the milestone quests of data/quests (well-formed ones). */
function loadSigils(root: string): SigilInfo[] {
  const out: SigilInfo[] = [];
  for (const file of yamlFiles(join(root, "data", "quests"))) {
    const rel = `data/quests/${file.replace(/^.*[\\/]/, "")}`;
    const q = readYaml(file);
    const quest = isObj(q) ? q["id"] : undefined;
    if (!isObj(q) || typeof quest !== "string" || !Array.isArray(q["steps"])) continue;
    const req = isObj(q["requires"]) ? q["requires"] : {};
    const players = Number.isInteger(req["players"]) ? (req["players"] as number) : 0;
    const vocations = Array.isArray(req["vocations"])
      ? req["vocations"].filter((v): v is string => typeof v === "string")
      : [];
    for (const [step, s] of q["steps"].entries()) {
      const when = isObj(s) ? s["complete_when"] : undefined;
      const sig = isObj(when) ? when["sigils"] : undefined;
      const to = isObj(sig) ? sig["to"] : undefined;
      if (!isObj(sig) || !isPos(sig) || !isPos(to)) continue;
      const radius = (sig as Record<string, unknown>)["radius"];
      out.push({
        quest,
        file: rel,
        step,
        at: { x: sig.x, y: sig.y, z: sig.z },
        radius: Number.isInteger(radius) && (radius as number) >= 0 ? (radius as number) : 0,
        to: { x: to.x, y: to.y, z: to.z },
        players,
        vocations,
      });
    }
  }
  return out;
}

/** The reach steps of the quests of data/quests (well-formed ones). */
function loadReaches(root: string): ReachInfo[] {
  const out: ReachInfo[] = [];
  for (const file of yamlFiles(join(root, "data", "quests"))) {
    const rel = `data/quests/${file.replace(/^.*[\\/]/, "")}`;
    const q = readYaml(file);
    const quest = isObj(q) ? q["id"] : undefined;
    if (!isObj(q) || typeof quest !== "string" || !Array.isArray(q["steps"])) continue;
    for (const [step, s] of q["steps"].entries()) {
      const when = isObj(s) ? s["complete_when"] : undefined;
      const reach = isObj(when) ? when["reach"] : undefined;
      if (!isObj(reach)) continue;
      const radius = reach["radius"];
      if (typeof reach["zone"] === "string")
        out.push({ quest, file: rel, step, zone: reach["zone"] });
      else if (isPos(reach))
        out.push({
          quest,
          file: rel,
          step,
          at: { x: reach.x, y: reach.y, z: reach.z },
          radius: Number.isInteger(radius) && (radius as number) >= 0 ? (radius as number) : 0,
        });
    }
  }
  return out;
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

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

/** data/borders.yaml, keeping only well-formed entries (content-schema reports the rest). */
export function readBorders(raw: unknown): BorderSet {
  const set: BorderSet = { ladder: [] };
  if (!isObj(raw)) return set;
  const ladder = raw["ladder"];
  if (Array.isArray(ladder))
    for (const r of ladder) {
      if (!isObj(r) || typeof r["ground"] !== "string") continue;
      const step: LadderStep = { ground: r["ground"] };
      if (typeof r["pieces"] === "string") step.pieces = r["pieces"];
      const edge = EDGE_STYLES.find((e) => e === r["edge"]);
      if (edge) step.edge = edge as EdgeStyle;
      if (isStrings(r["over"])) step.over = r["over"];
      set.ladder.push(step);
    }
  const shore = raw["shore"];
  if (isObj(shore) && isStrings(shore["water"]) && typeof shore["pieces"] === "string")
    set.shore = { water: shore["water"], pieces: shore["pieces"] };
  return set;
}

/** Marks the items of data/livingworld/*.yaml (well-formed entries; content-schema checks the rest). */
function addLiving(root: string, items: Map<string, ItemInfo>): void {
  const mark = (id: unknown, living: NonNullable<ItemInfo["living"]>): ItemInfo | undefined => {
    const info = typeof id === "string" ? items.get(id) : undefined;
    if (info) info.living = living;
    return info;
  };
  for (const file of yamlFiles(join(root, "data", "livingworld"))) {
    const list = readYaml(file);
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isObj(e)) continue;
      const b = e["breakable"];
      if (isObj(b)) {
        const info = mark(e["item"], "breakable");
        const by = b["by"];
        if (
          info &&
          Array.isArray(by) &&
          by.some((m) => m === "melee" || m === "any_attack" || m === "fire")
        )
          info.breaksFreely = true;
        if (b["becomes"] !== "none") mark(b["becomes"], "debris");
      }
      if (isObj(e["pushable"])) mark(e["item"], "pushable");
      if (isObj(e["gate"])) {
        mark(e["item"], "gate");
        mark(e["gate"]["open"], "gate");
      }
      if (isObj(e["plate"])) mark(e["item"], "plate");
    }
  }
}
