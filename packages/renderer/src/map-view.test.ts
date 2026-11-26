import { Texture } from "pixi.js";
import type { Container, Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import { Container as PixiContainer } from "pixi.js";
import {
  CAST_SHADOW_ALPHA,
  MapView,
  REVEAL_ALPHA,
  REVEAL_FADE_MS,
  entityZIndex,
  itemZIndex,
  overlaps,
} from "./map-view.ts";
import type { ChunkData, TileSource } from "./map-view.ts";
import { groundDecal, groundLook, groundTone, lookOf, tileHash } from "./tile-art.ts";
import type { TileArt } from "./tile-art.ts";

const T = 32;
const ground = (): (string | null)[] => new Array<string | null>(32 * 32).fill("grass");

function view(chunks: Map<string, ChunkData>): MapView {
  const source: TileSource = { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) };
  return new MapView({ source, texture: () => Texture.WHITE, tileSize: T, floor: 7 });
}

/** root → world → [ground, ground overlay, shadows, indoor ground, lit overlay, items, overlay]. */
const layer = (v: MapView, i: number): Container =>
  (v.root.children[0] as Container).children[i] as Container;
const itemLayer = (v: MapView): Container => layer(v, 5);

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

  it("lists the item sprites with their tile and id, and versions the built chunks", () => {
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: ground(), items: [{ x: 3, y: 4, stack: ["bush", "coin"] }] }],
    ]);
    const v = view(chunks);
    const before = v.version;
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 20 * T, height: 20 * T });
    expect(v.version).toBeGreaterThan(before);
    const seen: string[] = [];
    v.forEachItemSprite((x, y, id, sprite) => {
      expect(itemLayer(v).children).toContain(sprite);
      seen.push(`${x},${y},${id}`);
    });
    expect(seen).toEqual(["3,4,bush", "3,4,coin"]);
    const built = v.version;
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 20 * T, height: 20 * T });
    expect(v.version).toBe(built); // nothing rebuilt
    // The ground overlay lies between the grounds and the cast shadows.
    const world = v.root.children[0] as Container;
    expect(world.children.indexOf(v.groundOverlay)).toBe(1);
    // The day and night fades the baked cast shadows with the sun (one alpha).
    const shadows = world.children[2] as Container;
    expect(shadows.alpha).toBeCloseTo(CAST_SHADOW_ALPHA);
    v.castShadowStrength = 0.25;
    expect(shadows.alpha).toBeCloseTo(CAST_SHADOW_ALPHA * 0.25);
    expect(v.castShadowStrength).toBeCloseTo(0.25);
    v.castShadowStrength = 7;
    expect(shadows.alpha).toBeCloseTo(CAST_SHADOW_ALPHA);
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
  const sandLooks = [0, 1, 2, 3, 4].map((k) => named(k === 0 ? "sand" : `sand/var_${k}`));
  const sandDecals = [named("sand/decal_1"), named("sand/decal_2")];
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
    if (id === "sand")
      return {
        ...base,
        base: sandLooks[0] as Texture,
        variants: sandLooks,
        decals: sandDecals,
        weight: 0.3,
      };
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

  it("fades the walls in front of a figure that cover it, never the ones behind (ART-3)", () => {
    // The textures here are 1x1: each wall piece covers the pixel at its tile's bottom-right.
    const chunks = new Map<string, ChunkData>([
      [
        "7/0/0",
        {
          ground: ground(),
          items: [
            { x: 10, y: 4, stack: ["wall"] }, // north of the figure: drawn behind it
            { x: 10, y: 6, stack: ["wall"] }, // south of it, over its feet
            { x: 20, y: 6, stack: ["wall"] }, // south, but far from it
          ],
        },
      ],
    ]);
    const v = artView(chunks);
    v.render(cam, size);
    const wallAt = (x: number, y: number): Sprite =>
      itemLayer(v).children.find((s) => s.x === (x + 1) * T && s.y === (y + 1) * T) as Sprite;
    // A figure standing on row 5 whose drawing reaches down past the wall's corner, and up
    // past the north wall's corner.
    const figure = { x: 330, y: 150, width: 30, height: 80 };
    v.revealBehind(figure, 5, 1000);
    expect(wallAt(10, 6).alpha).toBe(REVEAL_ALPHA);
    expect(wallAt(10, 4).alpha).toBe(1);
    expect(wallAt(20, 6).alpha).toBe(1);
    expect(v.wallAlphaAt(10, 6)).toEqual([REVEAL_ALPHA]);
    expect(v.wallAlphaAt(10, 4)).toEqual([1]);
    expect(v.wallAlphaAt(11, 6)).toEqual([]);
    // It walks away: the wall fades back in smoothly, not in one frame.
    v.revealBehind(undefined, 5, 1016);
    const back = wallAt(10, 6).alpha;
    expect(back).toBeGreaterThan(REVEAL_ALPHA);
    expect(back).toBeLessThan(1);
    v.revealBehind(undefined, 5, 1016 + REVEAL_FADE_MS * 10);
    expect(wallAt(10, 6).alpha).toBe(1);
  });

  it("tells whether two rectangles overlap (touching edges do not)", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(overlaps(a, { x: 9, y: 9, width: 5, height: 5 })).toBe(true);
    expect(overlaps(a, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
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
    // About 70 % the main look (more in calm areas, fewer in busy ones), the rest the others.
    expect(counts.get("grass") ?? 0).toBeGreaterThan(500);
    expect(counts.get("grass/var_1") ?? 0).toBeGreaterThan(80);
    expect(counts.get("grass/var_2") ?? 0).toBeGreaterThan(80);
    // Each tile shows the look groundLook gives it (mapcli renders the same).
    const grassArt = art("grass") as TileArt<Texture>;
    first.forEach((label, i) => {
      const k = groundLook(grassArt, i % 32, Math.floor(i / 32), 7);
      expect(label).toBe(k === 0 ? "grass" : `grass/var_${k}`);
    });
    const b = artView(chunks);
    b.render(cam, size);
    expect(looksOf(b)).toEqual(first);
  });

  it("tints grounds and flat pieces by groundTone and lays decals only inside a field", () => {
    const g = new Array<string | null>(32 * 32).fill("sand");
    // A strip of grass: the sand tiles next to it are edges and get no decal.
    for (let y = 0; y < 32; y++) g[y * 32 + 16] = "grass";
    const chunks = new Map<string, ChunkData>([
      ["7/0/0", { ground: g, items: [{ x: 15, y: 4, stack: ["flat_fringe"] }] }],
    ]);
    const v = artView(chunks);
    v.render(cam, size);
    const c = layer(v, 0).children[0] as Container;
    const sprites = c.children as Sprite[];
    for (let i = 0; i < 32 * 32; i++) {
      const s = sprites[i] as Sprite;
      expect(s.tint).toBe(groundTone(i % 32, Math.floor(i / 32), 7));
    }
    const expected: string[] = [];
    const inside = (x: number, y: number): boolean =>
      x > 0 && y > 0 && x < 31 && y < 31 && Math.abs(x - 16) > 1;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const d = groundDecal(x, y, 7, sandDecals.length);
        if (d >= 0 && inside(x, y)) expected.push(`sand/decal_${d + 1}@${x},${y}`);
      }
    expect(expected.length).toBeGreaterThan(5);
    const decals = sprites.slice(32 * 32, -1);
    expect(decals.map((s) => `${s.texture.label ?? ""}@${s.x / T},${s.y / T}`)).toEqual(expected);
    for (const s of decals) expect(s.tint).toBe(groundTone(s.x / T, s.y / T, 7));
    // The flat piece comes last, tinted like the ground of its tile.
    const piece = sprites.at(-1) as Sprite;
    expect(piece.texture.label?.startsWith("fringe/")).toBe(true);
    expect(piece.tint).toBe(groundTone(15, 4, 7));
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
    expect(world.children.indexOf(layer(v, 0))).toBeLessThan(world.children.indexOf(layer(v, 2)));
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
    const shadows = layer(v, 2);
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

// docs/17 ART-5: the sun's shadows stay out of the buildings. The map has no roofs, so the
// tiles walls close in are "indoors": their ground is drawn over the shadows.
describe("MapView indoors", () => {
  const G = "grass";
  const wallArt: TileArt<Texture> = {
    base: Texture.WHITE,
    ms: 250,
    sync: "world",
    joinsWalls: true,
    light: 0,
    anchorX: 1,
    wall: Array.from({ length: 16 }, () => Texture.WHITE),
  };
  type Stack = { x: number; y: number; stack: string[] };
  const open = (): (string | null)[] => new Array<string | null>(32 * 32).fill(G);
  /** A house: walls round (x0..x1, y0..y1), with a gap of `gap` tiles in its south wall. */
  const house = (x0: number, y0: number, x1: number, y1: number, gap = 0): ChunkData => {
    const items: Stack[] = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const edge = x === x0 || x === x1 || y === y0 || y === y1;
        if (edge && !(y === y1 && x > x0 && x <= x0 + gap)) items.push({ x, y, stack: ["wall"] });
      }
    return { ground: new Array<string | null>(32 * 32).fill(G), items };
  };
  const make = (
    chunks: Map<string, ChunkData>,
    indoors: ((z: number) => boolean) | undefined,
  ): MapView => {
    const v = new MapView({
      source: { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) },
      texture: () => Texture.WHITE,
      art: (id) => (id === "wall" ? wallArt : undefined),
      tileSize: T,
      floor: 7,
      indoors,
    });
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 2048, height: 1024 });
    return v;
  };

  it("knows the tiles walls close in, and draws their ground over the shadows", () => {
    const v = make(new Map([["7/0/0", house(4, 4, 9, 8)]]), () => true);
    expect(v.indoorAt(5, 5)).toBe(true);
    expect(v.indoorAt(8, 7)).toBe(true);
    // The walls themselves and the open ground are not indoors.
    expect(v.indoorAt(4, 4)).toBe(false);
    expect(v.indoorAt(3, 5)).toBe(false);
    expect(v.indoorAt(20, 20)).toBe(false);
    expect(v.indoorAt(-1, 5)).toBe(false);
    const world = v.root.children[0] as Container;
    expect(world.children.map((c) => c.label)).toEqual([
      "ground",
      "ground overlay",
      "shadows",
      "indoor ground",
      "lit overlay",
      "items",
      "overlay",
    ]);
    // The 4 x 3 tiles inside: their ground is in the indoor layer and not in the ground's.
    const indoor = layer(v, 3).children[0] as Container;
    expect(indoor.children).toHaveLength(12);
    expect((layer(v, 0).children[0] as Container).children).toHaveLength(32 * 32 - 12);
    expect(indoor.children.map((s) => `${s.x / T},${s.y / T}`)).toContain("5,5");
  });

  it("closes a room at its doorway, and is outdoors where the gap is wider than a door", () => {
    const door = make(new Map([["7/0/0", house(4, 4, 9, 8, 2)]]), () => true);
    expect(door.indoorAt(5, 5)).toBe(true);
    // The doorway's own tiles are under the lintel.
    expect(door.indoorAt(5, 8)).toBe(true);
    expect(door.indoorAt(5, 9)).toBe(false);
    const open = make(new Map([["7/0/0", house(4, 4, 9, 8, 4)]]), () => true);
    expect(open.indoorAt(5, 5)).toBe(false);
    expect(layer(open, 3).children).toHaveLength(0);
  });

  it("answers only on the floors asked for, and never without the option (the editor)", () => {
    const chunks = new Map([["7/0/0", house(4, 4, 9, 8)]]);
    const editor = make(chunks, undefined);
    expect(editor.indoorAt(5, 5)).toBe(false);
    expect(layer(editor, 3).children).toHaveLength(0);
    // Underground (the client names the floors under the sky): nothing is "indoors".
    const cave = make(chunks, (z) => z < 7);
    expect(cave.indoorAt(5, 5)).toBe(false);
    expect(make(chunks, (z) => z <= 7).indoorAt(5, 5)).toBe(true);
  });

  it("closes a house that lies across two chunks, and redraws when its last wall is seen", () => {
    // Walls from x 28 of chunk 0 to x 3 of chunk 1 (global 28..35), open between them.
    const whole = house(28, 4, 31, 8);
    const west: ChunkData = {
      ground: whole.ground,
      items: whole.items.filter((i) => i.x !== 31 || i.y === 4 || i.y === 8),
    };
    const walls: Stack[] = [];
    for (let x = 0; x <= 3; x++)
      for (let y = 4; y <= 8; y++)
        if (x === 3 || y === 4 || y === 8) walls.push({ x, y, stack: ["wall"] });
    const east: ChunkData = { ground: open(), items: walls };
    const chunks = new Map<string, ChunkData>([["7/0/0", west]]);
    const v = make(chunks, () => true);
    // The east half is not known yet: the room counts as outdoors.
    expect(v.indoorAt(30, 6)).toBe(false);
    chunks.set("7/1/0", east);
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 2048, height: 1024 });
    expect(v.indoorAt(30, 6)).toBe(true);
    expect(v.indoorAt(33, 6)).toBe(true);
    expect(v.indoorAt(36, 6)).toBe(false);
  });

  it("takes the map's own roofs: a room half seen is indoors before its last wall is (owner, 2026-11-26)", () => {
    // The same house across two chunks, with only its west half known: the guess says
    // outdoors, the roofs the map ships say indoors, and nothing waits for the east half.
    const whole = house(28, 4, 31, 8);
    const west: ChunkData = {
      ground: whole.ground,
      items: whole.items.filter((i) => i.x !== 31 || i.y === 4 || i.y === 8),
    };
    const chunks = new Map<string, ChunkData>([["7/0/0", west]]);
    const roofed = (x: number, y: number): boolean => x >= 29 && x <= 34 && y >= 5 && y <= 7;
    const v = new MapView({
      source: { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) },
      texture: () => Texture.WHITE,
      art: (id) => (id === "wall" ? wallArt : undefined),
      tileSize: T,
      floor: 7,
      indoors: () => true,
      roofs: (z) => (z === 7 ? roofed : undefined),
    });
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 2048, height: 1024 });
    expect(v.indoorAt(30, 6)).toBe(true);
    expect(v.indoorAt(27, 6)).toBe(false);
    // Its floor is drawn over the sun's shadows (the indoor layer), like a whole room's.
    expect(layer(v, 3).children.length).toBeGreaterThan(0);
    // A floor the map has no roofs for falls back to the guess.
    v.setFloor(6);
    expect(v.indoorAt(30, 6)).toBe(false);
  });

  it("hides the baked shadow art at strength 0: the client casts every shadow itself", () => {
    const v = make(new Map([["7/0/0", house(4, 4, 9, 8)]]), () => true);
    expect(layer(v, 2).visible).toBe(true);
    v.castShadowStrength = 0;
    expect(layer(v, 2).visible).toBe(false);
    v.castShadowStrength = 1;
    expect(layer(v, 2).visible).toBe(true);
    expect(layer(v, 2).alpha).toBe(CAST_SHADOW_ALPHA);
  });
});

