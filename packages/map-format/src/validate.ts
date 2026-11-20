// World validation (docs/03-world-and-maps.md, "Validación"). The editor, mapcli, the MCP
// server and `make validate` all call validateWorld, so they agree on what is an error.
import { chunkFileName, floorDir } from "./chunk.ts";
import { isSignItem, loadContent, routesFile, showsPortal } from "./content.ts";
import type { ContentIndex, ItemInfo, SigilInfo } from "./content.ts";
import { Reporter } from "./diagnostics.ts";
import type { Diagnostic, PathSegment } from "./diagnostics.ts";
import { islandDir, loadWorld, worldFile } from "./io.ts";
import { PREFAB_DIR, checkPrefab } from "./prefabs.ts";
import type { LoadResult } from "./io.ts";
import { TileMap, isPassable, isWalkable } from "./tiles.ts";
import {
  DOOR_ROOM_ERRORS,
  ON_STEP_KINDS,
  doorRooms,
  doorsOn,
  hasLockedDoor,
  templeReach,
} from "./doors.ts";
import type { DoorWorld, TempleReach } from "./doors.ts";
import { disconnectedFloors, onHouseEdge } from "./houses.ts";
import { borderItems, borderPieces, hasBorders } from "./ops/borders.ts";
import { CHUNK_SIZE, formatPos, houseContains, rectContains, rectsOverlap } from "./types.ts";
import type { Chunk, Island, Portal, Position, Rect, World } from "./types.ts";

export interface MapReport {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
}

export interface ValidateWorldOptions {
  /** Only report findings in this island's files (the whole world is still loaded). */
  island?: string;
  /** Content index to validate against; loaded from root when omitted. */
  content?: ContentIndex;
}

/** Spawns denser than this many monsters per walkable tile in their area get a warning. */
export const MAX_SPAWN_DENSITY = 0.25;

/** Farthest (Chebyshev, same floor) a captain may stand from the dock of its route. */
export const MAX_DOCK_DISTANCE = 8;

/** Stairs and ladders that need a way back, with the kinds that can serve as it. */
const PAIRED_KINDS = new Set(["stairs", "ladder"]);

/**
 * Portals with no way back of their own (a hole only leads down, a teleport one way): a
 * warning when no temple is reached from where they lead (checkPortalExits).
 */
const ONE_WAY_KINDS = new Set(["hole", "teleport"]);

/** The `portal` block an item needs to show the portal of kind from `from` to `to`. */
function portalLookHint(kind: string, from: Position, to: Position): string {
  if (kind === "hole" || kind === "rope_spot" || kind === "teleport") return `{ kind: ${kind} }`;
  return `{ kind: ${kind}, leads: ${to.z > from.z ? "down" : "up"} }`;
}

/**
 * The most travel.arrival_radius may be (the balance schema's maximum): the radius of the
 * arrival check when the content index does not bring the configured one.
 */
export const MAX_ARRIVAL_RADIUS = 5;

export function validateWorld(root: string, opts: ValidateWorldOptions = {}): MapReport {
  const loaded = loadWorld(root);
  const content = opts.content ?? loadContent(root);
  const v = new WorldValidator(loaded, content);
  v.run();
  let diags = [...loaded.diagnostics, ...v.diags];
  if (opts.island !== undefined) {
    const id = opts.island;
    const prefix = `${islandDir(id)}/`;
    // world.yaml findings about this island (its entry in `islands`) and findings about
    // boat routes whose dock or arrival is on it.
    const entries = new Set<number>();
    loaded.world.meta.islands.forEach((e, i) => e.id === id && entries.add(i));
    const rect = loaded.world.islands.get(id)?.meta.rect;
    // If world.yaml itself did not load, every world.yaml finding concerns every island.
    const worldBroken = !loaded.files.some((f) => f.file === worldFile);
    const aboutIsland = (d: Diagnostic): boolean => {
      if (d.file.startsWith(prefix)) return true;
      if (d.file === routesFile) {
        if (!rect) return false;
        // By route: its dock or arrival on this island (a finding may have no position).
        const r = content.routes.find((x) => x.index === d.path[0]);
        const at = r ? [r.from, r.to] : d.pos ? [d.pos] : [];
        return at.some((p) => rectContains(rect, p.x, p.y));
      }
      if (d.file !== worldFile) return false;
      if (worldBroken) return true;
      const [section, index] = d.path;
      if (typeof index !== "number") return false;
      return section === "islands" && entries.has(index);
    };
    diags = diags.filter(aboutIsland);
    if (!loaded.world.islands.has(opts.island) && !diags.some((d) => d.severity === "error")) {
      diags.push({
        severity: "error",
        file: prefix,
        path: [],
        message: `island "${opts.island}" is not loaded`,
      });
    }
  }
  return summarize(diags);
}

export interface ValidateLoadedOptions {
  /** Line lookup per YAML file (LoadResult.lines), to point findings at file:line. */
  lines?: LoadResult["lines"];
}

/**
 * Validates a world that is already in memory (the editor's), without reading world/.
 * Same rules as validateWorld except the on-disk ones (file layout, canonical form):
 * whatever is written from memory is canonical by construction.
 */
export function validateLoaded(
  world: World,
  content: ContentIndex,
  opts: ValidateLoadedOptions = {},
): MapReport {
  const v = new WorldValidator(
    { world, lines: opts.lines ?? new Map(), files: [], diagnostics: [], prefabs: new Map() },
    content,
  );
  v.run();
  return summarize(v.diags);
}

export function summarize(diagnostics: Diagnostic[]): MapReport {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return { diagnostics, errors, warnings: diagnostics.length - errors };
}

class WorldValidator {
  readonly diags: Diagnostic[] = [];
  private readonly r = new Reporter(this.diags);
  /** Island directory (the world.yaml / directory name), which may differ from meta.id. */
  private readonly dirs = new Map<Island, string>();
  private readonly world: World;
  private readonly tiles: TileMap;
  private readonly loaded: LoadResult;
  private readonly content: ContentIndex;

  constructor(loaded: LoadResult, content: ContentIndex) {
    this.loaded = loaded;
    this.world = loaded.world;
    this.content = content;
    this.tiles = new TileMap(loaded.world.islands.values());
    for (const [id, island] of loaded.world.islands) this.dirs.set(island, islandDir(id));
  }

  private dirOf(island: Island): string {
    return this.dirs.get(island) ?? islandDir(island.meta.id);
  }

  private err(file: string, path: PathSegment[], message: string, pos?: Position): void {
    this.r.error(file, path, message, pos, this.loaded.lines.get(file)?.(path));
  }

  private warn(file: string, path: PathSegment[], message: string, pos?: Position): void {
    this.r.warn(file, path, message, pos, this.loaded.lines.get(file)?.(path));
  }

  run(): void {
    for (const f of this.loaded.files) {
      if (f.text !== f.canonical) this.err(f.file, [], "not in canonical format; run `mapcli fmt`");
    }
    this.checkWorldIndex();
    for (const island of this.world.islands.values()) this.checkIsland(island);
    this.checkUniqueAcrossWorld();
    this.checkChestsPlacedOnce();
    this.checkPortalArrivals();
    this.checkPortalExits();
    this.checkBoatRoutes();
    this.checkDevIslands();
    this.checkDoors();
    this.checkArrivals();
    this.checkSigils();
    this.checkPrefabs();
  }

  // ---- world/prefabs -----------------------------------------------------------

  private checkPrefabs(): void {
    for (const [name, p] of this.loaded.prefabs) {
      const file = `${PREFAB_DIR}/${name}.yaml`;
      if (p.id !== name) this.err(file, ["id"], `id "${p.id}" must match the file name "${name}"`);
      for (const e of checkPrefab(p, this.content)) this.err(file, e.path, e.message);
    }
  }

  // ---- world.yaml ------------------------------------------------------------

  private checkWorldIndex(): void {
    const entries = this.world.meta.islands;
    for (const [i, e] of entries.entries()) {
      const { x, y, w, h } = e.rect;
      if ([x, y, w, h].some((n) => n % CHUNK_SIZE !== 0))
        this.err(
          worldFile,
          ["islands", i, "rect"],
          `island rectangles must be aligned to chunks: x, y, w and h multiples of ${CHUNK_SIZE}`,
        );
      if (e.rect.x + e.rect.w > 65536 || e.rect.y + e.rect.h > 65536)
        this.err(
          worldFile,
          ["islands", i, "rect"],
          "rectangle leaves the world (coordinates go up to 65535)",
        );
      if (e.level_hint[0] > e.level_hint[1])
        this.err(
          worldFile,
          ["islands", i, "level_hint"],
          "level_hint is [min, max]; min is larger than max",
        );
      // Reported on both entries, so filtering by either island shows it.
      for (const [j, other] of entries.entries()) {
        if (j !== i && rectsOverlap(e.rect, other.rect))
          this.err(worldFile, ["islands", i, "rect"], `overlaps island "${other.id}"`);
      }
      const island = this.world.islands.get(e.id);
      if (!island) continue;
      const file = `${islandDir(e.id)}/island.yaml`;
      const m = island.meta;
      if (m.id !== e.id)
        this.err(file, ["id"], `id "${m.id}" must match the directory name "${e.id}"`);
      const r = m.rect;
      if (r.x !== e.rect.x || r.y !== e.rect.y || r.w !== e.rect.w || r.h !== e.rect.h)
        this.err(file, ["rect"], `differs from the rect of "${e.id}" in ${worldFile}`);
      if (m.level_hint[0] !== e.level_hint[0] || m.level_hint[1] !== e.level_hint[1])
        this.err(file, ["level_hint"], `differs from the level_hint of "${e.id}" in ${worldFile}`);
    }
  }

