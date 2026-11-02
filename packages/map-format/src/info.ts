// Summaries for `mapcli info` and the MCP `map_info` tool.
import { CHUNK_SIZE } from "./types.ts";
import type { Island, World } from "./types.ts";

export interface IslandInfo {
  id: string;
  name: string;
  rect: Island["meta"]["rect"];
  floors: number[];
  temple: Island["meta"]["temple"];
  level_hint: [number, number];
  /** Per floor: chunk files and tiles with ground. */
  floor_stats: { z: number; chunks: number; tiles: number }[];
  spawns: { id: string; center: Island["meta"]["temple"]; monsters: Record<string, number> }[];
  npcs: { npc: string; pos: Island["meta"]["temple"] }[];
  zones: { id: string; type: string }[];
  portals: {
    id: string;
    kind: string;
    from: Island["meta"]["temple"];
    to: Island["meta"]["temple"];
  }[];
  texts: number;
}

export function islandInfo(island: Island): IslandInfo {
  const m = island.meta;
  const stats = new Map<number, { z: number; chunks: number; tiles: number }>();
  for (const c of island.chunks.values()) {
    const s = stats.get(c.z) ?? { z: c.z, chunks: 0, tiles: 0 };
    s.chunks++;
    s.tiles += c.ground.filter((g) => g !== null).length;
    stats.set(c.z, s);
  }
  return {
    id: m.id,
    name: m.name,
    rect: m.rect,
    floors: m.floors,
    temple: m.temple,
    level_hint: m.level_hint,
    floor_stats: [...stats.values()].sort((a, b) => a.z - b.z),
    spawns: island.spawns.map((s) => ({
      id: s.id,
      center: s.center,
      monsters: Object.fromEntries(s.monsters.map((x) => [x.monster, x.count])),
    })),
    npcs: island.npcs.map((n) => ({ npc: n.npc, pos: n.pos })),
    zones: island.zones.map((z) => ({ id: z.id, type: z.type })),
    portals: island.portals.map((p) => ({ id: p.id, kind: p.kind, from: p.from, to: p.to })),
    texts: island.texts.length,
  };
}

export interface WorldInfo {
  islands: {
    id: string;
    rect: Island["meta"]["rect"];
    level_hint: [number, number];
    chunks: number;
  }[];
  boat_routes: number;
  chunk_size: number;
}

export function worldInfo(world: World): WorldInfo {
  return {
    islands: world.meta.islands.map((e) => ({
      id: e.id,
      rect: e.rect,
      level_hint: e.level_hint,
      chunks: world.islands.get(e.id)?.chunks.size ?? 0,
    })),
    boat_routes: world.meta.boat_routes.length,
    chunk_size: CHUNK_SIZE,
  };
}
