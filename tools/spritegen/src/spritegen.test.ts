import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  canvas,
  castShadow,
  get,
  opaque,
  outline,
  polygon,
  px,
  rect,
  rng,
  seedOf,
  SHADOW,
  tileNoise,
} from "./draw.ts";
import {
  bodyClashes,
  checkPaths,
  EFFECT_FRAME,
  MISSILE_ART,
  OUTFIT_FRAME,
  previewSheet,
  RECIPES,
  recipePaths,
  render,
  spriteFile,
  UI_ICON,
  LIVING_FX,
  UI_ICON_BOX,
  UI_SLOT_BOX,
  UI_STATUS_BOX,
  uiIconBox,
} from "./index.ts";
import { EFFECT_FRAMES, MAX_ORB_FRAMES, MISSILE_FRAMES, ORB_ELEMENTS } from "./recipes/effects.ts";
import { SLOT_MASKS, STATUS_ART } from "./recipes/ui.ts";
import { PALETTE } from "./palette.ts";
import { HUMANOID_LAYERS } from "./engine/specs/humanoid/index.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
/** A ground's decal (docs/17 ART-4): <ground>/decal_<n>. */
const DECAL = /^ground\/[a-z0-9_]+\/decal_[1-9][0-9]*$/;

/** The ids of balance.yaml's conditions, parsed as YAML: any style of entry counts. */
function conditionIds(balance: string): string[] {
  const doc: unknown = parse(balance);
  const conditions =
    doc && typeof doc === "object" && "conditions" in doc ? doc.conditions : undefined;
  return conditions && typeof conditions === "object" ? Object.keys(conditions) : [];
}

function lum(img: Image, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.3 * (img.data[i] ?? 0) + 0.59 * (img.data[i + 1] ?? 0) + 0.11 * (img.data[i + 2] ?? 0);
}

describe("draw helpers", () => {
  it("rng and seedOf are reproducible", () => {
    const a = rng(seedOf("decor/anvil"));
    const b = rng(seedOf("decor/anvil"));
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
    expect(seedOf("a")).not.toBe(seedOf("b"));
  });

  it("tileNoise wraps at its period", () => {
    for (let y = 0; y < 32; y += 3)
      for (let x = 0; x < 32; x += 5)
        expect(tileNoise(x + 32, y - 32, 4, 2, 9)).toBeCloseTo(tileNoise(x, y, 4, 2, 9), 12);
  });

  it("polygon fills by pixel centres and outline darkens only the rim", () => {
    const img = canvas(8, 8);
    polygon(
      img,
      [
        [1, 1],
        [7, 1],
        [7, 7],
        [1, 7],
      ],
      PALETTE.stone.base,
    );
    outline(img);
    expect(img.data[(0 * 8 + 0) * 4 + 3]).toBe(0);
    expect(lum(img, 1, 1)).toBeLessThan(lum(img, 3, 3));
    expect(lum(img, 3, 3)).toBe(lum(img, 4, 4));
    px(img, 0, 0, PALETTE.gold.light);
    expect(img.data[3]).toBe(255);
  });
});

