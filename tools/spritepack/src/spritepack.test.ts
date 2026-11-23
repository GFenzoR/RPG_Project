import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PNG_SIDE, MAX_TOTAL_PIXELS, buildAtlas, pngSize, writeAtlas } from "./build.ts";
import { collectSpriteRefs } from "./content.ts";
import {
  derivedLicense,
  fileLicenses,
  markdownSection,
  markdownTableRows,
  parseCreditsCsv,
  parseCreditsRows,
  plainCell,
  registeredPacks,
  usedLicense,
} from "./credits.ts";
import { createImage, decodePng, encodePng, fillRect } from "./image.ts";
import { licenceProblems } from "./licences.ts";
import type { Image } from "./image.ts";
import { MAX_PLACEHOLDER_SIDE, parseManifest } from "./manifest.ts";
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

  it("reads per-file licences from an LPC CREDITS.csv", () => {
    const csv =
      "filename,notes,authors,licenses,urls\r\n" +
      '"hair/long/walk.png","a ""quoted"" note, with a comma" ,"A,B" ,"CC-BY-SA 3.0,GPL 3.0" ,"u"\r\n' +
      '"body/male/walk.png","" ,"C" ,"OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0" ,"u"\r\n';
    const rows = parseCreditsCsv(csv);
    expect([...rows.keys()]).toEqual(["hair/long/walk.png", "body/male/walk.png"]);
    expect(rows.get("hair/long/walk.png")).toEqual(["CC-BY-SA 3.0", "GPL 3.0"]);
    // A path inside the pack matches the row named from its spritesheets/ folder.
    expect(fileLicenses(rows, "spritesheets/body/male/walk.png")).toEqual([
      "OGA-BY 3.0",
      "CC-BY-SA 3.0",
      "GPL 3.0",
    ]);
    expect(fileLicenses(rows, "spritesheets/body/female/walk.png")).toBeUndefined();
  });

  it("reads each CREDITS.csv row's authors, licences and links for the credits page", () => {
    const csv =
      "filename,notes,authors,licenses,urls\r\n" +
      '"hair/long/walk.png","a ""quoted"" note, with a comma" ,"A,B (b)" ,"CC-BY-SA 3.0,GPL 3.0" ,"https://x/1,https://x/2"\r\n' +
      '"","" ,"nobody" ,"CC0" ,""\r\n';
    expect(parseCreditsRows(csv)).toEqual([
      {
        file: "hair/long/walk.png",
        authors: ["A", "B (b)"],
        licenses: ["CC-BY-SA 3.0", "GPL 3.0"],
        urls: ["https://x/1", "https://x/2"],
      },
    ]);
    // Without a licences column there is nothing to check a file against.
    expect(parseCreditsCsv("filename,authors\na.png,A\n").size).toBe(0);
    expect(parseCreditsRows("filename,authors\na.png,A\n")).toEqual([
      { file: "a.png", authors: ["A"], licenses: [], urls: [] },
    ]);
  });

  it("reads the rows of a CREDITS.md section's tables", () => {
    const md =
      "# Credits\n\n| a | b |\n|---|:-:|\n| `x` | **y** |\n\n## Fonts\n\n| f | l |\n|---|---|\n| F | OFL 1.1 |\n\n## Next\n| n |\n";
    expect(markdownTableRows(md)).toEqual([
      ["a", "b"],
      ["`x`", "**y**"],
      ["f", "l"],
      ["F", "OFL 1.1"],
      ["n"],
    ]);
    expect(markdownTableRows(markdownSection(md, "## Fonts"))).toEqual([
      ["f", "l"],
      ["F", "OFL 1.1"],
    ]);
    expect(markdownSection(md, "## Missing")).toBe("");
    expect(plainCell(" `x`  **y** ")).toBe("x y");
  });

  it("uses each file under its most permissive accepted licence, never GPL", () => {
    expect(usedLicense(["CC-BY-SA 3.0", "GPL 3.0", "OGA-BY 3.0"])).toBe("OGA-BY 3.0");
    expect(usedLicense(["CC-BY 3.0", "OGA-BY 3.0"])).toBe("OGA-BY 3.0");
    expect(usedLicense(["CC-BY-SA 3.0", "GPL 3.0"])).toBe("CC-BY-SA 3.0");
    expect(usedLicense(["CC0"])).toBe("CC0");
    expect(usedLicense(["GPL 3.0", "GPL 2.0"])).toBeUndefined();
    expect(usedLicense(["CC-BY-NC 3.0"])).toBeUndefined();
    // One CC-BY-SA layer makes the composed frame CC-BY-SA.
    expect(derivedLicense(["OGA-BY 3.0", "CC0", "OGA-BY 3.0"])).toBe("OGA-BY 3.0");
    expect(derivedLicense(["OGA-BY 3.0", "CC-BY-SA 3.0"])).toBe("CC-BY-SA 3.0");
    expect(derivedLicense([])).toBeUndefined();
  });
});

