import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatChunk } from "../chunk.ts";
import { loadContent } from "../content.ts";
import { loadWorld } from "../io.ts";
import { chunkKey } from "../types.ts";
import type { Island, World } from "../types.ts";
import { applyOps, OpError } from "./index.ts";
import type { MapOp, OpOptions } from "./index.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const content = loadContent(repo);
const opts: OpOptions = { itemKind: (id) => content.items.get(id)?.kind };

function testisle(): World {
  const { world, diagnostics } = loadWorld(repo);
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return world;
}

/** Every chunk of the world in canonical bytes, keyed by island and chunk. */
function bytes(world: World): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, isl] of world.islands)
    for (const [k, c] of isl.chunks) out.set(`${id}:${k}`, formatChunk(c));
  return out;
}

function tileOf(world: World, x: number, y: number, z: number) {
  const isl = world.islands.get("testisle");
  const c = isl?.chunks.get(chunkKey(z, Math.floor(x / 32), Math.floor(y / 32)));
  if (!c) return undefined;
  const lx = x % 32;
  const ly = y % 32;
  return {
    ground: c.ground[ly * 32 + lx] ?? null,
    stack: c.items.find((s) => s.x === lx && s.y === ly)?.stack ?? [],
  };
}

/** Applies ops, then the inverse, and checks the bytes came back. Returns the edited world. */
function roundTrip(world: World, ops: MapOp[]): World {
  const before = bytes(world);
  const { world: edited, inverse } = applyOps(world, ops, opts);
  expect(bytes(world)).toEqual(before); // input untouched
  const { world: restored, inverse: redo } = applyOps(edited, inverse, opts);
  expect(bytes(restored)).toEqual(before);
  // The inverse of the inverse redoes the edit.
  expect(bytes(applyOps(restored, redo, opts).world)).toEqual(bytes(edited));
  return edited;
}

