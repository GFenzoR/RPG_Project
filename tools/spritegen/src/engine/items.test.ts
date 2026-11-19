// The item icons of the engine (docs/17 "Íconos de items"): the icon size class and its
// gates, the helpers that build them, the review images, and the rule that every equipable
// of data/items has its own icon drawn by the engine.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSpriteRefs, MANIFEST_FILE, parseManifest } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { RECIPES } from "../index.ts";
import { engineFrames } from "./book.ts";
import { box, gateProblems, pixelsChanged } from "./gates.ts";
import { renderSpec } from "./render.ts";
import { iconBoard, reviewLineup, slotCell } from "./sheet.ts";
import { specMaterials } from "./spec.ts";
import type { ShapeSpec, SpriteSpec } from "./spec.ts";
import { ENGINE_SPECS } from "./specs/index.ts";
import { ICON_ROWS, ITEM_ICONS } from "./specs/items/index.ts";
import { blade, centred, icon, mirrored, moved, resized } from "./specs/items/kit.ts";
import { OUTLINE, SIZES, VALUE_BAND } from "./style.ts";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
/** The value, or a thrown error naming what was missing. */
function must<T>(v: T | undefined, what = "value"): T {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}

/** A plain icon: one iron ball of radius r at (x, z), not centred. */
const ball = (r: number, x = 0, z = 0): SpriteSpec => ({
  sprite: "weapons/test_ball",
  size: "icon",
  parts: [
    {
      name: "ball",
      at: [x, 0, z],
      material: "iron",
      shapes: [{ type: "ellipsoid", radii: [r, r, r] }],
    },
  ],
});

/** The centre of an image's opaque box, against the canvas centre. */
function offCentre(spec: SpriteSpec): [number, number] {
  const img = renderSpec(spec);
  const b = must(box(img), "figure");
  return [(b[0] + b[2] + 1) / 2 - img.width / 2, (b[1] + b[3] + 1) / 2 - img.height / 2];
}

describe("the icon size class (docs/17 'Íconos de items')", () => {
  it("is one 32x32 item image, centred on its canvas, with a dark outline", () => {
    expect(SIZES.icon.kind).toBe("item");
    expect(SIZES.icon.canvases).toEqual([[32, 32]]);
    expect(SIZES.icon.centred).toBe(true);
    // The model origin is the canvas centre: no ground row.
    expect(SIZES.icon.ground).toBe(16);
    // On the near-black well of a slot and on grass: the creatures' dark outline.
    expect(OUTLINE.item.dark).toBe("outline");
    expect(OUTLINE.item.lit).toBe(OUTLINE.creature.lit);
    // An item is an object for ART-6.
    expect(VALUE_BAND.item).toEqual(VALUE_BAND.object);
  });

  it("is drawn as an item recipe (kind item, 32x32), one per icon", () => {
    for (const spec of ITEM_ICONS) {
      const r = must(RECIPES[spec.sprite], spec.sprite);
      expect(r.kind, spec.sprite).toBe("item");
      expect([r.width, r.height]).toEqual([32, 32]);
    }
  });
});

