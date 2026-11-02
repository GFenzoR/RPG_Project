import { applyOps } from "@rpg/map-format/ops";
import type { Chunk, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import { brushCells, line, tileAt, toolOps } from "./tools.ts";
import type { ToolSettings } from "./tools.ts";

function world(): World {
  return {
    meta: { format: 1, islands: [], boat_routes: [] },
    islands: new Map([
      [
        "t",
        {
          meta: {
            id: "t",
            name: "island.t.name",
            rect: { x: 32, y: 32, w: 16, h: 16 },
            floors: [7],
            temple: { x: 33, y: 33, z: 7 },
            level_hint: [1, 1],
          },
          chunks: new Map<string, Chunk>(),
          spawns: [],
          npcs: [],
          zones: [],
          portals: [],
          texts: [],
        },
      ],
    ]),
  };
}

const base: ToolSettings = {
  tool: "brush",
  floor: 7,
  ground: "grass",
  item: "cargo_crate",
  brushSize: 3,
  eraseLayer: "all",
};

describe("tools", () => {
  it("brush paints the square around the tile, clipped to the island", () => {
    expect(brushCells(5, 5, 3)).toHaveLength(9);
    const ops = toolOps(world(), base, 32, 32, false);
    expect(ops).toEqual([
      {
        op: "paint_ground",
        floor: 7,
        cells: [
          { x: 32, y: 32 },
          { x: 33, y: 32 },
          { x: 32, y: 33 },
          { x: 33, y: 33 },
        ],
        item: "grass",
      },
    ]);
    expect(toolOps(world(), base, 10, 10, false)).toEqual([]);
  });

  it("brush skips tiles that already have the ground", () => {
    const w = applyOps(world(), toolOps(world(), base, 40, 40, false)).world;
    expect(toolOps(w, base, 40, 40, false)).toEqual([]);
    expect(toolOps(w, { ...base, ground: "sand", brushSize: 1 }, 40, 40, false)).toHaveLength(1);
  });

  it("item tool places on top and secondary removes the top item", () => {
    let w = applyOps(world(), toolOps(world(), base, 40, 40, false)).world;
    const item = { ...base, tool: "item" as const };
    w = applyOps(w, toolOps(w, item, 40, 40, false)).world;
    w = applyOps(w, toolOps(w, { ...item, item: "mooring_post" }, 40, 40, false)).world;
    expect(tileAt(w, 40, 40, 7)?.stack).toEqual(["cargo_crate", "mooring_post"]);
    expect(toolOps(w, item, 40, 40, true)).toEqual([
      { op: "remove_item", pos: { x: 40, y: 40, z: 7 }, item: "mooring_post" },
    ]);
    expect(toolOps(w, item, 41, 45, true)).toEqual([]);
  });

  it("eraser only targets tiles with something on the chosen layer", () => {
    let w = applyOps(world(), toolOps(world(), { ...base, brushSize: 1 }, 40, 40, false)).world;
    const eraser = { ...base, tool: "eraser" as const };
    expect(toolOps(w, { ...eraser, eraseLayer: "items" }, 40, 40, false)).toEqual([]);
    const ops = toolOps(w, eraser, 40, 40, false);
    expect(ops).toEqual([{ op: "erase", floor: 7, cells: [{ x: 40, y: 40 }], layer: "all" }]);
    w = applyOps(w, ops).world;
    expect(tileAt(w, 40, 40, 7)).toBeUndefined();
  });

  it("line covers every tile between two points", () => {
    expect(line({ x: 0, y: 0 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(line({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }]);
  });
});
