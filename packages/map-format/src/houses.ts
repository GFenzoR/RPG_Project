// House geometry (docs/03-world-and-maps.md, "Casas"): the tiles of a house, the rects that
// cover a set of tiles, and the checks a house must pass. Shared by the house ops, the
// validator and the editor's house panel, so they agree on what a valid house is.
// Browser-safe: only types and plain code (the editor bundles it through ./ops).
import {
  CHUNK_SIZE,
  MAX_HOUSE_DOORS,
  MAX_HOUSE_RECTS,
  MAX_HOUSE_SIDE,
  chunkKey,
  formatPos,
  rectContains,
} from "./types.ts";
import type { House, HouseRect, Island, Position, World } from "./types.ts";

/** Largest rent (the server stores it as a u32). */
export const MAX_HOUSE_RENT = 4294967295;

/** i18n key of a house's name: always derived from its id (docs/03). */
export const houseNameKey = (id: string): string => `house.${id}.name`;

const HOUSE_ID = /^[a-z][a-z0-9_]*$/;

/** Whether `id` is a valid house id (snake_case, at most 64 characters). */
export const isHouseId = (id: unknown): id is string =>
  typeof id === "string" && HOUSE_ID.test(id) && id.length <= 64;

/** Sorts tiles by floor, row and column and drops repeated ones. */
export function sortTiles(tiles: readonly Position[]): Position[] {
  const seen = new Set<string>();
  const out: Position[] = [];
  for (const t of tiles) {
    const k = formatPos(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: t.x, y: t.y, z: t.z });
  }
  return out.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
}

/** Every tile of the rects (each once), sorted by floor, row and column. */
export function houseTiles(rects: readonly HouseRect[]): Position[] {
  const out: Position[] = [];
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y, z: r.z });
  return sortTiles(out);
}

/**
 * Rects that cover exactly `tiles` (no tile twice), deterministic: per floor (ascending),
 * the first free tile in row order starts a rect that grows right as far as it can, then
 * down while the whole row below is free. Sides stop at MAX_HOUSE_SIDE. A house drawn as
 * a main room plus a doorway gives the same two rects as houses.yaml writes by hand.
 */
export function tilesToRects(tiles: readonly Position[]): HouseRect[] {
  const sorted = sortTiles(tiles);
  const free = new Set(sorted.map(formatPos));
  const has = (x: number, y: number, z: number): boolean => free.has(`${x},${y},${z}`);
  const out: HouseRect[] = [];
  for (const t of sorted) {
    if (!has(t.x, t.y, t.z)) continue;
    let w = 1;
    while (w < MAX_HOUSE_SIDE && has(t.x + w, t.y, t.z)) w++;
    let h = 1;
    const rowFree = (y: number): boolean => {
      for (let x = t.x; x < t.x + w; x++) if (!has(x, y, t.z)) return false;
      return true;
    };
    while (h < MAX_HOUSE_SIDE && rowFree(t.y + h)) h++;
    for (let y = t.y; y < t.y + h; y++)
      for (let x = t.x; x < t.x + w; x++) free.delete(`${x},${y},${t.z}`);
    out.push({ x: t.x, y: t.y, z: t.z, w, h });
  }
  return out;
}

const inRects = (rects: readonly HouseRect[], p: Position): boolean =>
  rects.some((r) => r.z === p.z && rectContains(r, p.x, p.y));

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Whether tile `p` of the house is on its edge: one of its 4 neighbours (same floor) is not
 * a house tile. Doors must be (the outside meets the house there).
 */
export function onHouseEdge(rects: readonly HouseRect[], p: Position): boolean {
  return SIDES.some(([dx, dy]) => !inRects(rects, { x: p.x + dx, y: p.y + dy, z: p.z }));
}

/** Floors whose house tiles are not one 4-connected area (ascending). */
export function disconnectedFloors(rects: readonly HouseRect[]): number[] {
  const byFloor = new Map<number, Position[]>();
  for (const t of houseTiles(rects)) {
    const list = byFloor.get(t.z);
    if (list) list.push(t);
    else byFloor.set(t.z, [t]);
  }
  const out: number[] = [];
  for (const [z, tiles] of byFloor) {
    const all = new Set(tiles.map(formatPos));
    const first = tiles[0] as Position;
    const reached = new Set([formatPos(first)]);
    const queue = [first];
    while (queue.length > 0) {
      const p = queue.pop() as Position;
      for (const [dx, dy] of SIDES) {
        const n = { x: p.x + dx, y: p.y + dy, z };
        const k = formatPos(n);
        if (all.has(k) && !reached.has(k)) {
          reached.add(k);
          queue.push(n);
        }
      }
    }
    if (reached.size < all.size) out.push(z);
  }
  return out.sort((a, b) => a - b);
}

/** A house as a form or a tool builds it: the exit may still be missing. */
export type HouseInput = Omit<House, "exit"> & { exit?: Position | undefined };

export type HouseIssueCode =
  | "id"
  | "duplicate"
  | "rent"
  | "no_tiles"
  | "too_many_rects"
  | "rect_too_big"
  | "rects_overlap"
  | "outside_island"
  | "two_islands"
  | "overlap"
  | "no_doors"
  | "too_many_doors"
  | "door_outside"
  | "door_not_on_edge"
  | "no_exit"
  | "exit_outside_island"
  | "exit_in_house"
  | "exit_far"
  | "not_contiguous"
  | "no_ground";