describe("licence audit", () => {
  const CSV = [
    "filename,notes,authors,licenses,urls",
    '"body/walk.png","" ,"A" ,"OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0" ,"u"',
    '"beard/walk.png","" ,"B" ,"CC-BY-SA 3.0,GPL 3.0" ,"u"',
    "",
  ].join("\n");
  const WALK =
    "    actions: { walk: { sheet: walk, frame: [32, 32], rows: { s: 0 }, col: 0, count: 1 } }";
  const ANIMS = [
    "animations:",
    "  npcs/plain:",
    WALK,
    "    layers: [{ file: vendor/lpc/spritesheets/body/<sheet>.png }]",
    "  npcs/bearded:",
    WALK,
    "    layers:",
    "      - { file: vendor/lpc/spritesheets/body/<sheet>.png }",
    "      - { file: vendor/lpc/spritesheets/beard/<sheet>.png }",
    "",
  ].join("\n");
  const credits = (...rows: string[]): string =>
    [
      "| Pack | ... |",
      "|---|---|",
      "| LPC | x | por archivo | u | `assets/vendor/lpc/` | Sí |",
      "",
      "## Obras derivadas de terceros",
      "",
      "| Archivos | Sale de | Licencia | Herramienta |",
      "|---|---|---|---|",
      ...rows,
      "",
      "## Otra",
      "",
    ].join("\n");
  function lpcPack(): void {
    put("assets/vendor/lpc/CREDITS.csv", CSV);
    put("assets/vendor/lpc/LICENSE.txt", "per file");
    put("assets/vendor/lpc/spritesheets/body/walk.png", encodePng(createImage(32, 32)));
    put("assets/vendor/lpc/spritesheets/beard/walk.png", encodePng(createImage(32, 32)));
    put("assets/sprites.yaml", ANIMS);
  }

  it("accepts each sprite under the licence its layers give it", () => {
    lpcPack();
    put(
      "assets/CREDITS.md",
      credits(
        "| `npcs/plain` | capas | OGA-BY 3.0 | spritepack |",
        "| `npcs/bearded` | capas | **CC-BY-SA 3.0** | spritepack |",
      ),
    );
    expect(licenceProblems(root)).toEqual([]);
  });

  it("refuses a blanket licence, a missing sprite and a GPL-only or unlisted file", () => {
    lpcPack();
    put("assets/CREDITS.md", credits("| `npcs/plain` | capas | CC-BY-SA 3.0 | spritepack |"));
    put("assets/vendor/lpc/spritesheets/gpl/walk.png", encodePng(createImage(32, 32)));
    put("assets/vendor/lpc/spritesheets/stray.png", encodePng(createImage(32, 32)));
    put("assets/vendor/lpc/CREDITS.csv", CSV + '"gpl/walk.png","" ,"C" ,"GPL 3.0" ,"u"\n');
    expect(licenceProblems(root)).toEqual([
      "assets/vendor/lpc/spritesheets/gpl/walk.png: lists no accepted licence (GPL 3.0)",
      "assets/vendor/lpc/spritesheets/stray.png: no row in its CREDITS.csv",
      "npcs/plain: assets/CREDITS.md says CC-BY-SA 3.0, its layers make it OGA-BY 3.0",
      'npcs/bearded: its frames come from vendor layers (CC-BY-SA 3.0); name it in "Obras derivadas de terceros" of assets/CREDITS.md',
    ]);
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

  it("packs the living world's own art under livingworld/ (livingworld/README.md)", () => {
    put("assets/livingworld/sprites/plants/reeds.png", encodePng(solid(32, 32, [0, 128, 0])));
    put("assets/livingworld/sprites/fx/ripple_0.png", encodePng(solid(32, 32, [255, 255, 255])));
    put("data/items/x.yaml", "- id: reeds\n  sprite: livingworld/plants/reeds\n");
    const r = buildAtlas(root, { strict: true });
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.sprites).toEqual({
      "livingworld/fx/ripple_0": { page: 0, origin: "file" },
      "livingworld/plants/reeds": { page: 0, origin: "file" },
    });
  });

  it("treats an outfit's sprite as a folder of frames (T0.5)", () => {
    put(
      "data/outfits.yaml",
      "- id: citizen\n  sprite: outfits/citizen\n  frames: 3\n- id: still\n  sprite: outfits/still\n  frames: 1\n",
    );
    for (const dir of ["n", "e", "s", "w"])
      for (const f of [0, 1, 2])
        put(`assets/sprites/outfits/citizen/${dir}_${f}.png`, encodePng(solid(32, 32, [9, 9, 9])));
    const refs = collectSpriteRefs(root);
    expect(refs.map((r) => r.sprite)).toEqual([
      ...["n", "e", "s", "w"].flatMap((d) => [0, 1, 2].map((f) => `outfits/citizen/${d}_${f}`)),
      "outfits/still/n_0",
      "outfits/still/e_0",
      "outfits/still/s_0",
      "outfits/still/w_0",
    ]);
    expect(refs[0]).toEqual({
      sprite: "outfits/citizen/n_0",
      file: "data/outfits.yaml",
      id: "citizen",
    });
    // The folder itself is never a sprite; frames without art get the usual placeholder.
    const r = buildAtlas(root);
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.sprites["outfits/citizen"]).toBeUndefined();
    expect(r.atlas?.index.sprites["outfits/citizen/w_2"]).toMatchObject({ origin: "file" });
    expect(r.atlas?.index.sprites["outfits/still/s_0"]).toMatchObject({ origin: "auto" });
    expect(r.diagnostics.filter((d) => d.severity === "warning")).toHaveLength(4);
  });

  it("describes map tile art in atlas.json tiles (docs/17 ART-3, ART-4, ART-7)", () => {
    const tile = encodePng(solid(32, 32, [9, 9, 9]));
    const tall = encodePng(solid(32, 64, [9, 9, 9]));
    put("assets/sprites/ground/grass.png", tile);
    for (const n of [1, 2, 3]) put(`assets/sprites/ground/grass/var_${n}.png`, tile);
    put("assets/sprites/ground/water.png", tile);
    for (const n of [1, 2, 3]) put(`assets/sprites/ground/water/frame_${n}.png`, tile);
    put("assets/sprites/ground/sand.png", tile);
    put("assets/sprites/walls/stone.png", tall);
    for (let m = 0; m < 16; m++) put(`assets/sprites/walls/stone/wall_${m}.png`, tall);
    put("assets/sprites/decor/tree.png", tall);
    put("assets/sprites/decor/tree/shadow.png", tall);
    put("assets/sprites/doors/gate.png", tall);
    // A surf piece: 2 looks, each with its own 2 frames (docs/17 ART-4, ART-7).
    for (const n of ["", "/frame_1", "/var_1", "/var_1/frame_1"])
      put(`assets/sprites/borders/surf/n${n}.png`, tile);
    // A border piece with no looks: flat all the same, like every sprite under borders/.
    put("assets/sprites/borders/grass/w.png", tile);
    put(
      "assets/sprites.yaml",
      `sprites: {}
tiles:
  ground/water: { ms: 220, sync: world, particles: spray }
  ground/grass: { weight: 0.6 }
  ground/sand: { steps: dust }
  decor/tree: { anchor: bc, particles: pollen }
  doors/gate: { joins_walls: true }
`,
    );
    const r = buildAtlas(root);
    expect(errors(r)).toEqual([]);
    expect(r.atlas?.index.tiles).toEqual({
      // The look's frames are part of the sprite's entry, not one of their own.
      // Border pieces lie flat on their tile's ground: the renderer draws them with it.
      "borders/grass/w": { flat: true },
      "borders/surf/n": { variants: 1, frames: 2, flat: true },
      "decor/tree": { anchor: "bc", shadow: true, particles: "pollen" },
      "doors/gate": { joins: true },
      "ground/grass": { variants: 3, weight: 0.6 },
      "ground/sand": { steps: "dust" },
      "ground/water": { frames: 4, ms: 220, sync: "world", particles: "spray" },
      "walls/stone": { wall: true },
    });
  });

  it("refuses tile art with gaps, missing pieces or no sprite to belong to", () => {
    const tile = encodePng(solid(32, 32, [9, 9, 9]));
    put("assets/sprites/ground/grass.png", tile);
    put("assets/sprites/ground/grass/var_2.png", tile);
    put("assets/sprites/walls/stone.png", tile);
    put("assets/sprites/walls/stone/wall_0.png", tile);
    put("assets/sprites/decor/lost/shadow.png", tile);
    put("assets/sprites/ground/sand.png", tile);
    // An animated sprite whose second look lacks its frames, and frames on a look of a still one.
    for (const n of ["", "/frame_1", "/var_1", "/var_1/frame_1", "/var_2"])
      put(`assets/sprites/borders/surf/n${n}.png`, tile);
    for (const n of ["", "/var_1", "/var_1/frame_1"])
      put(`assets/sprites/borders/odd/n${n}.png`, tile);
    put(
      "assets/sprites.yaml",
      `sprites: {}
tiles:
  ground/sand: { ms: 200 }
  ground/nothing: { anchor: bc }
  ground/grass: { sync: sometimes, particles: smoke, steps: splash }
`,
    );
    expect(errors(buildAtlas(root))).toContainEqual(
      expect.stringMatching(/ground\/grass: sync must be world, tile or random/),
    );
    expect(errors(buildAtlas(root))).toContainEqual(
      expect.stringMatching(/ground\/grass: particles must be one of embers, pollen, spray, dust/),
    );
    expect(errors(buildAtlas(root))).toContainEqual(
      expect.stringMatching(/ground\/grass: steps must be one of dust, ripple/),
    );
    put(
      "assets/sprites.yaml",
      `sprites: {}
tiles:
  ground/sand: { ms: 200 }
  ground/nothing: { anchor: bc }
`,
    );
    expect(errors(buildAtlas(root))).toEqual([
      expect.stringMatching(/decor\/lost: decor\/lost\/shadow needs the sprite decor\/lost itself/),
      expect.stringMatching(/ground\/grass: var_<n> must be var_1..var_1 without gaps/),
      expect.stringMatching(/ground\/nothing: a tiles entry needs a sprite of that name/),
      expect.stringMatching(/ground\/sand: ms and sync need frames/),
      expect.stringMatching(/walls\/stone: a wall needs all 16 pieces/),
      expect.stringMatching(/borders\/odd\/n\/var_1: a look's frames go with the sprite's/),
      expect.stringMatching(
        /borders\/surf\/n: an animated sprite's looks need their frames: .*var_2\/frame_1 is missing/,
      ),
    ]);
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
  // The whole repository's art, the engine humanoids' ~3600 frames among them: seconds.
  it("maps every sprite used in data/ and builds without errors", { timeout: 60_000 }, () => {
    const r = buildAtlas(REPO);
    expect(errors(r)).toEqual([]);
    const used = new Set(collectSpriteRefs(REPO).map((ref) => ref.sprite));
    expect(used.size).toBeGreaterThan(0);
    for (const sprite of used) expect(r.atlas?.index.sprites[sprite]).toBeDefined();
  });

  it("credits every vendor file and every derived sprite under the right licence", () => {
    expect(licenceProblems(REPO)).toEqual([]);
  });
});

describe("decodePng", () => {
  it("ignores a repeated IEND and bytes after the first one", () => {
    const img = createImage(2, 1);
    fillRect(img, 0, 0, 1, 1, [255, 0, 0, 255]);
    const png = encodePng(img);
    const iend = png.subarray(png.length - 12); // length 0 + "IEND" + CRC
    expect(iend.toString("latin1", 4, 8)).toBe("IEND");
    for (const tail of [iend, Buffer.from("junk")]) {
      expect(decodePng(Buffer.concat([png, tail]))).toEqual(img);
    }
  });
});

describe("size limits (a map PR's sprites are decoded by the check)", () => {
  it("refuses a PNG whose header declares more than a page, without decoding it", () => {
    const png = encodePng(solid(32, 32, [1, 2, 3]));
    expect(pngSize(png)).toEqual({ width: 32, height: 32 });
    const huge = Buffer.from(png);
    huge.writeUInt32BE(MAX_PNG_SIDE + 32, 16); // IHDR width (the CRC no longer matches)
    put("assets/sprites/a/huge.png", huge);
    const r = buildAtlas(root);
    expect(errors(r)).toEqual([
      `assets/sprites/a/huge.png PNG is ${MAX_PNG_SIDE + 32}x32; at most ${MAX_PNG_SIDE} per side`,
    ]);
    expect(r.atlas).toBeUndefined();
  });

  it("stops decoding once the build's pixel budget is spent", () => {
    put("assets/sprites/a/one.png", encodePng(solid(32, 32, [1, 2, 3])));
    put("assets/sprites/a/two.png", encodePng(solid(32, 32, [4, 5, 6])));
    expect(errors(buildAtlas(root, { maxPixels: 2 * 32 * 32 }))).toEqual([]);
    expect(errors(buildAtlas(root, { maxPixels: 32 * 32 + 1 }))).toEqual([
      "assets/sprites/a/two.png over the pixel budget of a build (MAX_TOTAL_PIXELS of PNGs in total)",
    ]);
    expect(MAX_TOTAL_PIXELS).toBeGreaterThanOrEqual(16 * MAX_PNG_SIDE * MAX_PNG_SIDE);
  });

  it("refuses a placeholder larger than its limit", () => {
    const side = MAX_PLACEHOLDER_SIDE;
    const { manifest, errors: errs } = parseManifest(`sprites:
  a/ok: { placeholder: { size: [${side}, ${side}] } }
  a/big: { placeholder: { size: [${side + 32}, 32] } }
`);
    expect(manifest.sprites.get("a/ok")).toMatchObject({ width: side, height: side });
    expect(errs.map((e) => `${e.line}: ${e.message}`)).toEqual([
      expect.stringMatching(/^3: placeholder.size .* up to 256/),
    ]);
  });
});
