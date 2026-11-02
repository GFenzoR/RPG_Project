import { Texture } from "pixi.js";
import type { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { MapView, itemZIndex } from "./map-view.ts";
import type { ChunkData, TileSource } from "./map-view.ts";

const T = 32;
const ground = (): (string | null)[] => new Array<string | null>(32 * 32).fill("grass");

function view(chunks: Map<string, ChunkData>): MapView {
  const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
  return new MapView({ source, texture: () => Texture.WHITE, tileSize: T, floor: 7 });
}

/** The item layer: root → world → [ground, items, overlay]. */
const itemLayer = (v: MapView): Container =>
  (v.root.children[0] as Container).children[1] as Container;

/** Global tile of each drawn item sprite, in draw order. */
const drawn = (v: MapView): string[] =>
  itemLayer(v).children.map((s) => `${s.x / T - 1},${s.y / T - 1}`);

describe("MapView", () => {
  it("draws items in global row-major order across chunk borders", () => {
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 5, y: 31, stack: ["tree"] },
            { x: 31, y: 5, stack: ["a"] },
          ],
        },
      ],
      ["7/1/0", { ground: ground(), items: [{ x: 0, y: 5, stack: ["b", "c"] }] }],
      ["7/0/1", { ground: ground(), items: [{ x: 0, y: 0, stack: ["d"] }] }],
    ]);
    const v = view(chunks);
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 64 * T, height: 64 * T });
    expect(v.chunkCount).toBe(3);
    // Built per chunk (0/0, 1/0, 0/1) but drawn by (y, x): row 5 before row 31 before row 32.
    expect(drawn(v)).toEqual(["31,5", "32,5", "32,5", "5,31", "0,32"]);
    // Stack order within a tile is kept.
    const [, b, c] = itemLayer(v).children;
    expect((b?.zIndex ?? 0) < (c?.zIndex ?? 0)).toBe(true);
  });

  it("rebuilds a chunk when the source returns a new object, and drops chunks out of view", () => {
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: ground(), items: [{ x: 1, y: 1, stack: ["a"] }] }],
      ["7/5/5", { ground: ground(), items: [] }],
    ]);
    const v = view(chunks);
    const cam = { x: 0, y: 0, zoom: 1 };
    const size = { width: 20 * T, height: 20 * T };
    v.render(cam, size);
    expect(v.chunkCount).toBe(1);
    chunks.set("7/0/0", { ground: ground(), items: [{ x: 1, y: 1, stack: ["a", "b"] }] });
    v.render(cam, size);
    expect(drawn(v)).toEqual(["1,1", "1,1"]);
    v.render({ x: 160, y: 160, zoom: 1 }, size);
    expect(v.chunkCount).toBe(1);
    expect(drawn(v)).toEqual([]);
  });

  it("orders by row, then column, then stack height", () => {
    expect(itemZIndex(65535, 0, 0)).toBeLessThan(itemZIndex(0, 1, 0));
    expect(itemZIndex(3, 3, 0)).toBeLessThan(itemZIndex(3, 3, 1));
    expect(itemZIndex(3, 3, 999)).toBeLessThan(itemZIndex(4, 3, 0));
    expect(Number.isSafeInteger(itemZIndex(65535, 65535, 255))).toBe(true);
  });
});
