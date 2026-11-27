// Every monster's own corpse (recipes/corpses.ts, docs/17 "Cadáveres").
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { tippedRest, createImage, decodePng, parseYaml, restsOf } from "@rpg/spritepack";
import type { AnimMeta as PackMeta, Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import {
  FALL_DIRS,
  fallArt,
  fallShift,
  tipPlacement,
  TIP_SQUASH,
} from "../../../../packages/renderer/src/anim.ts";
import type { AnimMeta, FallDir } from "../../../../packages/renderer/src/anim.ts";
import { bodyClashes, checkPaths, RECIPES, recipesAt, render, spriteFile } from "../index.ts";
import {
  BODY_SEXES,
  bodyPath,
  CORPSE_DIRS,
  CORPSE_LIGHT,
  corpseOf,
  corpsePath,
  deaden,
  FEET_LINE,
  mirrored,
  monsterIds,
  ownCorpseDirs,
  tipOver,
  tipTo,
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

/** The pixels of `img` that show: what a transparent one has in its colour does not count. */
const visible = (img: Image): Buffer => {
  const out = Buffer.from(img.data);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out.fill(0, i, i + 4);
  return out;
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

  it("lies four ways, one per facing it can die in, each sex its own (docs/17)", () => {
    expect(bodyPath("female")).toBe("corpses/body_female");
    expect(bodyPath("female", "w")).toBe("corpses/body_female_w");
    const seen = new Map<string, string>();
    for (const sex of BODY_SEXES)
      for (const dir of CORPSE_DIRS) {
        const path = bodyPath(sex, dir);
        expect(RECIPES[path], path).toBeDefined();
        expect(existsSync(spriteFile(root, path)), `${path}: run make spritegen`).toBe(true);
        const img = render(path);
        expect([img.width, img.height], path).toEqual([64, 64]);
        expect(lowest(img), path).toBe(img.height - 1 - FEET_LINE);
        expect(opaque(img), path).toBeGreaterThan(150);
        const key = Buffer.from(img.data).toString("base64");
        expect(seen.get(key), `${path} looks like ${seen.get(key) ?? ""}`).toBeUndefined();
        seen.set(key, path);
      }
    expect(seen.size).toBe(8);
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
    // Fallen facing the same or another way: the body of one is never another's. (One
    // monster's own may repeat: a death drawn facing south only has two bodies, not four.)
    const seen = new Map<string, string>();
    for (const id of [...monsterIds(root), ...BODY_SEXES.map((s) => `body_${s}`)])
      for (const dir of CORPSE_DIRS) {
        const path = corpsePath(id, dir);
        const key = Buffer.from(render(path, book[path]).data).toString("base64");
        const other = seen.get(key);
        expect(other === undefined || other === id, `${path} looks like ${other ?? ""}`).toBe(true);
        seen.set(key, id);
      }
  });

  it("every monster has a corpse fallen each of the four ways, committed (docs/17)", () => {
    expect(CORPSE_DIRS).toEqual(["s", "e", "n", "w"]);
    expect(corpsePath("wolf")).toBe("corpses/wolf");
    expect(corpsePath("wolf", "s")).toBe("corpses/wolf");
    expect(corpsePath("wolf", "e")).toBe("corpses/wolf_e");
    for (const id of monsterIds(root))
      for (const dir of CORPSE_DIRS) {
        const path = corpsePath(id, dir);
        expect(book[path], path).toBeDefined();
        expect(existsSync(spriteFile(root, path)), `${path}: run make spritegen`).toBe(true);
        // The committed PNG is the recipe's: nobody forgot to run make spritegen.
        const file = decodePng(readFileSync(spriteFile(root, path)));
        expect(
          Buffer.from(file.data).equals(Buffer.from(render(path, book[path]).data)),
          path,
        ).toBe(true);
      }
    // 21 monsters and the two bodies of a player, four ways each.
    expect(Object.keys(book).length).toBe((monsterIds(root).length + BODY_SEXES.length) * 4);
  });

  it("the east and the west ones differ for every monster, and at least two of the four", () => {
    for (const id of monsterIds(root)) {
      const data = (dir: FallDir): string =>
        Buffer.from(render(corpsePath(id, dir), book[corpsePath(id, dir)]).data).toString("base64");
      expect(data("e"), `${id}: east and west`).not.toBe(data("w"));
      expect(data("s"), `${id}: south and north`).not.toBe(data("n"));
    }
  });

  it("have their own art where the creature's death is drawn that way, derived elsewhere", () => {
    // docs/17's table: the engine draws the boar's and the stag's deaths (and every
    // humanoid's) in the four facings; the hand-made monsters fall facing south only, so
    // their other bodies are that one mirrored; the gull, one image, is tipped four ways.
    const coded = RECIPES;
    const own: Record<string, FallDir[]> = {};
    for (const file of monsterIds(root)) {
      const m = parseYaml(readFileSync(join(root, "data", "monsters", `${file}.yaml`), "utf8")) as {
        sprite?: string;
        look?: unknown;
      };
      own[file] = m.look ? [...CORPSE_DIRS] : ownCorpseDirs(root, m.sprite ?? "", coded);
    }
    const four = Object.keys(own).filter((id) => own[id]?.length === 4);
    expect(four.sort()).toEqual([
      "bramble_stag",
      "bristleback_boar",
      "coffer_smuggler",
      "drowned_miner",
      "obsidian_delver",
      "wreck_looter",
    ]);
    expect(Object.keys(own).filter((id) => own[id]?.length === 0)).toEqual(["thieving_gull"]);
    // Everyone else: the south only.
    for (const [id, dirs] of Object.entries(own))
      if (dirs.length !== 4 && dirs.length !== 0) expect(dirs, id).toEqual(["s"]);
  });

  it("are what the client's fall ends on, pixel for pixel, in every facing (fallArt)", () => {
    // The client plays the fall with packages/renderer fallArt and lowers the body by
    // fallShift of the atlas's rest for that facing (tools/spritepack restsOf): the last
    // frame it draws, mirrored where fallArt says, lowered and darkened, is the corpse PNG.
    let checked = 0;
    for (const id of monsterIds(root)) {
      const m = parseYaml(readFileSync(join(root, "data", "monsters", `${id}.yaml`), "utf8")) as {
        sprite?: string;
        look?: unknown;
      };
      if (m.look || !m.sprite) continue;
      const sprite = m.sprite;
      const frame = (name: string): Image | undefined => {
        const file = join(root, "assets", "sprites", `${name}.png`);
        return existsSync(file) ? decodePng(readFileSync(file)) : undefined;
      };
      const dirs = FALL_DIRS.filter((d) => frame(`${sprite}/death_${d}_0`));
      if (dirs.length === 0) continue; // a single image: the next test
      let frames = 0;
      while (frame(`${sprite}/death_s_${frames}`)) frames++;
      const first = frame(`${sprite}/death_s_0`) as Image;
      // What atlas.json says of it, as far as a fall goes (spritepack restsOf).
      const meta: AnimMeta = {
        w: first.width,
        h: first.height,
        anchor: "bc",
        foot: 3,
        top: 20,
        shadow: "ellipse",
        actions: { death: { frames, ms: 100, dirs } },
      };
      const rests = restsOf(sprite, meta as unknown as PackMeta, frame, undefined);
      for (const dir of FALL_DIRS) {
        const art = fallArt(dirs, dir);
        const last = frame(`${sprite}/death_${art.clip}_${frames - 1}`) as Image;
        const drawn = art.mirror ? mirrored(last) : last;
        // Drawn with its frame's bottom `foot` under the feet line (FEET_LINE over the
        // tile's bottom, where the corpse's frame ends), then fallShift lower.
        const shift = fallShift(meta, rests[dir]) + meta.foot - FEET_LINE;
        const body = createImage(drawn.width, drawn.height);
        for (let y = 0; y < drawn.height; y++) {
          const ty = y + shift;
          if (ty < 0 || ty >= drawn.height) continue;
          body.data.set(
            drawn.data.subarray(y * drawn.width * 4, (y + 1) * drawn.width * 4),
            ty * drawn.width * 4,
          );
        }
        deaden(body);
        const corpse = decodePng(readFileSync(spriteFile(root, corpsePath(id, dir))));
        expect([corpse.width, corpse.height], `${id} ${dir}`).toEqual([body.width, body.height]);
        expect(visible(corpse).equals(visible(body)), `${id} ${dir}`).toBe(true);
        expect(lowest(corpse), `${id} ${dir}`).toBe(corpse.height - 1 - FEET_LINE);
        checked++;
      }
    }
    // The 16 monsters with a death clip, four ways each.
    expect(checked).toBe(16 * 4);
  });

  it("tip a single image four ways, as the client's tip draws each (tipPlacement)", () => {
    const img = block(32, 32, 6, 13, 4, 29); // off centre: every way gives another body
    const boxOf = (im: Image): [number, number, number, number] => {
      let x0 = im.width;
      let y0 = im.height;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < im.height; y++)
        for (let x = 0; x < im.width; x++)
          if ((im.data[(y * im.width + x) * 4 + 3] ?? 0) > 0) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
      return [x0, y0, x1 + 1, y1 + 1];
    };
    const seen = new Set<string>();
    const meta: AnimMeta = {
      w: 32,
      h: 32,
      anchor: "br",
      foot: 0,
      top: 20,
      shadow: "none",
      actions: {},
    };
    const rests = restsOf("gull", meta as unknown as PackMeta, () => undefined, img);
    for (const dir of FALL_DIRS) {
      const fallen = tipTo(img, dir);
      seen.add(Buffer.from(fallen.data).toString("base64"));
      const art = fallArt(undefined, dir);
      // The client: the image mirrored about its middle when art.mirror, anchored at its
      // bottom centre, tipped a quarter turn art.tip and flattened (tipPlacement).
      const at = tipPlacement((Math.PI / 2) * art.tip, TIP_SQUASH, 32, {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        skewX: 0,
        skewY: 0,
      });
      const cos = Math.cos((Math.PI / 2) * art.tip);
      const sin = Math.sin((Math.PI / 2) * art.tip);
      const [bx0, by0, bx1, by1] = boxOf(img);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [px, py] of [
        [bx0, by0],
        [bx1, by0],
        [bx0, by1],
        [bx1, by1],
      ] as const) {
        const u = (px - 16) * (art.mirror ? -1 : 1);
        const v = py - 32;
        xs.push(16 + at.x + u * cos - v * sin);
        ys.push(32 + at.y + TIP_SQUASH * (u * sin + v * cos));
      }
      const [fx0, fy0, fx1, fy1] = boxOf(fallen);
      // The same box, to the pixel across and within one row of rounding down.
      expect(fx0, dir).toBeCloseTo(Math.min(...xs), 5);
      expect(fx1, dir).toBeCloseTo(Math.max(...xs), 5);
      expect(Math.abs(fy0 - Math.min(...ys)), dir).toBeLessThan(1);
      expect(Math.abs(fy1 - Math.max(...ys)), dir).toBeLessThan(1);
      // And the atlas says where it rests (restsOf): the fall ends on the corpse's rows.
      expect(rests[dir], dir).toBe(32 - fy1);
    }
    expect(seen.size).toBe(4);
    // South is the tip there always was; north is its mirror image, east is west's.
    expect(Buffer.from(tipTo(img, "s").data).equals(Buffer.from(tipOver(img).data))).toBe(true);
    expect(
      Buffer.from(tipTo(img, "n").data).equals(Buffer.from(mirrored(tipTo(img, "s")).data)),
    ).toBe(true);
    expect(
      Buffer.from(tipTo(img, "e").data).equals(Buffer.from(mirrored(tipTo(img, "w")).data)),
    ).toBe(true);
  });

  it("no monster may be named like another's corpse fallen another way, or a body", () => {
    expect(bodyClashes(["wolf", "rat"])).toEqual([]);
    expect(bodyClashes(["wolf", "wolf_e"]).join()).toMatch(
      /wolf_e.*corpse of wolf fallen facing e/,
    );
    expect(bodyClashes(["body_male"]).join()).toMatch(/body of a player/);
    expect(bodyClashes(["body_female_n"]).join()).toMatch(/body of a player/);
    expect(bodyClashes(monsterIds(root))).toEqual([]);
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
