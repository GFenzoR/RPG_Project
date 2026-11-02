// World validation (docs/03-world-and-maps.md, "Validación"). The editor, mapcli, the MCP
// server and `make validate` all call validateWorld, so they agree on what is an error.
import { loadContent } from "./content.ts";
import type { ContentIndex } from "./content.ts";
import { Reporter } from "./diagnostics.ts";
import type { Diagnostic, PathSegment } from "./diagnostics.ts";
import { islandDir, loadWorld, worldFile } from "./io.ts";
import type { LoadResult } from "./io.ts";
import { TileMap, isWalkable } from "./tiles.ts";
import { CHUNK_SIZE, formatPos, rectContains, rectsOverlap } from "./types.ts";
import type { Island, Position, Rect, World } from "./types.ts";

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

/** Stairs and ladders that need a way back, with the kinds that can serve as it. */
const PAIRED_KINDS = new Set(["stairs", "ladder"]);

export function validateWorld(root: string, opts: ValidateWorldOptions = {}): MapReport {
  const loaded = loadWorld(root);
  const content = opts.content ?? loadContent(root);
  const v = new WorldValidator(loaded, content);
  v.run();
  let diags = [...loaded.diagnostics, ...v.diags];
  if (opts.island !== undefined) {
    const id = opts.island;
    const prefix = `${islandDir(id)}/`;
    // world.yaml findings about this island: its entry in `islands` and routes sailing to it.
    const entries = new Set<number>();
    loaded.world.meta.islands.forEach((e, i) => e.id === id && entries.add(i));
    const routes = new Set<number>();
    loaded.world.meta.boat_routes.forEach((b, i) => b.to.island === id && routes.add(i));
    const aboutIsland = (d: Diagnostic): boolean => {
      if (d.file.startsWith(prefix)) return true;
      if (d.file !== worldFile) return false;
      const [section, index] = d.path;
      if (typeof index !== "number") return false;
      return (
        (section === "islands" && entries.has(index)) ||
        (section === "boat_routes" && routes.has(index))
      );
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
    this.checkBoatRoutes();
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
      for (let j = 0; j < i; j++) {
        const other = entries[j];
        if (other && rectsOverlap(e.rect, other.rect))
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
    for (const [i, p] of island.portals.entries()) {
      needWalkable(portalsFile, [i, "from"], p.from, "portal entrance");
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
      if (PAIRED_KINDS.has(p.kind) && !this.hasPair(p.from, p.to))
        this.err(
          portalsFile,
          [i],
          `${p.kind} at ${formatPos(p.from)} has no way back: add a stairs/ladder portal from next to ${formatPos(p.to)} to next to ${formatPos(p.from)}`,
          p.from,
        );
    }

    const textsFile = `${dir}/texts.yaml`;
    for (const [i, t] of island.texts.entries()) {
      const out = where(t.pos);
      if (out) this.err(textsFile, [i, "pos"], `text is ${out}`, t.pos);
      else if (!this.tiles.tileAt(t.pos)?.ground)
        this.err(textsFile, [i, "pos"], "text is on a tile without ground", t.pos);
      this.checkI18n(textsFile, [i, "text"], t.text);
    }

    this.checkReachability(island);
  }

  private checkChunks(island: Island, floors: Set<number>): void {
    const dir = this.dirOf(island);
    const rect = island.meta.rect;
    for (const c of island.chunks.values()) {
      const file = `${dir}/chunks/z${String(c.z).padStart(2, "0")}/c${String(c.cx).padStart(4, "0")}_${String(c.cy).padStart(4, "0")}.json`;
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
          }
        }
      }
    }
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
    }
  }

  private checkBoatRoutes(): void {
    const placed = new Set<string>();
    for (const island of this.world.islands.values())
      for (const n of island.npcs) placed.add(n.npc);
    for (const [i, b] of this.world.meta.boat_routes.entries()) {
      if (!placed.has(b.from_npc))
        this.err(
          worldFile,
          ["boat_routes", i, "from_npc"],
          `NPC "${b.from_npc}" is not placed on any island`,
        );
      const island = this.world.islands.get(b.to.island);
      if (!island) {
        this.err(worldFile, ["boat_routes", i, "to", "island"], `unknown island "${b.to.island}"`);
        continue;
      }
      if (!rectContains(island.meta.rect, b.to.pos.x, b.to.pos.y))
        this.err(
          worldFile,
          ["boat_routes", i, "to", "pos"],
          `outside island "${b.to.island}"`,
          b.to.pos,
        );
      else if (!isWalkable(this.tiles.tileAt(b.to.pos), this.content))
        this.err(
          worldFile,
          ["boat_routes", i, "to", "pos"],
          "boat destination is not a walkable tile",
          b.to.pos,
        );
    }
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

  private walkableAround(c: Position, radius: number): number {
    let n = 0;
    for (let y = c.y - radius; y <= c.y + radius; y++)
      for (let x = c.x - radius; x <= c.x + radius; x++)
        if (isWalkable(this.tiles.tile(x, y, c.z), this.content)) n++;
    return n;
  }

  /**
   * BFS from the temple over walkable tiles (8 directions, like player movement) and portals.
   * Every spawn, NPC and non-community zone must be reachable on foot.
   */
  private checkReachability(island: Island): void {
    const meta = island.meta;
    if (!isWalkable(this.tiles.tileAt(meta.temple), this.content)) return; // already reported
    const portals = new Map<string, Position[]>();
    for (const i of this.world.islands.values())
      for (const p of i.portals) {
        const k = formatPos(p.from);
        portals.set(k, [...(portals.get(k) ?? []), p.to]);
      }
    const reached = new Set<string>();
    const queue: Position[] = [meta.temple];
    reached.add(formatPos(meta.temple));
    while (queue.length > 0) {
      const p = queue.pop() as Position;
      const next: Position[] = [...(portals.get(formatPos(p)) ?? [])];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (dx !== 0 || dy !== 0) next.push({ x: p.x + dx, y: p.y + dy, z: p.z });
      for (const n of next) {
        const k = formatPos(n);
        if (reached.has(k) || !rectContains(meta.rect, n.x, n.y)) continue;
        if (!isWalkable(this.tiles.tileAt(n), this.content)) continue;
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
    for (const [i, z] of island.zones.entries()) {
      if (z.type === "community_plot") continue;
      const any = z.floors.some((f) =>
        z.rects.some((r) => anyIn(clip(r, meta.rect), (x, y) => ok({ x, y, z: f }))),
      );
      if (!any)
        this.err(`${dir}/zones.yaml`, [i], `zone "${z.id}" has no tile reachable from the temple`);
    }
  }
}

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
