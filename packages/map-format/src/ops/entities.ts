// Ops on the auxiliary lists: spawns.yaml, zones.yaml, portals.yaml and npcs.yaml. The
// island is the one that owns the entity's position (spawn center, zone rects, portal
// origin, NPC tile). IDs are unique in the whole world, and each NPC is placed once.
// Inverses carry `index`, so undo puts an entry back where it was (same bytes on disk).
// Whether a spawn or NPC stands on a walkable tile is the validator's job, not the op's:
// an AI or a human may place the spawn first and paint the ground afterwards.
import { PORTAL_KINDS, ZONE_TYPES, samePos } from "../types.ts";
import type { NpcPlacement, Portal, Position, Spawn, Zone } from "../types.ts";
import { InvalidOp, checkId, checkPos, checkRect, insertIndex } from "./draft.ts";
import type { EntityList, Draft } from "./draft.ts";
import type {
  AddPortalOp,
  AddSpawnOp,
  AddZoneOp,
  MapOp,
  OpOptions,
  PlaceNpcOp,
  RemoveNpcOp,
  RemovePortalOp,
  RemoveSpawnOp,
  RemoveZoneOp,
} from "./types.ts";

const pos = (p: Position): Position => ({ x: p.x, y: p.y, z: p.z });

function checkNotes(notes: unknown): void {
  if (notes !== undefined && typeof notes !== "string")
    throw new InvalidOp("notes must be a string");
}

/** Where an entry with this key is, in any island. */
function find(
  d: Draft,
  file: EntityList,
  match: (e: { id?: string; npc?: string }) => boolean,
): { island: string; index: number } | undefined {
  for (const island of d.islandIds()) {
    const index = (d.list(island, file) as { id?: string; npc?: string }[]).findIndex(match);
    if (index >= 0) return { island, index };
  }
  return undefined;
}

function checkUnique(d: Draft, file: EntityList, id: string, what: string): void {
  const at = find(d, file, (e) => e.id === id);
  if (at) throw new InvalidOp(`${what} "${id}" already exists in island "${at.island}"`);
}

function insert<T>(list: T[], entry: T, index: number | undefined): void {
  list.splice(insertIndex(index, list.length), 0, entry);
}

// ---- spawns -----------------------------------------------------------------------------

export function addSpawn(d: Draft, op: AddSpawnOp, opts: OpOptions): MapOp[] {
  const id = checkId(op.id, "spawn id");
  checkPos(op.center, "center");
  if (!Number.isInteger(op.radius) || op.radius < 0 || op.radius > 32)
    throw new InvalidOp(`radius must be an integer 0..32 (got ${JSON.stringify(op.radius)})`);
  if (!Array.isArray(op.monsters) || op.monsters.length === 0)
    throw new InvalidOp("a spawn needs at least one monster");
  for (const m of op.monsters) {
    checkId(m?.monster, "monster");
    if (!Number.isInteger(m.count) || m.count < 1)
      throw new InvalidOp(`count of "${m.monster}" must be an integer >= 1`);
    if (opts.monsterKnown && !opts.monsterKnown(m.monster))
      throw new InvalidOp(`unknown monster "${m.monster}" (not in data/monsters/)`);
  }
  if (!Number.isInteger(op.respawn_seconds) || op.respawn_seconds < 1)
    throw new InvalidOp("respawn_seconds must be an integer >= 1");
  checkNotes(op.notes);
  checkUnique(d, "spawns", id, "spawn");
  const island = d.islandAt(op.center.x, op.center.y, op.center.z);
  const entry: Spawn = {
    id,
    center: pos(op.center),
    radius: op.radius,
    monsters: op.monsters.map((m) => ({ monster: m.monster, count: m.count })),
    respawn_seconds: op.respawn_seconds,
  };
  if (op.notes !== undefined) entry.notes = op.notes;
  insert(d.editList(island, "spawns"), entry, op.index);
  return [{ op: "remove_spawn", id }];
}

export function removeSpawn(d: Draft, op: RemoveSpawnOp): MapOp[] {
  const at = find(d, "spawns", (e) => e.id === op.id);
  if (!at) throw new InvalidOp(`no spawn "${String(op.id)}"`);
  const [s] = d.editList(at.island, "spawns").splice(at.index, 1) as [Spawn];
  return [{ op: "add_spawn", ...s, index: at.index }];
}

// ---- zones ------------------------------------------------------------------------------