  // ---- one island --------------------------------------------------------------

  private checkIsland(island: Island): void {
    const dir = this.dirOf(island);
    const meta = island.meta;
    const file = `${dir}/island.yaml`;
    const floors = new Set(meta.floors);
    this.checkI18n(file, ["name"], meta.name);
    if ([...meta.floors].sort((a, b) => a - b).join() !== meta.floors.join())
      this.err(file, ["floors"], "list floors in ascending order");
    const where = (p: Position): string | undefined =>
      !rectContains(meta.rect, p.x, p.y)
        ? "outside the island rectangle"
        : !floors.has(p.z)
          ? `on floor ${p.z}, which is not in the island floors`
          : undefined;
    const needWalkable = (f: string, path: PathSegment[], p: Position, what: string): void => {
      const out = where(p);
      if (out) this.err(f, path, `${what} is ${out}`, p);
      else if (!isWalkable(this.tiles.tileAt(p), this.content))
        this.err(f, path, `${what} is not on a walkable tile`, p);
    };
    needWalkable(file, ["temple"], meta.temple, "temple");

    this.checkChunks(island, floors);
    this.checkBorders(island);

    const spawnsFile = `${dir}/spawns.yaml`;
    for (const [i, s] of island.spawns.entries()) {
      needWalkable(spawnsFile, [i, "center"], s.center, "spawn center");
      for (const [j, m] of s.monsters.entries()) {
        if (!this.content.monsters.has(m.monster))
          this.err(
            spawnsFile,
            [i, "monsters", j, "monster"],
            `unknown monster "${m.monster}" (no data/monsters/${m.monster}.yaml)`,
          );
      }
      const total = s.monsters.reduce((n, m) => n + m.count, 0);
      const area = this.walkableAround(s.center, s.radius);
      if (area > 0 && total / area > MAX_SPAWN_DENSITY)
        this.warn(
          spawnsFile,
          [i],
          `${total} monsters on ${area} walkable tiles is denser than ${MAX_SPAWN_DENSITY} per tile`,
          s.center,
        );
    }

    const npcsFile = `${dir}/npcs.yaml`;
    for (const [i, n] of island.npcs.entries()) {
      if (!this.content.npcs.has(n.npc))
        this.err(npcsFile, [i, "npc"], `unknown NPC "${n.npc}" (no data/npcs/${n.npc}.yaml)`);
      needWalkable(npcsFile, [i, "pos"], n.pos, "NPC");
    }

    const zonesFile = `${dir}/zones.yaml`;
    for (const [i, z] of island.zones.entries()) {
      for (const [j, f] of z.floors.entries())
        if (!floors.has(f))
          this.err(zonesFile, [i, "floors", j], `floor ${f} is not in the island floors`);
      for (const [j, rect] of z.rects.entries()) {
        if (!rectInside(rect, meta.rect))
          this.err(zonesFile, [i, "rects", j], "rectangle leaves the island rectangle");
      }
    }
    const protects = (p: Position): boolean =>
      island.zones.some(
        (z) =>
          z.type === "protection" &&
          z.floors.includes(p.z) &&
          z.rects.some((r) => rectContains(r, p.x, p.y)),
      );
    if (!protects(meta.temple))
      this.err(file, ["temple"], "temple is not covered by a protection zone", meta.temple);

    const portalsFile = `${dir}/portals.yaml`;
    // The server (world.NewMap) indexes portals by their entrance: one per tile.
    const entrances = new Map<string, string>();
    for (const [i, p] of island.portals.entries()) {
      needWalkable(portalsFile, [i, "from"], p.from, "portal entrance");
      const other = entrances.get(formatPos(p.from));
      if (other !== undefined)
        this.err(
          portalsFile,
          [i, "from"],
          `portals "${other}" and "${p.id}" leave from the same tile`,
          p.from,
        );
      else entrances.set(formatPos(p.from), p.id);
      if (formatPos(p.from) === formatPos(p.to))
        this.err(portalsFile, [i, "to"], "portal leads to its own tile", p.from);
      if (p.kind === "boat")
        // docs/02 "Cambiar de piso": the server moves nobody through it.
        this.warn(
          portalsFile,
          [i, "kind"],
          "a boat portal moves nobody in the game: boat travel is a route of data/boat_routes.yaml",
          p.from,
        );
      if (!isWalkable(this.tiles.tileAt(p.to), this.content))
        this.err(
          portalsFile,
          [i, "to"],
          "portal destination is not a walkable tile of any island",
          p.to,
        );
      if (p.from.z === p.to.z && p.kind !== "teleport" && p.kind !== "boat")
        this.err(portalsFile, [i, "kind"], `${p.kind} must change floor`, p.from);
      if (
        (p.kind === "hole" && p.to.z <= p.from.z) ||
        (p.kind === "rope_spot" && p.to.z >= p.from.z)
      )
        this.err(
          portalsFile,
          [i, "to"],
          p.kind === "hole"
            ? "a hole leads down (to.z > from.z)"
            : "a rope spot leads up (to.z < from.z)",
          p.from,
        );
      // The tile is the portal, but players only see an item: the one that shows it
      // (its `portal` block), never a bare tile that moves whoever steps on it.
      if (p.kind !== "boat" && !this.portalShown(p.kind, p.from, p.to))
        this.err(
          portalsFile,
          [i, "from"],
          `${p.kind} "${p.id}" has no item that shows it on its entrance (one with portal: ${portalLookHint(p.kind, p.from, p.to)}, ${this.portalItemsHint(p.kind, p.from, p.to)})`,
          p.from,
        );
      if (PAIRED_KINDS.has(p.kind) && !this.hasPair(p.from, p.to))
        this.err(
          portalsFile,
          [i],
          `${p.kind} at ${formatPos(p.from)} has no way back: add a stairs/ladder portal from next to ${formatPos(p.to)} to next to ${formatPos(p.from)}`,
          p.from,
        );
    }
    // Nobody stands for good on stairs, a hole or a teleport (the server, world.NewMap,
    // refuses the same): an NPC there blocks it, and monsters keep off it, so a spawn of
    // radius 0 there never shows one.
    const stepped = new Map<string, string>();
    for (const p of island.portals)
      if (ON_STEP_KINDS.has(p.kind)) stepped.set(formatPos(p.from), p.id);
    for (const [i, n] of island.npcs.entries()) {
      const id = stepped.get(formatPos(n.pos));
      if (id !== undefined)
        this.err(
          npcsFile,
          [i, "pos"],
          `NPC stands on the entrance of portal "${id}", which nobody could take`,
          n.pos,
        );
    }
    for (const [i, s] of island.spawns.entries()) {
      const id = stepped.get(formatPos(s.center));
      if (id !== undefined && s.radius === 0)
        this.err(
          spawnsFile,
          [i, "center"],
          `spawn of radius 0 on the entrance of portal "${id}": monsters keep off it, none would appear`,
          s.center,
        );
    }
    // The temple and a house exit are the last resort of waking up and of leaving a house
    // when every tile around is taken: never a tile nobody may stand on.
    const templeOn = stepped.get(formatPos(meta.temple));
    if (templeOn !== undefined)
      this.err(
        file,
        ["temple"],
        `temple lies on the entrance of portal "${templeOn}", where nobody may wake up`,
        meta.temple,
      );
    for (const [i, h] of island.houses.entries()) {
      const id = stepped.get(formatPos(h.exit));
      if (id !== undefined)
        this.err(
          `${dir}/houses.yaml`,
          [i, "exit"],
          `house exit lies on the entrance of portal "${id}", where nobody may be put out`,
          h.exit,
        );
    }

    const textsFile = `${dir}/texts.yaml`;
    for (const [i, t] of island.texts.entries()) {
      const out = where(t.pos);
      if (out) this.err(textsFile, [i, "pos"], `text is ${out}`, t.pos);
      else if (!this.tiles.tileAt(t.pos)?.ground)
        this.err(textsFile, [i, "pos"], "text is on a tile without ground", t.pos);
      this.checkI18n(textsFile, [i, "text"], t.text);
      // A sign item on the tile (T5.5) is what players read: it must say the same text. A
      // sign without its item is allowed (only texts.yaml knows it; docs/03 "Carteles").
      if (t.kind !== "sign") continue;
      const signs = (this.tiles.tileAt(t.pos)?.stack ?? []).filter((id) =>
        isSignItem(this.content.items.get(id)),
      );
      const first = signs[0];
      if (
        first !== undefined &&
        !signs.some((id) => this.content.items.get(id)?.description === t.text)
      )
        this.err(
          textsFile,
          [i, "text"],
          `sign "${t.id}" says ${t.text}, but its sign item "${first}" says ${this.content.items.get(first)?.description}`,
          t.pos,
        );
    }

    this.checkHouses(island, where, needWalkable);
    this.checkReachability(island);
  }