describe("applyOps", () => {
  it("paints ground over a rect and cells, and undoes it exactly", () => {
    const w = testisle();
    const edited = roundTrip(w, [
      { op: "paint_ground", floor: 7, rect: { x: 1050, y: 1050, w: 4, h: 3 }, item: "sand" },
      { op: "paint_ground", floor: 7, cells: [{ x: 1040, y: 1040 }], item: "dirt" },
    ]);
    expect(tileOf(edited, 1053, 1052, 7)?.ground).toBe("sand");
    expect(tileOf(edited, 1040, 1040, 7)?.ground).toBe("dirt");
  });

  it("creates a chunk when painting into an empty area and removes it on undo", () => {
    const w = testisle();
    const key = chunkKey(8, 32, 32);
    expect(w.islands.get("testisle")?.chunks.has(key)).toBe(false);
    const { world, inverse, touched } = applyOps(
      w,
      [{ op: "paint_ground", floor: 8, cells: [{ x: 1030, y: 1030 }], item: "dirt" }],
      opts,
    );
    expect(touched).toEqual([{ island: "testisle", z: 8, cx: 32, cy: 32 }]);
    expect(world.islands.get("testisle")?.chunks.has(key)).toBe(true);
    const back = applyOps(world, inverse, opts).world;
    expect(back.islands.get("testisle")?.chunks.has(key)).toBe(false);
  });

  it("places and removes items at a given index", () => {
    const w = testisle();
    const pos = { x: 1052, y: 1050, z: 7 };
    const edited = roundTrip(w, [
      { op: "place_item", pos, item: "cargo_crate" },
      { op: "place_item", pos, item: "mooring_post", index: 0 },
    ]);
    expect(tileOf(edited, 1052, 1050, 7)?.stack).toEqual(["mooring_post", "cargo_crate"]);
    const removed = roundTrip(edited, [{ op: "remove_item", pos, item: "cargo_crate" }]);
    expect(tileOf(removed, 1052, 1050, 7)?.stack).toEqual(["mooring_post"]);
  });

  it("removes the topmost occurrence when no index is given", () => {
    const pos = { x: 1052, y: 1050, z: 7 };
    const w = applyOps(
      testisle(),
      ["cargo_crate", "mooring_post", "cargo_crate"].map((item) => ({
        op: "place_item" as const,
        pos,
        item,
      })),
      opts,
    ).world;
    const { world, inverse } = applyOps(w, [{ op: "remove_item", pos, item: "cargo_crate" }], opts);
    expect(tileOf(world, 1052, 1050, 7)?.stack).toEqual(["cargo_crate", "mooring_post"]);
    expect(inverse).toEqual([{ op: "place_item", pos, item: "cargo_crate", index: 2 }]);
  });

  it.each(["ground", "items", "all"] as const)("erases layer %s and restores it", (layer) => {
    const pos = { x: 1052, y: 1050, z: 7 };
    const w = applyOps(
      testisle(),
      [
        { op: "place_item", pos, item: "cargo_crate" },
        { op: "place_item", pos, item: "mooring_post" },
      ],
      opts,
    ).world;
    const edited = roundTrip(w, [
      { op: "erase", floor: 7, rect: { x: 1048, y: 1048, w: 8, h: 8 }, layer },
    ]);
    const t = tileOf(edited, 1052, 1050, 7);
    expect(t?.ground ?? null).toBe(layer === "items" ? tileOf(w, 1052, 1050, 7)?.ground : null);
    expect(t?.stack ?? []).toEqual(layer === "ground" ? ["cargo_crate", "mooring_post"] : []);
  });

  it("erasing a whole chunk removes it, and undo brings back the same bytes", () => {
    const w = testisle();
    const key = chunkKey(8, 33, 32);
    expect(w.islands.get("testisle")?.chunks.has(key)).toBe(true);
    const edited = roundTrip(w, [
      { op: "erase", floor: 8, rect: { x: 1056, y: 1024, w: 32, h: 32 }, layer: "all" },
    ]);
    expect(edited.islands.get("testisle")?.chunks.has(key)).toBe(false);
  });

  it("random edits always undo to the original bytes", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const grounds = ["grass", "sand", "dirt", "water_shallow"];
    const items = ["cargo_crate", "mooring_post"];
    let w = testisle();
    const original = bytes(w);
    const undo: MapOp[][] = [];
    for (let i = 0; i < 200; i++) {
      const z = rnd(2) === 0 ? 7 : 8;
      const x = 1024 + rnd(64);
      const y = 1024 + rnd(64);
      const kind = rnd(4);
      const op: MapOp =
        kind === 0
          ? {
              op: "paint_ground",
              floor: z,
              rect: { x, y, w: 1 + rnd(3), h: 1 + rnd(3) },
              item: grounds[rnd(4)] as string,
            }
          : kind === 1
            ? { op: "place_item", pos: { x, y, z }, item: items[rnd(2)] as string }
            : kind === 2
              ? {
                  op: "erase",
                  floor: z,
                  cells: [{ x, y }],
                  layer: (["ground", "items", "all"] as const)[rnd(3)] as "all",
                }
              : {
                  op: "paint_ground",
                  floor: z,
                  cells: [{ x, y }],
                  item: grounds[rnd(4)] as string,
                };
      try {
        const r = applyOps(w, [op], opts);
        w = r.world;
        undo.push(r.inverse);
      } catch (e) {
        if (!(e instanceof OpError)) throw e; // e.g. a tile outside the 64x64 island
      }
    }
    for (const inv of undo.reverse()) w = applyOps(w, inv, opts).world;
    expect(bytes(w)).toEqual(original);
  });

  it("is atomic: one invalid op applies nothing", () => {
    const w = testisle();
    const call = (): unknown =>
      applyOps(
        w,
        [
          { op: "paint_ground", floor: 7, cells: [{ x: 1050, y: 1050 }], item: "sand" },
          { op: "remove_item", pos: { x: 1050, y: 1050, z: 7 }, item: "cargo_crate" },
        ],
        opts,
      );
    expect(call).toThrow(OpError);
    expect(call).toThrow(/op 1: no "cargo_crate" on the stack at 1050,1050,7/);
  });

  it.each<[string, MapOp, RegExp]>([
    [
      "outside islands",
      { op: "paint_ground", floor: 7, cells: [{ x: 5, y: 5 }], item: "sand" },
      /not inside any island/,
    ],
    [
      "unlisted floor",
      { op: "paint_ground", floor: 6, cells: [{ x: 1030, y: 1030 }], item: "sand" },
      /floor 6 is not in the floors/,
    ],
    [
      "non-ground paint",
      { op: "paint_ground", floor: 7, cells: [{ x: 1030, y: 1030 }], item: "cargo_crate" },
      /not a ground item/,
    ],
    [
      "ground on a stack",
      { op: "place_item", pos: { x: 1030, y: 1030, z: 7 }, item: "sand" },
      /use paint_ground/,
    ],
    [
      "unknown item",
      { op: "place_item", pos: { x: 1030, y: 1030, z: 7 }, item: "nope" },
      /unknown item "nope"/,
    ],
    [
      "bad index",
      { op: "place_item", pos: { x: 1030, y: 1030, z: 7 }, item: "cargo_crate", index: 3 },
      /outside the stack/,
    ],
    ["no area", { op: "erase", floor: 7, layer: "all" }, /needs rect or cells/],
    [
      "bad rect",
      { op: "erase", floor: 7, rect: { x: 1030, y: 1030, w: 0, h: 1 }, layer: "all" },
      /invalid rect/,
    ],
  ])("rejects %s", (_name, op, msg) => {
    expect(() => applyOps(testisle(), [op], opts)).toThrow(msg);
  });

  it("returns the same world object when nothing changes", () => {
    const w = testisle();
    expect(applyOps(w, []).world).toBe(w);
  });
});

