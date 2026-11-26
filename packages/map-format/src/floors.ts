// Building floors stay inside their walls (docs/03-world-and-maps.md, "Pisos de edificio").
// A ground with `ground.floor: building` is the floor of a room: none of its sides and none
// of its corners may face open ground. Each of the eight neighbours must be another building
// floor or hold a wall or a door; a floor tile that holds the wall or the door itself is the
// edge, and so is a doorway: a floor tile in a straight gap of up to DOORWAY_TILES between
// two walls with open ground across it (the same gap the renderer reads as a doorway,
// tile-art.ts indoorTiles), whose floor is the threshold. There is no other way out: a porch, a pier or a stall uses a ground
// that is no building floor (dock_planks), and it does not close a room either.
import type { ContentIndex } from "./content.ts";
import type { Tile, TileMap } from "./tiles.ts";
import { CHUNK_SIZE } from "./types.ts";
import type { Island, Position } from "./types.ts";

/** The widest gap in a wall that is a doorway, tiles (as the renderer's DOORWAY_TILES). */
export const DOORWAY_TILES = 3;

/** A building floor tile with a side or a corner open to outdoor ground. */
export interface FloorLeak {
  /** The floor tile. */
  pos: Position;
  /** Where the open neighbour is: a side, or a corner no wall closes. */
  side: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
  /** What the open neighbour is: its ground id, or "nothing" when it has none. */
  facing: string;
}

const SIDES: readonly { side: FloorLeak["side"]; dx: number; dy: number }[] = [
  { side: "n", dx: 0, dy: -1 },
  { side: "ne", dx: 1, dy: -1 },
  { side: "e", dx: 1, dy: 0 },
  { side: "se", dx: 1, dy: 1 },
  { side: "s", dx: 0, dy: 1 },
  { side: "sw", dx: -1, dy: 1 },
  { side: "w", dx: -1, dy: 0 },
  { side: "nw", dx: -1, dy: -1 },
];

/** Whether the tile holds a wall (windows included) or a door: a structural edge. */
function hasEdge(tile: Tile | undefined, content: ContentIndex): boolean {
  if (!tile) return false;
  return [tile.ground, ...tile.stack].some((id) => {
    const info = id === null ? undefined : content.items.get(id);
    return info?.kind === "wall" || info?.door === true;
  });
}

/** Every building floor tile of the island with a side or a corner open to outdoor ground. */
export function floorLeaks(island: Island, tiles: TileMap, content: ContentIndex): FloorLeak[] {
  const out: FloorLeak[] = [];
  const chunks = [...island.chunks.values()].sort(
    (a, b) => a.z - b.z || a.cy - b.cy || a.cx - b.cx,
  );
  const isFloor = (t: Tile | undefined): boolean =>
    !!t && t.ground !== null && content.items.get(t.ground)?.floor === "building";
  for (const c of chunks) {
    const z = c.z;
    const edge = (x: number, y: number): boolean => hasEdge(tiles.tile(x, y, z), content);
    /** How many tiles from (x, y) to the first wall along (dx, dy), 0 when none is near. */
    const toWall = (x: number, y: number, dx: number, dy: number): number => {
      for (let d = 1; d <= DOORWAY_TILES; d++) if (edge(x + dx * d, y + dy * d)) return d;
      return 0;
    };
    const open = (x: number, y: number): boolean => !isFloor(tiles.tile(x, y, z)) && !edge(x, y);
    /**
     * A tile in a straight gap of up to DOORWAY_TILES between two walls, with open ground
     * right across the gap: a doorway. (A corner open only diagonally is no doorway.)
     */
    const doorway = (x: number, y: number): boolean => {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const a = toWall(x, y, -dx, -dy);
        const b = toWall(x, y, dx, dy);
        if (a === 0 || b === 0 || a + b - 1 > DOORWAY_TILES) continue;
        if (open(x + dy, y + dx) || open(x - dy, y - dx)) return true;
      }
      return false;
    };
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = c.cx * CHUNK_SIZE + lx;
        const y = c.cy * CHUNK_SIZE + ly;
        if (!isFloor(tiles.tile(x, y, z)) || edge(x, y)) continue;
        let threshold: boolean | undefined;
        for (const s of SIDES) {
          if (!open(x + s.dx, y + s.dy)) continue;
          threshold ??= doorway(x, y);
          if (threshold) break;
          const facing = tiles.tile(x + s.dx, y + s.dy, z)?.ground ?? "nothing";
          out.push({ pos: { x, y, z }, side: s.side, facing });
        }
      }
    }
  }
  return out;
}
