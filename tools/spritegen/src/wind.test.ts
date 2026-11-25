// The plants' wind metadata (wind.ts, livingworld/README.md "Viento"): every plant recipe
// declares it, the drawings deform well, and data/livingworld/wind_sprites.yaml is what the
// recipes say.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImage, encodePng, fillRect, WIND_HINT_KINDS } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkWind,
  plantWind,
  plantWinds,
  RECIPES,
  render,
  spriteFile,
  swayPng,
  WIND_KINDS,
  WIND_SPRITES_FILE,
  windSpritesYaml,
} from "./index.ts";
import { LIVING } from "./recipes/living.ts";
import { TREES } from "./recipes/trees.ts";
import { drawnRows, spriteWind, swaySheet, windSprites } from "./wind.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GREEN = [40, 120, 40, 255] as const;
const BROWN = [90, 60, 30, 255] as const;

/** A 32x48 tree: a 4 px trunk 12 px tall under a 20 px wide crown. */
function toyTree(): Image {
  const img = createImage(32, 48);
  fillRect(img, 14, 36, 4, 12, BROWN);
  fillRect(img, 6, 10, 20, 26, GREEN);
  return img;
}

describe("the wind metadata of the plant recipes", () => {
  it("is declared by every tree, bush and small plant recipe", () => {
    for (const [path, recipe] of Object.entries(TREES))
      if (!path.endsWith("/shadow")) expect(recipe.wind, path).toBeDefined();
    for (const [path, recipe] of Object.entries(LIVING))
      if (path.startsWith("livingworld/plants/")) expect(recipe.wind, path).toBeDefined();
    // No baked sway frames any more: the client moves the canopy.
    expect(Object.keys(RECIPES).filter((p) => /decor\/[a-z_]*(tree|bush)\/frame_/.test(p))).toEqual(
      [],
    );
  });

  it("gives sensible defaults by plant type: a type is enough for what bends from the ground", () => {
    expect(plantWind("reed")).toEqual({ kind: "reed" });
    expect(plantWind("tree", { pivot: 28 })).toEqual({ kind: "tree", pivot: 28 });
    // One list of types everywhere: the client's, the recipes' and the manifest hints'.
    expect([...WIND_HINT_KINDS]).toEqual([...WIND_KINDS]);
    // Grass drawn on the lowest rows: the pivot is its type's share of the drawing.
    const grass = createImage(32, 32);
    fillRect(grass, 10, 12, 12, 20, GREEN);
    const got = spriteWind(grass, plantWind("tall_grass"), 0.05);
    expect(got.problems).toEqual([]);
    expect(got.wind).toEqual({ kind: "tall_grass", pivot: 1, top: 20 });
  });

  it("measures the drawing: its top, its foot and the pivot it was given", () => {
    const tree = toyTree();
    expect(drawnRows(tree)).toEqual({ base: 0, top: 38 });
    expect(drawnRows(createImage(8, 8))).toBeUndefined();
    const got = spriteWind(tree, plantWind("tree", { pivot: 12, amplitude: 1.5 }), 0.3);
    expect(got.problems).toEqual([]);
    expect(got.wind).toEqual({ kind: "tree", pivot: 12, top: 38, amplitude: 1.5 });
  });

  it("refuses a drawing the wind would deform badly (the art guidelines)", () => {
    const problems = (img: Image, meta = plantWind("tree", { pivot: 12 })): string =>
      spriteWind(img, meta, 0.3).problems.join("\n");
    // No clear split: the "trunk" is as wide as the crown.
    const block = createImage(32, 48);
    fillRect(block, 6, 10, 20, 38, GREEN);
    expect(problems(block)).toContain("no clear trunk and canopy split");
    // A loose pixel floating beside the crown.
    const loose = toyTree();
    fillRect(loose, 29, 4, 1, 1, GREEN);
    expect(problems(loose)).toContain("a loose pixel at (29, 4)");
    // The crown against the side of the canvas.
    const wide = toyTree();
    fillRect(wide, 0, 20, 8, 4, GREEN);
    expect(problems(wide)).toContain("touches the side of the canvas");
    // A pivot over the drawing, a tree with no pivot, a tree with no trunk under it.
    expect(problems(toyTree(), plantWind("tree", { pivot: 40 }))).toContain("nothing moves");
    expect(problems(toyTree(), { kind: "tree" })).toContain("must say its pivot");
    expect(problems(toyTree(), plantWind("tree", { pivot: 0 }))).toContain("no trunk under it");
    expect(problems(createImage(32, 32), plantWind("bush"))).toContain("nothing is drawn");
  });

  it("passes on every plant of the game, and the committed file is what the recipes say", () => {
    const { sprites, problems } = plantWinds(root);
    expect(problems).toEqual([]);
    expect(checkWind(root), "run make spritegen").toEqual([]);
    expect(readFileSync(join(root, WIND_SPRITES_FILE), "utf8").replace(/\r\n/g, "\n")).toBe(
      windSpritesYaml(sprites),
    );
    // Trees know where their trunk ends; the bush moves from near the ground.
    expect(sprites["decor/oak_tree"]).toMatchObject({ kind: "tree", pivot: 28 });
    expect(sprites["decor/bush"]?.kind).toBe("bush");
    expect(sprites["livingworld/plants/reeds"]?.kind).toBe("reed");
    for (const [path, w] of Object.entries(sprites)) {
      expect(w.pivot, path).toBeLessThan(w.top ?? 0);
      expect(w.top, path).toBeLessThanOrEqual(render(path).height);
    }
  });
});