export function addZone(d: Draft, op: AddZoneOp): MapOp[] {
  const id = checkId(op.id, "zone id");
  if (!ZONE_TYPES.includes(op.type))
    throw new InvalidOp(`zone type must be one of ${ZONE_TYPES.join(", ")}`);
  if (!Array.isArray(op.floors) || op.floors.length === 0)
    throw new InvalidOp("a zone needs at least one floor");
  if (new Set(op.floors).size !== op.floors.length) throw new InvalidOp("zone floors repeat");
  if (!Array.isArray(op.rects) || op.rects.length === 0)
    throw new InvalidOp("a zone needs at least one rect");
  op.rects.forEach((r) => checkRect(r));
  checkNotes(op.notes);
  checkUnique(d, "zones", id, "zone");
  const first = op.rects[0] as (typeof op.rects)[number];
  const island = d.islandAt(first.x, first.y, op.floors[0] as number);
  const meta = d.current(island).meta;
  for (const f of op.floors)
    if (!meta.floors.includes(f))
      throw new InvalidOp(`floor ${f} is not in the floors of island "${island}"`);
  for (const r of op.rects) {
    const m = meta.rect;
    if (r.x < m.x || r.y < m.y || r.x + r.w > m.x + m.w || r.y + r.h > m.y + m.h)
      throw new InvalidOp(`zone rect ${JSON.stringify(r)} is not inside island "${island}"`);
  }
  const entry: Zone = {
    id,
    type: op.type,
    floors: [...op.floors],
    rects: op.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
  };
  if (op.notes !== undefined) entry.notes = op.notes;
  insert(d.editList(island, "zones"), entry, op.index);
  return [{ op: "remove_zone", id }];
}

export function removeZone(d: Draft, op: RemoveZoneOp): MapOp[] {
  const at = find(d, "zones", (e) => e.id === op.id);
  if (!at) throw new InvalidOp(`no zone "${String(op.id)}"`);
  const [z] = d.editList(at.island, "zones").splice(at.index, 1) as [Zone];
  return [{ op: "add_zone", ...z, index: at.index }];
}

// ---- portals ----------------------------------------------------------------------------

export function addPortal(d: Draft, op: AddPortalOp): MapOp[] {
  const id = checkId(op.id, "portal id");
  if (!PORTAL_KINDS.includes(op.kind))
    throw new InvalidOp(`portal kind must be one of ${PORTAL_KINDS.join(", ")}`);
  checkPos(op.from, "from");
  checkPos(op.to, "to");
  checkNotes(op.notes);
  checkUnique(d, "portals", id, "portal");
  const island = d.islandAt(op.from.x, op.from.y, op.from.z);
  const entry: Portal = { id, kind: op.kind, from: pos(op.from), to: pos(op.to) };
  if (op.notes !== undefined) entry.notes = op.notes;
  insert(d.editList(island, "portals"), entry, op.index);
  return [{ op: "remove_portal", id }];
}

export function removePortal(d: Draft, op: RemovePortalOp): MapOp[] {
  const at = find(d, "portals", (e) => e.id === op.id);
  if (!at) throw new InvalidOp(`no portal "${String(op.id)}"`);
  const [p] = d.editList(at.island, "portals").splice(at.index, 1) as [Portal];
  return [{ op: "add_portal", ...p, index: at.index }];
}

// ---- NPCs -------------------------------------------------------------------------------

export function placeNpc(d: Draft, op: PlaceNpcOp, opts: OpOptions): MapOp[] {
  const npc = checkId(op.npc, "npc");
  checkPos(op.pos);
  checkNotes(op.notes);
  if (opts.npcKnown && !opts.npcKnown(npc))
    throw new InvalidOp(`unknown NPC "${npc}" (not in data/npcs/)`);
  const at = find(d, "npcs", (e) => e.npc === npc);
  if (at) throw new InvalidOp(`NPC "${npc}" is already placed in island "${at.island}"`);
  const island = d.islandAt(op.pos.x, op.pos.y, op.pos.z);
  const entry: NpcPlacement = { npc, pos: pos(op.pos) };
  if (op.notes !== undefined) entry.notes = op.notes;
  insert(d.editList(island, "npcs"), entry, op.index);
  return [{ op: "remove_npc", npc, pos: pos(op.pos) }];
}

export function removeNpc(d: Draft, op: RemoveNpcOp): MapOp[] {
  const at = find(d, "npcs", (e) => e.npc === op.npc);
  if (!at) throw new InvalidOp(`NPC "${String(op.npc)}" is not placed`);
  const current = d.list(at.island, "npcs")[at.index] as NpcPlacement;
  if (op.pos !== undefined) {
    checkPos(op.pos);
    if (!samePos(op.pos, current.pos))
      throw new InvalidOp(
        `NPC "${op.npc}" is at ${current.pos.x},${current.pos.y},${current.pos.z}, not at ${op.pos.x},${op.pos.y},${op.pos.z}`,
      );
  }
  const [n] = d.editList(at.island, "npcs").splice(at.index, 1) as [NpcPlacement];
  return [{ op: "place_npc", ...n, index: at.index }];
}
