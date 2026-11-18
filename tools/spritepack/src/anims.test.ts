import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layerOver, measureFrames, recolorImage } from "./anims.ts";
import { buildAtlas, legacyFrame } from "./build.ts";
import { createImage, encodePng, fillRect } from "./image.ts";
import type { Image } from "./image.ts";
import { parseManifest } from "./manifest.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spritepack-anims-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, data: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

function pixel(img: Image, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREY: [number, number, number, number] = [128, 128, 128, 255];

/**
 * A pack with two layer sheets per action of 32x32 frames: "body" (a grey column 10 px
 * wide from row 4 to row 29 of every frame, 2 columns x 4 rows) and "hat" (a red strip on
 * rows 4..5), plus licence and credits.
 */
function layeredPack(): void {
  for (const sheet of ["walk", "idle"]) {
    const body = createImage(64, 128);
    const hat = createImage(64, 128);
    for (let col = 0; col < 2; col++)
      for (let row = 0; row < 4; row++) {
        fillRect(body, col * 32 + 11, row * 32 + 4, 10, 26, GREY);
        fillRect(hat, col * 32 + 11, row * 32 + 4, 10, 2, RED);
      }
    put(`assets/vendor/lpcish/body/${sheet}.png`, encodePng(body));
    put(`assets/vendor/lpcish/hat/${sheet}.png`, encodePng(hat));
  }
  put("assets/vendor/lpcish/LICENSE.txt", "CC-BY-SA 3.0");
  put(
    "assets/CREDITS.md",
    "| Pack | ... |\n|---|---|\n| lpcish | someone | CC-BY-SA 3.0 | https://example.org | `assets/vendor/lpcish/` | yes |\n",
  );
}

const ANIM_YAML = `sprites: {}
palettes:
  red: ["#ff0000"]
  blue: ["#0000ff"]
animations:
  outfits/hero:
    layers:
      - vendor/lpcish/body/<sheet>.png
      - { file: vendor/lpcish/hat/<sheet>.png, recolor: { red: blue } }
    actions:
      idle: { sheet: idle, frame: [32, 32], rows: { n: 0, w: 1, s: 2, e: 3 }, count: 2, ms: 400 }
      walk: { sheet: walk, frame: [32, 32], rows: { n: 0, w: 1, s: 2, e: 3 }, count: 2, per_tile: 1 }
`;

const errors = (r: ReturnType<typeof buildAtlas>): string[] =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.where} ${d.message}`);

describe("animations in the manifest", () => {
  it("parses palettes, presets, specs and hints", () => {
    const { manifest, errors: errs } = parseManifest(`sprites: {}
palettes:
  a: ["#000000", "#ffffff"]
  b: ["#111111", "#eeeeee"]
animations:
  outfits/citizen:
    preset: lpc
    actions: [walk, death]
    layers:
      - vendor/ulpc/body/<sheet>.png
      - { file: vendor/ulpc/hair/<sheet>.png, recolor: { a: b } }
  creatures/bat: { facing: left, flying: true }
`);
    expect(errs).toEqual([]);
    const citizen = manifest.animations.get("outfits/citizen");
    expect([...(citizen?.actions.keys() ?? [])]).toEqual(["walk", "death"]);
    expect(citizen?.actions.get("walk")).toMatchObject({
      sheet: "walk",
      col: 1,
      count: 8,
      perTile: 4,
    });
    expect(citizen?.actions.get("death")?.rows).toEqual({ s: 0 });
    expect(citizen?.layers[1]).toEqual({
      file: "vendor/ulpc/hair/<sheet>.png",
      pack: "ulpc",
      recolor: [["a", "b"]],
    });
    expect(citizen?.shadow).toBe("ellipse");
    expect(manifest.animations.get("creatures/bat")).toMatchObject({
      layers: [],
      facing: "left",
      flying: true,
      shadow: "baked",
    });
  });

  it("rejects bad entries with the line number", () => {
    const { errors: errs } = parseManifest(`sprites: {}
palettes:
  a: ["#000000"]
  b: ["#111111", "#eeeeee"]
  c: [nope]
animations:
  x/one: { preset: nope, layers: [vendor/p/<sheet>.png] }
  x/two: { facing: up }
  x/three: { actions: [walk] }
  x/four: { layers: [vendor/p/a.png], actions: { walk: { sheet: w, frame: [30, 32], rows: { s: 0 }, count: 2 } } }
  x/five: { layers: [{ file: vendor/p/a.png, recolor: { a: b } }], preset: lpc }
  x/six: { layers: [assets/p.png], preset: lpc }
