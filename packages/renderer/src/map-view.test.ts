import { Texture } from "pixi.js";
import type { Container, Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import { Container as PixiContainer } from "pixi.js";
import { MapView, entityZIndex, itemZIndex } from "./map-view.ts";
import type { ChunkData, TileSource } from "./map-view.ts";
import type { TileArt } from "./tile-art.ts";

const T = 32;
const ground = (): (string | null)[] => new Array<string | null>(32 * 32).fill("grass");

function view(chunks: Map<string, ChunkData>): MapView {
  const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
  return new MapView({ source, texture: () => Texture.WHITE, tileSize: T, floor: 7 });
}

/** The layers: root → world → [ground, shadows, items, overlay]. */
const layer = (v: MapView, i: number): Container =>
  (v.root.children[0] as Container).children[i] as Container;
const itemLayer = (v: MapView): Container => layer(v, 2);

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

  it("draws entities over their own tile's items and under the next tiles' items", () => {
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 2, y: 2, stack: ["a", "b"] },
            { x: 3, y: 2, stack: ["c"] },
          ],
        },
      ],
    ]);
    const v = view(chunks);
    const cam = { x: 0, y: 0, zoom: 1 };
    const size = { width: 20 * T, height: 20 * T };
    const hero = new PixiContainer({ label: "hero" });
    v.placeEntity(hero, 2, 2);
    v.render(cam, size);
    expect(itemLayer(v).children.indexOf(hero)).toBe(2);
    v.placeEntity(hero, 3, 2);
    v.render(cam, size);
    expect(itemLayer(v).children.indexOf(hero)).toBe(3);
    v.removeEntity(hero);
    expect(itemLayer(v).children.includes(hero)).toBe(false);
    expect(entityZIndex(65535, 65535)).toBeGreaterThan(itemZIndex(65535, 65535, 255));
  });
});

