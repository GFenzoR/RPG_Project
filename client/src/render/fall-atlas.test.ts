// The fall of every creature ends on the pixels of its corpse, in every facing (docs/17 "Un
// cadáver por dirección"), checked against the real atlas: the frames, the `rest`/`rests`
// and the death facings assets/atlas says, drawn as CreatureBody draws the last frame of a
// fall (packages/renderer fallArt, fallShift, tipPlacement), against the corpse sprite as
// the map draws it (state/corpse-art.ts corpseArt: centred on its tile, standing on its
// bottom edge). The atlas is built by `make sprites` and not committed: without it this
// file is skipped (tools/spritegen corpses.test.ts checks the same from the PNGs, always).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FALL_DIRS,
  FEET_LINE,
  TIP_SQUASH,
  fallArt,
  fallShift,
  lookSprites,
  restFor,
  tipPlacement,
} from "@rpg/renderer";
import type { AnimMeta, FallDir, LayerSlot, Look, LookTables, Worn } from "@rpg/renderer";
import { decodePng, parseYaml } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { bodyCorpse, corpseSprite } from "../state/corpse-art.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const atlasDir = join(root, "assets", "atlas");
const built = existsSync(join(atlasDir, "atlas.json"));

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface PageFrame {
  frame: Rect;
  spriteSourceSize: Rect;
  sourceSize: { w: number; h: number };
}
interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

const T = 32;
/** The canvas the two are drawn on: the tile's top-left corner is at (PAD, PAD). */
const PAD = 96;
const SIZE = PAD * 2 + T;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