describe("islands that share a chunk", () => {
  // Rectangles are chunk-aligned in valid worlds, but ops must not mix islands if not.
  function twoIslands(): World {
    const island = (id: string, x: number, w: number): Island => ({
      meta: {
        id,
        name: `island.${id}.name`,
        rect: { x, y: 0, w, h: 32 },
        floors: [7],
        temple: { x, y: 0, z: 7 },
        level_hint: [1, 1],
      },
      chunks: new Map(),
      spawns: [],
      npcs: [],
      zones: [],
      portals: [],
      texts: [],
      houses: [],
    });
    return {
      meta: { format: 1, islands: [] },
      islands: new Map([
        ["a", island("a", 0, 40)],
        ["b", island("b", 40, 24)],
      ]),
    };
  }

  it("keeps each island's copy of the chunk apart, and undoes both", () => {
    const w = twoIslands();
    const { world, touched, inverse } = applyOps(w, [
      { op: "paint_ground", floor: 7, cells: [{ x: 35, y: 1 }], item: "sand" },
      { op: "paint_ground", floor: 7, cells: [{ x: 45, y: 1 }], item: "dirt" },
    ]);
    expect(touched).toEqual([
      { island: "a", z: 7, cx: 1, cy: 0 },
      { island: "b", z: 7, cx: 1, cy: 0 },
    ]);
    const chunk = (id: string) => world.islands.get(id)?.chunks.get(chunkKey(7, 1, 0));
    expect(chunk("a")?.ground.filter((g) => g !== null)).toEqual(["sand"]);
    expect(chunk("b")?.ground.filter((g) => g !== null)).toEqual(["dirt"]);
    const back = applyOps(world, inverse).world;
    expect([...back.islands.values()].map((i) => i.chunks.size)).toEqual([0, 0]);
  });
});

describe("ops module", () => {
  it("imports nothing from Node, so the editor can bundle it", () => {
    const dir = new URL("./", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      // Only siblings in ops/, the plain model types and the model-level patch merge.
      for (const i of imports)
        expect(
          i === "../types.ts" || i === "../patch/merge.ts" || /^\.\/[a-z-]+\.ts$/.test(i ?? ""),
        ).toBe(true);
    }
    // patch/merge.ts (browser half of map patches) only uses the model and the op types.
    const merge = readFileSync(new URL("../patch/merge.ts", dir), "utf8");
    for (const m of merge.matchAll(/from "([^"]+)"/g))
      expect(["../types.ts", "../ops/types.ts"]).toContain(m[1]);
  });
});
