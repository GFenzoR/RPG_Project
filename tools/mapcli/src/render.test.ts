import { createImage, decodePng, fillRect, GLYPH_H, textWidth } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "@rpg/map-format";
import type { ContentIndex, ItemInfo, World } from "@rpg/map-format";
import { groundDecal, groundLook, groundTone, pickVariant, tileHash } from "@rpg/renderer/tile-art";
import type { TileArt } from "@rpg/renderer/tile-art";
import { describe, expect, it } from "vitest";
import { renderArea } from "./render.ts";
import type { SpriteFrames } from "./render.ts";

/** One page holding every test sprite side by side, each a solid colour. */
function framesOf(sprites: [name: string, w: number, h: number, rgb: Rgba][]): SpriteFrames {
  const width = sprites.reduce((s, [, w]) => s + w, 0);
  const page = createImage(width, 64);
  const frames: SpriteFrames = new Map();
  let x = 0;
  for (const [name, w, h, c] of sprites) {
    fillRect(page, x, 0, w, h, c);
    frames.set(name, { page, x, y: 0, w, h });
    x += w;
  }
  return frames;
}

const item = (id: string, sprite: string): ItemInfo =>
  ({ id, kind: "decoration", blocksMovement: false, sprite }) as ItemInfo;

function world(ground: string, items: { x: number; y: number; stack: string[] }[]): World {
  const chunk = emptyChunk(0, 0, 7);
  chunk.ground.fill(ground);
  chunk.items.push(...items);
  return {
    meta: {},
    islands: new Map([
      [
        "isle",
        {
          meta: { id: "isle", rect: { x: 0, y: 0, w: CHUNK_SIZE, h: CHUNK_SIZE } },
          chunks: new Map([[chunkKey(7, 0, 0), chunk]]),
          spawns: [],
          npcs: [],
          zones: [],
          portals: [],
          texts: [],
          houses: [],
        },
      ],
    ]),
  } as unknown as World;
}

const content = (items: ItemInfo[]): ContentIndex =>
  ({ items: new Map(items.map((i) => [i.id, i])) }) as unknown as ContentIndex;

/** Pixel colour at the centre of tile (x, y) of a 32 px render starting at (0, 0). */
function at(img: Image, x: number, y: number, dx = 16, dy = 16): number[] {
  const left = textWidth("00000", 1) + 6;
  const top = GLYPH_H + 6;
  const i = ((top + y * 32 + dy) * img.width + left + x * 32 + dx) * 4;
  return Array.from(img.data.subarray(i, i + 3));
}

/** A colour as drawn on ground tile (x, y) of floor 7: tinted by its tone (groundTone). */
function toned(rgb: readonly number[], x: number, y: number): number[] {
  const t = groundTone(x, y, 7);
  const k = [(t >> 16) & 255, (t >> 8) & 255, t & 255];
  return rgb.map((c, i) => (c * ((k[i] ?? 255) / 255)) | 0);
}

