import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import { loadContent } from "./content.ts";
import { floorLeaks } from "./floors.ts";
import { TileMap } from "./tiles.ts";
import { chunkKey, emptyChunk } from "./types.ts";
import type { Island } from "./types.ts";
import { fileURLToPath } from "node:url";

const content = loadContent(fileURLToPath(new URL("../../../", import.meta.url)));

/** A 6x4 room of wooden floor at (4,4) on grass, walled on its edge; `edit` changes it. */
function room(edit: (c: ReturnType<typeof emptyChunk>) => void, doors: Island["houses"] = []) {
  const c = emptyChunk(0, 0, 7);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setGround(c, x, y, "grass");
  for (let y = 4; y < 8; y++) for (let x = 4; x < 10; x++) setGround(c, x, y, "wooden_floor");
  for (let y = 4; y < 8; y++)
    for (let x = 4; x < 10; x++)
      if (x === 4 || x === 9 || y === 4 || y === 7) pushItem(c, x, y, "wooden_wall");
  edit(c);
  const island = { chunks: new Map([[chunkKey(7, 0, 0), c]]), houses: doors } as unknown as Island;
  return floorLeaks(island, new TileMap([island]), content);
}

describe("floorLeaks", () => {
  it("accepts a room closed by walls", () => {
    expect(room(() => {})).toEqual([]);
  });

  it("flags a doorway floor that opens to the grass", () => {
    const leaks = room((c) => {
      c.items = c.items.filter((s) => !(s.x === 6 && s.y === 7));
    });
    expect(leaks.map((l) => `${l.pos.x},${l.pos.y} ${l.side} ${l.facing}`)).toEqual([
      "6,7 s grass",
    ]);
  });

  it("flags a floor that spills out past the wall", () => {
    const leaks = room((c) => setGround(c, 10, 5, "wooden_floor"));
    expect(leaks.length).toBe(3);
    expect(leaks.every((l) => l.pos.x === 10 && l.pos.y === 5)).toBe(true);
  });

  it("accepts a house doorway and an open floor (porch) in the gap", () => {
    const gap = (c: ReturnType<typeof emptyChunk>) => {
      c.items = c.items.filter((s) => !(s.x === 6 && s.y === 7));
      setGround(c, 6, 7, "dock_planks");
    };
    expect(room(gap)).toEqual([]);
    const doorway = (c: ReturnType<typeof emptyChunk>) => {
      c.items = c.items.filter((s) => !(s.x === 6 && s.y === 7));
    };
    const houses = [{ doors: [{ x: 6, y: 7, z: 7 }] }] as unknown as Island["houses"];
    expect(room(doorway, houses)).toEqual([]);
  });
});