describe.skipIf(!built)("the fall ends on the corpse, in the real atlas (make sprites)", () => {
  const index = built
    ? (JSON.parse(readFileSync(join(atlasDir, "atlas.json"), "utf8")) as {
        sprites: Record<string, { page: number }>;
        anims: Record<string, AnimMeta>;
      })
    : { sprites: {}, anims: {} };
  const pages = new Map<number, { frames: Record<string, PageFrame>; image: Bitmap }>();
  const page = (n: number) => {
    let p = pages.get(n);
    if (!p) {
      const json = JSON.parse(readFileSync(join(atlasDir, `atlas-${n}.json`), "utf8")) as {
        frames: Record<string, PageFrame>;
      };
      p = { frames: json.frames, image: decodePng(readFileSync(join(atlasDir, `atlas-${n}.png`))) };
      pages.set(n, p);
    }
    return p;
  };
  /** A sprite as Pixi draws its texture: its whole source box, the trimmed part in place. */
  const sprite = (name: string): Bitmap | undefined => {
    const at = index.sprites[name];
    if (!at) return undefined;
    const p = page(at.page);
    const f = p.frames[name];
    if (!f) return undefined;
    const out = {
      width: f.sourceSize.w,
      height: f.sourceSize.h,
      data: new Uint8Array(f.sourceSize.w * f.sourceSize.h * 4),
    };
    for (let y = 0; y < f.frame.h; y++)
      for (let x = 0; x < f.frame.w; x++) {
        const s = ((f.frame.y + y) * p.image.width + f.frame.x + x) * 4;
        const d = ((f.spriteSourceSize.y + y) * out.width + f.spriteSourceSize.x + x) * 4;
        out.data.set(p.image.data.subarray(s, s + 4), d);
      }
    return out;
  };

  const mask = (): Uint8Array => new Uint8Array(SIZE * SIZE);
  const set = (m: Uint8Array, x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) m[y * SIZE + x] = 1;
  };
  /** The corpse sprite on its tile: centred, standing on the tile's bottom edge. */
  const corpseMask = (name: string): Uint8Array | undefined => {
    const img = sprite(name);
    if (!img) return undefined;
    const m = mask();
    const left = PAD + T / 2 - img.width / 2;
    const top = PAD + T - img.height;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++)
        if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) > 0) set(m, left + x, top + y);
    return m;
  };
  /**
   * The last frame of the fall of one sprite (a layer of a doll, or the whole body) as
   * CreatureBody places it: anchored at its bottom centre on (baseX, baseY + fallY),
   * mirrored where fallArt says, a single image tipped.
   */
  const drawFall = (
    m: Uint8Array,
    name: string,
    place: AnimMeta | undefined,
    own: AnimMeta | undefined,
    dir: FallDir,
    fallY: number,
  ): boolean => {
    const death = own?.actions.death;
    const art = fallArt(death?.dirs, dir);
    const img = death ? sprite(`${name}/death_${art.clip}_${death.frames - 1}`) : sprite(name);
    if (!img) return false;
    const bc = place?.anchor === "bc";
    const baseX = PAD + (bc ? T / 2 : T - img.width / 2);
    const baseY = PAD + (bc ? T - FEET_LINE + (place?.foot ?? 0) : T) + fallY;
    if (death) {
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) === 0) continue;
          const sx = art.mirror ? img.width - 1 - x : x;
          set(m, baseX - img.width / 2 + sx, baseY - img.height + y);
        }
      return true;
    }
    // A single image: every screen pixel's centre taken back through the tip's transform.
    const tip = (Math.PI / 2) * art.tip;
    const at = tipPlacement(tip, TIP_SQUASH, img.height, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
    });
    const cos = Math.cos(tip);
    const sin = Math.sin(tip);
    for (let py = 0; py < SIZE; py++)
      for (let px = 0; px < SIZE; px++) {
        // (X, Y) from the anchor = at + (u cos - v sin, squash (u sin + v cos)).
        const X = px + 0.5 - baseX - at.x;
        const Y = (py + 0.5 - baseY - at.y) / TIP_SQUASH;
        const u = (X * cos + Y * sin) * (art.mirror ? -1 : 1);
        const v = -X * sin + Y * cos;
        const sx = Math.floor(u + img.width / 2);
        const sy = Math.floor(v + img.height);
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        if ((img.data[(sy * img.width + sx) * 4 + 3] ?? 0) > 0) set(m, px, py);
      }
    return true;
  };
  const diff = (a: Uint8Array, b: Uint8Array): { off: number; of: number } => {
    let off = 0;
    let of = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] || b[i]) of++;
      if (a[i] !== b[i]) off++;
    }
    return { off, of };
  };
  /** Pixels of `a` with no pixel of `b` on them or next to them. */
  const strays = (a: Uint8Array, b: Uint8Array): number => {
    let n = 0;
    for (let y = 1; y < SIZE - 1; y++)
      for (let x = 1; x < SIZE - 1; x++) {
        if (!a[y * SIZE + x]) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if (b[(y + dy) * SIZE + x + dx]) {
              near = true;
              break;
            }
        if (!near) n++;
      }
    return n;
  };
  const boxOf = (m: Uint8Array): number[] => {
    let x0 = SIZE;
    let y0 = SIZE;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++)
        if (m[y * SIZE + x]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    return [x0, y0, x1, y1];
  };

  const monsters = readdirSync(join(root, "data", "monsters"))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseYaml(readFileSync(join(root, "data", "monsters", f), "utf8")))
    .filter(isObj);
  const looks = parseYaml(readFileSync(join(root, "data", "looks.yaml"), "utf8"));
  const tables: LookTables = {
    skins: {},
    hairColors: {},
    tints: {},
    hides: (isObj(looks) && isObj(looks["hides"]) ? looks["hides"] : {}) as Record<
      string,
      LayerSlot[]
    >,
  };
  /** The layer sprites of a look of data/ (data/monsters `look`, or a player's plain body). */
  const layersOf = (raw: Obj): string[] => {
    const look: Look = {
      sex: str(raw["sex"]),
      body: str(raw["body"]),
      skin: str(raw["skin"]),
      hair: str(raw["hair"]),
      hairColor: str(raw["hair_color"]),
      beard: str(raw["beard"]),
    };
    const worn: Worn = {};
    if (isObj(raw["worn"]))
      for (const [slot, piece] of Object.entries(raw["worn"]))
        if (isObj(piece))
          (worn as Record<string, unknown>)[slot] = {
            shape: str(piece["shape"]),
            tint: str(piece["tint"]),
          };
    return Object.values(lookSprites(look, worn, tables)).map((l) => l.sprite);
  };
  /** A doll's fall: every layer's last frame, lowered to where the lowest of them rests. */
  const dollFall = (layers: string[], dir: FallDir): Uint8Array | undefined => {
    const body = index.anims[layers[0] ?? ""];
    let rest = restFor(body, dir);
    for (const l of layers) {
      const r = restFor(index.anims[l], dir);
      if (r !== undefined && (rest === undefined || r < rest)) rest = r;
    }
    const m = mask();
    for (const l of layers)
      if (!drawFall(m, l, body, index.anims[l], dir, fallShift(body, rest))) return undefined;
    return m;
  };

  it("every monster with a death clip: the same pixels, the four ways", () => {
    let checked = 0;
    for (const mon of monsters) {
      const id = str(mon["id"]);
      const name = str(mon["sprite"]);
      const meta = index.anims[name];
      if (isObj(mon["look"]) || !meta?.actions.death) continue;
      for (const dir of FALL_DIRS) {
        const fall = mask();
        const drawn = drawFall(fall, name, meta, meta, dir, fallShift(meta, restFor(meta, dir)));
        expect(drawn, `${id} ${dir}: the last frame of its death`).toBe(true);
        const corpse = corpseMask(corpseSprite(id, dir));
        expect(corpse, `${id} ${dir}: its corpse`).toBeDefined();
        expect(diff(fall, corpse as Uint8Array).off, `${id} fallen facing ${dir}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(16 * 4);
  });

  it("every humanoid monster and a player's body of each sex: the doll's layers together", () => {
    const dolls: { who: string; layers: string[] }[] = monsters
      .filter((m) => isObj(m["look"]))
      .map((m) => ({ who: str(m["id"]), layers: layersOf(m["look"] as Obj) }));
    // tools/spritegen BODY_LOOKS: the plain person a player's body is drawn as.
    dolls.push({
      who: bodyCorpse("male"),
      layers: layersOf({
        sex: "male",
        body: "sturdy",
        hair: "short",
        beard: "none",
        worn: { torso: { shape: "tunic" }, legs: { shape: "trousers" } },
      }),
    });
    dolls.push({
      who: bodyCorpse("female"),
      layers: layersOf({
        sex: "female",
        body: "slender",
        hair: "long",
        beard: "none",
        worn: { torso: { shape: "tunic" }, legs: { shape: "trousers" } },
      }),
    });
    expect(dolls.length).toBe(4 + 2);
    for (const doll of dolls)
      for (const dir of FALL_DIRS) {
        const fall = dollFall(doll.layers, dir);
        expect(fall, `${doll.who} ${dir}: its layers' death frames`).toBeDefined();
        const corpse = corpseMask(corpseSprite(doll.who, dir));
        expect(corpse, `${doll.who} ${dir}: its corpse`).toBeDefined();
        expect(
          diff(fall as Uint8Array, corpse as Uint8Array).off,
          `${doll.who} fallen facing ${dir}`,
        ).toBe(0);
      }
  });

  it("a single image (the gull) tips onto its corpse: the same box, the four ways", () => {
    let checked = 0;
    for (const mon of monsters) {
      const id = str(mon["id"]);
      const name = str(mon["sprite"]);
      const meta = index.anims[name];
      if (isObj(mon["look"]) || !name || meta?.actions.death) continue;
      for (const dir of FALL_DIRS) {
        const fall = mask();
        expect(drawFall(fall, name, meta, meta, dir, fallShift(meta, restFor(meta, dir)))).toBe(
          true,
        );
        const corpse = corpseMask(corpseSprite(id, dir)) as Uint8Array;
        expect(corpse, `${id} ${dir}: its corpse`).toBeDefined();
        // The tip is a resampling (spritegen keeps one row of the turned image per row,
        // the screen samples pixel centres): the same box within a pixel of rounding, the
        // same side up, and nearly every pixel.
        const [fallBox, corpseBox] = [boxOf(fall), boxOf(corpse)];
        for (let i = 0; i < 4; i++)
          expect(
            Math.abs((fallBox[i] ?? 0) - (corpseBox[i] ?? 0)),
            `${id} fallen facing ${dir}: ${fallBox.join()} on ${corpseBox.join()}`,
          ).toBeLessThanOrEqual(1);
        // No pixel of one farther than a pixel from the other: the same body, not its
        // mirror image nor the other tip.
        expect(strays(fall, corpse), `${id} fallen facing ${dir}`).toBe(0);
        expect(strays(corpse, fall), `${id} fallen facing ${dir}`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(4);
  });
});
