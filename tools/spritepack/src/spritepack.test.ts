import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAtlas, writeAtlas } from "./build.ts";
import { collectSpriteRefs } from "./content.ts";
import { registeredPacks } from "./credits.ts";
import { createImage, decodePng, encodePng, fillRect } from "./image.ts";
import type { Image } from "./image.ts";
import { parseManifest } from "./manifest.ts";
import { packSprites } from "./pack.ts";
import { defaultColor, defaultLabel, renderPlaceholder } from "./placeholder.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const CREDITS_ROW = (pack: string): string =>
  `| ${pack} | someone | CC0 | https://example.org | \`assets/vendor/${pack}/\` | no |\n`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spritepack-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, data: string | Buffer): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

function solid(w: number, h: number, rgb: [number, number, number]): Image {
  const img = createImage(w, h);
  fillRect(img, 0, 0, w, h, [...rgb, 255]);
  return img;
}

function pixel(img: Image, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
}

/** A 64x32 vendor sheet: left tile red, right tile blue, plus licence and credits. */
function vendorPack(pack = "testpack", registered = true): void {
  const sheet = createImage(64, 32);
  fillRect(sheet, 0, 0, 32, 32, [255, 0, 0, 255]);
  fillRect(sheet, 32, 0, 32, 32, [0, 0, 255, 255]);
  put(`assets/vendor/${pack}/sheet.png`, encodePng(sheet));
  put(`assets/vendor/${pack}/LICENSE.txt`, "CC0");
  put("assets/CREDITS.md", "| Pack | ... |\n|---|---|\n" + (registered ? CREDITS_ROW(pack) : ""));
}

function errors(r: ReturnType<typeof buildAtlas>): string[] {
  return r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.where} ${d.message}`);
}

describe("placeholders", () => {
  it("derives initials from the sprite name", () => {
    expect(defaultLabel("weapons/iron_sword")).toBe("IS");
    expect(defaultLabel("creatures/wolf")).toBe("WO");
    expect(defaultLabel("a/big_old_tree")).toBe("BO");
    expect(defaultLabel("tools/rope_2")).toBe("R2");
  });

  it("gives every sprite of a category the same colour", () => {
    expect(defaultColor("weapons/a")).toEqual(defaultColor("weapons/b"));
    expect(defaultColor("weapons/a")).not.toEqual(defaultColor("creatures/a"));
  });

  it("draws a border, a fill and a label", () => {
    const img = renderPlaceholder({
      label: "IS",
      color: [200, 200, 200, 255],
      width: 32,
      height: 32,
    });
    expect(img.width).toBe(32);
    expect(pixel(img, 0, 0)).toEqual([120, 120, 120, 255]);
    expect(pixel(img, 2, 2)).toEqual([200, 200, 200, 255]);
    const ink = new Set<string>();
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) ink.add(pixel(img, x, y).join());
    expect(ink.size).toBeGreaterThan(2);
  });

  it("supports labels up to 3 characters and larger sizes", () => {
    const img = renderPlaceholder({
      label: "ABC",
      color: [10, 10, 10, 255],
      width: 64,
      height: 32,
    });
    expect([img.width, img.height]).toEqual([64, 32]);
  });
});

describe("manifest", () => {
  it("parses placeholders and vendor sources", () => {
    const { manifest, errors: errs } = parseManifest(`sprites:
  a/one: { placeholder: {} }
  a/two: { placeholder: { label: X1, color: "#102030", size: [64, 32] } }
  b/three: { source: vendor/p/s.png, tile: [1, 2] }
  b/four: { source: vendor/p/sub/s.png, rect: [0, 0, 32, 64] }
`);
    expect(errs).toEqual([]);
    expect(manifest.sprites.get("a/two")).toEqual({
      kind: "placeholder",
      label: "X1",
      color: [16, 32, 48, 255],
      width: 64,
      height: 32,
    });
    expect(manifest.sprites.get("b/three")).toEqual({
      kind: "source",
      source: "vendor/p/s.png",
      pack: "p",
      rect: { x: 32, y: 64, w: 32, h: 32 },
    });
    expect(manifest.lines.get("b/four")).toBe(5);
  });

  it("rejects malformed entries with the line number", () => {
    const { errors: errs } = parseManifest(`sprites:
  Bad/Name: { placeholder: {} }
  a/both: { placeholder: {}, source: vendor/p/s.png }
  a/label: { placeholder: { label: toolong } }
  a/size: { placeholder: { size: [30, 32] } }
  a/escape: { source: ../secret.png }
  a/notvendor: { source: sprites/x.png }
  a/rt: { source: vendor/p/s.png, rect: [0, 0, 32, 32], tile: [0, 0] }
  a/typo: { placeholder: {}, colour: "#000000" }