describe("recipes", () => {
  const paths = recipePaths();
  // A paper-doll layer of the engine humanoids (docs/17 "Humanoides del motor") can be all
  // hidden by the body in a frame (a beard seen from behind): it may draw nothing.
  const dollFrame = (p: string): boolean =>
    HUMANOID_LAYERS.some((l) => l.slot !== "body" && p.startsWith(`${l.sprite}/`));

  // With the engine humanoids' ~9000 frames (eight facings), the tests over every recipe
  // take a minute or more while the whole suite runs.
  it("render the same bytes every time", () => {
    for (const p of paths) expect(encodePng(render(p)).equals(encodePng(render(p))), p).toBe(true);
  }, 180_000);

  it("have sizes in multiples of 32, only fully opaque or transparent pixels, and draw something", () => {
    for (const p of paths) {
      const img = render(p);
      expect(img.width % 32, p).toBe(0);
      expect(img.height % 32, p).toBe(0);
      // One expect per image, not per pixel: with the wall pieces, looks and frames of the
      // world art there are hundreds of recipes, and a per-pixel expect timed out on CI.
      let opaque = 0;
      let partial = -1;
      for (let i = 3; i < img.data.length; i += 4) {
        const a = img.data[i] ?? 0;
        if (a === 255) opaque++;
        else if (a !== 0 && partial < 0) partial = a;
      }
      expect(partial, `${p}: alpha that is neither 0 nor 255`).toBe(-1);
      // The living world's effect masks are a few pixels on purpose (a firefly, a leaf), and
      // so are a ground's decals (a shell, a flower: docs/17 ART-4), which must not read as
      // items.
      if (!dollFrame(p) && !LIVING_FX.test(p) && !DECAL.test(p))
        expect(opaque, p).toBeGreaterThan(20);
    }
  }, 180_000);

  it("ground decals are small, flat details in the middle of their tile (docs/17 ART-4)", () => {
    const decals = paths.filter((p) => DECAL.test(p));
    expect(decals.length).toBeGreaterThanOrEqual(12); // sand and grass, six each
    for (const p of decals) {
      expect(RECIPES[p]?.kind, p).toBe("object");
      const img = render(p);
      expect([img.width, img.height], p).toEqual([32, 32]);
      let opaque = 0;
      let minX = 32;
      let minY = 32;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          if ((img.data[(y * 32 + x) * 4 + 3] ?? 0) === 0) continue;
          opaque++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      // Something, but not an item-sized drawing; kept off the edges a border would cover.
      expect(opaque, p).toBeGreaterThan(4);
      expect(opaque, p).toBeLessThan(80);
      expect(Math.min(minX, minY), p).toBeGreaterThanOrEqual(6);
      expect(Math.max(maxX, maxY), p).toBeLessThanOrEqual(25);
    }
  });

  it("ground looks keep the main look's outer ring, so any look meets any other", () => {
    for (const p of paths) {
      const m = /^(ground\/[a-z0-9_]+)\/var_[0-9]+$/.exec(p);
      if (!m?.[1] || RECIPES[p]?.kind !== "ground") continue;
      const look = render(p);
      const main = render(m[1]);
      for (let k = 0; k < 32; k++)
        for (const [x, y] of [
          [k, 0],
          [k, 31],
          [0, k],
          [31, k],
        ] as const) {
          const i = (y * 32 + x) * 4;
          const a = Array.from(look.data.subarray(i, i + 4));
          const b = Array.from(main.data.subarray(i, i + 4));
          if (!same(a, b)) expect(`${p} ${x},${y}: ${a.join()}`).toBe(`${b.join()}`);
        }
    }
  });

  it("ground and walls are opaque and tile seamlessly", () => {
    for (const p of paths) {
      const kind = RECIPES[p]?.kind;
      if (kind !== "ground" && kind !== "wall") continue;
      const img = render(p);
      expect(img.width, p).toBe(32);
      expect(img.height, p).toBe(32);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i], p).toBe(255);
      // The jump across the wrap (last column -> first) must look like a jump that already
      // happens inside the tile (plank edges are fine, a visible tile border is not).
      const colStep = (j: number, k: number): number =>
        Math.abs(lum(img, j, k) - lum(img, (j + 1) % 32, k));
      const rowStep = (j: number, k: number): number =>
        Math.abs(lum(img, k, j) - lum(img, k, (j + 1) % 32));
      for (const [name, at] of [
        ["horizontal", colStep],
        ["vertical", rowStep],
      ] as const) {
        const boundary = (j: number): number => {
          let s = 0;
          for (let k = 0; k < 32; k++) s += at(j, k);
          return s / 32;
        };
        let worstInside = 0;
        for (let j = 0; j < 31; j++) worstInside = Math.max(worstInside, boundary(j));
        expect(boundary(31), `${p} ${name} seam`).toBeLessThanOrEqual(worstInside * 1.1 + 2);
      }
    }
  });

  it("grounds stay in the value band of docs/17 ART-6 (mean L* 20-50), but lava, which glows", () => {
    const linear = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    for (const p of paths) {
      if (RECIPES[p]?.kind !== "ground" || /^ground\/lava(\/|$)/.test(p)) continue;
      const img = render(p);
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const y =
          0.2126 * linear(img.data[i] ?? 0) +
          0.7152 * linear(img.data[i + 1] ?? 0) +
          0.0722 * linear(img.data[i + 2] ?? 0);
        sum += y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
      }
      const mean = sum / (img.data.length / 4);
      expect(mean, p).toBeGreaterThanOrEqual(20);
      expect(mean, p).toBeLessThanOrEqual(50);
    }
  });

  it("the committed PNGs equal the generator output (run make spritegen)", () => {
    for (const p of paths) {
      const file = spriteFile(root, p);
      expect(existsSync(file), `${p}: missing, run make spritegen`).toBe(true);
      expect(
        readFileSync(file).equals(encodePng(render(p))),
        `${p}: stale, run make spritegen`,
      ).toBe(true);
    }
  }, 180_000);

  it("every recipe path is used by data/ or is an outfit or effect frame or a ui icon", () => {
    expect(checkPaths(root)).toEqual([]);
    // A monster may not take the id a player's body is drawn by.
    expect(bodyClashes(["wolf", "body_male", "body_female"])).toHaveLength(2);
    expect(OUTFIT_FRAME.test("outfits/citizen/s_0")).toBe(true);
    expect(OUTFIT_FRAME.test("outfits/citizen/south_0")).toBe(false);
    expect(OUTFIT_FRAME.test("outfits/citizen/up_0")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/0")).toBe(true);
    expect(EFFECT_FRAME.test("effects/gather_miss/12")).toBe(true);
    expect(EFFECT_FRAME.test("effects/hit")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/first")).toBe(false);
    expect(UI_ICON.test("ui/marks/aggressor")).toBe(true);
    expect(UI_ICON.test("ui/aggressor")).toBe(false);
    expect(UI_ICON.test("items/ui/marks/aggressor")).toBe(false);
  });
});