// The floor of a room never shows past its wall (tile-art.ts groundSplit).
describe("MapView ground under a wall", () => {
  const grass = Texture.WHITE;
  const boards = new Texture({ source: Texture.WHITE.source });
  const wallArt: TileArt<Texture> = {
    base: Texture.WHITE,
    ms: 250,
    sync: "world",
    joinsWalls: true,
    light: 0,
    anchorX: 1,
    wall: Array.from({ length: 16 }, () => Texture.WHITE),
  };

  it("draws the outer half of a wall's tile with the ground outside", () => {
    // Boards from x = 4 on, the wall on their first column: grass lies to its west.
    const ground = new Array<string | null>(32 * 32).fill("grass");
    const items: { x: number; y: number; stack: string[] }[] = [];
    for (let y = 0; y < 32; y++) {
      for (let x = 4; x < 32; x++) ground[y * 32 + x] = "boards";
      items.push({ x: 4, y, stack: ["wall"] });
    }
    const chunks = new Map<string, ChunkData>([["7/0/0", { ground, items }]]);
    const v = new MapView({
      source: { chunk: (z, cx, cy) => chunks.get(`${z}/${cx}/${cy}`) },
      texture: (id) => (id === "boards" ? boards : grass),
      art: (id) => (id === "wall" ? wallArt : undefined),
      tileSize: T,
      floor: 7,
    });
    v.render({ x: 0, y: 0, zoom: 1 }, { width: 2048, height: 1024 });
    const sprites = (layer(v, 0).children[0] as Container).children as Sprite[];
    // One half per wall tile, and nothing else: 32 x 32 grounds and 32 halves.
    expect(sprites).toHaveLength(32 * 32 + 32);
    const on = sprites.filter((s) => s.x === 4 * T && s.y === 6 * T);
    expect(on).toHaveLength(2);
    const [whole, half] = on as [Sprite, Sprite];
    expect(whole.texture).toBe(boards);
    expect([whole.width, whole.height]).toEqual([T, T]);
    // The west half, over the boards, cut from the grass.
    expect([half.width, half.height]).toEqual([T / 2, T]);
    expect(half.texture.source).toBe(grass.source);
    expect(half.texture.frame.width).toBe(grass.frame.width / 2);
    expect(half.texture.frame.height).toBe(grass.frame.height);
    expect(half.tint).toBe(whole.tint);
    expect(sprites.indexOf(half)).toBeGreaterThan(sprites.indexOf(whole));
    // The same half texture serves every wall tile.
    const other = sprites.filter((s) => s.x === 4 * T && s.y === 7 * T)[1] as Sprite;
    expect(other.texture).toBe(half.texture);
    v.destroy();
  });
});