`);
    const msgs = errs.map((e) => `${e.line}: ${e.message}`);
    expect(msgs).toEqual([
      expect.stringMatching(/^2: sprite path/),
      expect.stringMatching(/^3: entry needs exactly one/),
      expect.stringMatching(/^4: placeholder.label/),
      expect.stringMatching(/^5: placeholder.size/),
      expect.stringMatching(/^6: source must be/),
      expect.stringMatching(/^7: source must be/),
      expect.stringMatching(/^8: use rect or tile/),
      expect.stringMatching(/^9: unknown key "colour"/),
    ]);
  });
});

describe("credits", () => {
  it("only counts real pack rows, not the template", () => {
    const md =
      "| | | | | `assets/vendor/...` | |\n" + CREDITS_ROW("kenney_tiny") + "assets/vendor/prose\n";
    expect([...registeredPacks(md)]).toEqual(["kenney_tiny"]);
  });
});

describe("packer", () => {
  it("is independent of input order and opens new pages when full", () => {
    const inputs = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, width: 32, height: 32 }));
    inputs.push({ name: "big", width: 64, height: 64 });
    const a = packSprites(inputs, 96);
    const b = packSprites([...inputs].reverse(), 96);
    expect(a).toEqual(b);
    expect(a.placements[0]).toEqual({ name: "big", page: 0, x: 0, y: 0, width: 64, height: 64 });
    expect(a.pages.length).toBe(2);
    for (const p of a.placements) {
      const page = a.pages[p.page];
      expect(p.x + p.width).toBeLessThanOrEqual(page?.width ?? 0);
      expect(p.y + p.height).toBeLessThanOrEqual(page?.height ?? 0);
    }
    const seen = new Set(a.placements.map((p) => `${p.page}:${p.x}:${p.y}`));
    expect(seen.size).toBe(a.placements.length);
  });

  it("rejects sprites larger than a page", () => {
    expect(() => packSprites([{ name: "x", width: 128, height: 32 }], 64)).toThrow(/larger/);
  });
});

describe("buildAtlas", () => {
  it("resolves files, vendor crops, placeholders and automatic placeholders", () => {
    vendorPack();
    put("assets/sprites/decor/statue.png", encodePng(solid(32, 64, [0, 255, 0])));
    put(
      "assets/sprites.yaml",
      `sprites:
  weapons/iron_sword: { source: vendor/testpack/sheet.png, tile: [1, 0] }
  ground/grass: { placeholder: { label: "", color: "#00ff00" } }
