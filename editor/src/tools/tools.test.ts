import { applyOps } from "@rpg/map-format/ops";
import type { Chunk, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import {
  autoborderAfter,
  brushCells,
  clipToIslands,
  copyRect,
  line,
  pasteOps,
  rectOf,
  rectOps,
  tileAt,
  toolOps,
} from "./tools.ts";
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
            floors: [7, 8],
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

describe("hito 2 tools", () => {
  it("fill floods the contiguous ground with the fill op, and does nothing on the same ground", () => {
    const fill = { ...base, tool: "fill" as const };
    expect(toolOps(world(), fill, 40, 40, false)).toEqual([
      { op: "fill", pos: { x: 40, y: 40, z: 7 }, item: "grass" },
    ]);
    const w = applyOps(world(), toolOps(world(), fill, 40, 40, false)).world;
    expect(tileAt(w, 32, 32, 7)?.ground).toBe("grass");
    expect(tileAt(w, 47, 47, 7)?.ground).toBe("grass");
    expect(toolOps(w, fill, 40, 40, false)).toEqual([]);
    expect(toolOps(world(), fill, 10, 10, false)).toEqual([]);
  });

  it("rect paints (or erases) the dragged rect, clipped to the islands", () => {
    expect(rectOf({ x: 50, y: 30 }, { x: 45, y: 34 })).toEqual({ x: 45, y: 30, w: 6, h: 5 });
    expect(clipToIslands(world(), { x: 45, y: 30, w: 6, h: 5 }, 7)).toEqual([
      { x: 45, y: 32, w: 3, h: 3 },
    ]);
    expect(clipToIslands(world(), { x: 45, y: 30, w: 6, h: 5 }, 9)).toEqual([]);
    const rect = { ...base, tool: "rect" as const };
    const ops = rectOps(world(), rect, { x: 45, y: 30, w: 6, h: 5 }, false);
    expect(ops).toEqual([
      { op: "paint_ground", floor: 7, rect: { x: 45, y: 32, w: 3, h: 3 }, item: "grass" },
    ]);
    const w = applyOps(world(), ops).world;
    expect(rectOps(w, rect, { x: 45, y: 32, w: 1, h: 1 }, true)).toEqual([
      { op: "erase", floor: 7, rect: { x: 45, y: 32, w: 1, h: 1 }, layer: "all" },
    ]);
    // Dragging tile by tile does nothing: the rect is applied on release.
    expect(toolOps(world(), rect, 40, 40, false)).toEqual([]);
  });

  it("copy and paste move ground and item stacks, to another floor too", () => {
    let w = applyOps(world(), [
      { op: "paint_ground", floor: 7, rect: { x: 33, y: 33, w: 2, h: 1 }, item: "sand" },
      { op: "place_item", pos: { x: 34, y: 33, z: 7 }, item: "cargo_crate" },
      { op: "place_item", pos: { x: 34, y: 33, z: 7 }, item: "mooring_post" },
    ]).world;
    const clip = copyRect(w, 7, { x: 33, y: 33, w: 3, h: 1 });
    expect(clip).toEqual({
      w: 3,
      h: 1,
      tiles: [
        { ground: "sand", stack: [] },
        { ground: "sand", stack: ["cargo_crate", "mooring_post"] },
        null,
      ],
    });
    // Paste on floor 8 over a tile with another item: the stack is replaced.
    w = applyOps(w, [
      { op: "paint_ground", floor: 8, cells: [{ x: 41, y: 40 }], item: "grass" },
      { op: "place_item", pos: { x: 41, y: 40, z: 8 }, item: "cargo_crate" },
    ]).world;
    const ops = pasteOps(w, clip, 40, 40, 8);
    const r = applyOps(w, ops);
    expect(tileAt(r.world, 40, 40, 8)).toEqual({ ground: "sand", stack: [] });
    expect(tileAt(r.world, 41, 40, 8)).toEqual({
      ground: "sand",
      stack: ["cargo_crate", "mooring_post"],
    });
    expect(tileAt(r.world, 42, 40, 8)).toEqual({ ground: null, stack: [] }); // empty copied tile: untouched
    // Undo restores the target exactly; pasting twice changes nothing more.
    expect(applyOps(r.world, r.inverse).world).toEqual(w);
    expect(pasteOps(r.world, clip, 40, 40, 8)).toEqual([]);
    // Parts outside the island are dropped instead of failing.
    expect(applyOps(w, pasteOps(w, clip, 46, 40, 7)).world).toBeDefined();
  });

  it("autoborderAfter recomputes the changed cells and their neighbours, inside the islands", () => {
    const w = world();
    const paint = applyOps(w, [
      {
        op: "paint_ground",
        floor: 7,
        cells: [
          { x: 40, y: 40 },
          { x: 42, y: 41 },
        ],
        item: "sand",
      },
    ]);
    expect(autoborderAfter(paint.world, paint.inverse)).toEqual([
      { op: "autoborder", floor: 7, rect: { x: 39, y: 39, w: 5, h: 4 } },
    ]);
    const corner = applyOps(w, [
      { op: "paint_ground", floor: 7, rect: { x: 32, y: 32, w: 2, h: 2 }, item: "sand" },
    ]);
    expect(autoborderAfter(corner.world, corner.inverse)).toEqual([
      { op: "autoborder", floor: 7, rect: { x: 32, y: 32, w: 3, h: 3 } },
    ]);
    const items = applyOps(paint.world, [
      { op: "place_item", pos: { x: 40, y: 40, z: 7 }, item: "cargo_crate" },
    ]);
    expect(autoborderAfter(items.world, items.inverse)).toEqual([]);
  });
});