describe("effect strips", () => {
  const strips = new Map<string, string[]>();
  for (const p of recipePaths("effects/")) {
    const name = EFFECT_FRAME.exec(p)?.[1] ?? p;
    strips.set(name, [...(strips.get(name) ?? []), p]);
  }

  it("are effect recipes of EFFECT_FRAMES frames, numbered from 0", () => {
    expect(strips.size).toBeGreaterThan(0);
    for (const [name, paths] of strips) {
      expect(paths, name).toEqual(
        Array.from({ length: EFFECT_FRAMES }, (_, f) => `effects/${name}/${f}`),
      );
      for (const p of paths) expect(RECIPES[p]?.kind, p).toBe("effect");
    }
  });

  it("animate: no two consecutive frames are the same picture", () => {
    for (const paths of strips.values()) {
      for (let f = 1; f < paths.length; f++) {
        const a = encodePng(render(paths[f - 1] ?? ""));
        const b = encodePng(render(paths[f] ?? ""));
        expect(a.equals(b), paths[f]).toBe(false);
      }
    }
  });

  it("preview a strip per row", () => {
    const hit = strips.get("hit") ?? [];
    const heal = strips.get("heal") ?? [];
    const one = previewSheet(root, hit);
    expect(previewSheet(root, [...hit, ...heal]).height).toBe(one.height * 2);
    // Without strips the cells still pack row after row.
    const items = recipePaths()
      .filter((p) => RECIPES[p]?.kind === "item")
      .slice(0, 2);
    expect(items).toHaveLength(2);
    expect(previewSheet(root, items).height).toBe(one.height);
  });
});

/** Same colour (alpha ignored: everything is opaque). */
const same = (a: readonly number[] | undefined, b: readonly number[]): boolean =>
  a !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

