import { createImage, decodePng, fillRect, GLYPH_H, textWidth } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "@rpg/map-format";
import type { ContentIndex, ItemInfo, World } from "@rpg/map-format";
import { pickVariant, tileHash } from "@rpg/renderer/tile-art";
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
    expect(at(img, 5, 5)).toEqual([0, 80, 0]);
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
      const v = pickVariant(tileHash(x, y, 7), 2, 0.7);
      expect(at(img, x, y)).toEqual(v === 0 ? [0, 80, 0] : [0, 120, 0]);
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
    expect(at(img, 5, 2)).toEqual([0, 80, 0]); // a door of another floor
    // Without the item in data/items, nothing is drawn (and nothing is missing).
    const bare = decodePng(
      renderArea(
        w,
        content([item("grass", "ground/grass"), item("coin", "items/coin")]),
        frames,
        opts,
      ).png,
    );
    expect(at(bare, 3, 2)).toEqual([0, 80, 0]);
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
