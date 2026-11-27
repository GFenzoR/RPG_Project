// The fall of every creature ends on the pixels of its corpse, in every facing (docs/17 "Un
// cadáver por dirección"), checked against the real atlas with the client's own renderer:
// the clips the canvas builds from assets/atlas (clips.ts spriteClips), a CreatureBody of
// them (a paper doll's layers as the canvas stacks them), the pose packages/renderer
// animate gives at the end of a death begun as the canvas begins it (startDeath with
// CreatureBody.fallY), and CreatureBody.draw. What is compared is where Pixi would put
// each sprite's pixels (its texture, position, scale and skew after draw) against the
// corpse sprite as the map draws it (state/corpse-art.ts corpseArt: centred on its tile,
// standing on its bottom edge). The atlas is built by `make sprites` and not committed:
// without it this file is skipped locally and FAILS in CI, where the atlas is built
// before the tests (.github/workflows/ci.yml; tools/spritegen corpses.test.ts checks the
// PNG side from assets/sprites, always).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sprite, Texture } from "pixi.js";
import type { Container } from "pixi.js";
import {
  FALL_DIRS,
  animate,
  dirIndex,
  fallMs,
  lookSprites,
  newAnimInput,
  newAnimState,
  newPose,
  startDeath,
} from "@rpg/renderer";
import type { FallDir, LayerSlot, Look, LookTables, Worn } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { decodePng, parseYaml } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { bodyCorpse, corpseSprite } from "../state/corpse-art.ts";
import { spriteClips } from "./clips.ts";
import type { ClipSet } from "./clips.ts";
import { CreatureBody, SpritePool } from "./creature-body.ts";
import type { BodyLayer } from "./creature-body.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const atlasDir = join(root, "assets", "atlas");
const built = existsSync(join(atlasDir, "atlas.json"));
/** In CI the atlas is built before the tests: a missing one is an error there, not a skip. */
const required = Boolean(process.env["CI"]);

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

