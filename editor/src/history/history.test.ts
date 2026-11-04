import { CHUNK_SIZE, chunkKey } from "@rpg/map-format/ops";
import type { Chunk, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import { History, Stroke } from "./history.ts";
import { OpError, applyOps } from "@rpg/map-format/ops";

/** One island, one empty chunk-sized area at the origin, floor 7. */
function world(): World {
  return {
    meta: { format: 1, islands: [] },
    islands: new Map([
      [
        "t",
        {
          meta: {
            id: "t",
            name: "island.t.name",
            rect: { x: 0, y: 0, w: CHUNK_SIZE, h: CHUNK_SIZE },
            floors: [7],
            temple: { x: 1, y: 1, z: 7 },
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

const ground = (w: World, x: number, y: number): string | null =>
  w.islands.get("t")?.chunks.get(chunkKey(7, 0, 0))?.ground[y * CHUNK_SIZE + x] ?? null;

describe("History", () => {
  it("undoes and redoes, and a new edit clears redo", () => {
    const h = new History();
    const w0 = world();
    const w1 = h.apply(w0, "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "grass" },
    ]).world;
    const w2 = h.apply(w1, "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "sand" },
    ]).world;
    expect(ground(w2, 1, 1)).toBe("sand");
    const u1 = h.undo(w2);
    expect(u1 && ground(u1.world, 1, 1)).toBe("grass");
    const u2 = h.undo(u1?.world ?? w2);
    expect(u2?.world.islands.get("t")?.chunks.size).toBe(0);
    expect(h.undo(u2?.world ?? w2)).toBeUndefined();
    const r1 = h.redo(u2?.world ?? w2);
    expect(r1 && ground(r1.world, 1, 1)).toBe("grass");
    expect(h.canRedo).toBe(true);
    h.apply(r1?.world ?? w2, "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 2, y: 2 }], item: "dirt" },
    ]);
    expect(h.canRedo).toBe(false);
  });

  it("undoes over items the content does not know, as the inverse only restores", () => {
    const h = new History({ itemKind: (id) => (id === "grass" ? "ground" : undefined) });
    const w0 = applyOps(world(), [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "retired_ground" },
    ]).world;
    const w1 = h.apply(w0, "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "grass" },
    ]).world;
    const u = h.undo(w1);
    expect(u && ground(u.world, 1, 1)).toBe("retired_ground");
  });

  it("keeps the entry when undo or redo cannot be applied", () => {
    const h = new History();
    const pos = { x: 1, y: 1, z: 7 };
    const w0 = applyOps(world(), [
      { op: "paint_ground", floor: 7, cells: [pos], item: "grass" },
    ]).world;
    const w1 = h.apply(w0, "place", [{ op: "place_item", pos, item: "crate" }]).world;
    // Something else removed the crate: the inverse (remove_item) no longer applies.
    const elsewhere = applyOps(w1, [{ op: "remove_item", pos, item: "crate" }]).world;
    expect(() => h.undo(elsewhere)).toThrow(OpError);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    const u = h.undo(w1);
    expect(u).toBeDefined();
    // Redo onto a world whose island is gone fails the same way, keeping the entry.
    expect(() => h.redo({ ...w1, islands: new Map() })).toThrow(OpError);
    expect(h.canRedo).toBe(true);
  });

  it("does not record edits that change nothing", () => {
    const h = new History();
    const w1 = h.apply(world(), "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "grass" },
    ]).world;
    h.apply(w1, "paint", [
      { op: "paint_ground", floor: 7, cells: [{ x: 1, y: 1 }], item: "grass" },
    ]);
    expect(h.size).toBe(1);
  });

  it("records a stroke as one entry", () => {
    const h = new History();
    const stroke = new Stroke("paint");
    let w = world();
    for (let x = 0; x < 5; x++) {
      const ops = [{ op: "paint_ground" as const, floor: 7, cells: [{ x, y: 0 }], item: "grass" }];
      const r = applyOps(w, ops);
      stroke.add(ops, r.inverse);
      w = r.world;
    }
    h.record(stroke.entry());
    expect(h.size).toBe(1);
    const u = h.undo(w);
    expect(u?.world.islands.get("t")?.chunks.size).toBe(0);
    const r = h.redo(u?.world ?? w);
    expect([0, 1, 2, 3, 4].map((x) => (r ? ground(r.world, x, 0) : null))).toEqual(
      Array(5).fill("grass"),
    );
  });
});