describe("the gates of an icon", () => {
  it("fail a figure off the canvas centre, and centred() fixes it by whole pixels", () => {
    const off = ball(8, 5, -4);
    expect(gateProblems(off).join()).toMatch(/off the canvas centre/);
    const fixed = centred(off);
    expect(gateProblems(fixed)).toEqual([]);
    const [dx, dy] = offCentre(fixed);
    expect(Math.abs(dx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(dy)).toBeLessThanOrEqual(0.5);
    // A whole-pixel move only translates the pixels.
    const a = renderSpec(off);
    const b = renderSpec(fixed);
    const ba = must(box(a));
    const bb = must(box(b));
    expect(bb[2] - bb[0]).toBe(ba[2] - ba[0]);
    expect(bb[3] - bb[1]).toBe(ba[3] - ba[1]);
  });

  it("fail a speck: under 16 px at its longest it does not read at 1x in a slot", () => {
    expect(gateProblems(centred(ball(4))).join()).toMatch(/a speck at 1x/);
    expect(gateProblems(centred(ball(9)))).toEqual([]);
  });

  it("fail what touches the canvas edge, like any sprite", () => {
    expect(gateProblems(centred(ball(16))).join()).toMatch(/touches the canvas edge/);
  });
});

describe("the item spec kit", () => {
  it("builds a blade as two plates: the -x half lit, the other shaded, a ridge between", () => {
    const [lit, shaded] = blade(
      [
        [0, 0],
        [0, 10],
        [0, 14],
      ],
      [2, 2, 0],
    );
    expect(must(lit).bias).toBeGreaterThan(0);
    expect(must(shaded).bias).toBeLessThan(0);
    const xs = (s: ShapeSpec | undefined): number[] =>
      s?.type === "extrusion" ? s.points.map(([x]) => x) : [];
    expect(Math.min(...xs(lit))).toBeLessThan(0);
    expect(Math.max(...xs(lit))).toBeCloseTo(0);
    expect(Math.max(...xs(shaded))).toBeGreaterThan(0);
  });

  it("mirrors a half outline about x = 0 without repeating the centre points", () => {
    const whole = mirrored([
      [0, 4],
      [3, 2],
      [0, 0],
    ]);
    expect(whole).toEqual([
      [0, 4],
      [3, 2],
      [0, 0],
      [-3, 2],
    ]);
  });

  it("moves every kind of shape, and resized() keeps an icon centred", () => {
    const d = [1, 2, 3] as const;
    expect(moved({ type: "box", min: [0, 0, 0], max: [1, 1, 1] }, d)).toMatchObject({
      min: [1, 2, 3],
    });
    expect(
      moved({ type: "extrusion", axis: "y", points: [[0, 0]], from: 0, to: 1 }, d),
    ).toMatchObject({ points: [[1, 3]], from: 2, to: 3 });
    const big = resized(icon("weapons/test_ball", ball(6).parts), 1.5);
    const [dx, dy] = offCentre(big);
    expect(Math.abs(dx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(dy)).toBeLessThanOrEqual(0.5);
    const w = (s: SpriteSpec): number => {
      const b = must(box(renderSpec(s)));
      return b[2] - b[0] + 1;
    };
    expect(w(big)).toBeGreaterThan(w(icon("weapons/test_ball", ball(6).parts)) + 3);
  });
});

describe("the item icons of the game", () => {
  const files = new Set([
    "data/items/weapons.yaml",
    "data/items/equipment.yaml",
    "data/items/ammo.yaml",
  ]);
  const equipables = collectSpriteRefs(root).filter((r) => files.has(r.file));
  const icons = new Map(ENGINE_SPECS.filter((s) => s.size === "icon").map((s) => [s.sprite, s]));

  it("give every weapon, shield, armour piece, jewel and ammunition its own engine icon", () => {
    expect(equipables.length).toBeGreaterThanOrEqual(86);
    const seen = new Map<string, string>();
    for (const r of equipables) {
      const other = seen.get(r.sprite);
      expect(other, `${r.id} and ${other} share ${r.sprite}`).toBeUndefined();
      seen.set(r.sprite, r.id ?? "");
      expect(icons.has(r.sprite), `${r.id}: ${r.sprite} is not an engine icon`).toBe(true);
    }
    // And every icon is the sprite of one of them.
    expect([...icons.keys()].sort()).toEqual([...seen.keys()].sort());
  });

  it("leave no Dungeon Crawl entry for them in assets/sprites.yaml", () => {
    const { manifest } = parseManifest(readFileSync(join(root, MANIFEST_FILE), "utf8"));
    for (const r of equipables) expect(manifest.sprites.has(r.sprite), r.sprite).toBe(false);
  });

  it("read as better band by band: each line changes its look and materials", () => {
    for (const row of ICON_ROWS) {
      if (row.label === "retired" || row.label === "ammunition") continue;
      const line = row.specs.filter((s): s is SpriteSpec => s !== undefined);
      expect(line.length, row.label).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < line.length; i++) {
        const a = must(line[i - 1]);
        const b = must(line[i]);
        const changed = pixelsChanged(
          must(engineFrames(a)[0]).image,
          must(engineFrames(b)[0]).image,
        );
        expect(changed, `${a.sprite} -> ${b.sprite}`).toBeGreaterThan(80);
        const ma = [...specMaterials(a)].sort().join();
        const mb = [...specMaterials(b)].sort().join();
        expect(mb, `${a.sprite} -> ${b.sprite} share every material`).not.toBe(ma);
      }
    }
  });

  it("put every catalog icon on the review board once", () => {
    const onBoard = ICON_ROWS.flatMap((r) => r.specs).filter((s) => s !== undefined);
    expect(onBoard.length).toBe(ITEM_ICONS.length);
    expect(new Set(onBoard.map((s) => s.sprite)).size).toBe(ITEM_ICONS.length);
  });
});

describe("the review images of an icon", () => {
  const sword = must(ITEM_ICONS.find((s) => s.sprite === "weapons/iron_sword"));
  const image = must(engineFrames(sword)[0]).image;

  it("put it in the client's inventory slot at 1x (36 px) and at 2x (68 px)", () => {
    expect(slotCell(image, 1).width).toBe(36);
    expect(slotCell(image, 2).height).toBe(68);
  });

  it("add the slots under the lineup on the ground", () => {
    const plain = reviewLineup(root, { ...sword, size: "object" });
    const withSlots = reviewLineup(root, sword);
    expect(withSlots.height).toBeGreaterThan(plain.height + 60);
  });

  it("lay out a board: a row per line, a cell per band", () => {
    const rows = ICON_ROWS.slice(0, 2);
    const board = iconBoard(root, rows);
    const detail = iconBoard(root, rows, true);
    expect(board.height).toBeLessThan(detail.height);
    expect(detail.width).toBeGreaterThan(6 * 128);
  });
});
