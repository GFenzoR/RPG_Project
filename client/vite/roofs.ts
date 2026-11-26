// Which tiles of the map are under a roof (docs/17 ART-5 "Bajo techo"), worked out at build
// time from world/ itself. The canvas used to guess it from the tiles the server had sent
// so far, and a building seen from outside, with its far wall beyond the view window, read
// as open ground: the sun's shadows fell on its floor until the player walked in (owner,
// 2026-11-26: "it looks as if nothing had a roof"). The whole map knows every wall, so the
// answer no longer depends on what is in view.
//
// Same rule as the canvas (packages/renderer tile-art.ts indoorTiles: ground closed in by
// walls, doorways of up to DOORWAY_TILES), run over every chunk of the surface floors with
// its real neighbours. Shipped as runs per floor: { "<z>": [y, x, length, ...] }.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CELL_OPEN,
  CELL_UNKNOWN,
  CELL_WALL,
  INDOOR_REACH,
  indoorTiles,
} from "@rpg/renderer/tile-art";

const SIZE = 32;
/** Floors from this one down are underground: no sky, no roofs (render/light-layer.ts). */
const UNDERGROUND = 8;

interface RawChunk {
  chunk: { cx: number; cy: number; z: number };
  palette: string[];
  ground: (number | null)[][];
  items?: { x: number; y: number; stack: number[] }[];
}

/** Open, wall or unknown for each tile of a chunk file. */
function cellsOf(c: RawChunk, isWall: (itemId: string) => boolean): Uint8Array {
  const cells = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const g = c.ground[y]?.[x];
      cells[y * SIZE + x] = g === null || g === undefined ? CELL_UNKNOWN : CELL_OPEN;
    }
  for (const s of c.items ?? [])
    if (s.stack.some((i) => isWall(c.palette[i] ?? ""))) cells[s.y * SIZE + s.x] = CELL_WALL;
  return cells;
}

/**
 * The roofed tiles of the islands under `root`/world/islands, by floor: flat runs
 * [y, x, length, ...] in global tiles. `isWall`: the item id is a wall or joins walls (a
 * gate). `extraWalls`: tiles ("x,y,z") that hold a wall the chunk files do not (the frame
 * of a house door, drawn by the client).
 */
export function loadRoofs(
  root: string,
  isWall: (itemId: string) => boolean,
  extraWalls: readonly string[] = [],
): Record<string, number[]> {
  const dir = join(root, "world", "islands");
  const floors = new Map<number, Map<string, Uint8Array>>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^c\d+_\d+\.json$/.test(e.name)) {
        const c = JSON.parse(readFileSync(p, "utf8")) as RawChunk;
        if (c.chunk.z >= UNDERGROUND) continue;
        let floor = floors.get(c.chunk.z);
        if (!floor) floors.set(c.chunk.z, (floor = new Map()));
        floor.set(`${c.chunk.cx},${c.chunk.cy}`, cellsOf(c, isWall));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  for (const key of extraWalls) {
    const [x = -1, y = -1, z = -1] = key.split(",").map(Number);
    const cells = floors.get(z)?.get(`${Math.floor(x / SIZE)},${Math.floor(y / SIZE)}`);
    if (cells) cells[(y % SIZE) * SIZE + (x % SIZE)] = CELL_WALL;
  }
  const out: Record<string, number[]> = {};
  for (const z of [...floors.keys()].sort((a, b) => a - b)) {
    const floor = floors.get(z) as Map<string, Uint8Array>;
    const rows = new Map<number, number[]>();
    for (const key of floor.keys()) {
      const [cx = 0, cy = 0] = key.split(",").map(Number);
      const mask = indoorTiles(SIZE, INDOOR_REACH, (x, y) => {
        const cells = floor.get(`${cx + Math.floor(x / SIZE)},${cy + Math.floor(y / SIZE)}`);
        if (!cells) return CELL_UNKNOWN;
        return cells[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)] as number;
      });
      if (!mask) continue;
      for (let ly = 0; ly < SIZE; ly++)
        for (let lx = 0; lx < SIZE; lx++) {
          if (mask[ly * SIZE + lx] !== 1) continue;
          const gy = cy * SIZE + ly;
          let row = rows.get(gy);
          if (!row) rows.set(gy, (row = []));
          row.push(cx * SIZE + lx);
        }
    }
    const runs: number[] = [];
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const xs = (rows.get(y) as number[]).sort((a, b) => a - b);
      for (let i = 0; i < xs.length;) {
        let j = i + 1;
        while (j < xs.length && xs[j] === (xs[j - 1] as number) + 1) j++;
        runs.push(y, xs[i] as number, j - i);
        i = j;
      }
    }
    if (runs.length > 0) out[String(z)] = runs;
  }
  return out;
}
