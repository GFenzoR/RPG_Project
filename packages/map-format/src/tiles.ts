// Tile lookup over global coordinates, across every loaded island.
import { groundAt, stackAt } from "./chunk.ts";
import type { ContentIndex } from "./content.ts";
import { CHUNK_SIZE, chunkKey } from "./types.ts";
import type { Chunk, Island, Position } from "./types.ts";

export interface Tile {
  ground: string | null;
  stack: string[];
}

export class TileMap {
  private readonly chunks = new Map<string, Chunk>();

  constructor(islands: Iterable<Island>) {
    for (const island of islands) for (const [k, c] of island.chunks) this.chunks.set(k, c);
  }

  chunkAt(x: number, y: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(z, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)));
  }

  /** The ground of a tile, null where there is none (no chunk, no ground). */
  groundAt(x: number, y: number, z: number): string | null {
    if (x < 0 || y < 0) return null;
    const c = this.chunkAt(x, y, z);
    return c ? groundAt(c, x % CHUNK_SIZE, y % CHUNK_SIZE) : null;
  }

  tile(x: number, y: number, z: number): Tile | undefined {
    if (x < 0 || y < 0) return undefined;
    const c = this.chunkAt(x, y, z);
    if (!c) return undefined;
    const lx = x % CHUNK_SIZE;
    const ly = y % CHUNK_SIZE;
    return { ground: groundAt(c, lx, ly), stack: stackAt(c, lx, ly) };
  }

  tileAt(p: Position): Tile | undefined {
    return this.tile(p.x, p.y, p.z);
  }
}

/** A creature can stand here: walkable ground and nothing on the stack blocks movement. */
export function isWalkable(tile: Tile | undefined, content: ContentIndex): boolean {
  if (!tile?.ground) return false;
  if (content.items.get(tile.ground)?.walkable !== true) return false;
  return tile.stack.every((id) => content.items.get(id)?.blocksMovement !== true);
}

/**
 * A creature can get through here once its doors are open: like isWalkable, but a door
 * that blocks movement (shut) does not count (docs/02 "Puertas con llave"). The rooms
 * behind locked doors, their escape check and the arrivals use it: they are the server's
 * walks (session/door.go), where every living object that blocks (a crate, a rock, a
 * boulder, a closed gate) is a wall. Standing rules (spawns, NPCs, arrivals) keep
 * isWalkable.
 */
export function isPassable(tile: Tile | undefined, content: ContentIndex): boolean {
  if (!tile?.ground) return false;
  if (content.items.get(tile.ground)?.walkable !== true) return false;
  return tile.stack.every((id) => {
    const info = content.items.get(id);
    return info?.blocksMovement !== true || info.door === true;
  });
}

/**
 * isPassable, also through a living object anyone breaks without a tool (thorny vines, a
 * crate: livingworld/README.md). Only the lints of make validate that the server does not
 * repeat use it (what a player reaches from the temple, areas nobody reaches): a player
 * gets past such an object, but the server's room and escape walks never count on it.
 */
export function isPassableBreaking(tile: Tile | undefined, content: ContentIndex): boolean {
  if (!tile?.ground) return false;
  if (content.items.get(tile.ground)?.walkable !== true) return false;
  return tile.stack.every((id) => {
    const info = content.items.get(id);
    return info?.blocksMovement !== true || info.door === true || info.breaksFreely === true;
  });
}
