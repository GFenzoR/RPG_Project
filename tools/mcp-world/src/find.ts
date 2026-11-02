// map_find: where things are. Items are found by scanning chunks (ground and stacks);
// spawns, NPCs, zones, portals and signs come from the auxiliary lists.
import { CHUNK_SIZE, rectContains, rectsOverlap } from "@rpg/map-format";
import type { Position, Rect, World } from "@rpg/map-format";

export const FIND_KINDS = ["item", "spawn", "npc", "zone", "portal", "text"] as const;
export type FindKind = (typeof FIND_KINDS)[number];

export interface FindQuery {
  kind: FindKind;
  /** Exact item / monster / NPC / entry ID; for spawns it also matches a monster. */
  id?: string;
  island?: string;
  floor?: number;
  area?: Rect;
  limit?: number;
}

export interface FindResult {
  /** Matches found (may exceed the number returned). */
  total: number;
  results: Record<string, unknown>[];
}

export function findInWorld(world: World, q: FindQuery): FindResult {
  const limit = q.limit ?? 100;
  const results: Record<string, unknown>[] = [];
  let total = 0;
  const add = (r: Record<string, unknown>): void => {
    total++;
    if (results.length < limit) results.push(r);
  };
  const posOk = (p: Position): boolean =>
    (q.floor === undefined || p.z === q.floor) && (!q.area || rectContains(q.area, p.x, p.y));
  for (const [islandId, isl] of world.islands) {
    if (q.island !== undefined && islandId !== q.island) continue;
    switch (q.kind) {
      case "item": {
        if (q.id === undefined) throw new RangeError("finding items needs an id");
        const chunks = [...isl.chunks.values()].sort(
          (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
        );
        for (const c of chunks) {
          if (q.floor !== undefined && c.z !== q.floor) continue;
          const crect = {
            x: c.cx * CHUNK_SIZE,
            y: c.cy * CHUNK_SIZE,
            w: CHUNK_SIZE,
            h: CHUNK_SIZE,
          };
          if (q.area && !rectsOverlap(q.area, crect)) continue;
          for (let i = 0; i < c.ground.length; i++) {
            if (c.ground[i] !== q.id) continue;
            const p = {
              x: crect.x + (i % CHUNK_SIZE),
              y: crect.y + Math.floor(i / CHUNK_SIZE),
              z: c.z,
            };
            if (posOk(p)) add({ island: islandId, pos: p, layer: "ground" });
          }
          for (const s of c.items)
            s.stack.forEach((id, index) => {
              if (id !== q.id) return;
              const p = { x: crect.x + s.x, y: crect.y + s.y, z: c.z };
              if (posOk(p)) add({ island: islandId, pos: p, layer: "stack", index });
            });
        }
        break;
      }
      case "spawn":
        for (const s of isl.spawns)
          if (
            (q.id === undefined || s.id === q.id || s.monsters.some((m) => m.monster === q.id)) &&
            posOk(s.center)
          )
            add({ island: islandId, ...s });
        break;
      case "npc":
        for (const n of isl.npcs)
          if ((q.id === undefined || n.npc === q.id) && posOk(n.pos))
            add({ island: islandId, ...n });
        break;
      case "portal":
        for (const p of isl.portals)
          if ((q.id === undefined || p.id === q.id) && (posOk(p.from) || posOk(p.to)))
            add({ island: islandId, ...p });
        break;
      case "text":
        for (const t of isl.texts)
          if ((q.id === undefined || t.id === q.id) && posOk(t.pos))
            add({ island: islandId, ...t });
        break;
      case "zone":
        for (const z of isl.zones)
          if (
            (q.id === undefined || z.id === q.id || z.type === q.id) &&
            (q.floor === undefined || z.floors.includes(q.floor)) &&
            (!q.area || z.rects.some((r) => rectsOverlap(r, q.area as Rect)))
          )
            add({ island: islandId, ...z });
        break;
    }
  }
  return { total, results };
}