describe("renderArea tile art (the game's, docs/17)", () => {
  const opts = {
    floor: 7,
    area: { x: 0, y: 0, w: 8, h: 8 },
    tile: 32,
    overlays: false,
    grid: false,
  };

  it("draws each wall with the piece for its neighbours, its top over the tile behind", () => {
    const sprites: [string, number, number, Rgba][] = [
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["walls/stone", 32, 64, [1, 1, 1, 255]],
    ];
    // Piece m is a solid 32x64 of colour (m * 10, 100, 200).
    for (let m = 0; m < 16; m++)
      sprites.push([`walls/stone/wall_${m}`, 32, 64, [m * 10, 100, 200, 255]]);
    const frames = framesOf(sprites);
    frames.tiles = { "walls/stone": { wall: true } };
    const w = world("grass", [
      { x: 2, y: 3, stack: ["wall"] },
      { x: 3, y: 3, stack: ["wall"] },
      { x: 3, y: 4, stack: ["wall"] },
    ]);
    const c = content([item("grass", "ground/grass"), item("wall", "walls/stone")]);
    const img = decodePng(renderArea(w, c, frames, opts).png);
    expect(at(img, 2, 3)).toEqual([20, 100, 200]); // E
    // A piece is 32x64: its upper half covers the tile behind the wall, (3, 4) hides (3, 3).
    expect(at(img, 3, 2)).toEqual([120, 100, 200]); // S, W
    expect(at(img, 3, 3)).toEqual([10, 100, 200]);
    expect(at(img, 3, 4)).toEqual([10, 100, 200]); // N
    expect(at(img, 2, 2)).toEqual([20, 100, 200]);
    expect(at(img, 5, 5)).toEqual(toned([0, 80, 0], 5, 5));
  });

  it("shows a border piece's look by tile, evenly, as the game does (docs/17 ART-4)", () => {
    const sprites: [string, number, number, Rgba][] = [
      ["ground/sand", 32, 32, [90, 80, 60, 255]],
      ["borders/grass/n", 32, 32, [0, 100, 0, 255]],
    ];
    for (const k of [1, 2, 3])
      sprites.push([`borders/grass/n/var_${k}`, 32, 32, [0, 100, k * 50, 255]]);
    const frames = framesOf(sprites);
    frames.tiles = { "borders/grass/n": { variants: 3 } };
    const all: { x: number; y: number; stack: string[] }[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) all.push({ x, y, stack: ["edge"] });
    const c = content([item("sand", "ground/sand"), item("edge", "borders/grass/n")]);
    const img = decodePng(renderArea(world("sand", all), c, frames, opts).png);
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const k = pickVariant(tileHash(x, y, 7), 4, 0.25);
        seen.add(k);
        expect(at(img, x, y)).toEqual([0, 100, k * 50]);
      }
    expect(seen.size).toBe(4);
  });

  it("shows a ground's look by tile, centres bc sprites and darkens under cast shadows", () => {
    const frames = framesOf([
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["ground/grass/var_1", 32, 32, [0, 120, 0, 255]],
      ["decor/tree", 32, 64, [90, 60, 30, 255]],
      ["decor/bush", 64, 32, [70, 90, 30, 255]],
      ["decor/tree/shadow", 64, 32, [0, 0, 0, 255]],
    ]);
    frames.tiles = {
      "ground/grass": { variants: 1 },
      "decor/tree": { anchor: "bc", shadow: true },
      "decor/bush": { anchor: "bc" },
    };
    const w = world("grass", [
      { x: 4, y: 6, stack: ["tree"] },
      { x: 4, y: 2, stack: ["bush"] },
    ]);
    const c = content([
      item("grass", "ground/grass"),
      item("tree", "decor/tree"),
      item("bush", "decor/bush"),
    ]);
    const img = decodePng(renderArea(w, c, frames, opts).png);
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [7, 1],
      [6, 7],
    ] as const) {
      const v = groundLook({ variants: [0, 1] } as unknown as TileArt<unknown>, x, y, 7);
      expect(at(img, x, y)).toEqual(toned(v === 0 ? [0, 80, 0] : [0, 120, 0], x, y));
    }
    // The 64 px bush is centred on tile 4: it covers half of tiles 3 and 5.
    expect(at(img, 3, 2, 20, 16)).toEqual([70, 90, 30]);
    expect(at(img, 3, 2, 12, 16)).not.toEqual([70, 90, 30]);
    expect(at(img, 5, 2, 12, 16)).toEqual([70, 90, 30]);
    expect(at(img, 5, 2, 20, 16)).not.toEqual([70, 90, 30]);
    // The tree's 64 px shadow, centred too, darkens the ground half a tile either side.
    const bare = decodePng(renderArea(world("grass", []), c, frames, opts).png);
    expect(at(img, 4, 6)).toEqual([90, 60, 30]);
    expect(at(img, 5, 6, 8, 16)[1]).toBeLessThan((at(bare, 5, 6, 8, 16)[1] ?? 0) * 0.8);
    expect(at(img, 5, 6, 24, 16)).toEqual(at(bare, 5, 6, 24, 16));
  });

  it("lays a ground's decals where groundDecal says, only inside a field, toned", () => {
    const frames = framesOf([
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["ground/grass/decal_1", 32, 32, [200, 0, 0, 255]],
      ["ground/grass/decal_2", 32, 32, [0, 0, 200, 255]],
    ]);
    frames.tiles = { "ground/grass": { decals: 2 } };
    const c = content([item("grass", "ground/grass")]);
    const area = { x: 0, y: 0, w: 16, h: 16 };
    const img = decodePng(renderArea(world("grass", []), c, frames, { ...opts, area }).png);
    let decals = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        // Tiles on the island's edge (x or y = 0) border nothing: no decal there.
        const d = x > 0 && y > 0 ? groundDecal(x, y, 7, 2) : -1;
        if (d >= 0) decals++;
        const rgb = d === 0 ? [200, 0, 0] : d === 1 ? [0, 0, 200] : [0, 80, 0];
        expect(at(img, x, y), `${x},${y}`).toEqual(toned(rgb, x, y));
      }
    expect(decals).toBeGreaterThan(0);
  });

  it("draws a flat border piece with the grounds, under shadows and the sprites beside it", () => {
    const frames = framesOf([
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["borders/sand/w", 32, 32, [200, 180, 120, 255]],
      ["decor/bush", 64, 32, [70, 90, 30, 255]],
      ["decor/tree", 32, 64, [90, 60, 30, 255]],
      ["decor/tree/shadow", 64, 32, [0, 0, 0, 255]],
    ]);
    frames.tiles = {
      "borders/sand/w": { flat: true },
      "decor/tree": { anchor: "bc", shadow: true },
      "decor/bush": { anchor: "bc" },
    };
    // A 64 px bush on (4, 2) reaches over (5, 2); a tree on (4, 6) casts its shadow on (5, 6).
    const w = world("grass", [
      { x: 4, y: 2, stack: ["bush"] },
      { x: 5, y: 2, stack: ["edge"] },
      { x: 4, y: 6, stack: ["tree"] },
      { x: 5, y: 6, stack: ["edge"] },
    ]);
    const c = content([
      item("grass", "ground/grass"),
      item("edge", "borders/sand/w"),
      item("bush", "decor/bush"),
      item("tree", "decor/tree"),
    ]);
    const img = decodePng(renderArea(w, c, frames, opts).png);
    // The piece takes the tone of its tile, like the ground it comes from.
    expect(at(img, 5, 2, 20, 16)).toEqual(toned([200, 180, 120], 5, 2));
    expect(at(img, 5, 2, 12, 16)).toEqual([70, 90, 30]); // the bush over the piece
    expect(at(img, 5, 6, 24, 16)).toEqual(toned([200, 180, 120], 5, 6));
    expect(at(img, 5, 6, 8, 16)[0]).toBeLessThan(200 * 0.8); // the shadow over the piece
  });

  it("draws the frame of a house door on its tile, under what lies there (docs/17 A11)", () => {
    const frames = framesOf([
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["doors/house_door_frame", 32, 32, [140, 90, 50, 255]],
      ["items/coin", 32, 4, [250, 220, 0, 255]],
    ]);
    const w = world("grass", [{ x: 3, y: 2, stack: ["coin"] }]);
    const isle = w.islands.get("isle") as unknown as { houses: unknown[] };
    isle.houses.push({
      id: "h",
      doors: [
        { x: 3, y: 2, z: 7 },
        { x: 5, y: 2, z: 6 },
      ],
    });
    const c = content([
      item("grass", "ground/grass"),
      item("house_door_frame", "doors/house_door_frame"),
      item("coin", "items/coin"),
    ]);
    const img = decodePng(renderArea(w, c, frames, opts).png);
    expect(at(img, 3, 2)).toEqual([140, 90, 50]);
    expect(at(img, 3, 2, 16, 30)).toEqual([250, 220, 0]); // the coin, over the frame
    expect(at(img, 5, 2)).toEqual(toned([0, 80, 0], 5, 2)); // a door of another floor
    // Without the item in data/items, nothing is drawn (and nothing is missing).
    const bare = decodePng(
      renderArea(
        w,
        content([item("grass", "ground/grass"), item("coin", "items/coin")]),
        frames,
        opts,
      ).png,
    );
    expect(at(bare, 3, 2)).toEqual(toned([0, 80, 0], 3, 2));
  });

  it("draws what is stacked on a crate higher by its elevation (ART-8)", () => {
    const frames = framesOf([
      ["ground/grass", 32, 32, [0, 80, 0, 255]],
      ["decor/crate", 32, 32, [120, 80, 40, 255]],
      ["items/coin", 32, 4, [250, 220, 0, 255]],
    ]);
    // The coin sprite is a 4 px strip: drawn bottom-right, it sits on the tile's last rows.
    const w = world("grass", [
      { x: 2, y: 2, stack: ["crate", "coin"] },
      { x: 4, y: 2, stack: ["coin"] },
    ]);
    const crate = { ...item("crate", "decor/crate"), elevation: 8 };
    const c = content([item("grass", "ground/grass"), crate, item("coin", "items/coin")]);
    const img = decodePng(renderArea(w, c, frames, opts).png);
    expect(at(img, 4, 2, 16, 30)).toEqual([250, 220, 0]); // on the ground: the bottom rows
    expect(at(img, 2, 2, 16, 30)).toEqual([120, 80, 40]); // on the crate: 8 px up
    expect(at(img, 2, 2, 16, 22)).toEqual([250, 220, 0]);
  });
});
