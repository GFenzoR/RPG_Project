// Every monster's own corpse (recipes/corpses.ts, docs/17 "Cadáveres").
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImage } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { render, spriteFile } from "../index.ts";
import {
  CORPSE_LIGHT,
  corpseOf,
  corpsePath,
  corpseRecipes,
  FEET_LINE,
  monsterIds,
  tipOver,
} from "./corpses.ts";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

const lowest = (img: Image): number => {
  for (let y = img.height - 1; y >= 0; y--)
    for (let x = 0; x < img.width; x++)
      if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) > 0) return y;
  return -1;
};
const opaque = (img: Image): number => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] ?? 0) > 0) n++;
  return n;
};

/** A w x h image with one opaque grey block (x0..x1, y0..y1). */
function block(w: number, h: number, x0: number, x1: number, y0: number, y1: number): Image {
  const img = createImage(w, h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) img.data.set([200, 100, 50, 255], (y * w + x) * 4);
  return img;
}

describe("monster corpses", () => {
  const book = corpseRecipes(root);

  it("every monster of data/monsters has its own, committed", () => {
    const ids = monsterIds(root);
    expect(ids.length).toBeGreaterThanOrEqual(21);
    for (const id of ids) {
      expect(book[corpsePath(id)], id).toBeDefined();
      expect(existsSync(spriteFile(root, corpsePath(id))), `${id}: run make spritegen`).toBe(true);
    }
  });

  it("are all different: no two monsters share a body", () => {
    const seen = new Map<string, string>();
    for (const path of Object.keys(book)) {
      const key = Buffer.from(render(path, book[path]).data).toString("base64");
      expect(seen.get(key), `${path} looks like ${seen.get(key) ?? ""}`).toBeUndefined();
      seen.set(key, path);
    }
  });

  it("keep the creature's footprint and lie where its feet stood", () => {
    for (const [path, recipe] of Object.entries(book)) {
      const img = render(path, recipe);
      expect(img.width % 32, path).toBe(0);
      expect(img.height % 32, path).toBe(0);
      expect(lowest(img), path).toBe(img.height - 1 - FEET_LINE);
      expect(opaque(img), path).toBeGreaterThan(20);
    }
    // The warden, a 96x96 boss, stays as big as it was.
    expect(book[corpsePath("slagbound_warden")]?.width).toBe(96);
  });

  it("are darker than the body they come from", () => {
    const img = corpseOf(block(32, 32, 4, 20, 10, 20), "bc");
    const i = (20 * 32 + 10) * 4; // the bottom row moved to 32 - 1 - FEET_LINE
    expect(img.data[i + 3]).toBe(255);
    expect(img.data[i] ?? 0).toBeLessThan(200);
    expect(img.data[i] ?? 0).toBeLessThanOrEqual((200 * CORPSE_LIGHT) >> 8);
  });

  it("widen a bottom-right sprite so its middle stays on its tile", () => {
    const img = corpseOf(block(64, 64, 40, 50, 30, 40), "br");
    expect(img.width).toBe(96);
    // Same pixels from the left edge: drawn centred, its right edge is the tile's again.
    expect(img.data[((64 - 1 - FEET_LINE) * 96 + 45) * 4 + 3]).toBe(255);
  });

  it("tip a single image over onto its side, flattened", () => {
    const tall = block(32, 32, 14, 17, 4, 31); // a post: 4 wide, 28 tall
    const fallen = tipOver(tall);
    let minX = 32;
    let maxX = -1;
    let minY = 32;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++)
        if ((fallen.data[(y * 32 + x) * 4 + 3] ?? 0) > 0) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
        }
    expect(maxX - minX + 1).toBe(28); // lying along x now
    expect(minY).toBeGreaterThanOrEqual(32 - 20); // in the bottom 3/5
  });
});