describe("missiles", () => {
  /** The opaque pixels of a sprite as "x,y". */
  const pixels = (img: Image): Set<string> => {
    const out = new Set<string>();
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) if (opaque(img, x, y)) out.add(`${x},${y}`);
    return out;
  };

  it("are the arrow and, per element, an orb loop of MISSILE_FRAMES frames and its trail", () => {
    const expected = ["missiles/arrow/e", "missiles/arrow/se"];
    for (const el of ORB_ELEMENTS) {
      for (let f = 0; f < MISSILE_FRAMES; f++) expected.push(`missiles/${el}/${f}`);
      expected.push(`missiles/${el}/trail`);
    }
    expect(recipePaths("missiles/")).toEqual([...expected].sort());
    for (const p of expected) {
      expect(RECIPES[p]?.kind, p).toBe("effect");
      expect(MISSILE_ART.test(p), p).toBe(true);
    }
    expect(MISSILE_FRAMES).toBeLessThanOrEqual(MAX_ORB_FRAMES);
    // Only the paths the client looks for (render/effects.ts missileArt): a stray recipe
    // under missiles/ is art nobody draws, and `check` (checkPaths) must say so.
    for (const p of [
      "missiles/arrow",
      "effects/fire/0",
      "missiles/physical/0", // physical flies as the arrow
      "missiles/arrow/0",
      "missiles/arrow/trail",
      "missiles/arrow/n", // the arrow is turned from e and se
      "missiles/fire/e",
      "missiles/fire/8", // past MAX_ORB_FRAMES
      "missiles/fire/01",
      "missiles/wind/0", // no such element
    ])
      expect(MISSILE_ART.test(p), p).toBe(false);
  });

  it("draw inside the middle 16x16, so a quarter turn keeps them in the sprite", () => {
    for (const p of recipePaths("missiles/")) {
      for (const xy of pixels(render(p))) {
        const [x = 0, y = 0] = xy.split(",").map(Number);
        expect(x >= 8 && x < 24 && y >= 8 && y < 24, `${p} at ${xy}`).toBe(true);
      }
    }
  });

  it("draw the diagonal arrow as the straight one turned 45 degrees (same length)", () => {
    const span = (img: Image, along: (x: number, y: number) => number): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const xy of pixels(img)) {
        const [x = 0, y = 0] = xy.split(",").map(Number);
        lo = Math.min(lo, along(x, y));
        hi = Math.max(hi, along(x, y));
      }
      return hi - lo;
    };
    const e = span(render("missiles/arrow/e"), (x) => x);
    const se = span(render("missiles/arrow/se"), (x, y) => (x + y) / Math.SQRT2);
    expect(e).toBeGreaterThanOrEqual(14);
    expect(Math.abs(e - se)).toBeLessThanOrEqual(2);
  });

  it("animate the orbs: no two frames of a loop are the same picture", () => {
    for (const el of ORB_ELEMENTS) {
      const frames = Array.from({ length: MISSILE_FRAMES }, (_, f) =>
        encodePng(render(`missiles/${el}/${f}`)),
      );
      for (let f = 0; f < frames.length; f++)
        for (let g = f + 1; g < frames.length; g++)
          expect(frames[f]?.equals(frames[g] ?? Buffer.alloc(0)), `${el} ${f}/${g}`).toBe(false);
    }
  });
});