describe.runIf(required && !built)("the real atlas (make sprites)", () => {
  it("is built before the tests in CI", () => {
    expect(built, `${atlasDir}/atlas.json: run make sprites before the tests`).toBe(true);
  });
});

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
  /** The atlas sprites as the textures the canvas hands CreatureBody, with their pixels. */
  const bitmaps = new WeakMap<Texture, Bitmap>();
  const textures = new Map<string, Texture | undefined>();
  const texture = (name: string): Texture | undefined => {
    if (textures.has(name)) return textures.get(name);
    const img = sprite(name);
    let t: Texture | undefined;
    if (img) {
      t = new Texture();
      t.frame.width = img.width;
      t.frame.height = img.height;
      bitmaps.set(t, img);
    }
    textures.set(name, t);
    return t;
  };
  /** The clips of a sprite path, as the canvas builds them (game-canvas.ts creatureClips). */
  const clipsOf = (path: string): ClipSet<Texture> | undefined =>
    spriteClips(path, index.anims, texture);
  const pool = new SpritePool();

  /** Every sprite under `node`, back to front. */
  const spritesOf = (node: Container, out: Sprite[] = []): Sprite[] => {
    for (const child of node.children) {
      if (child instanceof Sprite) out.push(child);
      else if (child.visible) spritesOf(child, out);
    }
    return out;
  };
  /**
   * The pixels Pixi draws of `sp` as CreatureBody.draw left it: every screen pixel's
   * centre taken back through the sprite's own transform to its texture.
   */
  const raster = (m: Uint8Array, sp: Sprite): boolean => {
    const img = bitmaps.get(sp.texture);
    if (!img) return false;
    sp.updateLocalTransform();
    const { a, b, c, d, tx, ty } = sp.localTransform;
    const det = a * d - b * c;
    for (let py = 0; py < SIZE; py++)
      for (let px = 0; px < SIZE; px++) {
        const X = px + 0.5 - PAD - tx;
        const Y = py + 0.5 - PAD - ty;
        const sx = Math.floor((d * X - c * Y) / det + sp.anchor.x * img.width);
        const sy = Math.floor((a * Y - b * X) / det + sp.anchor.y * img.height);
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        if ((img.data[(sy * img.width + sx) * 4 + 3] ?? 0) > 0) set(m, px, py);
      }
    return true;
  };
  /**
   * The body of `clips` (and a paper doll's `layers`) at the end of its fall facing `dir`,
   * as the canvas plays a death: startDeath with the body's own fallY, the pose of the
   * moment the fall ends, CreatureBody.draw. Undefined: a sprite it draws has no pixels.
   */
  const fallen = (
    clips: ClipSet<Texture>,
    layers: readonly BodyLayer[],
    dir: FallDir,
  ): Uint8Array | undefined => {
    const body = new CreatureBody(clips, T, 0xffffff, layers, pool);
    const state = newAnimState(1, 0);
    const input = newAnimInput();
    const pose = newPose();
    // Alive it looked the other way on the screen: the fall is drawn as its corpse lies,
    // whatever way the drawing looked before.
    input.dir = dir === "e" ? "w" : "e";
    input.now = 1000;
    animate(state, clips.meta, input, pose);
    body.draw(pose, dirIndex(input.dir));
    startDeath(state, 1000, body.fallY(dir), dir);
    input.now = 1000 + fallMs(clips.meta);
    animate(state, clips.meta, input, pose);
    expect(pose.action).toBe("death");
    expect(pose.done).toBe(false);
    body.draw(pose, dirIndex(state.fallDir));
    const m = mask();
    let ok = true;
    for (const sp of spritesOf(body.root)) if (sp.visible && !raster(m, sp)) ok = false;
    body.release();
    return ok ? m : undefined;
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
  const layersOf = (raw: Obj): { slot: LayerSlot; sprite: string }[] => {
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
    return Object.entries(lookSprites(look, worn, tables)).map(([slot, l]) => ({
      slot: slot as LayerSlot,
      sprite: l.sprite,
    }));
  };
  /** A doll of those layers, as the canvas builds it (game-canvas.ts dollOf). */
  const dollFall = (
    sprites: { slot: LayerSlot; sprite: string }[],
    dir: FallDir,
  ): Uint8Array | undefined => {
    const layers: BodyLayer[] = [];
    let body: ClipSet<Texture> | undefined;
    for (const { slot, sprite: path } of sprites) {
      const clips = clipsOf(path);
      if (!clips?.meta) return undefined;
      if (slot === "body") body = clips;
      layers.push({ slot, clips, tint: 0xffffff });
    }
    return body ? fallen(body, layers, dir) : undefined;
  };

  it("every monster with a death clip: the same pixels, the four ways", () => {
    let checked = 0;
    for (const mon of monsters) {
      const id = str(mon["id"]);
      const name = str(mon["sprite"]);
      const meta = index.anims[name];
      if (isObj(mon["look"]) || !meta?.actions.death) continue;
      for (const dir of FALL_DIRS) {
        const clips = clipsOf(name);
        expect(clips?.meta?.actions.death, `${id}: its death clip, whole`).toBeDefined();
        const fall = clips && fallen(clips, [], dir);
        expect(fall, `${id} ${dir}: the last frame of its death`).toBeDefined();
        const corpse = corpseMask(corpseSprite(id, dir));
        expect(corpse, `${id} ${dir}: its corpse`).toBeDefined();
        expect(
          diff(fall as Uint8Array, corpse as Uint8Array).off,
          `${id} fallen facing ${dir}`,
        ).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(17 * 4);
  });

  it("every humanoid monster and a player's body of each sex: the doll's layers together", () => {
    const dolls: { who: string; layers: { slot: LayerSlot; sprite: string }[] }[] = monsters
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

  // No creature is a single image today (the gull has its Gemini sheet): this holds a
  // future one to the same rule. The tip of a fixture image is checked in spritegen's
  // corpses.test.ts, which does not need the atlas.
  it("a single image, if there is one, tips onto its corpse: the same box, the four ways", () => {
    for (const mon of monsters) {
      const id = str(mon["id"]);
      const name = str(mon["sprite"]);
      const meta = index.anims[name];
      if (isObj(mon["look"]) || !name || meta?.actions.death) continue;
      for (const dir of FALL_DIRS) {
        const clips = clipsOf(name);
        const fall = clips && fallen(clips, [], dir);
        expect(fall, `${id} ${dir}: its image`).toBeDefined();
        if (!fall) continue;
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
      }
    }
  });
});