describe("plant sprites no recipe draws (packs, Gemini)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const setup = (tiles: string, png?: Image): string => {
    dir = mkdtempSync(join(tmpdir(), "wind-"));
    const put = (rel: string, body: string | Buffer): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    put("data/livingworld/wind.yaml", readFileSync(join(root, "data/livingworld/wind.yaml")));
    put("assets/sprites.yaml", `sprites: {}\ntiles:\n${tiles}`);
    if (png) put("assets/sprites/plants/jungle_palm.png", encodePng(png));
    return dir;
  };
  const run = (at: string): ReturnType<typeof windSprites> =>
    windSprites(at, {}, () => createImage(1, 1), spriteFile);

  it("take their wind from a hint in assets/sprites.yaml, measured and checked like ours", () => {
    const at = setup(
      "  plants/jungle_palm: { anchor: bc, wind: { kind: palm, pivot: 12 } }\n",
      toyTree(),
    );
    const { sprites, problems } = run(at);
    expect(problems).toEqual([]);
    expect(sprites).toEqual({ "plants/jungle_palm": { kind: "palm", pivot: 12, top: 38 } });
    expect(windSpritesYaml(sprites)).toContain(
      "  plants/jungle_palm: { kind: palm, pivot: 12, top: 38 }\n",
    );
  });

  it("report a drawing that would deform badly, and keep a pack sprite's hint as it is", () => {
    const bad = toyTree();
    fillRect(bad, 30, 2, 1, 1, GREEN);
    expect(
      run(
        setup("  plants/jungle_palm: { wind: { kind: palm, pivot: 12 } }\n", bad),
      ).problems.join(),
    ).toContain("plants/jungle_palm: a loose pixel");
    rmSync(dir, { recursive: true, force: true });
    // No file of its own (cut from a pack's sheet): the hint alone.
    const { sprites, problems } = run(
      setup("  plants/jungle_palm: { wind: { kind: palm, pivot: 12, amplitude: 2 } }\n"),
    );
    expect(problems).toEqual([]);
    expect(sprites["plants/jungle_palm"]).toMatchObject({ kind: "palm", pivot: 12, amplitude: 2 });
  });
});

describe("the sway preview", () => {
  it("draws a plant swaying with the client's maths: the trunk still, the canopy moving", () => {
    const tree = toyTree();
    const frames = 6;
    const sheet = swaySheet(
      root,
      [{ path: "plants/toy", image: tree, wind: { kind: "tree", pivot: 12, top: 38 } }],
      frames,
    );
    const cellW = sheet.width / (frames + 1);
    expect(Number.isInteger(cellW)).toBe(true);
    /** The x of the first pixel of `colour` on row y of cell f, from the cell's left. */
    const firstX = (f: number, y: number, colour: readonly number[]): number => {
      for (let x = 0; x < cellW; x++) {
        const at = (y * sheet.width + f * cellW + x) * 4;
        if (sheet.data[at] === colour[0] && sheet.data[at + 1] === colour[1]) return x;
      }
      return -1;
    };
    // Rows of the sheet: drawn at 2x from y = 4. The crown's top row and a trunk row.
    const crownY = 4 + 10 * 2;
    const trunkY = 4 + 44 * 2;
    const still = firstX(0, crownY, GREEN);
    expect(still).toBeGreaterThan(0);
    let moved = 0;
    for (let f = 1; f <= frames; f++) {
      expect(firstX(f, trunkY, BROWN)).toBe(firstX(0, trunkY, BROWN));
      const dx = firstX(f, crownY, GREEN) - still;
      // A tree's top: a couple of sprite px at most, here at 2 screen px each.
      expect(Math.abs(dx)).toBeLessThanOrEqual(6);
      if (dx !== 0) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it("renders the game's plants to a PNG (make sway-preview)", () => {
    const png = swayPng(root, "decor/bush", 1);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(() => swayPng(root, "no/such/", 1)).toThrow(/no plant sprite/);
  });
});