  /**
   * Houses (T5.4, docs/03 "Casas"): rects on the island and its floors, no tile in two
   * houses, doors walkable tiles on the edge of the house without a door item (warning:
   * tiles of a floor that are not one connected area), the exit a walkable tile outside
   * every house next to a door, every house tile with ground; nothing else lives inside
   * (NPCs, spawn centers, texts, portals, no_logout zones). The server (world.NewMap)
   * repeats the geometric rules, and session the door item one.
   */
  private checkHouses(
    island: Island,
    where: (p: Position) => string | undefined,
    needWalkable: (f: string, path: PathSegment[], p: Position, what: string) => void,
  ): void {
    const dir = this.dirOf(island);
    const file = `${dir}/houses.yaml`;
    const owner = new Map<string, string>();
    for (const [i, h] of island.houses.entries()) {
      if (h.name !== `house.${h.id}.name`)
        // Messages name a house by its id (the client shows house.<id>.name).
        this.err(file, [i, "name"], `a house's name key is house.${h.id}.name`);
      else this.checkI18n(file, [i, "name"], h.name);
      for (const [j, r] of h.rects.entries()) {
        const corner = { x: r.x + r.w - 1, y: r.y + r.h - 1, z: r.z };
        const out = where(r) ?? where(corner);
        if (out) {
          this.err(file, [i, "rects", j], `house rectangle is ${out}`, r);
          continue;
        }
        let bare = false;
        let shared: [string, Position] | undefined;
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            const p = { x, y, z: r.z };
            const k = formatPos(p);
            const prev = owner.get(k);
            if (prev === undefined) owner.set(k, h.id);
            else shared ??= [prev, p]; // also two rects of the same house
            bare ||= !this.tiles.tileAt(p)?.ground;
          }
        if (shared)
          this.err(
            file,
            [i, "rects", j],
            `house rectangle shares tiles with house "${shared[0]}"`,
            shared[1],
          );
        if (bare) this.err(file, [i, "rects", j], "house rectangle has tiles without ground", r);
      }
      for (const [j, d] of h.doors.entries()) {
        if (!houseContains(h, d))
          this.err(file, [i, "doors", j], "door is not a tile of the house", d);
        else {
          needWalkable(file, [i, "doors", j], d, "door");
          // Using a door item would open it, never the house window (docs/02 "Puertas con
          // llave"); the server refuses to start with one too.
          if (this.tiles.tileAt(d)?.stack.some((id) => this.content.items.get(id)?.door === true))
            this.err(file, [i, "doors", j], "a house door cannot hold a door item", d);
          if (!onHouseEdge(h.rects, d))
            this.err(
              file,
              [i, "doors", j],
              "door must be on the edge of the house (next to a tile outside it)",
              d,
            );
        }
      }
      for (const z of disconnectedFloors(h.rects))
        this.warn(file, [i, "rects"], `house tiles on floor ${z} are not one connected area`);
      needWalkable(file, [i, "exit"], h.exit, "house exit");
      if (
        !h.doors.some(
          (d) =>
            d.z === h.exit.z && Math.max(Math.abs(d.x - h.exit.x), Math.abs(d.y - h.exit.y)) === 1,
        )
      )
        this.err(file, [i, "exit"], "house exit must be next to a door", h.exit);
    }
    const inHouse = (p: Position): string | undefined => owner.get(formatPos(p));
    for (const [i, h] of island.houses.entries()) {
      const o = inHouse(h.exit);
      if (o !== undefined) this.err(file, [i, "exit"], `house exit is inside house "${o}"`, h.exit);
    }
    if (owner.size === 0) return;
    const inside = (f: string, path: PathSegment[], p: Position, what: string): void => {
      const o = inHouse(p);
      if (o !== undefined) this.err(f, path, `${what} is inside house "${o}"`, p);
    };
    for (const [i, n] of island.npcs.entries())
      inside(`${dir}/npcs.yaml`, [i, "pos"], n.pos, "NPC");
    for (const [i, s] of island.spawns.entries())
      inside(`${dir}/spawns.yaml`, [i, "center"], s.center, "spawn center");
    for (const [i, t] of island.texts.entries())
      inside(`${dir}/texts.yaml`, [i, "pos"], t.pos, "text");
    for (const [i, p] of island.portals.entries()) {
      inside(`${dir}/portals.yaml`, [i, "from"], p.from, "portal entrance");
      inside(`${dir}/portals.yaml`, [i, "to"], p.to, "portal destination");
    }
    // A portal of another island may lead here too (world.NewMap refuses it as well).
    for (const other of this.world.islands.values())
      if (other !== island)
        for (const [i, p] of other.portals.entries())
          inside(`${this.dirOf(other)}/portals.yaml`, [i, "to"], p.to, "portal destination");
    // A temple in a house: checkArrivals, with the server's words.
    for (const [i, z] of island.zones.entries()) {
      if (z.type !== "no_logout") continue;
      const hit = z.floors.some((f) =>
        z.rects.some((r) => anyIn(r, (x, y) => inHouse({ x, y, z: f }) !== undefined)),
      );
      if (hit)
        this.err(
          `${dir}/zones.yaml`,
          [i],
          `no_logout zone "${z.id}" covers a house (logout is safe inside)`,
        );
    }
  }

  private checkChunks(island: Island, floors: Set<number>): void {
    const dir = this.dirOf(island);
    const rect = island.meta.rect;
    // Sign texts by tile: every sign item must stand on a texts.yaml sign with its text.
    const signText = new Map<string, string[]>();
    for (const t of island.texts) {
      if (t.kind !== "sign") continue;
      const key = formatPos(t.pos);
      signText.set(key, [...(signText.get(key) ?? []), t.text]);
    }
    // Portal items by tile: each must stand on the entrance of a portal it shows.
    const portalAt = new Map(island.portals.map((p) => [formatPos(p.from), p]));
    for (const c of island.chunks.values()) {
      const file = chunkFile(dir, c);
      const ox = c.cx * CHUNK_SIZE;
      const oy = c.cy * CHUNK_SIZE;
      if (!floors.has(c.z))
        this.err(file, ["chunk", "z"], `floor ${c.z} is not in the island floors`);
      if (!rectsOverlap({ x: ox, y: oy, w: CHUNK_SIZE, h: CHUNK_SIZE }, rect)) {
        this.err(file, ["chunk"], "chunk lies outside the island rectangle");
        continue;
      }
      const reported = new Set<string>();
      const once = (key: string, path: PathSegment[], msg: string, pos: Position): void => {
        if (reported.has(key)) return;
        reported.add(key);
        this.err(file, path, msg, pos);
      };
      // A portal item, on the ground or the stack (portalShown takes both), stands on the
      // entrance of a portal it shows. A warning: it moves nobody, but players will take
      // it for a way through. Called only for an item with a portal block: nothing is
      // built for the other tiles of the world.
      const portalItem = (id: string, info: ItemInfo, path: PathSegment[], pos: Position): void => {
        if (!info.portal) return;
        const key = `portal:${pos.x},${pos.y}`;
        if (reported.has(key) || this.portalItemFits(info, portalAt.get(formatPos(pos)))) return;
        reported.add(key);
        this.warn(
          file,
          path,
          `"${id}" shows a ${info.portal.kind}${info.portal.leads ? ` leading ${info.portal.leads}` : ""}, but no such portal of ${dir}/portals.yaml leaves from this tile`,
          pos,
        );
      };
      const stacks = new Map(c.items.map((s) => [s.y * CHUNK_SIZE + s.x, s]));
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const g = c.ground[ly * CHUNK_SIZE + lx] ?? null;
          const s = stacks.get(ly * CHUNK_SIZE + lx);
          const pos = { x: ox + lx, y: oy + ly, z: c.z };
          if (g === null && !s) continue;
          if (!rectContains(rect, pos.x, pos.y))
            once("outside", ["ground", ly, lx], "tile outside the island rectangle", pos);
          if (g !== null) {
            const info = this.content.items.get(g);
            if (!info)
              once(`unknown:${g}`, ["palette"], `unknown item "${g}" (not in data/items/)`, pos);
            else if (info.kind !== "ground")
              once(
                `notground:${g}`,
                ["ground", ly, lx],
                `"${g}" is a ${info.kind}, not a ground item`,
                pos,
              );
            else if (info.portal) portalItem(g, info, ["ground", ly, lx], pos);
          }
          if (!s) continue;
          if (g === null)
            once(`noground:${lx},${ly}`, ["items"], "items on a tile without ground", pos);
          for (const id of s.stack) {
            const info = this.content.items.get(id);
            if (!info)
              once(`unknown:${id}`, ["palette"], `unknown item "${id}" (not in data/items/)`, pos);
            else if (info.kind === "ground")
              once(
                `stackground:${id}`,
                ["items"],
                `ground item "${id}" belongs in the ground layer, not on a stack`,
                pos,
              );
            else if (info.portal) portalItem(id, info, ["items"], pos);
            else if (
              isSignItem(info) &&
              !(signText.get(formatPos(pos)) ?? []).includes(info.description ?? "")
            )
              once(
                `sign:${lx},${ly}`,
                ["items"],
                `sign item "${id}" says ${info.description}, but ${dir}/texts.yaml has no sign with that text at ${formatPos(pos)}`,
                pos,
              );
          }
        }
      }
    }
  }

  // ---- borders ------------------------------------------------------------------

  /**
   * Border pieces (docs/06 "Bordes") are the autoborder's output, never drawn by hand: each
   * tile's must be exactly what borderPieces gives for its neighbours' grounds now, at the
   * bottom of its stack. A ground painted without `mapcli autoborder` (or a ladder changed
   * without rerunning it) leaves them out of date: one error per chunk, at its first tile.
   */
  private checkBorders(island: Island): void {
    const set = this.content.borders;
    if (!hasBorders(set)) return;
    const pieces = borderItems(set);
    const dir = this.dirOf(island);
    const chunks = [...island.chunks.values()].sort(
      (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
    );
    for (const c of chunks) {
      const ox = c.cx * CHUNK_SIZE;
      const oy = c.cy * CHUNK_SIZE;
      const ground = c.ground;
      // The chunk's own tiles straight from it; the neighbours' through the tile map.
      const groundAt = (x: number, y: number): string | null => {
        const lx = x - ox;
        const ly = y - oy;
        return lx >= 0 && ly >= 0 && lx < CHUNK_SIZE && ly < CHUNK_SIZE
          ? (ground[ly * CHUNK_SIZE + lx] ?? null)
          : this.tiles.groundAt(x, y, c.z);
      };
      /** Whether the 8 neighbours of a tile have its own ground: it borders nothing. */
      const alone = (x: number, y: number, here: string | null | undefined): boolean => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if ((dx !== 0 || dy !== 0) && groundAt(x + dx, y + dy) !== here) return false;
        return true;
      };
      const stacks = new Map(c.items.map((s) => [s.y * CHUNK_SIZE + s.x, s.stack]));
      let stale = 0;
      let first: { pos: Position; has: string[]; needs: string[] } | undefined;
      for (let ly = 0; ly < CHUNK_SIZE; ly++)
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const stack = stacks.get(ly * CHUNK_SIZE + lx) ?? [];
          const has = stack.filter((id) => pieces.has(id));
          if (has.length === 0 && alone(ox + lx, oy + ly, ground[ly * CHUNK_SIZE + lx] ?? null))
            continue;
          const needs = borderPieces(ox + lx, oy + ly, groundAt, set);
          const bottom = has.every((id, i) => stack[i] === id);
          if (bottom && has.length === needs.length && has.every((id, i) => needs[i] === id))
            continue;
          stale++;
          first ??= { pos: { x: ox + lx, y: oy + ly, z: c.z }, has, needs };
        }
      if (!first) continue;
      const list = (ids: string[]): string => (ids.length > 0 ? ids.join(", ") : "none");
      this.err(
        chunkFile(dir, c),
        ["items"],
        `${stale} tile(s) with border pieces out of date (first at ${formatPos(first.pos)}: has ${list(first.has)}, needs ${list(first.needs)} at the bottom of its stack); run \`mapcli autoborder ${island.meta.id} --floor ${c.z}\``,
        first.pos,
      );
    }
  }

  // ---- doors --------------------------------------------------------------------

  /**
   * Doors (docs/02 "Puertas con llave"; the server's initDoors refuses the same): one door
   * item per tile; a warning for a door placed open (it is open again after every
   * restart); a room behind every locked door (doorRooms, the server's walks), shared only
   * by locked doors of the same key, and the escape check (every side of every locked door
   * reaches a temple without keys or tools; no player gets into a room without
   * its key); and nothing of the outside in a room: no temple (where players wake up), NPC,
   * house, portal end, boat arrival or dialog teleport. Either the outside was taken for
   * the room, or a player would land behind the door. Spawns may live in a room (a guarded
   * vault).
   */
  private checkDoors(): void {
    const locked: { pos: Position; lock: string; id: string; file: string }[] = [];
    for (const island of this.world.islands.values()) {
      const dir = this.dirOf(island);
      const chunks = [...island.chunks.values()].sort(
        (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
      );
      for (const c of chunks) {
        const file = chunkFile(dir, c);
        for (const s of c.items) {
          const doors = doorsOn(s, this.content);
          const id = doors[0];
          if (id === undefined) continue;
          const pos = { x: c.cx * CHUNK_SIZE + s.x, y: c.cy * CHUNK_SIZE + s.y, z: c.z };
          if (doors.length > 1) {
            this.err(
              file,
              ["items"],
              `doors ${doors.map((d) => `"${d}"`).join(" and ")} on the same tile ${formatPos(pos)}: one door per tile`,
              pos,
            );
            continue;
          }
          const info = this.content.items.get(id);
          if (info?.doorOpen === true)
            this.warn(
              file,
              ["items"],
              `door "${id}" is placed open at ${formatPos(pos)}: it is open again after every restart`,
              pos,
            );
          if (info?.lock !== undefined) locked.push({ pos, lock: info.lock, id, file });
        }
      }
    }
    const { behind, findings } = doorRooms(this.tiles, this.content, locked, this.escapeWorld());
    for (const f of findings) {
      const d = locked.find((l) => formatPos(l.pos) === formatPos(f.door));
      if (!d) continue;
      const other =
        f.error === "bypass" && f.other
          ? ` (the door at ${formatPos(f.other)} opens onto it from its own room)`
          : f.other
            ? ` (the door at ${formatPos(f.other)})`
            : "";
      const side = f.side ? ` (its side at ${formatPos(f.side)})` : "";
      this.err(
        d.file,
        ["items"],
        `locked door "${d.id}" at ${formatPos(f.door)}: ${DOOR_ROOM_ERRORS[f.error]}${other}${side}`,
        f.door,
      );
    }
    if (behind.size === 0) return;
    const inRoom = (file: string, path: PathSegment[], what: string, p: Position): boolean => {
      const door = behind.get(formatPos(p));
      if (door)
        this.err(
          file,
          path,
          `${what} lies in the room behind the locked door at ${formatPos(door)}`,
          p,
        );
      return door !== undefined;
    };
    for (const island of this.world.islands.values()) {
      const dir = this.dirOf(island);
      inRoom(`${dir}/island.yaml`, ["temple"], "temple", island.meta.temple);
      for (const [i, n] of island.npcs.entries())
        inRoom(`${dir}/npcs.yaml`, [i, "pos"], `NPC "${n.npc}"`, n.pos);
      for (const [i, p] of island.portals.entries()) {
        inRoom(`${dir}/portals.yaml`, [i, "from"], `portal entrance "${p.id}"`, p.from);
        inRoom(`${dir}/portals.yaml`, [i, "to"], `portal destination "${p.id}"`, p.to);
      }
      for (const [i, h] of island.houses.entries()) {
        if (inRoom(`${dir}/houses.yaml`, [i, "exit"], `exit of house "${h.id}"`, h.exit)) continue;
        const tile = h.rects
          .flatMap((r) => tilesOf(r).map(([x, y]) => ({ x, y, z: r.z })))
          .find((t) => behind.has(formatPos(t)));
        if (tile) inRoom(`${dir}/houses.yaml`, [i, "rects"], `house "${h.id}"`, tile);
      }
    }
    for (const r of this.content.routes)
      inRoom(routesFile, [r.index, "to"], `arrival of boat route "${r.id}"`, r.to);
    for (const t of this.content.teleports ?? [])
      inRoom(
        t.file,
        ["dialog", "nodes", t.node],
        `teleport of NPC "${t.npc}" (node "${t.node}")`,
        t.to,
      );
  }

  /**
   * What the escape checks take of the world (the locked doors' and checkPortalExits): a
   * house is no street (its tiles are walls of the areas, and its owner or a guest stands
   * in it), the world is the temples (a boat arrival is a way in, not out), and the
   * portals: the entrances of stairs, holes and teleports are walls of the areas, and those
   * a player takes without anything (stairs, ladders, holes, teleports; not a rope spot or
   * a boat) are ways between them.
   */
  private escapeWorld(): DoorWorld {
    const houses = new Set<string>();
    const temples: Position[] = [];
    const portals: { kind: string; from: Position; to: Position }[] = [];
    for (const island of this.world.islands.values()) {
      for (const h of island.houses)
        for (const r of h.rects)
          for (const [x, y] of tilesOf(r)) houses.add(formatPos({ x, y, z: r.z }));
      temples.push(island.meta.temple);
      portals.push(...island.portals);
    }
    return { houses, temples, portals };
  }

  // ---- references across the world -------------------------------------------

  private checkUniqueAcrossWorld(): void {
    const seen = new Map<string, string>();
    const claim = (kind: string, id: string, file: string, path: PathSegment[]): void => {
      const key = `${kind}:${id}`;
      const prev = seen.get(key);
      if (prev) this.err(file, path, `${kind} "${id}" is already defined in ${prev}`);
      else seen.set(key, file);
    };
    for (const island of this.world.islands.values()) {
      const dir = this.dirOf(island);
      for (const [i, s] of island.spawns.entries())
        claim("spawn", s.id, `${dir}/spawns.yaml`, [i, "id"]);
      for (const [i, z] of island.zones.entries())
        claim("zone", z.id, `${dir}/zones.yaml`, [i, "id"]);
      for (const [i, p] of island.portals.entries())
        claim("portal", p.id, `${dir}/portals.yaml`, [i, "id"]);
      for (const [i, t] of island.texts.entries())
        claim("text", t.id, `${dir}/texts.yaml`, [i, "id"]);
      for (const [i, n] of island.npcs.entries())
        claim("placed NPC", n.npc, `${dir}/npcs.yaml`, [i, "npc"]);
      for (const [i, h] of island.houses.entries())
        claim("house", h.id, `${dir}/houses.yaml`, [i, "id"]);
    }
  }

  /**
   * Reward chests (docs/02 "Libros y cofres"): a chest gives once per character under its
   * chest id (storage chest.<id>), so each chest id stands once in the whole world: a second
   * copy of the item, or another item with the same id, would be opened once between them.
   */
  private checkChestsPlacedOnce(): void {
    const placed = new Map<string, { id: string; pos: Position }>();
    for (const island of this.world.islands.values()) {
      const dir = this.dirOf(island);
      for (const { c, s, pos } of placedItems(island))
        for (const id of s.stack) {
          const cid = this.content.items.get(id)?.chest;
          if (cid === undefined) continue;
          const first = placed.get(cid);
          if (!first) placed.set(cid, { id, pos });
          else
            this.err(
              chunkFile(dir, c),
              ["items"],
              `chest "${cid}" ("${id}") is also at ${formatPos(first.pos)} ("${first.id}"): a chest gives once per character, so each one stands once in the world`,
              pos,
            );
        }
    }
  }

  /**
   * Arrivals through portals (docs/02 "Cambiar de piso"): a player lands on `to` or, if it
   * is taken, on the nearest free tile within travel.arrival_radius, which the server finds
   * by rings, not on foot (session freeAround). Every tile that search could pick (walkable,
   * outside houses, without an NPC, not the entrance of stairs, a hole or a teleport) must
   * be connected on foot with `to`, the way a player walks: around house tiles (the server
   * keeps the search in the area of `to`, where a house is a wall) and around NPCs (they
   * never leave their tile, so a corridor one blocks is a wall for players). Otherwise a
   * crowd on `to` could put a player across a wall, in a pocket it might never leave (a
   * relog comes back to the same tile).
   */
  private checkPortalArrivals(): void {
    const radius = this.content.arrivalRadius ?? MAX_ARRIVAL_RADIUS;
    const onStep = new Set<string>();
    const houses = new Set<string>();
    const npcs = new Set<string>();
    for (const island of this.world.islands.values()) {
      for (const p of island.portals) if (ON_STEP_KINDS.has(p.kind)) onStep.add(formatPos(p.from));
      for (const h of island.houses)
        for (const r of h.rects)
          for (const [x, y] of tilesOf(r)) houses.add(formatPos({ x, y, z: r.z }));
      for (const n of island.npcs) npcs.add(formatPos(n.pos));
    }
    for (const island of this.world.islands.values())
      for (const [i, p] of island.portals.entries()) {
        if (p.kind === "boat" || !isWalkable(this.tiles.tileAt(p.to), this.content)) continue;
        const stray = this.strayArrival(p.to, radius, onStep, houses, npcs);
        if (stray)
          this.err(
            `${this.dirOf(island)}/portals.yaml`,
            [i, "to"],
            `${formatPos(stray)} is within travel.arrival_radius (${radius}) of the destination but not connected to it on foot: a crowded arrival would land a player there`,
            p.to,
          );
      }
  }

  /**
   * The nearest tile (by rings) within radius of `to` where a taken arrival could land
   * that cannot be walked to from `to` (8 directions, one floor, doors open, across no
   * stairs, hole or teleport, no house tile and no NPC), or undefined. An NPC's tile is
   * never a landing tile (it is always taken). The walk stops once it found them all.
   */
  private strayArrival(
    to: Position,
    radius: number,
    onStep: Set<string>,
    houses: Set<string>,
    npcs: Set<string>,
  ): Position | undefined {
    const wall = (k: string): boolean => onStep.has(k) || houses.has(k) || npcs.has(k);
    const pending = new Map<string, Position>();
    for (let r = 1; r <= radius; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const q = { x: to.x + dx, y: to.y + dy, z: to.z };
          const k = formatPos(q);
          if (wall(k)) continue;
          if (isWalkable(this.tiles.tileAt(q), this.content)) pending.set(k, q);
        }
    const seen = new Set<string>([formatPos(to)]);
    const queue: Position[] = [to];
    for (let head = 0; head < queue.length && pending.size > 0; head++) {
      const p = queue[head] as Position;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const n = { x: p.x + dx, y: p.y + dy, z: p.z };
          const k = formatPos(n);
          if (seen.has(k) || wall(k)) continue;
          if (!isPassable(this.tiles.tileAt(n), this.content)) continue;
          seen.add(k);
          pending.delete(k);
          queue.push(n);
        }
    }
    return pending.values().next().value;
  }

  /**
   * Holes and teleports with no way out (docs/03 "Validación"): a warning when, from where
   * one leads, a player without keys or tools reaches no temple (templeReach: on foot in
   * its area, by stairs, ladders, holes and teleports; not by a rope spot or a boat). A pit
   * left with a rope is a fine design (a hole only leads down), so it is no error; one made
   * by mistake strands whoever takes it (a relog comes back to the same place). Stairs and
   * ladders have their pair instead (PAIRED_KINDS). The player lands in the area of `to` or,
   * when `to` is the entrance of stairs, a hole or a teleport (in no area), in one of the
   * areas next to it (the server's arrival search): each of them must reach a temple. A
   * destination in no area otherwise (a house, a locked door, no walkable tile) is refused
   * elsewhere.
   */
  private checkPortalExits(): void {
    const world = this.escapeWorld();
    const onStep = new Set<string>();
    for (const p of world.portals ?? [])
      if (ON_STEP_KINDS.has(p.kind)) onStep.add(formatPos(p.from));
    let reach: TempleReach | undefined;
    for (const island of this.world.islands.values())
      for (const [i, p] of island.portals.entries()) {
        if (!ONE_WAY_KINDS.has(p.kind)) continue;
        reach ??= templeReach(this.tiles, this.content, world);
        const { areaOf, escapes } = reach;
        const own = areaOf(p.to);
        const landing = new Set<number>(own !== 0 ? [own] : []);
        if (own === 0 && onStep.has(formatPos(p.to)))
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const a = areaOf({ x: p.to.x + dx, y: p.to.y + dy, z: p.to.z });
              if (a !== 0) landing.add(a);
            }
        if ([...landing].every((a) => escapes.has(a))) continue;
        this.warn(
          `${this.dirOf(island)}/portals.yaml`,
          [i, "to"],
          `from where ${p.kind} "${p.id}" leads, no temple is reached without keys or tools (on foot, by stairs, ladders, holes and teleports): fine for a pit left with a rope, otherwise whoever takes it is stuck`,
          p.to,
        );
      }
  }

  /**
   * Boat routes of data/boat_routes.yaml (T3.5): the captain is placed on the map, close
   * to the dock, and the dock and the arrival are walkable tiles of an island.
   */
  private checkBoatRoutes(): void {
    const placed = new Map<string, Position>();
    for (const island of this.world.islands.values())
      for (const n of island.npcs) placed.set(n.npc, n.pos);
    for (const r of this.content.routes) {
      const at = placed.get(r.captain);
      if (!at)
        this.err(
          routesFile,
          [r.index, "captain"],
          `NPC "${r.captain}" is not placed on any island`,
          r.from,
        );
      else if (
        at.z !== r.from.z ||
        Math.max(Math.abs(at.x - r.from.x), Math.abs(at.y - r.from.y)) > MAX_DOCK_DISTANCE
      )
        this.err(
          routesFile,
          [r.index, "from"],
          `the dock is more than ${MAX_DOCK_DISTANCE} tiles from captain "${r.captain}" (${formatPos(at)})`,
          r.from,
        );
      this.checkRouteTile(r.index, ["from"], r.from, "dock");
      this.checkRouteTile(r.index, ["to"], r.to, "arrival");
    }
  }

  /**
   * Dev-only islands (world.yaml `dev_only`, the sandbox island): mapcompile leaves them out
   * of a build without -dev, the production image's, so nothing the server checks against
   * the map may need one. No boat route leaves from or lands on one or has its captain
   * there (the server would not start), no dialog teleport lands on one (same), no portal
   * of another island leads into one (mapcompile would refuse the map), and the first
   * island of world.yaml, where characters with no town start, is not one.
   */
  private checkDevIslands(): void {
    const entries = this.world.meta.islands;
    const dev = new Set(entries.filter((e) => e.dev_only === true).map((e) => e.id));
    if (dev.size === 0) return;
    if (entries[0] && dev.has(entries[0].id))
      this.err(
        worldFile,
        ["islands", 0, "dev_only"],
        `the first island is where characters with no town start: "${entries[0].id}" cannot be dev-only`,
      );
    const devAt = (p: Position): string | undefined => {
      const id = this.islandAt(p)?.meta.id;
      return id !== undefined && dev.has(id) ? id : undefined;
    };
    const left = "a build without -dev (the production image) leaves it out";
    const placed = new Map<string, Position>();
    for (const island of this.world.islands.values())
      for (const n of island.npcs) placed.set(n.npc, n.pos);
    for (const r of this.content.routes) {
      for (const [key, p] of [
        ["from", r.from],
        ["to", r.to],
      ] as const) {
        const id = devAt(p);
        if (id)
          this.err(
            routesFile,
            [r.index, key],
            `boat route "${r.id}" ${key === "from" ? "leaves from" : "lands on"} dev-only island "${id}": ${left} and the server would not start`,
            p,
          );
      }
      const at = placed.get(r.captain);
      const id = at && devAt(at);
      if (at && id)
        this.err(
          routesFile,
          [r.index, "captain"],
          `captain "${r.captain}" of boat route "${r.id}" stands on dev-only island "${id}": ${left} and the server would not start`,
          at,
        );
    }
    for (const t of this.content.teleports ?? []) {
      const id = devAt(t.to);
      if (id)
        this.err(
          t.file,
          ["dialog", "nodes", t.node],
          `teleport of NPC "${t.npc}" (node "${t.node}") lands on dev-only island "${id}": ${left} and the server would not start`,
          t.to,
        );
    }
    for (const island of this.world.islands.values()) {
      if (dev.has(island.meta.id)) continue;
      for (const [i, p] of island.portals.entries()) {
        const id = devAt(p.to);
        if (id)
          this.err(
            `${this.dirOf(island)}/portals.yaml`,
            [i, "to"],
            `portal "${p.id}" leads into dev-only island "${id}": ${left} and mapcompile would refuse that map`,
            p.to,
          );
      }
    }
  }

  /**
   * Boat arrivals, dialog teleports, temples and house exits (docs/03 "Validación"; the
   * server's checkArrivals refuses the same, with the cases of testdata/arrivals.json): no
   * arrival on a house tile (an arrival puts nobody inside a house) nor on a locked door
   * placed open (a door is no place to land: its doorway). A dialog teleport also needs a
   * walkable tile of an island, as a boat arrival does (checkRouteTile). The temple and a
   * house exit, the last resorts of waking up and of putting someone out of a house (with
   * every tile around taken, the tile itself), lie on no door: on a locked one, open or
   * closed, whoever is put there would stand in its doorway, a step from its room; any
   * other one anyone may close, and whoever is put there next would stand in a closed door.
   * The temple lies in no house either (that both are walkable, needWalkable says).
   */
  private checkArrivals(): void {
    const owner = new Map<string, string>(); // house tile → house id, every island
    const lastResort = (file: string, path: PathSegment[], what: string, p: Position): void => {
      const tile = this.tiles.tileAt(p);
      const why = hasLockedDoor(tile, this.content)
        ? "lies on a locked door: whoever is put there with every tile around taken would stand in its doorway"
        : doorsOn(tile, this.content).length > 0
          ? "lies on a door anyone may close: whoever is put there with every tile around taken could stand in a closed door"
          : undefined;
      if (why) this.err(file, path, `${what} ${why}`, p);
    };
    for (const island of this.world.islands.values()) {
      const at = (p: Position): string => `${formatPos(p)} (island "${island.meta.id}")`;
      for (const [i, h] of island.houses.entries()) {
        for (const r of h.rects)
          for (const [x, y] of tilesOf(r)) owner.set(formatPos({ x, y, z: r.z }), h.id);
        lastResort(
          `${this.dirOf(island)}/houses.yaml`,
          [i, "exit"],
          `exit of house "${h.id}" at ${at(h.exit)}`,
          h.exit,
        );
      }
      const t = island.meta.temple;
      lastResort(`${this.dirOf(island)}/island.yaml`, ["temple"], `temple at ${at(t)}`, t);
    }
    for (const island of this.world.islands.values()) {
      const t = island.meta.temple;
      const house = owner.get(formatPos(t));
      if (house !== undefined)
        this.err(
          `${this.dirOf(island)}/island.yaml`,
          ["temple"],
          `temple at ${formatPos(t)} (island "${island.meta.id}") lies in house "${house}": nobody wakes up inside a house`,
          t,
        );
    }
    const land = (
      file: string,
      path: PathSegment[],
      what: string,
      p: Position,
      own: boolean,
    ): void => {
      const island = this.islandAt(p);
      const tile = this.tiles.tileAt(p);
      if (!island || !isWalkable(tile, this.content)) {
        // A boat arrival's own check (checkRouteTile) says it already.
        if (own)
          this.err(file, path, `${what} at ${formatPos(p)} is not a walkable tile of an island`, p);
        return;
      }
      const where = `${what} at ${formatPos(p)} (island "${island.meta.id}")`;
      const house = owner.get(formatPos(p));
      if (house !== undefined)
        this.err(
          file,
          path,
          `${where} lies in house "${house}": an arrival puts nobody inside a house`,
          p,
        );
      else if (hasLockedDoor(tile, this.content))
        this.err(file, path, `${where} lies on a locked door: a door is no place to land`, p);
    };
    for (const r of this.content.routes)
      land(routesFile, [r.index, "to"], `arrival of boat route "${r.id}"`, r.to, false);
    for (const t of this.content.teleports ?? [])
      land(
        t.file,
        ["dialog", "nodes", t.node],
        `teleport of NPC "${t.npc}" (node "${t.node}")`,
        t.to,
        true,
      );
  }

  private plateCache: Map<string, PlacedPlate> | undefined;

  /** Every sigil plate placed in the world, by tile. */
  private plates(): Map<string, PlacedPlate> {
    if (this.plateCache) return this.plateCache;
    const out = new Map<string, PlacedPlate>();
    for (const island of this.world.islands.values()) {
      const dir = this.dirOf(island);
      for (const { c, s, pos } of placedItems(island))
        for (const id of s.stack) {
          const vocation = this.content.items.get(id)?.sigil;
          if (vocation !== undefined)
            out.set(formatPos(pos), { pos, vocation, id, file: chunkFile(dir, c) });
        }
    }
    this.plateCache = out;
    return out;
  }

  /** The plates within a sigils step's square, in row order. */
  private platesOf(s: SigilInfo): Position[] {
    const out: Position[] = [];
    for (const p of this.plates().values())
      if (
        p.pos.z === s.at.z &&
        Math.max(Math.abs(p.pos.x - s.at.x), Math.abs(p.pos.y - s.at.y)) <= s.radius
      )
        out.push(p.pos);
    return out.sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /**
   * Milestone plates (docs/02 "Quests de hito", the server's initSigils): each sigils step
   * has as many plates within its square as requires.players, with the vocations it lists
   * (or none), on walkable tiles; a plate belongs to one milestone, and none lies outside
   * every milestone. The reward room (`to`) is a walkable tile of an island outside houses,
   * locked doors and portal entrances, and from it a player reaches a temple without keys
   * or tools (templeReach: on foot, stairs, ladders, holes, teleports, out of a room
   * through its door): whoever lands there must be able to leave. That the plates are
   * reached on foot is checkReachability's, which also counts the reward room as reached
   * from them.
   */
  private checkSigils(): void {
    const owner = new Map<string, string>();
    const houses = new Set<string>();
    for (const island of this.world.islands.values())
      for (const h of island.houses)
        for (const r of h.rects)
          for (const [x, y] of tilesOf(r)) houses.add(formatPos({ x, y, z: r.z }));
    const steps = new Set<string>();
    for (const p of this.escapeWorld().portals ?? [])
      if (ON_STEP_KINDS.has(p.kind)) steps.add(formatPos(p.from));
    let reach: TempleReach | undefined;
    for (const s of this.content.sigils ?? []) {
      const path: PathSegment[] = ["steps", s.step, "complete_when", "sigils"];
      const plates = this.platesOf(s);
      const what = `milestone "${s.quest}"`;
      if (plates.length !== s.players)
        this.err(
          s.file,
          path,
          `${what}: ${plates.length} sigil plates within radius ${s.radius} of ${formatPos(s.at)}, requires.players is ${s.players}`,
          s.at,
        );
      const got = plates.map((p) => this.plates().get(formatPos(p))?.vocation ?? "").sort();
      const want = (s.vocations.length > 0 ? [...s.vocations] : plates.map(() => "")).sort();
      if (plates.length === s.players && got.join(",") !== want.join(","))
        this.err(
          s.file,
          path,
          `${what}: its plates are marked [${got.join(", ")}], requires.vocations is [${s.vocations.join(", ")}]`,
          s.at,
        );
      for (const p of plates) {
        const k = formatPos(p);
        const other = owner.get(k);
        if (other !== undefined && other !== s.quest)
          this.err(
            s.file,
            path,
            `${what}: the plate at ${k} is also one of milestone "${other}"`,
            p,
          );
        owner.set(k, s.quest);
        if (!isWalkable(this.tiles.tileAt(p), this.content))
          this.err(s.file, path, `${what}: the plate at ${k} is not a walkable tile`, p);
      }
      const to = s.to;
      const tile = this.tiles.tileAt(to);
      const at = `${what}: its reward room at ${formatPos(to)}`;
      if (!this.islandAt(to) || !isWalkable(tile, this.content))
        this.err(s.file, [...path, "to"], `${at} is not a walkable tile of an island`, to);
      else if (houses.has(formatPos(to)))
        this.err(s.file, [...path, "to"], `${at} lies in a house`, to);
      else if (hasLockedDoor(tile, this.content) || steps.has(formatPos(to)))
        this.err(s.file, [...path, "to"], `${at} lies on a locked door or a portal entrance`, to);
      else {
        reach ??= templeReach(this.tiles, this.content, this.escapeWorld());
        if (!reach.escapes.has(reach.areaOf(to)))
          this.err(
            s.file,
            [...path, "to"],
            `${at}: no temple is reached from there without keys or tools (on foot, stairs, ladders, holes, teleports, out of a room through its door): whoever lands there is stuck`,
            to,
          );
      }
    }
    for (const [k, p] of this.plates())
      if (!owner.has(k))
        this.err(
          p.file,
          ["items"],
          `sigil plate "${p.id}" at ${k} belongs to no milestone's sigils step`,
          p.pos,
        );
  }

  /** The island whose rect holds p, or undefined. */
  private islandAt(p: Position): Island | undefined {
    return [...this.world.islands.values()].find((i) => rectContains(i.meta.rect, p.x, p.y));
  }

  private checkRouteTile(index: number, path: PathSegment[], p: Position, what: string): void {
    const island = this.islandAt(p);
    if (!island) this.err(routesFile, [index, ...path], `${what} is outside every island`, p);
    else if (!isWalkable(this.tiles.tileAt(p), this.content))
      this.err(routesFile, [index, ...path], `${what} is not a walkable tile`, p);
  }

  private checkI18n(file: string, path: PathSegment[], key: string): void {
    const missing = [...this.content.i18n]
      .filter(([, keys]) => !keys.has(key))
      .map(([lang]) => lang);
    if (this.content.i18n.size === 0)
      this.err(file, path, `i18n key "${key}": no languages under i18n/`);
    else if (missing.length > 0)
      this.err(file, path, `i18n key "${key}" is missing in: ${missing.join(", ")}`);
  }

  // ---- geometry helpers ------------------------------------------------------------

  /** A stairs/ladder portal from next to `to` that lands next to `from` (Chebyshev distance ≤ 1). */
  private hasPair(from: Position, to: Position): boolean {
    const near = (a: Position, b: Position): boolean =>
      a.z === b.z && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;
    for (const island of this.world.islands.values())
      for (const p of island.portals)
        if (PAIRED_KINDS.has(p.kind) && near(p.from, to) && near(p.to, from)) return true;
    return false;
  }

  /** Whether a portal item stands on the entrance of a portal it shows. */
  private portalItemFits(info: ItemInfo, p: Portal | undefined): boolean {
    return p !== undefined && showsPortal(info, p.kind, p.from, p.to);
  }

  /** Whether the tile `from` holds an item that shows the portal of kind to `to`. */
  private portalShown(kind: string, from: Position, to: Position): boolean {
    const tile = this.tiles.tileAt(from);
    if (!tile) return false;
    return [tile.ground, ...tile.stack].some(
      (id) => id !== null && showsPortal(this.content.items.get(id), kind, from, to),
    );
  }

  /** "e.g. stairs_down" with the items of data/ that show such a portal, or a hint to add one. */
  private portalItemsHint(kind: string, from: Position, to: Position): string {
    const ids = [...this.content.items.values()]
      .filter((info) => showsPortal(info, kind, from, to))
      .map((info) => info.id)
      .sort();
    return ids.length > 0 ? `e.g. ${ids.join(" or ")}` : "none in data/items yet";
  }

  private walkableAround(c: Position, radius: number): number {
    let n = 0;
    for (let y = c.y - radius; y <= c.y + radius; y++)
      for (let x = c.x - radius; x <= c.x + radius; x++)
        if (isWalkable(this.tiles.tile(x, y, c.z), this.content)) n++;
    return n;
  }

  /**
   * The portals of the world by entrance tile, as the server moves players through them
   * (docs/02 "Cambiar de piso"): where each leads, and whether stepping onto it moves the
   * player (stairs, hole, teleport). Boat portals move nobody and are left out.
   */
  private portalMoves(): Map<string, { to: Position[]; onStep: boolean }> {
    const out = new Map<string, { to: Position[]; onStep: boolean }>();
    for (const i of this.world.islands.values())
      for (const p of i.portals) {
        if (p.kind === "boat") continue;
        const k = formatPos(p.from);
        const e = out.get(k) ?? { to: [], onStep: false };
        e.to.push(p.to);
        e.onStep ||= ON_STEP_KINDS.has(p.kind);
        out.set(k, e);
      }
    return out;
  }

  /**
   * BFS from the temple over passable tiles (8 directions, like player movement) and portals,
   * as the server moves players: a step onto stairs, a hole or a teleport only leads to its
   * destination (nobody walks across it), a ladder or a rope spot is a tile like any other
   * that also leads to its destination, a boat portal leads nowhere. Doors count as open
   * (isPassable): a locked door opens with its key, so the room behind it is reachable
   * (docs/02 "Puertas con llave"). Every spawn, NPC and non-community zone must be
   * reachable on foot.
   */
  private checkReachability(island: Island): void {
    const meta = island.meta;
    if (!isWalkable(this.tiles.tileAt(meta.temple), this.content)) return; // already reported
    const portals = this.portalMoves();
    // A milestone's plates lead to its reward room (the server moves the group there).
    const sigilTo = new Map<string, Position>();
    for (const s of this.content.sigils ?? [])
      for (const p of this.platesOf(s)) sigilTo.set(formatPos(p), s.to);
    const reached = new Set<string>();
    const queue: Position[] = [meta.temple];
    reached.add(formatPos(meta.temple));
    while (queue.length > 0) {
      const p = queue.pop() as Position;
      const moves = portals.get(formatPos(p));
      const next: Position[] = [...(moves?.to ?? [])];
      const reward = sigilTo.get(formatPos(p));
      if (reward) next.push(reward);
      // Off stairs only to their destination (the temple itself is where one starts).
      if (!moves?.onStep || p === meta.temple)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (dx !== 0 || dy !== 0) next.push({ x: p.x + dx, y: p.y + dy, z: p.z });
      for (const n of next) {
        const k = formatPos(n);
        if (reached.has(k) || !rectContains(meta.rect, n.x, n.y)) continue;
        if (!isPassable(this.tiles.tileAt(n), this.content)) continue;
        reached.add(k);
        queue.push(n);
      }
    }
    const dir = this.dirOf(island);
    const ok = (p: Position): boolean => reached.has(formatPos(p));
    const walkable = (p: Position): boolean => isWalkable(this.tiles.tileAt(p), this.content);
    for (const [i, s] of island.spawns.entries())
      if (walkable(s.center) && !ok(s.center))
        this.err(
          `${dir}/spawns.yaml`,
          [i, "center"],
          "spawn cannot be reached on foot from the temple",
          s.center,
        );
    for (const [i, n] of island.npcs.entries())
      if (walkable(n.pos) && !ok(n.pos))
        this.err(
          `${dir}/npcs.yaml`,
          [i, "pos"],
          "NPC cannot be reached on foot from the temple",
          n.pos,
        );
    for (const [i, h] of island.houses.entries())
      if (walkable(h.exit) && !ok(h.exit))
        this.err(
          `${dir}/houses.yaml`,
          [i, "exit"],
          "house exit cannot be reached on foot from the temple",
          h.exit,
        );
    // A reward chest opens from its tile or one next to it (docs/02 "Libros y cofres"), where
    // a player stands: not the entrance of stairs, a hole or a teleport, which moves it on.
    const standsNear = (p: Position): boolean => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = formatPos({ x: p.x + dx, y: p.y + dy, z: p.z });
          if (reached.has(k) && portals.get(k)?.onStep !== true) return true;
        }
      return false;
    };
    for (const { c, s, pos } of placedItems(island))
      for (const id of s.stack)
        if (this.content.items.get(id)?.chest !== undefined && !standsNear(pos))
          this.err(
            chunkFile(dir, c),
            ["items"],
            `chest "${id}" cannot be opened: no tile next to it is reached on foot from the temple`,
            pos,
          );
    for (const s of this.content.sigils ?? [])
      for (const p of this.platesOf(s))
        if (
          rectContains(meta.rect, p.x, p.y) &&
          (!reached.has(formatPos(p)) || portals.get(formatPos(p))?.onStep === true)
        )
          this.err(
            s.file,
            ["steps", s.step, "complete_when", "sigils"],
            `sigil plate of milestone "${s.quest}" at ${formatPos(p)} is not reached on foot from the temple (or moves whoever steps on it): the milestone could never be done`,
            p,
          );
    this.warnUnreachableAreas(island, reached, portals);
    this.checkReachPlaces(island, reached, portals);
    for (const [i, z] of island.zones.entries()) {
      if (z.type === "community_plot") continue;
      const any = z.floors.some((f) =>
        z.rects.some((r) => anyIn(clip(r, meta.rect), (x, y) => ok({ x, y, z: f }))),
      );
      if (!any)
        this.err(`${dir}/zones.yaml`, [i], `zone "${z.id}" has no tile reachable from the temple`);
    }
  }

  /**
   * The place of every reach step of data/quests on this island (docs/06 "Quest") needs a
   * tile reached on foot from the temple (the BFS of checkReachability) where a player can
   * stand: walkable, and no entrance of stairs, a hole or a teleport (a step onto one
   * lands elsewhere). Otherwise the step can never be done, and the quest is stuck there. A
   * point counts on the island whose rect and floors hold it; a zone, on the island that has
   * it. The server checks that some such tile is walkable (initReach), not that it is
   * reached.
   */
  private checkReachPlaces(
    island: Island,
    reached: Set<string>,
    portals: Map<string, { onStep: boolean }>,
  ): void {
    const meta = island.meta;
    const stands = (p: Position): boolean => {
      const k = formatPos(p);
      return (
        reached.has(k) &&
        portals.get(k)?.onStep !== true &&
        isWalkable(this.tiles.tileAt(p), this.content)
      );
    };
    for (const r of this.content.reaches ?? []) {
      const path = ["steps", r.step, "complete_when", "reach"];
      let ok: boolean;
      let where: string;
      if (r.zone !== undefined) {
        const z = island.zones.find((zone) => zone.id === r.zone);
        if (!z) continue;
        where = `zone "${r.zone}"`;
        ok = z.floors.some((f) =>
          z.rects.some((rect) => anyIn(clip(rect, meta.rect), (x, y) => stands({ x, y, z: f }))),
        );
      } else if (r.at) {
        const { x, y, z } = r.at;
        if (!rectContains(meta.rect, x, y) || !meta.floors.includes(z)) continue;
        const radius = r.radius ?? 0;
        where = `point ${x},${y},${z} radius ${radius}`;
        const square = { x: x - radius, y: y - radius, w: 2 * radius + 1, h: 2 * radius + 1 };
        ok = anyIn(clip(square, meta.rect), (tx, ty) => stands({ x: tx, y: ty, z }));
      } else continue;
      if (!ok)
        this.err(
          r.file,
          path,
          `reach step of quest "${r.quest}": no tile of its ${where} on island "${meta.id}" is walkable ground reached on foot from the temple (stairs, holes and teleports count where they land): the step could never be done`,
          r.at,
        );
    }
  }

  /**
   * Warns once per connected walkable area (8 directions, one floor, doors open) that the
   * temple BFS did not reach and that has at least UNREACHABLE_AREA_MIN tiles: a stranded
   * dock, a sandbar the generator left, a room with no stairs. Areas inside a community_plot
   * are skipped (they may be unbuilt). Smaller pockets (a tile between two trees) are noise.
   */
  private warnUnreachableAreas(
    island: Island,
    reached: Set<string>,
    portals: Map<string, { onStep: boolean }>,
  ): void {
    const meta = island.meta;
    // Nobody walks across stairs, a hole or a teleport: they split areas like a wall.
    const across = (k: string): boolean => portals.get(k)?.onStep !== true;
    const plots = island.zones.filter((z) => z.type === "community_plot");
    const inPlot = (p: Position): boolean =>
      plots.some((z) => z.floors.includes(p.z) && z.rects.some((r) => rectContains(r, p.x, p.y)));
    const seen = new Set<string>();
    const walkable = (p: Position): boolean => isWalkable(this.tiles.tileAt(p), this.content);
    const chunks = [...island.chunks.values()].sort(
      (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
    );
    for (const c of chunks) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++)
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const start = { x: c.cx * CHUNK_SIZE + lx, y: c.cy * CHUNK_SIZE + ly, z: c.z };
          const k0 = formatPos(start);
          if (
            seen.has(k0) ||
            reached.has(k0) ||
            !across(k0) ||
            !rectContains(meta.rect, start.x, start.y)
          )
            continue;
          if (!walkable(start)) continue;
          seen.add(k0);
          let size = 0;
          let plot = false;
          const queue: Position[] = [start];
          while (queue.length > 0) {
            const p = queue.pop() as Position;
            size++;
            plot ||= inPlot(p);
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                const n = { x: p.x + dx, y: p.y + dy, z: p.z };
                const k = formatPos(n);
                if (seen.has(k) || !across(k) || !rectContains(meta.rect, n.x, n.y)) continue;
                if (!isPassable(this.tiles.tileAt(n), this.content)) continue;
                seen.add(k);
                queue.push(n);
              }
          }
          if (size >= UNREACHABLE_AREA_MIN && !plot)
            this.warn(
              `${this.dirOf(island)}/island.yaml`,
              ["temple"],
              `${size} walkable tiles around here cannot be reached on foot from the temple`,
              start,
            );
        }
    }
  }
}