`);
    const lines = errs.map((e) => `${e.line ?? "-"} ${e.sprite ?? ""}: ${e.message}`);
    expect(lines).toEqual([
      '- : palette c: must be a list of "#rrggbb" colours',
      "7 x/one: unknown preset nope (known: lpc)",
      "7 x/one: an animation needs at least one action",
      "8 x/two: facing must be left or right",
      "9 x/three: preset and actions need layers (an entry without layers only gives hints)",
      "10 x/four: walk: frame must be [w, h], multiples of 32",
      "10 x/four: an animation needs at least one action",
      "11 x/five: vendor/p/a.png: palettes a and b have different lengths",
      "12 x/six: layer file must be a .png path under vendor/<pack>/ (relative to assets/)",
    ]);
  });
});

describe("animation images", () => {
  it("recolours by palette position and layers with alpha 0 or 255", () => {
    const src = createImage(2, 1);
    fillRect(src, 0, 0, 1, 1, [255, 0, 0, 255]);
    fillRect(src, 1, 0, 1, 1, [1, 2, 3, 255]);
    const out = recolorImage(src, [[[0xff0000], [0x0000ff]]]);
    expect(pixel(out, 0, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(out, 1, 0)).toEqual([1, 2, 3, 255]);
    expect(pixel(src, 0, 0)).toEqual([255, 0, 0, 255]); // the source is not touched

    const dst = createImage(2, 1);
    const top = createImage(2, 1);
    fillRect(top, 0, 0, 1, 1, [9, 9, 9, 200]);
    fillRect(top, 1, 0, 1, 1, [9, 9, 9, 100]);
    layerOver(top, 0, 0, dst);
    expect(pixel(dst, 0, 0)).toEqual([9, 9, 9, 255]);
    expect(pixel(dst, 1, 0)).toEqual([0, 0, 0, 0]);
  });

  it("measures the feet and the height of the drawing", () => {
    const a = createImage(32, 32);
    const b = createImage(32, 32);
    fillRect(a, 10, 10, 4, 18, GREY); // rows 10..27
    fillRect(b, 10, 6, 4, 4, GREY); // rows 6..9
    expect(measureFrames([a, b])).toEqual({ foot: 4, top: 22 });
    expect(measureFrames([createImage(32, 64)])).toEqual({ foot: 0, top: 64 });
  });
});

describe("buildAtlas with animations", () => {
  it("composes layered frames, aliases the base sprite and describes them", () => {
    layeredPack();
    put("assets/sprites.yaml", ANIM_YAML);
    put("data/outfits.yaml", "- id: hero\n  sprite: outfits/hero\n  frames: 3\n");
    const r = buildAtlas(root, { strict: true });
    expect(errors(r)).toEqual([]);
    const index = r.atlas?.index;
    expect(index?.anims["outfits/hero"]).toEqual({
      w: 32,
      h: 32,
      anchor: "bc",
      foot: 2,
      top: 26,
      shadow: "ellipse",
      actions: {
        idle: { frames: 2, ms: 400, dirs: ["n", "e", "s", "w"] },
        walk: { frames: 2, ms: 0, perTile: 1, dirs: ["n", "e", "s", "w"] },
      },
    });
    // Every frame of every action and facing, from the vendor pack.
    expect(index?.sprites["outfits/hero/walk_e_1"]).toMatchObject({ origin: "vendor" });
    expect(index?.sprites["outfits/hero/idle_w_0"]).toMatchObject({ origin: "vendor" });
    // The base name and the legacy outfit frames (T0.5) share frames' rectangles.
    const page = r.atlas?.pages[0]?.json.frames;
    expect(page?.["outfits/hero"]).toEqual(page?.["outfits/hero/idle_s_0"]);
    expect(page?.["outfits/hero/s_0"]).toEqual(page?.["outfits/hero/idle_s_0"]);
    expect(page?.["outfits/hero/e_2"]).toEqual(page?.["outfits/hero/walk_e_1"]);
    // The hat was recoloured red -> blue and drawn over the body.
    const img = r.atlas?.pages[0]?.image;
    const f = page?.["outfits/hero/walk_s_0"]?.frame;
    if (!img || !f) throw new Error("no frame");
    expect(pixel(img, f.x + 12, f.y + 4)).toEqual([0, 0, 255, 255]);
    expect(pixel(img, f.x + 12, f.y + 10)).toEqual([128, 128, 128, 255]);
    expect(pixel(img, f.x + 2, f.y + 10)).toEqual([0, 0, 0, 0]);
  });

  it("gives hints to existing sprites and refuses clashes and missing sheets", () => {
    layeredPack();
    const bat = createImage(32, 32);
    fillRect(bat, 8, 8, 16, 8, GREY);
    put("assets/sprites/creatures/bat.png", encodePng(bat));
    put("assets/sprites/outfits/hero/s_0.png", encodePng(bat));
    put(
      "assets/sprites.yaml",
      ANIM_YAML +
        `  creatures/bat: { facing: left, flying: true }
  creatures/ghost: { facing: right }
  npcs/broken:
    layers: [vendor/lpcish/body/<sheet>.png]
    actions:
      attack: { sheet: slash, frame: [32, 32], rows: { s: 0 }, count: 2, ms: 60 }
      walk: { sheet: walk, frame: [32, 32], rows: { s: 0 }, count: 3 }