/** Blocking problems; the rest are warnings (the house works, but looks like a mistake). */
const WARNINGS: ReadonlySet<HouseIssueCode> = new Set(["not_contiguous", "no_ground"]);

export interface HouseIssue {
  code: HouseIssueCode;
  severity: "error" | "warning";
  /** Tile the problem is at, when there is one. */
  pos?: Position;
  /** The other house (overlap, exit_in_house) or the floor (not_contiguous). */
  other?: string;
}

/** Island whose rect holds (x, y) and lists floor z; undefined outside every island. */
function islandHolding(world: World, p: Position): Island | undefined {
  for (const isl of world.islands.values())
    if (rectContains(isl.meta.rect, p.x, p.y))
      return isl.meta.floors.includes(p.z) ? isl : undefined;
  return undefined;
}

function groundAt(isl: Island, p: Position): string | null {
  const c = isl.chunks.get(
    chunkKey(p.z, Math.floor(p.x / CHUNK_SIZE), Math.floor(p.y / CHUNK_SIZE)),
  );
  if (!c) return null;
  return c.ground[(p.y - c.cy * CHUNK_SIZE) * CHUNK_SIZE + (p.x - c.cx * CHUNK_SIZE)] ?? null;
}

export interface HouseIssueOptions {
  /**
   * Id of the house this one replaces (an edit): its tiles and id do not count as taken.
   * Undefined for a new house.
   */
  replacing?: string;
}

/**
 * Everything wrong with `house` in `world` (docs/03 "Casas"): bad id or rent, no tiles or
 * too many rects, tiles outside the island or spanning two, tiles of another house, doors
 * that are not on the house's edge, an exit that is missing, inside a house or not next to
 * a door; and as warnings, tiles that are not one connected area per floor or have no
 * ground. Walkability and reachability are left to the validator (they depend on items).
 */
export function houseIssues(
  world: World,
  house: HouseInput,
  opts: HouseIssueOptions = {},
): HouseIssue[] {
  const out: HouseIssue[] = [];
  const add = (code: HouseIssueCode, pos?: Position, other?: string): void => {
    out.push({
      code,
      severity: WARNINGS.has(code) ? "warning" : "error",
      ...(pos ? { pos: { x: pos.x, y: pos.y, z: pos.z } } : {}),
      ...(other === undefined ? {} : { other }),
    });
  };
  const others: House[] = [];
  for (const isl of world.islands.values())
    for (const h of isl.houses) if (h.id !== opts.replacing) others.push(h);
  if (!isHouseId(house.id)) add("id");
  else if (others.some((h) => h.id === house.id)) add("duplicate");
  if (!Number.isInteger(house.rent) || house.rent < 1 || house.rent > MAX_HOUSE_RENT) add("rent");

  const rects = house.rects;
  if (rects.length === 0) add("no_tiles");
  if (rects.length > MAX_HOUSE_RECTS) add("too_many_rects");
  if (rects.some((r) => r.w > MAX_HOUSE_SIDE || r.h > MAX_HOUSE_SIDE)) add("rect_too_big");
  const tiles = houseTiles(rects);
  if (tiles.length < rects.reduce((n, r) => n + r.w * r.h, 0)) add("rects_overlap");

  let home: Island | undefined;
  let outside: Position | undefined;
  let split = false;
  let bare: Position | undefined;
  for (const t of tiles) {
    const isl = islandHolding(world, t);
    if (!isl) {
      outside ??= t;
      continue;
    }
    home ??= isl;
    if (isl !== home) split = true;
    else if (groundAt(isl, t) === null) bare ??= t;
  }
  if (outside) add("outside_island", outside);
  if (split) add("two_islands");
  const owner = new Map<string, string>();
  for (const h of others) for (const t of houseTiles(h.rects)) owner.set(formatPos(t), h.id);
  const taken = tiles.find((t) => owner.has(formatPos(t)));
  if (taken) add("overlap", taken, owner.get(formatPos(taken)));

  if (house.doors.length === 0) add("no_doors");
  if (house.doors.length > MAX_HOUSE_DOORS) add("too_many_doors");
  for (const d of house.doors) {
    if (!inRects(rects, d)) add("door_outside", d);
    else if (!onHouseEdge(rects, d)) add("door_not_on_edge", d);
  }

  const exit = house.exit;
  if (!exit) add("no_exit");
  else {
    if (!islandHolding(world, exit) || (home && islandHolding(world, exit) !== home))
      add("exit_outside_island", exit);
    if (inRects(rects, exit)) add("exit_in_house", exit, house.id);
    else if (owner.has(formatPos(exit))) add("exit_in_house", exit, owner.get(formatPos(exit)));
    const near = house.doors.some(
      (d) => d.z === exit.z && Math.max(Math.abs(d.x - exit.x), Math.abs(d.y - exit.y)) === 1,
    );
    if (house.doors.length > 0 && !near) add("exit_far", exit);
  }

  for (const z of disconnectedFloors(rects)) add("not_contiguous", undefined, String(z));
  if (bare) add("no_ground", bare);
  return out;
}