/** The file of chunk c of the island in directory dir. */
function chunkFile(dir: string, c: Chunk): string {
  return `${dir}/chunks/${floorDir(c.z)}/${chunkFileName(c.cx, c.cy)}`;
}

/**
 * Every item stack of the island's chunks (by floor, then chunk row and column) with its
 * chunk and world position.
 */
/** A sigil plate placed on the map (checkSigils). */
interface PlacedPlate {
  pos: Position;
  vocation: string;
  id: string;
  file: string;
}

function placedItems(island: Island): { c: Chunk; s: Chunk["items"][number]; pos: Position }[] {
  const out: { c: Chunk; s: Chunk["items"][number]; pos: Position }[] = [];
  const chunks = [...island.chunks.values()].sort(
    (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
  );
  for (const c of chunks)
    for (const s of c.items)
      out.push({ c, s, pos: { x: c.cx * CHUNK_SIZE + s.x, y: c.cy * CHUNK_SIZE + s.y, z: c.z } });
  return out;
}

/** The [x, y] of every tile of a rect. */
function tilesOf(r: { x: number; y: number; w: number; h: number }): [number, number][] {
  const out: [number, number][] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push([x, y]);
  return out;
}

/** Walkable areas of at least this many tiles that cannot be reached warn (T3.6). */
export const UNREACHABLE_AREA_MIN = 10;

function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Intersection of two rects (w/h may be 0 when they do not overlap). */
function clip(r: Rect, bounds: Rect): Rect {
  const x = Math.max(r.x, bounds.x);
  const y = Math.max(r.y, bounds.y);
  const w = Math.max(0, Math.min(r.x + r.w, bounds.x + bounds.w) - x);
  const h = Math.max(0, Math.min(r.y + r.h, bounds.y + bounds.h) - y);
  return { x, y, w, h };
}

function anyIn(r: Rect, fn: (x: number, y: number) => boolean): boolean {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) if (fn(x, y)) return true;
  return false;
}