`,
    );
    const r = buildAtlas(root);
    expect(errors(r)).toEqual([
      "assets/sprites.yaml:15 npcs/broken: walk needs 96x32 px but assets/vendor/lpcish/body/walk.png is 64x128",
      "assets/sprites.yaml:15 npcs/broken: assets/vendor/lpcish/body/slash.png not found",
      "assets/sprites.yaml:6 outfits/hero: the animation's frames would clash with sprite outfits/hero/s_0; keep only one",
      "assets/sprites.yaml:14 creatures/ghost: hints need a sprite of that name (a file in assets/sprites or a sprites entry)",
    ]);
  });

  it("builds the hints of a single-frame sprite", () => {
    const bat = createImage(32, 32);
    fillRect(bat, 8, 8, 16, 8, GREY);
    put("assets/sprites/creatures/bat.png", encodePng(bat));
    put(
      "assets/sprites.yaml",
      "sprites: {}\nanimations:\n  creatures/bat: { facing: left, flying: true }\n",
    );
    const r = buildAtlas(root);
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.anims).toEqual({
      "creatures/bat": {
        w: 32,
        h: 32,
        anchor: "br",
        foot: 16,
        top: 8,
        shadow: "baked",
        facing: "left",
        flying: true,
        actions: {},
      },
    });
  });

  it("animates a sprite from files named <sprite>/<action>_<dir>_<n> (own art)", () => {
    const frame = (rows: number): Buffer => {
      const img = createImage(32, 32);
      fillRect(img, 8, 30 - rows, 16, rows, GREY);
      return encodePng(img);
    };
    put("assets/sprites/creatures/boar.png", frame(10));
    for (const n of [0, 1, 2, 3])
      put(`assets/sprites/creatures/boar/walk_w_${n}.png`, frame(10 + n));
    put("assets/sprites/creatures/boar/walk_e_0.png", frame(10)); // e has a gap: 1 frame
    for (const n of [0, 1]) put(`assets/sprites/creatures/ghost/idle_s_${n}.png`, frame(8));
    put("assets/sprites.yaml", "sprites: {}\nanimations:\n  creatures/boar: { facing: left }\n");
    put("data/monsters/boar.yaml", "id: boar\nsprite: creatures/boar\n");
    put("data/monsters/ghost.yaml", "id: ghost\nsprite: creatures/ghost\n");
    const r = buildAtlas(root, { strict: true });
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.anims["creatures/boar"]).toEqual({
      w: 32,
      h: 32,
      anchor: "br",
      foot: 2,
      top: 13,
      shadow: "baked",
      facing: "left",
      actions: { walk: { frames: 1, ms: 0, perTile: 1, dirs: ["e", "w"] } },
    });
    expect(r.atlas?.index.anims["creatures/ghost"]?.actions).toEqual({
      idle: { frames: 2, ms: 500, dirs: ["s"] },
    });
    // No base file: the base name is the first idle frame, not a placeholder.
    const page = r.atlas?.pages[0]?.json.frames;
    expect(page?.["creatures/ghost"]).toEqual(page?.["creatures/ghost/idle_s_0"]);
  });

  it("mirrors west frames to the east, anchors on the feet and times the clips (mirror, anchor, ms)", () => {
    // A 64x64 creature drawn facing south, north and west, as the Gemini monsters: a grey
    // body with a red snout on its left, so a mirrored frame has the snout on its right.
    const frame = (rows: number): Buffer => {
      const img = createImage(64, 64);
      fillRect(img, 20, 60 - rows, 24, rows, GREY);
      fillRect(img, 20, 58 - rows, 2, 2, RED);
      return encodePng(img);
    };
    for (const n of [0, 1, 2, 3])
      for (const d of ["s", "n", "w"])
        put(`assets/sprites/creatures/wolf/walk_${d}_${n}.png`, frame(20 + n));
    for (const n of [0, 1, 2]) {
      put(`assets/sprites/creatures/wolf/attack_w_${n}.png`, frame(20));
      put(`assets/sprites/creatures/wolf/death_s_${n}.png`, frame(10));
    }
    put("assets/sprites/creatures/wolf/walk_e_9.png", frame(20)); // not frame 0: e is still missing
    put(
      "assets/sprites.yaml",
      "sprites: {}\nanimations:\n  creatures/wolf: { mirror: true, anchor: bc, shadow: ellipse, ms: { attack: 110, death: 200 } }\n",
    );
    put("data/monsters/wolf.yaml", "id: wolf\nsprite: creatures/wolf\n");
    const r = buildAtlas(root, { strict: true });
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.anims["creatures/wolf"]).toEqual({
      w: 64,
      h: 64,
      anchor: "bc",
      foot: 4,
      top: 25,
      shadow: "ellipse",
      actions: {
        walk: { frames: 4, ms: 0, perTile: 2, dirs: ["n", "e", "s", "w"] },
        attack: { frames: 3, ms: 110, dirs: ["e", "w"] },
        death: { frames: 3, ms: 200, dirs: ["s"] },
      },
    });
    const page = r.atlas?.pages[0]?.json.frames;
    const img = r.atlas?.pages[0]?.image;
    const west = page?.["creatures/wolf/walk_w_2"]?.frame;
    const east = page?.["creatures/wolf/walk_e_2"]?.frame;
    if (!img || !west || !east) throw new Error("no frame");
    expect(r.atlas?.index.sprites["creatures/wolf/walk_e_2"]).toMatchObject({ origin: "file" });
    expect(pixel(img, west.x + 20, west.y + 36)).toEqual(RED);
    expect(pixel(img, east.x + 43, east.y + 36)).toEqual(RED); // the snout on the other side
    expect(pixel(img, east.x + 20, east.y + 36)).toEqual([0, 0, 0, 0]);
    // A sprite with no frames of its own is the first one (walk, facing south).
    expect(page?.["creatures/wolf"]).toEqual(page?.["creatures/wolf/walk_s_0"]);
  });

  it("refuses frame hints with layers, without frames or for a clip that is not there", () => {
    const { errors: errs } = parseManifest(`sprites: {}
