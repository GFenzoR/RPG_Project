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
