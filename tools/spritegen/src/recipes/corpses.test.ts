// Every monster's own corpse (recipes/corpses.ts, docs/17 "Cadáveres").
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tippedRest, createImage } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { checkPaths, RECIPES, recipesAt, render, spriteFile } from "../index.ts";
import {
  BODY_SEXES,
  bodyPath,
  CORPSE_LIGHT,
  corpseOf,
  corpsePath,
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

/** A root with data/monsters/<id>.yaml for each of `monsters` (id -> the rest of its YAML). */
function rootWith(monsters: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "spritegen-corpses-"));
  mkdirSync(join(dir, "data", "monsters"), { recursive: true });
  mkdirSync(join(dir, "data", "npcs"));
  // The anchors (hints, no art): assets/ holds nothing else, so no PNG to read.
  mkdirSync(join(dir, "assets"));
  copyFileSync(join(root, "assets", "sprites.yaml"), join(dir, "assets", "sprites.yaml"));
  // The look previews read these two (previews.ts): the repo's parts, and no outfit.
  copyFileSync(join(root, "data", "looks.yaml"), join(dir, "data", "looks.yaml"));
  writeFileSync(join(dir, "data", "outfits.yaml"), "[]\n");
  for (const [id, rest] of Object.entries(monsters))
    writeFileSync(join(dir, "data", "monsters", `${id}.yaml`), `id: ${id}\n${rest}`);
  return dir;
}

describe("a player's body", () => {
  it("is a human lying down, one per sex, committed, with its feet where a person's stand", () => {
    expect(BODY_SEXES).toEqual(["male", "female"]);
    const imgs = BODY_SEXES.map((sex) => {
      expect(RECIPES[bodyPath(sex)], sex).toBeDefined();
      expect(existsSync(spriteFile(root, bodyPath(sex))), `${sex}: run make spritegen`).toBe(true);
      const img = render(bodyPath(sex));
      expect([img.width, img.height]).toEqual([64, 64]);
      expect(lowest(img)).toBe(img.height - 1 - FEET_LINE);
      return img;
    });
    // Two bodies, not one: the woman's has her own shape and hair.
    expect(Buffer.from(imgs[0]?.data ?? []).equals(Buffer.from(imgs[1]?.data ?? []))).toBe(false);
  });

  it("is a corpse the checker accepts (no monster of its own)", () => {
    expect(checkPaths(root).filter((p) => p.startsWith("corpses/body_"))).toEqual([]);
  });
});

describe("monster corpses", () => {
  const book = Object.fromEntries(
    Object.entries(RECIPES).filter(([path]) => path.startsWith("corpses/")),
  );

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

  it("come from the creature's recipe, not from the PNG an earlier build left", () => {
    // A root with the monsters and no assets/ at all: what `make spritegen` meets when the
    // creature's frames are new or changed in the same run. The corpse is that of the
    // frames the code draws now, in one pass.
    const dir = rootWith({
      fresh_boar: "sprite: creatures/bristleback_boar\n", // an engine clip
      fresh_gull: "sprite: creatures/thieving_gull\n", // a single coded image
    });
    try {
      const fresh = recipesAt(dir);
      for (const [id, same] of [
        ["fresh_boar", "bristleback_boar"],
        ["fresh_gull", "thieving_gull"],
      ] as const) {
        const recipe = fresh[corpsePath(id)];
        expect(recipe, id).toBeDefined();
        if (!recipe) continue;
        const twin = render(corpsePath(same));
        const img = render(corpsePath(id), recipe);
        expect([img.width, img.height], id).toEqual([twin.width, twin.height]);
        expect(Buffer.from(img.data).equals(Buffer.from(twin.data)), id).toBe(true);
      }
      // The boar's is its death clip's last frame as the recipe draws it.
      const frames = Object.keys(RECIPES).filter((p) =>
        p.startsWith("creatures/bristleback_boar/death_s_"),
      );
      const last = `creatures/bristleback_boar/death_s_${frames.length - 1}`;
      const want = corpseOf(render(last), "bc");
      const got = render(corpsePath("bristleback_boar"));
      expect(Buffer.from(got.data).equals(Buffer.from(want.data))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a monster with no art to make its corpse from is a problem of `check`", () => {
    const dir = rootWith({
      fine: "sprite: creatures/bristleback_boar\n",
      artless: "sprite: creatures/no_such_art\n",
      bare: "name: monster.bare.name\n",
    });
    try {
      const problems = checkPaths(dir).filter((p) => p.includes("has no corpse"));
      expect(problems.map((p) => p.split(":")[0]).sort()).toEqual([
        "corpses/artless",
        "corpses/bare",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(checkPaths(root).filter((p) => p.includes("has no corpse"))).toEqual([]);
  });

  it("refuse to tip over an image that is not square", () => {
    expect(() => tipOver(createImage(32, 64))).toThrow(/square/);
    expect(() => tipOver(createImage(64, 32))).toThrow(/square/);
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

  it("rest where the atlas says a tipped image does (the client's fall ends there)", () => {
    // atlas.json `rest` (tools/spritepack tippedRest) is measured without drawing the
    // tipped image: it must be the rows this recipe really leaves under it.
    for (const img of [
      block(32, 32, 14, 17, 4, 31),
      block(32, 32, 3, 21, 9, 30),
      block(32, 32, 0, 31, 0, 31),
      block(64, 64, 20, 50, 10, 63),
      block(48, 48, 5, 6, 40, 41),
    ]) {
      const fallen = tipOver(img);
      let low = -1;
      for (let y = 0; y < fallen.height; y++)
        for (let x = 0; x < fallen.width; x++)
          if ((fallen.data[(y * fallen.width + x) * 4 + 3] ?? 0) > 0) low = y;
      expect(tippedRest(img)).toBe(fallen.height - 1 - low);
    }
  });
});