`,
    );
    put(
      "data/items/x.yaml",
      `- id: iron_sword\n  sprite: weapons/iron_sword\n- id: grass\n  sprite: ground/grass\n`,
    );
    put("data/monsters/wolf.yaml", "id: wolf\nsprite: creatures/wolf\n");

    const r = buildAtlas(root);
    expect(errors(r)).toEqual([]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", where: "data/monsters/wolf.yaml" }),
    ]);
    const atlas = r.atlas;
    if (!atlas) throw new Error("no atlas");
    expect(atlas.index.sprites).toEqual({
      "creatures/wolf": { page: 0, origin: "auto" },
      "decor/statue": { page: 0, origin: "file" },
      "ground/grass": { page: 0, origin: "placeholder" },
      "weapons/iron_sword": { page: 0, origin: "vendor" },
    });
    const page = atlas.pages[0];
    if (!page) throw new Error("no page");
    const sword = page.json.frames["weapons/iron_sword"]?.frame;
    expect(sword && pixel(page.image, sword.x + 5, sword.y + 5)).toEqual([0, 0, 255, 255]);
    const statue = page.json.frames["decor/statue"]?.frame;
    expect(statue).toMatchObject({ w: 32, h: 64 });
    expect(statue && pixel(page.image, statue.x, statue.y + 63)).toEqual([0, 255, 0, 255]);
    expect(page.json.meta).toMatchObject({ image: "atlas-0.png", related_multi_packs: [] });
  });

  it("strict mode turns automatic placeholders into errors", () => {
    put("data/monsters/wolf.yaml", "id: wolf\nsprite: creatures/wolf\n");
    const r = buildAtlas(root, { strict: true });
    expect(r.atlas).toBeUndefined();
    expect(errors(r)).toEqual([expect.stringMatching(/creatures\/wolf \(wolf\) has no art/)]);
  });

  it("refuses vendor packs without a CREDITS.md row or a licence file", () => {
    vendorPack("unlisted", false);
    put("assets/sprites.yaml", "sprites:\n  a/b: { source: vendor/unlisted/sheet.png }\n");
    expect(errors(buildAtlas(root))).toEqual([
      expect.stringMatching(/^assets\/sprites.yaml:2 pack "unlisted" is not registered/),
    ]);

    rmSync(join(root, "assets/vendor/unlisted/LICENSE.txt"));
    put("assets/CREDITS.md", CREDITS_ROW("unlisted"));
    expect(errors(buildAtlas(root))).toEqual([expect.stringMatching(/has no LICENSE file/)]);
  });

  it("reports missing files, bad crops, bad sizes and duplicates", () => {
    vendorPack();
    put("assets/sprites/a/dup.png", encodePng(solid(32, 32, [1, 2, 3])));
    put("assets/sprites/a/odd.png", encodePng(solid(30, 32, [1, 2, 3])));
    put(
      "assets/sprites.yaml",
      `sprites:
  a/dup: { placeholder: {} }
  a/missing: { source: vendor/testpack/nope.png }
  a/outside: { source: vendor/testpack/sheet.png, tile: [2, 0] }
  a/whole: { source: vendor/testpack/sheet.png }
`,
    );
    const errs = errors(buildAtlas(root));
    expect(errs).toEqual([
      expect.stringMatching(/^assets\/sprites\/a\/odd.png sprite is 30x32/),
      expect.stringMatching(/^assets\/sprites.yaml:2 a\/dup: also exists/),
      expect.stringMatching(
        /^assets\/sprites.yaml:3 a\/missing: assets\/vendor\/testpack\/nope.png not found/,
      ),
      expect.stringMatching(
        /^assets\/sprites.yaml:4 a\/outside: rect \[64, 0, 32, 32\] is outside/,
      ),
    ]);
  });

  it("produces byte-identical output on every run and replaces stale pages", () => {
    put(
      "assets/sprites.yaml",
      "sprites:\n  a/b: { placeholder: {} }\n  a/c: { placeholder: {} }\n",
    );
    const out1 = join(root, "out1");
    const out2 = join(root, "out2");
    const a = buildAtlas(root).atlas;
    const b = buildAtlas(root).atlas;
    if (!a || !b) throw new Error("no atlas");
    put("out2/atlas-7.png", "stale");
    writeAtlas(a, out1);
    expect(writeAtlas(b, out2)).toEqual(["atlas-0.png", "atlas-0.json", "atlas.json"]);
    for (const f of ["atlas-0.png", "atlas-0.json", "atlas.json"]) {
      expect(readFileSync(join(out2, f))).toEqual(readFileSync(join(out1, f)));
    }
    expect(() => readFileSync(join(out2, "atlas-7.png"))).toThrow();
    const png = decodePng(readFileSync(join(out1, "atlas-0.png")));
    expect([png.width, png.height]).toEqual([64, 32]);
  });

  it("splits into several pages that reference each other", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `  a/s${i}: { placeholder: {} }`).join("\n");
    put("assets/sprites.yaml", `sprites:\n${lines}\n`);
    const atlas = buildAtlas(root, { maxPageSize: 64 }).atlas;
    expect(atlas?.index.pages).toEqual(["atlas-0.json", "atlas-1.json"]);
    expect(atlas?.pages[1]?.json.meta.related_multi_packs).toEqual(["atlas-0.json"]);
    expect(atlas?.index.sprites["a/s4"]).toEqual({ page: 1, origin: "placeholder" });
  });
});

describe("repository content", () => {
  it("maps every sprite used in data/ and builds without errors", () => {
    const r = buildAtlas(REPO);
    expect(errors(r)).toEqual([]);
    const used = new Set(collectSpriteRefs(REPO).map((ref) => ref.sprite));
    expect(used.size).toBeGreaterThan(0);
    for (const sprite of used) expect(r.atlas?.index.sprites[sprite]).toBeDefined();
  });
});
