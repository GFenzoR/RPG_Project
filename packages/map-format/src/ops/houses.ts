// Ops on houses.yaml (T5.4, docs/03 "Casas"): add, remove and change a player house. The
// island is the one that holds the house's first rect; every rect, door and the exit must
// be in it. The ops check the shape the file and the server need (schema limits, doors on
// house tiles, the exit outside the house); overlaps with other houses, ground,
// walkability and the exit's distance to a door are reported by the validator, like
// spawns on water: a house may be drawn before its floor is painted.
// Inverses carry `index` (add) or every previous value (set), so undo restores the file
// byte for byte.
import { MAX_HOUSE_RENT, houseNameKey } from "../houses.ts";
import { MAX_HOUSE_DOORS, MAX_HOUSE_RECTS, MAX_HOUSE_SIDE, houseContains } from "../types.ts";
import type { House, HouseRect, Position } from "../types.ts";
import { InvalidOp, checkId, checkPos, insertIndex, isCoord } from "./draft.ts";
import type { Draft } from "./draft.ts";
import type { AddHouseOp, MapOp, RemoveHouseOp, SetHouseOp } from "./types.ts";

const pos = (p: Position): Position => ({ x: p.x, y: p.y, z: p.z });
const rect = (r: HouseRect): HouseRect => ({ x: r.x, y: r.y, z: r.z, w: r.w, h: r.h });

/** A deep copy with the keys in a fixed order (so two copies compare as JSON). */
function copy(h: House): House {
  const out: House = {
    id: h.id,
    name: h.name,
    rent: h.rent,
    rects: h.rects.map(rect),
    doors: h.doors.map(pos),
    exit: pos(h.exit),
  };
  if (h.notes !== undefined) out.notes = h.notes;
  return out;
}

function findHouse(d: Draft, id: string): { island: string; index: number } | undefined {
  for (const island of d.islandIds()) {
    const index = d.list(island, "houses").findIndex((h) => h.id === id);
    if (index >= 0) return { island, index };
  }
  return undefined;
}

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/** Checks a whole house; returns the island it belongs to. */
function checkHouse(d: Draft, h: House): string {
  if (!isInt(h.rent, 1, MAX_HOUSE_RENT))
    throw new InvalidOp(
      `rent must be an integer 1..${MAX_HOUSE_RENT} (got ${JSON.stringify(h.rent)})`,
    );
  if (!Array.isArray(h.rects) || h.rects.length === 0 || h.rects.length > MAX_HOUSE_RECTS)
    throw new InvalidOp(`a house needs 1..${MAX_HOUSE_RECTS} rects`);
  for (const r of h.rects)
    if (
      !r ||
      !isCoord(r.x) ||
      !isCoord(r.y) ||
      !isInt(r.z, 0, 15) ||
      !isInt(r.w, 1, MAX_HOUSE_SIDE) ||
      !isInt(r.h, 1, MAX_HOUSE_SIDE)
    )
      throw new InvalidOp(
        `invalid house rect ${JSON.stringify(r)} (sides 1..${MAX_HOUSE_SIDE}, floor 0..15)`,
      );
  const first = h.rects[0] as HouseRect;
  const island = d.islandAt(first.x, first.y, first.z);
  const meta = d.current(island).meta;
  const m = meta.rect;
  let area = 0;
  const tiles = new Set<string>();
  for (const r of h.rects) {
    if (
      !meta.floors.includes(r.z) ||
      r.x < m.x ||
      r.y < m.y ||
      r.x + r.w > m.x + m.w ||
      r.y + r.h > m.y + m.h
    )
      throw new InvalidOp(`house rect ${JSON.stringify(r)} is not inside island "${island}"`);
    area += r.w * r.h;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) tiles.add(`${x},${y},${r.z}`);
  }
  if (tiles.size !== area) throw new InvalidOp("house rects overlap each other");
  if (!Array.isArray(h.doors) || h.doors.length === 0 || h.doors.length > MAX_HOUSE_DOORS)
    throw new InvalidOp(`a house needs 1..${MAX_HOUSE_DOORS} doors`);
  for (const door of h.doors) {
    checkPos(door, "door");
    if (!houseContains(h, door))
      throw new InvalidOp(`door ${door.x},${door.y},${door.z} is not a tile of the house`);
  }
  checkPos(h.exit, "exit");
  if (d.islandAt(h.exit.x, h.exit.y, h.exit.z) !== island)
    throw new InvalidOp(`house exit must be in island "${island}"`);
  if (houseContains(h, h.exit)) throw new InvalidOp("house exit must be outside the house");
  if (h.notes !== undefined && typeof h.notes !== "string")
    throw new InvalidOp("notes must be a string");
  return island;
}

export function addHouse(d: Draft, op: AddHouseOp): MapOp[] {
  const id = checkId(op.id, "house id");
  const name = op.name ?? houseNameKey(id);
  if (name !== houseNameKey(id))
    throw new InvalidOp(`a house's name key is ${houseNameKey(id)} (got ${JSON.stringify(name)})`);
  const at = findHouse(d, id);
  if (at) throw new InvalidOp(`house "${id}" already exists in island "${at.island}"`);
  const house: House = {
    id,
    name,
    rent: op.rent,
    rects: Array.isArray(op.rects) ? op.rects : [],
    doors: Array.isArray(op.doors) ? op.doors : [],
    exit: op.exit,
  };
  if (op.notes !== undefined) house.notes = op.notes;
  const island = checkHouse(d, house);
  const list = d.editList(island, "houses");
  list.splice(insertIndex(op.index, list.length), 0, copy(house));
  return [{ op: "remove_house", id }];
}

export function removeHouse(d: Draft, op: RemoveHouseOp): MapOp[] {
  const at = findHouse(d, op.id);
  if (!at) throw new InvalidOp(`no house "${String(op.id)}"`);
  const [h] = d.editList(at.island, "houses").splice(at.index, 1) as [House];
  return [{ op: "add_house", ...copy(h), index: at.index }];
}

export function setHouse(d: Draft, op: SetHouseOp): MapOp[] {
  const at = findHouse(d, op.id);
  if (!at) throw new InvalidOp(`no house "${String(op.id)}"`);
  const cur = d.list(at.island, "houses")[at.index] as House;
  const next: House = {
    id: cur.id,
    name: cur.name,
    rent: op.rent ?? cur.rent,
    rects: op.rects ?? cur.rects,
    doors: op.doors ?? cur.doors,
    exit: op.exit ?? cur.exit,
  };
  if (op.notes === null) {
    // removed
  } else if (op.notes !== undefined) next.notes = op.notes;
  else if (cur.notes !== undefined) next.notes = cur.notes;
  const island = checkHouse(d, next);
  if (island !== at.island)
    throw new InvalidOp(
      `set_house cannot move house "${cur.id}" to island "${island}"; remove it and add it there`,
    );
  const before = copy(cur);
  const after = copy(next);
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  d.editList(at.island, "houses").splice(at.index, 1, after);
  return [
    {
      op: "set_house",
      id: cur.id,
      rent: before.rent,
      rects: before.rects,
      doors: before.doors,
      exit: before.exit,
      notes: before.notes ?? null,
    },
  ];
}
