// Building floors stay inside their walls (docs/03-world-and-maps.md, "Pisos de edificio").
// A ground with `ground.floor: building` is the floor of a room: no side of it may face open
// ground. Every neighbour of such a tile is another building floor, or has a wall or a door
// on it, or the tile itself holds the wall or the door (the edge). Porches, piers, bridges,
// stalls and ruins use a ground without the property (dock_planks, stone_floor): they are
// the documented way out, never a silenced finding.
import type { ContentIndex } from "./content.ts";
import type { Tile, TileMap } from "./tiles.ts";
import { CHUNK_SIZE } from "./types.ts";
import type { Island, Position } from "./types.ts";

/** A building floor tile with a side open to outdoor ground. */
export interface FloorLeak {
  /** The floor tile. */
  pos: Position;
  /** The side that leaks: where the open neighbour is. */
  side: "n" | "e" | "s" | "w";
  /** What the open neighbour is: its ground id, or "nothing" when it has none. */
  facing: string;
}

const SIDES: readonly { side: FloorLeak["side"]; dx: number; dy: number }[] = [
  { side: "n", dx: 0, dy: -1 },
  { side: "e", dx: 1, dy: 0 },
  { side: "s", dx: 0, dy: 1 },
  { side: "w", dx: -1, dy: 0 },
];

/** Whether the tile holds a wall (windows included) or a door: a structural edge. */
function hasEdge(tile: Tile | undefined, content: ContentIndex): boolean {
  if (!tile) return false;
  return [tile.ground, ...tile.stack].some((id) => {
    const info = id === null ? undefined : content.items.get(id);
    return info?.kind === "wall" || info?.door === true;
  });
}

/** Every building floor tile of the island with a side open to outdoor ground. */
export function floorLeaks(island: Island, tiles: TileMap, content: ContentIndex): FloorLeak[] {
  const out: FloorLeak[] = [];
  const chunks = [...island.chunks.values()].sort(
    (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
  );
  const isFloor = (g: string | null): boolean =>
    g !== null && content.items.get(g)?.floor === "building";
  for (const c of chunks) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = c.cx * CHUNK_SIZE + lx;
        const y = c.cy * CHUNK_SIZE + ly;
        const here = tiles.tile(x, y, c.z);
        if (!here || !isFloor(here.ground) || hasEdge(here, content)) continue;
        for (const s of SIDES) {
          const there = tiles.tile(x + s.dx, y + s.dy, c.z);
          if (isFloor(there?.ground ?? null) || hasEdge(there, content)) continue;
          out.push({ pos: { x, y, z: c.z }, side: s.side, facing: there?.ground ?? "nothing" });
        }
      }
    }
  }
  return out;
}
