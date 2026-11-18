import { describe, expect, it } from "vitest";
import { DecoratedSource, extrasByChunk, withExtras } from "./decorated.ts";
import type { ChunkData, TileSource } from "./map-view.ts";

const ground = (): (string | null)[] => new Array<string | null>(32 * 32).fill("grass");

describe("extrasByChunk", () => {
  it("groups items by chunk in local coordinates", () => {
    const m = extrasByChunk([
      { x: 33, y: 2, z: 7, id: "frame" },
      { x: 5, y: 40, z: 7, id: "frame" },
      { x: 34, y: 3, z: 7, id: "frame" },
      { x: -1, y: 3, z: 7, id: "frame" },
    ]);
    expect([...m.keys()].sort()).toEqual(["7/0/1", "7/1/0"]);
    expect(m.get("7/1/0")).toEqual([
      { x: 1, y: 2, id: "frame" },
      { x: 2, y: 3, id: "frame" },
    ]);
    expect(m.get("7/0/1")).toEqual([{ x: 5, y: 8, id: "frame" }]);
  });
});

describe("withExtras", () => {
  it("puts an extra at the bottom of its tile's stack, or alone, leaving the map as it was", () => {
    const data: ChunkData = { ground: ground(), items: [{ x: 1, y: 1, stack: ["coin"] }] };
    const out = withExtras(data, [
      { x: 1, y: 1, id: "frame" },
      { x: 4, y: 2, id: "frame" },
    ]);
    expect(out.items).toEqual([
      { x: 1, y: 1, stack: ["frame", "coin"] },
      { x: 4, y: 2, stack: ["frame"] },
    ]);
    expect(data.items).toEqual([{ x: 1, y: 1, stack: ["coin"] }]);
    expect(out.ground).toBe(data.ground);
  });
});

describe("DecoratedSource", () => {
  it("returns the same decorated object until the map or its extras change", () => {
    let chunk: ChunkData = { ground: ground(), items: [] };
    const base: TileSource = {
      chunk: (z, cx, cy) => (z === 7 && cx === 0 && cy === 0 ? chunk : undefined),
    };
    let extras = [{ x: 3, y: 3, id: "frame" }];
    const src = new DecoratedSource(base, (z, cx, cy) =>
      cx === 0 && cy === 0 ? extras : undefined,
    );
    const a = src.chunk(7, 0, 0);
    expect(a?.items).toEqual([{ x: 3, y: 3, stack: ["frame"] }]);
    expect(src.chunk(7, 0, 0)).toBe(a);
    chunk = { ground: ground(), items: [{ x: 3, y: 3, stack: ["coin"] }] };
    const b = src.chunk(7, 0, 0);
    expect(b).not.toBe(a);
    expect(b?.items).toEqual([{ x: 3, y: 3, stack: ["frame", "coin"] }]);
    extras = [];
    expect(src.chunk(7, 0, 0)).toBe(chunk);
    expect(src.chunk(7, 1, 0)).toBeUndefined();
  });
});