describe("MapView tile art (docs/17 ART-3, ART-4, ART-7)", () => {
  const named = (label: string): Texture => {
    const t = new Texture();
    t.label = label;
    return t;
  };
  const pieces = Array.from({ length: 16 }, (_, m) => named(`wall_${m}`));
  const looks = [named("grass"), named("grass/var_1"), named("grass/var_2")];
  const water = [named("water/0"), named("water/1"), named("water/2"), named("water/3")];
  const torch = [named("torch/0"), named("torch/1")];
  const tree = named("tree");
  const treeShadow = named("tree/shadow");
  const art = (id: string): TileArt<Texture> | undefined => {
    const base = {
      weight: 0.7,
      ms: 250,
      sync: "world" as const,
      anchorX: 1 as const,
      joinsWalls: false,
    };
    if (id === "wall") return { ...base, base: named("wall"), wall: pieces, joinsWalls: true };
    if (id === "door") return { ...base, base: named("door"), joinsWalls: true };
    if (id === "grass") return { ...base, base: looks[0] as Texture, variants: looks };
    if (id === "water") return { ...base, base: water[0] as Texture, frames: water, ms: 200 };
    if (id === "torch")
      return { ...base, base: torch[0] as Texture, frames: torch, ms: 100, sync: "tile" };
    if (id === "tree") return { ...base, base: tree, anchorX: 0.5, shadow: treeShadow };
    return undefined;
  };
  function artView(chunks: Map<string, ChunkData>): MapView {
    const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
    return new MapView({ source, texture: () => Texture.WHITE, art, tileSize: T, floor: 7 });
  }
  const labelAt = (v: MapView, x: number, y: number): string[] =>
    itemLayer(v)
      .children.filter((s) => s.x === (x + 1) * T && s.y === (y + 1) * T)
      .map((s) => (s as Sprite).texture.label ?? "");
  const cam = { x: 0, y: 0, zoom: 1 };
  const size = { width: 64 * T, height: 64 * T };

  it("puts on each wall the piece for its wall neighbours, across chunk borders", () => {
    // A wall line along y = 5 from x = 30 to x = 33 (crossing into chunk 1/0), a wall going
    // south from (31, 5), and a door at (34, 5) that joins the line.
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 30, y: 5, stack: ["wall"] },
            { x: 31, y: 5, stack: ["wall"] },
            { x: 31, y: 6, stack: ["wall"] },
          ],
        },
      ],
      [
        "7/1/0",
        {
          ground: ground(),
          items: [
            { x: 0, y: 5, stack: ["wall"] },
            { x: 1, y: 5, stack: ["wall"] },
            { x: 2, y: 5, stack: ["door"] },
          ],
        },
      ],
    ]);
    const v = artView(chunks);
    v.render(cam, size);
    expect(labelAt(v, 30, 5)).toEqual(["wall_2"]); // E
    expect(labelAt(v, 31, 5)).toEqual(["wall_14"]); // E, S, W
    expect(labelAt(v, 31, 6)).toEqual(["wall_1"]); // N
    expect(labelAt(v, 32, 5)).toEqual(["wall_10"]); // E, W across the border
    expect(labelAt(v, 33, 5)).toEqual(["wall_10"]); // the door joins on the east
    expect(labelAt(v, 34, 5)).toEqual(["door"]);
    expect(v.wallAt(34, 5)).toBe(true);
    expect(v.wallAt(35, 5)).toBe(false);
    // The door goes: chunk 1/0 changes, and chunk 0/0's wall at its border is rebuilt too.
    chunks.set("7/1/0", { ground: ground(), items: [{ x: 1, y: 5, stack: ["wall"] }] });
    v.render(cam, size);
    expect(labelAt(v, 31, 5)).toEqual(["wall_12"]); // S, W
    expect(labelAt(v, 33, 5)).toEqual(["wall_0"]); // alone
  });

  it("picks a ground's look by tile, the same every time", () => {
    const chunks = new Map<string, ChunkData>([["7/0/0", { ground: ground(), items: [] }]]);
    const looksOf = (v: MapView): string[] =>
      layer(v, 0)
        .children.flatMap((c) => (c as Container).children)
        .map((s) => (s as Sprite).texture.label ?? "");
    const a = artView(chunks);
    a.render(cam, size);
    const first = looksOf(a);
    expect(first).toHaveLength(1024);
    const counts = new Map<string, number>();
    for (const l of first) counts.set(l, (counts.get(l) ?? 0) + 1);
    expect(counts.get("grass") ?? 0).toBeGreaterThan(600);
    expect(counts.get("grass/var_1") ?? 0).toBeGreaterThan(80);
    expect(counts.get("grass/var_2") ?? 0).toBeGreaterThan(80);
    const b = artView(chunks);
    b.render(cam, size);
    expect(looksOf(b)).toEqual(first);
  });

  it("steps animated grounds and items, a tile animation with its own phase", () => {
    const g = new Array<string | null>(32 * 32).fill(null);
    g[0] = "water";
    g[1] = "water";
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: g,
          items: Array.from({ length: 8 }, (_, i) => ({ x: i, y: 3, stack: ["torch"] })),
        },
      ],
    ]);
    const v = artView(chunks);
    v.render(cam, size, 0);
    expect(v.animatedCount).toBe(10);
    const waterNow = (): string[] =>
      ((layer(v, 0).children[0] as Container).children as Sprite[]).map(
        (s) => s.texture.label ?? "",
      );
    expect(waterNow()).toEqual(["water/0", "water/0"]);
    v.render(cam, size, 450);
    expect(waterNow()).toEqual(["water/2", "water/2"]);
    // Torches flicker out of step: at any time, not every one shows the same frame.
    const torches = itemLayer(v).children.map((s) => (s as Sprite).texture.label);
    expect(new Set(torches).size).toBe(2);
    // Dropping the chunk forgets its animations.
    v.render({ x: 200, y: 200, zoom: 1 }, size, 500);
    expect(v.animatedCount).toBe(0);
  });

  it("centres a bc sprite on its tile and draws its shadow under the items", () => {
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: ground(), items: [{ x: 4, y: 6, stack: ["tree"] }] }],
    ]);
    const v = artView(chunks);
    v.render(cam, size);
    const [sprite] = itemLayer(v).children as Sprite[];
    expect(sprite?.anchor.x).toBe(0.5);
    expect(sprite?.x).toBe(4.5 * T);
    expect(sprite?.y).toBe(7 * T);
    const shadows = layer(v, 1);
    const [sh] = (shadows.children[0] as Container).children as Sprite[];
    expect(sh?.texture).toBe(treeShadow);
    expect(sh?.x).toBe(4.5 * T);
    expect(shadows.alpha).toBeLessThan(0.5);
  });
});
