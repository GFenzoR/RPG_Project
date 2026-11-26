import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import { loadContent } from "./content.ts";
import type { ContentIndex, ItemInfo } from "./content.ts";
import { floorLeaks } from "./floors.ts";
import { loadWorld } from "./io.ts";
import { TileMap } from "./tiles.ts";
import { chunkKey, emptyChunk } from "./types.ts";
import type { Chunk, Island } from "./types.ts";

// The rule's own content: nothing here breaks when data/ changes.
const item = (id: string, kind: string, more: Partial<ItemInfo> = {}): [string, ItemInfo] => [
  id,
  { id, kind, blocksMovement: kind === "wall", ...more } as ItemInfo,
];
const content = {
  items: new Map([
    item("turf", "ground", { walkable: true }),
    item("deck", "ground", { walkable: true }),
    item("boards", "ground", { walkable: true, floor: "building" }),
    item("wall", "wall"),
    item("window", "wall"),
    item("door", "decoration", { door: true }),
  ]),
} as unknown as ContentIndex;

function turf(cx: number, cy: number): Chunk {
  const c = emptyChunk(cx, cy, 7);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setGround(c, x, y, "turf");
  return c;
}

function leaksOf(chunks: Chunk[], index: ContentIndex = content): string[] {
  const island = {
    chunks: new Map(chunks.map((c) => [chunkKey(c.z, c.cx, c.cy), c])),
    houses: [],
  } as unknown as Island;
  return floorLeaks(island, new TileMap([island]), index).map(
    (l) => `${l.pos.x},${l.pos.y} ${l.side} ${l.facing}`,
  );
}

const unwall = (c: Chunk, x: number, y: number): void => {
  c.items = c.items.filter((s) => !(s.x === x && s.y === y));
};

/** A 6x4 room of boards at (4,4) on turf, walled on its edge; `edit` changes it. */
function room(edit: (c: Chunk) => void = () => {}): string[] {
  const c = turf(0, 0);
  for (let y = 4; y < 8; y++)
    for (let x = 4; x < 10; x++) {
      setGround(c, x, y, "boards");
      if (x === 4 || x === 9 || y === 4 || y === 7) pushItem(c, x, y, "wall");
    }
  edit(c);
  return leaksOf([c]);
}

describe("floorLeaks", () => {
  it("accepts a room closed by walls", () => {
    expect(room()).toEqual([]);
  });

  it("accepts a doorway: a gap of up to three floor tiles between two walls", () => {
    expect(room((c) => unwall(c, 6, 7))).toEqual([]);
    expect(
      room((c) => {
        for (const x of [5, 6, 7]) unwall(c, x, 7);
      }),
    ).toEqual([]);
  });

  it("flags a gap wider than a doorway", () => {
    const leaks = room((c) => {
      for (const x of [5, 6, 7, 8]) unwall(c, x, 7);
    });
    expect(leaks).toContain("5,7 s turf");
    expect(leaks).toContain("8,7 s turf");
  });

  it("accepts a door or a window in the wall, and a door item in the gap", () => {
    expect(
      room((c) => {
        unwall(c, 6, 7);
        pushItem(c, 6, 7, "door");
        unwall(c, 6, 4);
        pushItem(c, 6, 4, "window");
      }),
    ).toEqual([]);
  });

  it("flags a floor that spills out past the wall, sides and corners", () => {
    expect(room((c) => setGround(c, 10, 5, "boards"))).toEqual([
      "10,5 n turf",
      "10,5 ne turf",
      "10,5 e turf",
      "10,5 se turf",
      "10,5 s turf",
    ]);
  });

  it("flags a corner no wall closes", () => {
    // The corner post is gone and so is its floor: the room touches the turf diagonally.
    expect(
      room((c) => {
        unwall(c, 4, 4);
        setGround(c, 4, 4, "turf");
      }),
    ).toEqual(["5,5 nw turf"]);
  });

  it("does not let another ground close the room: a porch needs the wall too", () => {
    const leaks = room((c) => {
      for (const x of [5, 6, 7, 8]) {
        unwall(c, x, 7);
        setGround(c, x, 8, "deck");
      }
    });
    expect(leaks).toContain("6,7 s deck");
  });

  it("names a neighbour with no ground", () => {
    const c = emptyChunk(0, 0, 7);
    setGround(c, 0, 0, "boards");
    setGround(c, 1, 0, "boards");
    pushItem(c, 1, 0, "wall");
    expect(leaksOf([c])).toEqual([
      "0,0 n nothing",
      "0,0 ne nothing",
      "0,0 se nothing",
      "0,0 s nothing",
      "0,0 sw nothing",
      "0,0 w nothing",
      "0,0 nw nothing",
    ]);
  });

  it("reads the neighbour in the next chunk", () => {
    // A room up against the border x = 32: its east wall is in the next chunk, or missing.
    const build = (closed: boolean): string[] => {
      const a = turf(0, 0);
      const b = turf(1, 0);
      for (let y = 4; y <= 9; y++) {
        for (const lx of [29, 30, 31]) {
          setGround(a, lx, y, "boards");
          if (lx === 29 || y === 4 || y === 9) pushItem(a, lx, y, "wall");
        }
        if (closed) pushItem(b, 0, y, "wall");
      }
      return leaksOf([a, b]);
    };
    expect(build(true)).toEqual([]);
    expect(build(false)).toEqual(
      [5, 6, 7, 8].flatMap((y) => ["ne", "e", "se"].map((s) => `31,${y} ${s} turf`)),
    );
  });

  it("holds for every prefab of world/prefabs stamped on open ground", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const real = loadContent(root);
    const outdoors = [...real.items.values()].find((i) => i.kind === "ground" && !i.floor);
    const prefabs = loadWorld(root).prefabs;
    expect(prefabs.size).toBeGreaterThan(0);
    for (const [id, p] of prefabs) {
      const c = emptyChunk(0, 0, 7);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) setGround(c, x, y, outdoors?.id ?? "");
      p.rows.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          const e = p.legend.find((l) => l.char === ch);
          if (e?.ground) setGround(c, x + 4, y + 4, e.ground);
          for (const it of e?.items ?? []) pushItem(c, x + 4, y + 4, it);
        }),
      );
      expect(leaksOf([c], real), id).toEqual([]);
    }
  });
});