describe("cast shadow", () => {
  it("falls to the bottom-right from part-way down, only behind the figure", () => {
    const img = canvas(16, 16);
    rect(img, 4, 2, 4, 10, PALETTE.stone.base); // a pillar, rows 2..11
    castShadow(img, { dx: 3, dy: 1, from: 0.5 });
    // The pillar keeps its colour; the shadow starts half-way down it (row 7).
    expect(same(get(img, 5, 5), PALETTE.stone.base)).toBe(true);
    expect(same(get(img, 8, 9), SHADOW)).toBe(true);
    expect(same(get(img, 10, 12), SHADOW)).toBe(true); // reaches dx right and dy down
    expect(opaque(img, 8, 3)).toBe(false); // the top of the pillar casts none
    expect(opaque(img, 11, 9)).toBe(false); // no further than dx
    expect(opaque(img, 3, 9)).toBe(false); // nothing to the left
  });

  it("always touches what casts it: a thin part leaves no loose piece of shadow", () => {
    const img = canvas(16, 16);
    rect(img, 4, 0, 2, 12, PALETTE.stone.base); // body
    rect(img, 7, 4, 1, 3, PALETTE.stone.base); // a 1 px strap, 1 px off the body
    castShadow(img, { dx: 3, dy: 1, from: 0 });
    for (let y = 5; y <= 7; y++)
      for (let x = 8; x <= 10; x++) expect(opaque(img, x, y), `${x},${y}`).toBe(true);
  });

  it("is on every creature that does not stand on the contact ellipse, and on nothing else", () => {
    for (const p of recipePaths()) {
      const img = render(p);
      let shadow = 0;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) if (same(get(img, x, y), SHADOW)) shadow++;
      const recipe = RECIPES[p];
      if (recipe?.kind === "creature" && recipe.shadow !== false)
        expect(shadow, p).toBeGreaterThan(10);
      else expect(shadow, p).toBeLessThan(10);
    }
  });
});

/** Opaque box of a sprite: left, top, right and bottom (inclusive). */
function opaqueBox(img: Image): { x0: number; y0: number; x1: number; y1: number } {
  const box = { x0: img.width, y0: img.height, x1: -1, y1: -1 };
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (opaque(img, x, y)) {
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x);
        box.y1 = Math.max(box.y1, y);
      }
  return box;
}

