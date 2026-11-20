import { Texture } from "pixi.js";
import type { Container, Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import { Container as PixiContainer } from "pixi.js";
import { MapView, entityZIndex, itemZIndex } from "./map-view.ts";
import type { ChunkData, TileSource } from "./map-view.ts";
import { lookOf, tileHash } from "./tile-art.ts";
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
  // A fringe piece with 4 looks, and a surf piece whose 4 looks play 2 frames each.
  const fringe = [0, 1, 2, 3].map((k) => named(`fringe/${k}`));
  const surf = [0, 1, 2, 3].map((k) => [named(`surf/${k}/0`), named(`surf/${k}/1`)]);
  const treeShadow = named("tree/shadow");
  const art = (id: string): TileArt<Texture> | undefined => {
    const base = {
      weight: 0.7,
      ms: 250,
      sync: "world" as const,
      anchorX: 1 as const,
      joinsWalls: false,
      light: 0,
    };
    if (id === "wall") return { ...base, base: named("wall"), wall: pieces, joinsWalls: true };
    if (id === "door") return { ...base, base: named("door"), joinsWalls: true };
    if (id === "grass") return { ...base, base: looks[0] as Texture, variants: looks };
    if (id === "water") return { ...base, base: water[0] as Texture, frames: water, ms: 200 };
    if (id === "torch")
      return { ...base, base: torch[0] as Texture, frames: torch, ms: 100, sync: "tile" };
    if (id === "tree") return { ...base, base: tree, anchorX: 0.5, shadow: treeShadow };
    // Border pieces leave the weight to lookOf: their looks come up evenly.
    const even = {
      ms: base.ms,
      sync: base.sync,
      anchorX: base.anchorX,
      joinsWalls: false,
      light: 0,
    };
    if (id === "fringe") return { ...even, base: fringe[0] as Texture, variants: fringe };
    if (id === "flat_fringe")
      return { ...even, base: fringe[0] as Texture, variants: fringe, flat: true };
    if (id === "surf")
      return {
        ...even,
        base: (surf[0] as Texture[])[0] as Texture,
        variants: surf.map((f) => f[0] as Texture),
        frames: surf[0] as Texture[],
        variantFrames: surf,
        ms: 200,
      };
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

  it("gives every border piece of a tile one look, evenly over the tiles, the surf its frames", () => {
    const items = [];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) items.push({ x, y, stack: ["surf", "fringe"] });
    const v = artView(new Map([["7/0/0", { ground: ground(), items }]]));
    v.render(cam, size, 0);
    const counts = [0, 0, 0, 0];
    const art0 = art("fringe") as TileArt<Texture>;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const k = lookOf(art0, tileHash(x, y, 7), false);
        counts[k] = (counts[k] ?? 0) + 1;
        // The surf and the fringe of a tile show the same look (the surf follows its edge).
        expect(labelAt(v, x, y)).toEqual([`surf/${k}/0`, `fringe/${k}`]);
      }
    for (const c of counts) expect(c).toBeGreaterThan(40); // about 64 each of 256
    // The surf plays the frames of its own look.
    v.render(cam, size, 250);
    const k = lookOf(art0, tileHash(5, 9, 7), false);
    expect(labelAt(v, 5, 9)).toEqual([`surf/${k}/1`, `fringe/${k}`]);
  });

  it("draws a flat border piece with the grounds, under the creatures, items and shadows", () => {
    // A wolf on (4, 6) whose sprite reaches over (5, 6), where a fringe lies under a coin;
    // a tree on (3, 6) whose shadow falls over the fringe too.
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 3, y: 6, stack: ["tree"] },
            { x: 5, y: 6, stack: ["flat_fringe", "coin"] },
          ],
        },
      ],
    ]);
    const v = artView(chunks);
    const wolf = new PixiContainer({ label: "wolf" });
    v.placeEntity(wolf, 4, 6);
    v.render(cam, size);
    // The item layer has the tree, the wolf and the coin: no fringe drawn over the wolf.
    const labels = itemLayer(v).children.map((s) =>
      s === wolf ? "wolf" : ((s as Sprite).texture.label ?? ""),
    );
    expect(labels).toEqual(["tree", "wolf", "WHITE"]);
    // The fringe is in its chunk's ground container, after every ground, at its tile.
    const g = layer(v, 0).children[0] as Container;
    expect(g.children).toHaveLength(32 * 32 + 1);
    const piece = g.children[32 * 32] as Sprite;
    const k = lookOf(art("flat_fringe") as TileArt<Texture>, tileHash(5, 6, 7), false);
    expect(piece.texture.label).toBe(`fringe/${k}`);
    expect([piece.x, piece.y]).toEqual([6 * T, 7 * T]);
    // The ground layer is drawn before the shadows: the tree's shadow darkens the fringe.
    const world = v.root.children[0] as Container;
    expect(world.children.indexOf(layer(v, 0))).toBeLessThan(world.children.indexOf(layer(v, 1)));
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

  it("lists the tiles that give off particles; spray only where its ground meets another", () => {
    const g = ground();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) g[y * 32 + x] = "sea";
    const withParticles = (id: string): TileArt<Texture> | undefined => {
      const base = {
        base: named(id),
        weight: 0.7,
        ms: 250,
        sync: "world" as const,
        anchorX: 1 as const,
        joinsWalls: false,
        light: 0,
      };
      if (id === "sea") return { ...base, particles: "spray" };
      if (id === "forge") return { ...base, particles: "embers" };
      return undefined;
    };
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: g, items: [{ x: 9, y: 9, stack: ["forge", "forge"] }] }],
    ]);
    const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
    const v = new MapView({
      source,
      texture: () => Texture.WHITE,
      art: withParticles,
      tileSize: T,
      floor: 7,
    });
    v.render(cam, size);
    const seen: string[] = [];
    v.forEachEmitter((x, y, kind) => seen.push(`${x},${y} ${kind}`));
    // The 4x4 sea in the chunk's corner: its edge tiles toward the grass (x = 3 or y = 3),
    // not the inner ones nor the chunk's own border; one emitter per stack.
    expect(seen.filter((e) => e.endsWith("spray")).sort()).toEqual(
      ["0,3", "1,3", "2,3", "3,0", "3,1", "3,2", "3,3"].map((t) => `${t} spray`).sort(),
    );
    expect(seen.filter((e) => e.endsWith("embers"))).toEqual(["9,9 embers"]);
  });
});

