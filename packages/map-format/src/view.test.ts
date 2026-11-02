import { describe, expect, it } from "vitest";
import { setGround } from "./chunk.ts";
import { chunkKey, emptyChunk } from "./types.ts";
import type { Island } from "./types.ts";
import { viewArea } from "./view.ts";

function tiny(): Island {
  const c = emptyChunk(0, 0, 7);
  setGround(c, 0, 0, "grass");
  setGround(c, 1, 0, "sand");
  return {
    meta: {
      id: "tiny",
      name: "island.tiny.name",
      rect: { x: 0, y: 0, w: 32, h: 32 },
      floors: [7],
      temple: { x: 1, y: 1, z: 7 },
      level_hint: [1, 2],
    },
    chunks: new Map([[chunkKey(7, 0, 0), c]]),
    spawns: [],
    npcs: [],
    zones: [],
    portals: [],
    texts: [],
  };
}

describe("viewArea", () => {
  it("draws ground, markers and empty tiles", () => {
    expect(viewArea(tiny(), 7, { x: 0, y: 0, w: 3, h: 2 })).toMatchObject({
      legend: { " ": "(no tile)", ",": "sand", ".": "grass", "@": "temple" },
      rows: ["., ", " @ "],
    });
  });

  it.each([
    ["wider than 64", 7, { x: 0, y: 0, w: 65, h: 1 }, /limited to 64x64/],
    ["taller than 64", 7, { x: 0, y: 0, w: 1, h: 65 }, /limited to 64x64/],
    ["negative x", 7, { x: -1, y: 0, w: 1, h: 1 }, /x,y >= 0/],
    ["negative y", 7, { x: 0, y: -1, w: 1, h: 1 }, /x,y >= 0/],
    ["zero width", 7, { x: 0, y: 0, w: 0, h: 1 }, /w,h >= 1/],
    ["zero height", 7, { x: 0, y: 0, w: 1, h: 0 }, /w,h >= 1/],
    ["fractional x", 7, { x: 0.5, y: 0, w: 1, h: 1 }, /integer/],
    ["past the world on x", 7, { x: 65535, y: 0, w: 2, h: 1 }, /leaves the world/],
    ["past the world on y", 7, { x: 0, y: 65535, w: 1, h: 2 }, /leaves the world/],
    ["floor above 15", 16, { x: 0, y: 0, w: 1, h: 1 }, /floor must be/],
    ["negative floor", -1, { x: 0, y: 0, w: 1, h: 1 }, /floor must be/],
    ["fractional floor", 7.5, { x: 0, y: 0, w: 1, h: 1 }, /floor must be/],
  ])("rejects %s", (_name, floor, area, message) => {
    expect(() => viewArea(tiny(), floor, area)).toThrow(message);
  });

  it("accepts the last tile of the world", () => {
    expect(viewArea(tiny(), 15, { x: 65535, y: 65535, w: 1, h: 1 }).rows).toEqual([" "]);
  });
});