animations:
  x/one: { layers: [vendor/p/<sheet>.png], preset: lpc, mirror: true }
  x/two: { mirror: yes, anchor: top, ms: { walk: 100, attack: 0 } }
`);
    expect(errs.map((e) => `${e.line ?? "-"} ${e.sprite ?? ""}: ${e.message}`)).toEqual([
      "3 x/one: mirror: only for frames from files (an entry without layers)",
      "4 x/two: mirror must be true or false",
      "4 x/two: anchor must be br or bc",
      "4 x/two: ms.walk: only idle, attack, death play by time",
      "4 x/two: ms.attack must be an integer >= 1",
    ]);
    put("assets/sprites/creatures/still.png", encodePng(createImage(32, 32)));
    put("assets/sprites/creatures/toad/walk_s_0.png", encodePng(createImage(32, 32)));
    put(
      "assets/sprites.yaml",
      "sprites: {}\nanimations:\n  creatures/still: { mirror: true }\n  creatures/toad: { ms: { idle: 500 } }\n",
    );
    put("data/monsters/a.yaml", "id: a\nsprite: creatures/still\n");
    put("data/monsters/b.yaml", "id: b\nsprite: creatures/toad\n");
    const r = buildAtlas(root, { strict: true });
    expect(errors(r)).toEqual([
      "assets/sprites.yaml:3 creatures/still: mirror, anchor and ms need frames from files (assets/sprites/creatures/still/<action>_<dir>_<n>.png)",
      "assets/sprites.yaml:4 creatures/toad: ms.idle but no idle frames",
    ]);
  });

  it("maps legacy outfit frames onto the idle pose and the walk cycle", () => {
    const meta = {
      w: 64,
      h: 64,
      anchor: "bc" as const,
      foot: 2,
      top: 46,
      shadow: "ellipse" as const,
      actions: {
        idle: { frames: 2, ms: 500, dirs: ["n", "e", "s", "w"] as ("n" | "e" | "s" | "w")[] },
        walk: {
          frames: 8,
          ms: 0,
          perTile: 4,
          dirs: ["n", "e", "s", "w"] as ("n" | "e" | "s" | "w")[],
        },
      },
    };
    const anims = { "outfits/x": meta };
    expect(legacyFrame("outfits/x/s_0", anims)).toBe("outfits/x/idle_s_0");
    expect(legacyFrame("outfits/x/w_1", anims)).toBe("outfits/x/walk_w_0");
    expect(legacyFrame("outfits/x/w_2", anims)).toBe("outfits/x/walk_w_4");
    expect(legacyFrame("outfits/y/w_2", anims)).toBeUndefined();
    expect(legacyFrame("outfits/x/walk_w_2", anims)).toBeUndefined();
  });
});