describe("MapView elevation (docs/17 ART-8)", () => {
  const elevation = (id: string): number => (id === "table" ? 8 : id === "crate" ? 10 : 0);
  function elevView(chunks: Map<string, ChunkData>, withElevation = true): MapView {
    const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
    return new MapView({
      source,
      texture: () => Texture.WHITE,
      elevation: withElevation ? elevation : undefined,
      tileSize: T,
      floor: 7,
    });
  }

  it("raises what is stacked on a table, up to the cap, and the creature standing there", () => {
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 2, y: 3, stack: ["table", "coin", "coin"] },
            { x: 5, y: 3, stack: ["crate", "crate", "crate", "coin"] },
            { x: 7, y: 3, stack: ["coin", "table"] },
          ],
        },
      ],
    ]);
    const v = elevView(chunks);
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 40 * T, height: 40 * T });
    const ys = itemLayer(v).children.map((s) => 4 * T - s.y);
    // Table, coin on it, coin on that (a coin raises nothing more); three crates (10 + 10,
    // then capped at 24) and a coin on top; a table on a coin raises nothing under it.
    expect(ys).toEqual([0, 8, 8, 0, 10, 20, 24, 0, 0]);
    expect(v.elevationAt(2, 3)).toBe(8);
    expect(v.elevationAt(5, 3)).toBe(24);
    expect(v.elevationAt(7, 3)).toBe(8);
    expect(v.elevationAt(1, 1)).toBe(0);
    expect(v.elevationAt(-1, 3)).toBe(0);
    expect(v.elevationAt(100, 100)).toBe(0);
  });

  it("raises nothing without an elevation lookup", () => {
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: ground(), items: [{ x: 2, y: 3, stack: ["table", "coin"] }] }],
    ]);
    const v = elevView(chunks, false);
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 40 * T, height: 40 * T });
    expect(itemLayer(v).children.map((s) => s.y)).toEqual([4 * T, 4 * T]);
    expect(v.elevationAt(2, 3)).toBe(0);
  });
});
