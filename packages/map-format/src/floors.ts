// Building floors stay inside their walls (docs/03-world-and-maps.md, "Pisos de edificio").
// A ground with `ground.floor: building` is the floor of a room: none of its sides may face
// open ground. Each neighbour must be another floor (building or open), or hold a wall or a
// door, or the tile itself holds the wall or the door, or be a house doorway (houses.yaml).
// Porches, doorsteps, piers, bridges and stalls use the `open` floor (dock_planks); ruins
// use a ground with no floor property: the documented way out, never a silenced finding.
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
  const doorways = new Set(
    island.houses.flatMap((h) => h.doors.map((d) => `${d.x},${d.y},${d.z}`)),
  );
  const edge = (t: Tile | undefined, x: number, y: number, z: number): boolean =>
    hasEdge(t, content) || doorways.has(`${x},${y},${z}`);
  const isFloorOrPorch = (g: string | null): boolean =>
    g !== null && content.items.get(g)?.floor !== undefined;
  const isFloor = (g: string | null): boolean =>
    g !== null && content.items.get(g)?.floor === "building";
  for (const c of chunks) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = c.cx * CHUNK_SIZE + lx;
        const y = c.cy * CHUNK_SIZE + ly;
        const here = tiles.tile(x, y, c.z);
        if (!here || !isFloor(here.ground) || edge(here, x, y, c.z)) continue;
        for (const s of SIDES) {
          const there = tiles.tile(x + s.dx, y + s.dy, c.z);
          if (isFloorOrPorch(there?.ground ?? null) || edge(there, x + s.dx, y + s.dy, c.z))
            continue;
          out.push({ pos: { x, y, z: c.z }, side: s.side, facing: there?.ground ?? "nothing" });
        }
      }
    }
  }
  return out;
}