describe("the boar and the stag (docs/17 ART-2, Animales medianos)", () => {
  // Beside the Gemini wolf (~39 px long) and the LPC people (~46 px tall) a 32x32 boar and
  // stag read like young ones. Since 2026-11-18 they are sprite engine models
  // (engine/specs/): 64x64 frames on the contact ellipse in all four facings.
  const animals = [
    ...recipePaths("creatures/bristleback_boar/"),
    ...recipePaths("creatures/bramble_stag/"),
  ];

  it("are 64x64 frames on the contact ellipse for idle, walk, attack and death in four facings", () => {
    // 4 facings x (4 idle + 4 walk + 4 attack + 5 death) each.
    expect(animals).toHaveLength(2 * 4 * 17);
    for (const action of ["idle", "walk", "attack", "death"])
      for (const dir of ["n", "e", "s", "w"]) {
        expect(animals, `${action}_${dir}`).toContain(
          `creatures/bristleback_boar/${action}_${dir}_0`,
        );
        expect(animals, `${action}_${dir}`).toContain(`creatures/bramble_stag/${action}_${dir}_0`);
      }
    for (const p of animals) {
      expect(RECIPES[p]?.shadow, p).toBe(false);
      const img = render(p);
      expect([img.width, img.height], p).toEqual([64, 64]);
      const b = opaqueBox(img);
      expect(63 - b.y1, `${p} feet`).toBeGreaterThanOrEqual(1);
    }
  });

  it("stand at the size of a grown animal: the boar about the wolf's length, the stag a person's height", () => {
    for (const p of animals.filter((a) => /\/walk_[we]_/.test(a))) {
      const b = opaqueBox(render(p));
      const [w, h] = [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1];
      if (p.startsWith("creatures/bristleback_boar")) {
        expect(w, p).toBeGreaterThanOrEqual(34);
        expect(h, p).toBeGreaterThanOrEqual(21);
      } else {
        expect(w, p).toBeGreaterThanOrEqual(34);
        expect(h, p).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

describe("ui icons", () => {
  const icons = recipePaths("ui/");

  it("draw only inside their box, which is all the client shows", () => {
    expect(icons.length).toBeGreaterThan(0);
    expect(uiIconBox("ui/marks/murderer")).toEqual(UI_ICON_BOX);
    expect(uiIconBox("ui/slots/head")).toEqual(UI_SLOT_BOX);
    expect(uiIconBox("ui/status/poison")).toEqual(UI_STATUS_BOX);
    for (const p of icons) {
      const img = render(p);
      const box = uiIconBox(p);
      expect([img.width, img.height], p).toEqual([32, 32]);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
          if (!inBox) expect(opaque(img, x, y), `${p} ${x},${y}`).toBe(false);
        }
    }
  });

  it("give each PvP mark its own silhouette, so they read without colour", () => {
    const marks = ["aggressor", "murderer", "outlaw"].map((id) => `ui/marks/${id}`);
    for (const m of marks) expect(icons, m).toContain(m);
    const masks = marks.map((m) => {
      const img = render(m);
      let bits = "";
      for (let i = 3; i < img.data.length; i += 4) bits += img.data[i] ? "1" : "0";
      return bits;
    });
    expect(new Set(masks).size).toBe(marks.length);
  });

  it("draw every status of the tray (docs/17), each its own 14x14 map outlined to 16x16", () => {
    // The conditions of data/balance.yaml, the statuses of server/internal/session/status.go
    // and the party bonus (client/src/state/status.ts withPartyBonus).
    const conditions = conditionIds(readFileSync(resolve(root, "data", "balance.yaml"), "utf8"));
    expect(conditions).toContain("poison");
    const ids = [...conditions, "in_combat", "pvp_locked", "protection_zone", "party_bonus"];
    expect(Object.keys(STATUS_ART).sort()).toEqual([...ids].sort());
    const masks = ids.map((id) => {
      const art = STATUS_ART[id];
      expect(art?.rows.length, id).toBe(14);
      for (const r of art?.rows ?? []) {
        expect(r.length, id).toBe(14);
        for (const ch of r) if (ch !== ".") expect(art?.colours[ch], `${id} ${ch}`).toBeDefined();
      }
      const img = render(`ui/status/${id}`);
      let bits = "";
      let on = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        bits += img.data[i] ? "1" : "0";
        if (img.data[i]) on++;
      }
      // Fills a good part of its box, to read at 1x in a phone's header.
      expect(on, id).toBeGreaterThan(70);
      return bits;
    });
    expect(new Set(masks).size).toBe(ids.length);
  });

  it("read every condition of balance.yaml, a block-style entry too", () => {
    // A line regex saw only `id: { kind: ... }`: a new condition written as a block had no
    // icon and neither this test nor status.test.ts's STATUS_ORDER noticed.
    const yaml = [
      "combat: { block_ms: 1 }",
      "conditions:",
      "  poison: { kind: damage, element: earth }",
      "  # a comment",
      "  frozen:",
      "    kind: speed",
      "    speed_pct: -20",
      "skills: {}",
    ].join("\n");
    expect(conditionIds(yaml)).toEqual(["poison", "frozen"]);
  });

  it("draw every equipment slot (docs/17 UI-5), each its own 20x20 silhouette", () => {
    const slots = [
      "head",
      "neck",
      "backpack",
      "armor",
      "right_hand",
      "left_hand",
      "legs",
      "feet",
      "ring",
      "ammo",
    ];
    expect(Object.keys(SLOT_MASKS).sort()).toEqual([...slots].sort());
    for (const [slot, rows] of Object.entries(SLOT_MASKS)) {
      expect(rows.length, slot).toBe(UI_SLOT_BOX.h);
      for (const r of rows) expect(r.length, slot).toBe(UI_SLOT_BOX.w);
    }
    const masks = slots.map((s) => {
      const img = render(`ui/slots/${s}`);
      let bits = "";
      let on = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        bits += img.data[i] ? "1" : "0";
        if (img.data[i]) on++;
      }
      // Big enough to read faded under an empty slot.
      expect(on, s).toBeGreaterThan(40);
      return bits;
    });
    expect(new Set(masks).size).toBe(slots.length);
  });
});
