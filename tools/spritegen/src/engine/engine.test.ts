import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createImage, encodePng, parseManifest } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import * as CLIENT_ANIM from "../../../../packages/renderer/src/anim.ts";
import { lighten, PALETTE } from "../palette.ts";
import { RECIPES, recipePaths } from "../index.ts";
import { ACTION_ORDER, engineFrames, framePaths } from "./book.ts";
import { engineProblems, hintProblems } from "./check.ts";
import {
  box,
  components,
  ditherShare,
  gateProblems,
  lstar,
  offPalette,
  outlineCoverage,
  partialAlpha,
  silhouetteIoU,
} from "./gates.ts";
import { apply, compose, euler, rotZ, toWorld } from "./math.ts";
import type { Vec3 } from "./math.ts";
import { keys, trot } from "./motion.ts";
import { allowedColors, colorKey, renderSpec } from "./render.ts";
import { frameTime, partTransforms, poseAt } from "./rig.ts";
import { intersect } from "./shapes.ts";
import { contactSheet, reviewLineup } from "./sheet.ts";
import { validateSpec } from "./spec.ts";
import type { PartSpec, ShapeSpec, SpriteSpec } from "./spec.ts";
import { ENGINE_SPECS } from "./specs/index.ts";
import {
  ACTIONS,
  CLIENT,
  FACING_YAW,
  GLOW_OUTLINE,
  LIGHT,
  OUTLINE,
  SIZES,
  VIEW_DIR,
} from "./style.ts";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
/** The value, or a thrown error naming what was missing (no non-null assertions). */
function must<T>(v: T | undefined, what = "value"): T {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
}
const close = (a: Vec3, b: Vec3, eps = 1e-6): boolean =>
  a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < eps);
const key = (img: Image, x: number, y: number): string => {
  const i = (y * img.width + x) * 4;
  return img.data[i + 3] ? `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}` : "";
};
const lum = (img: Image, x: number, y: number): number => {
  const i = (y * img.width + x) * 4;
  return lstar(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0);
};

/** A minimal creature rig: a body, a head and four legs that trot. */
function critter(over: Partial<SpriteSpec> = {}, parts?: PartSpec[]): SpriteSpec {
  const leg = (name: string, x: number, y: number): PartSpec => ({
    name,
    parent: "body",
    at: [x, y, -4],
    material: "fur",
    shapes: [{ type: "capsule", a: [0, 0, 0], b: [0, 0, -6], radius: 1.6 }],
  });
  return {
    sprite: "creatures/test_critter",
    size: "mediumAnimal",
    parts: parts ?? [
      {
        name: "body",
        at: [0, 0, 10],
        material: "fur",
        shapes: [{ type: "ellipsoid", radii: [9, 5, 5] }],
      },
      {
        name: "head",
        parent: "body",
        at: [-9, 0, 2],
        material: "fur",
        shapes: [{ type: "ellipsoid", center: [-2, 0, 0], radii: [3.5, 3, 3] }],
        marks: [{ at: [-4.5, -2.6, 0.8], material: "eye" }],
      },
      leg("leg_fl", -5, -2.5),
      leg("leg_fr", -5, 2.5),
      leg("leg_bl", 5, -2.5),
      leg("leg_br", 5, 2.5),
    ],
    actions: {
      idle: { frames: 2, ms: 500, keys: keys([0, {}], [0.5, { body: { move: [0, 0, 1] } }]) },
      walk: trot({
        legs: {
          frontLeft: "leg_fl",
          frontRight: "leg_fr",
          backLeft: "leg_bl",
          backRight: "leg_br",
        },
        swing: 25,
        lift: 1.5,
      }),
      attack: {
        frames: 3,
        ms: 110,
        keys: keys(
          [0, { "*": { move: [3, 0, 0] } }],
          [0.5, { "*": { move: [-6, 0, 0] } }],
          [1, {}],
        ),
      },
      death: {
        frames: 4,
        ms: 150,
        keys: keys([0, {}], [1, { "*": { rot: [-90, 0, 0], move: [0, -8, 5] } }]),
      },
    },
    ...over,
  };
}

/** One part with one shape, as an object, for renderer tests. */
const still = (shape: ShapeSpec, part: Partial<PartSpec> = {}): SpriteSpec => ({
  sprite: "decor/test_still",
  size: "object",
  parts: [{ name: "p", material: "stone", shapes: [shape], ...part }],
});

describe("style rules (docs/17, one place)", () => {
  it("match the client's feet line and contact shadow", () => {
    expect(CLIENT.feetLine).toBe(CLIENT_ANIM.FEET_LINE);
    expect(CLIENT.shadowW).toBe(CLIENT_ANIM.SHADOW_W);
    expect(CLIENT.shadowH).toBe(CLIENT_ANIM.SHADOW_H);
    expect(CLIENT.shadowAlpha).toBe(CLIENT_ANIM.SHADOW_ALPHA);
  });

  it("look down from 60 degrees off the vertical and light from above, left and the front", () => {
    expect(VIEW_DIR[1]).toBeGreaterThan(0); // into the scene: north
    expect(VIEW_DIR[2]).toBeLessThan(0); // and down
    expect(Math.atan2(-VIEW_DIR[2], VIEW_DIR[1]) * (180 / Math.PI)).toBeCloseTo(30, 6);
    expect(LIGHT.dir[0]).toBeLessThan(0); // from the left
    expect(LIGHT.dir[1]).toBeLessThan(0); // from the camera's side
    expect(LIGHT.dir[2]).toBeGreaterThan(Math.abs(LIGHT.dir[0])); // mostly from above
  });

  it("turn a west-facing model's nose to every facing (ANI-1)", () => {
    const nose: Vec3 = [-1, 0, 0];
    const want: Record<string, Vec3> = { w: [-1, 0, 0], s: [0, -1, 0], e: [1, 0, 0], n: [0, 1, 0] };
    for (const [dir, v] of Object.entries(want))
      expect(close(apply(rotZ(FACING_YAW[dir as "n"]), nose), v), dir).toBe(true);
  });

  it("give creatures a darker outline than objects (ART-5)", () => {
    expect(OUTLINE.creature.dark).toBe("outline");
    expect(OUTLINE.object.dark).not.toBe("outline");
  });
});

describe("primitives", () => {
  const down: Vec3 = [0, 0, -1];
  const from = (x: number, y: number): Vec3 => [x, y, 100];

  it("hit an ellipsoid where it is, with the outward normal", () => {
    const h = intersect({ type: "ellipsoid", radii: [4, 4, 2] }, from(0, 0), down);
    expect(h?.t).toBeCloseTo(98, 6);
    expect(close(h?.n ?? [0, 0, 0], [0, 0, 1])).toBe(true);
    expect(intersect({ type: "ellipsoid", radii: [4, 4, 2] }, from(5, 0), down)).toBeUndefined();
  });

  it("hit a box on the face the ray enters", () => {
    const b: ShapeSpec = { type: "box", min: [-1, -1, 0], max: [1, 1, 3] };
    const h = intersect(b, from(0, 0), down);
    expect(h?.t).toBeCloseTo(97, 6);
    expect(close(h?.n ?? [0, 0, 0], [0, 0, 1])).toBe(true);
    const side = intersect(b, [-10, 0, 1], [1, 0, 0]);
    expect(close(side?.n ?? [0, 0, 0], [-1, 0, 0])).toBe(true);
  });

  it("hit a cylinder on its side and on its cap", () => {
    const c: ShapeSpec = { type: "cylinder", a: [0, 0, 0], b: [0, 0, 4], radius: 2 };
    expect(intersect(c, from(0, 0), down)?.t).toBeCloseTo(96, 6);
    const side = intersect(c, [-10, 0, 2], [1, 0, 0]);
    expect(side?.t).toBeCloseTo(8, 6);
    expect(close(side?.n ?? [0, 0, 0], [-1, 0, 0])).toBe(true);
    expect(intersect(c, [-10, 0, 5], [1, 0, 0])).toBeUndefined();
  });

  it("taper a capsule from one radius to the other", () => {
    const c: ShapeSpec = { type: "capsule", a: [0, 0, 0], b: [10, 0, 0], radius: 3, radius2: 1 };
    const at = (x: number): number | undefined => intersect(c, [x, 0, 50], down)?.t;
    expect(50 - (at(0) ?? 0)).toBeCloseTo(3, 1);
    expect(50 - (at(10) ?? 0)).toBeCloseTo(1, 1);
    expect(at(13)).toBeUndefined();
  });

  it("extrude a profile: hit through its cap or its side wall", () => {
    const e: ShapeSpec = {
      type: "extrusion",
      axis: "y",
      from: 0,
      to: 4,
      points: [
        [0, 0],
        [4, 0],
        [0, 4],
      ],
    };
    const cap = intersect(e, [1, -10, 1], [0, 1, 0]);
    expect(cap?.t).toBeCloseTo(10, 6);
    expect(close(cap?.n ?? [0, 0, 0], [0, -1, 0])).toBe(true);
    // Down through the slanted side (x + z = 4): at x = 2 it meets it at z = 2.
    const wall = intersect(e, [2, 2, 10], [0, 0, -1]);
    expect(wall?.t).toBeCloseTo(8, 6);
    expect(close(wall?.n ?? [0, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2])).toBe(true);
    expect(intersect(e, [5, 2, 10], [0, 0, -1])).toBeUndefined();
    // A bulged card's cap leans out toward its rim.
    const card: ShapeSpec = {
      type: "polygon",
      points: [
        [-2, -2],
        [2, -2],
        [2, 2],
        [-2, 2],
      ],
      bulge: 1,
    };
    const rimHit = intersect(card, [1.5, -10, 0], [0, 1, 0]);
    expect((rimHit?.n[0] ?? 0) > 0.3).toBe(true);
  });
});

describe("specs are validated", () => {
  const problems = (s: SpriteSpec): string => validateSpec(s).join("\n");

  it("accept a good one", () => {
    expect(validateSpec(critter())).toEqual([]);
    for (const s of ENGINE_SPECS) expect(validateSpec(s), s.sprite).toEqual([]);
  });

  it("refuse what breaks the style rules or the rig", () => {
    const c = critter();
    expect(problems({ ...c, canvas: [48, 48] })).toMatch(/ART-2 canvas/);
    expect(problems({ ...c, sprite: "Creatures/X" })).toMatch(/lowercase path/);
    const parts = [...c.parts];
    parts[0] = { ...must(parts[0]), material: "unobtainium" as "fur" };
    expect(problems({ ...c, parts })).toMatch(/not in palette.ts/);
    expect(problems({ ...c, parts: [...c.parts.slice(1), ...c.parts.slice(0, 1)] })).toMatch(
      /parent body must be declared before it/,
    );
    const a = c.actions ?? {};
    expect(
      problems({ ...c, actions: { ...a, idle: { frames: 6, ms: 500, keys: keys([0, {}]) } } }),
    ).toMatch(/6 frames, ANI-2 wants 2-4/);
    expect(
      problems({ ...c, actions: { ...a, idle: { frames: 2, ms: 900, keys: keys([0, {}]) } } }),
    ).toMatch(/900 ms per frame/);
    expect(
      problems({ ...c, actions: { ...a, attack: { frames: 3, ms: 300, keys: keys([0, {}]) } } }),
    ).toMatch(/900 ms in all/);
    expect(
      problems({ ...c, actions: { ...a, walk: { frames: 4, ms: 100, keys: keys([0, {}]) } } }),
    ).toMatch(/walk plays by distance/);
    expect(
      problems({
        ...c,
        actions: { ...a, idle: { frames: 2, ms: 500, keys: keys([0, { tail: {} }]) } },
      }),
    ).toMatch(/unknown part tail/);
    expect(
      problems({
        ...c,
        actions: { ...a, idle: { frames: 2, ms: 500, keys: keys([0.5, {}], [0.2, {}]) } },
      }),
    ).toMatch(/in order/);
    expect(problems({ ...c, actions: { walk: must(a.walk) } })).toMatch(/needs a idle action/);
    expect(
      problems({
        ...still({ type: "box", min: [0, 0, 0], max: [1, 1, 1] }),
        actions: { idle: must(a.idle) },
      }),
    ).toMatch(/has no actions/);
    expect(problems(still({ type: "ellipsoid", radii: [1, 0, 1] }))).toMatch(/radii must be > 0/);
    expect(problems(still({ type: "box", min: [0, 0, 0], max: [1, 0, 1] }))).toMatch(
      /min must be below max/,
    );
    expect(
      problems(
        still({
          type: "polygon",
          points: [
            [0, 0],
            [1, 1],
          ],
        }),
      ),
    ).toMatch(/3 points/);
  });
});

describe("the rig", () => {
  it("samples looping actions around the cycle and one-shots end to end", () => {
    expect(frameTime("walk", 3, 4)).toBe(0.75);
    expect(frameTime("death", 3, 4)).toBe(1);
    expect(frameTime("attack", 0, 3)).toBe(0);
  });

  it("interpolates keys, wrapping a loop from its last key to its first", () => {
    const a = {
      frames: 4,
      keys: keys([0, { p: { rot: [0, 0, 0] } }], [0.5, { p: { rot: [0, 40, 0] } }]),
    };
    expect(poseAt(a, 0.25, true).get("p")?.rot[1]).toBeCloseTo(20, 9);
    expect(poseAt(a, 0.75, true).get("p")?.rot[1]).toBeCloseTo(20, 9); // back toward the first
    expect(poseAt(a, 0.75, false).get("p")?.rot[1]).toBeCloseTo(40, 9); // a one-shot holds
  });

  it("hangs children from their parent's joint, so a turned hip moves the whole leg", () => {
    const spec = critter();
    const pose = poseAt({ frames: 1, keys: keys([0, { body: { rot: [0, 0, 90] } }]) }, 0, true);
    const t = partTransforms(spec, pose, "w");
    const legIndex = spec.parts.findIndex((p) => p.name === "leg_fl");
    // leg_fl's hip is at (-5, -2.5, -4) from the body at (0, 0, 10); a quarter turn of the
    // body about z takes it to (2.5, -5, 6).
    expect(close(toWorld(must(t[legIndex]), [0, 0, 0]), [2.5, -5, 6], 1e-9)).toBe(true);
    expect(
      close(compose(must(t[0]), { rot: euler([0, 0, 0]), pos: [1, 0, 0] }).pos, [0, 1, 10], 1e-9),
    ).toBe(true);
  });

  it("trots in diagonal pairs (ANI-2: 4 frames), each leg lifted while it swings forward", () => {
    const walk = trot({
      legs: { frontLeft: "a", frontRight: "b", backLeft: "c", backRight: "d" },
      swing: 20,
      lift: 2,
    });
    expect(walk.frames).toBe(4);
    const k = (f: number, leg: string): { rot?: Vec3; move?: Vec3 } =>
      walk.keys[f]?.pose[leg] ?? {};
    for (let f = 0; f < 4; f++) {
      expect(k(f, "a")).toEqual(k(f, "d")); // front left with back right
      expect(k(f, "b")).toEqual(k(f, "c"));
    }
    expect(k(0, "a").rot?.[1]).toBe(20);
    expect(k(0, "b").rot?.[1]).toBe(-20);
    expect(k(3, "a").move?.[2]).toBe(2);
    expect(k(1, "a").move?.[2]).toBe(0);
  });
});

describe("the renderer", () => {
  it("lights a ball from the top-left and keeps every pixel opaque or clear, in its palette", () => {
    const spec = still({ type: "ellipsoid", center: [0, 0, 6], radii: [6, 6, 6] });
    const img = renderSpec(spec);
    expect(partialAlpha(img)).toBe(0);
    expect(offPalette(img, allowedColors(spec))).toEqual([]);
    const b = must(box(img));
    const cx = Math.round((b[0] + b[2]) / 2);
    const cy = Math.round((b[1] + b[3]) / 2);
    expect(lum(img, cx - 3, cy - 3)).toBeGreaterThan(lum(img, cx + 3, cy + 3));
  });

  it("outlines the silhouette darker on the shadow side than on the lit side (ART-5)", () => {
    const spec = critter();
    const img = renderSpec(spec, { action: "idle", dir: "s", frame: 0 });
    const fur = PALETTE.fur;
    const b = must(box(img));
    const row = Math.round((b[1] + b[3]) / 2);
    let left = -1;
    let right = -1;
    for (let x = 0; x < img.width; x++)
      if (key(img, x, row)) {
        if (left < 0) left = x;
        right = x;
      }
    expect(key(img, right, row)).toBe(colorKey(fur.outline));
    expect(key(img, left, row)).toBe(colorKey(fur.deep));
  });

  it("draws a crease on the farther of two overlapping parts", () => {
    const spec: SpriteSpec = {
      sprite: "decor/test_crease",
      size: "object",
      parts: [
        {
          name: "back",
          material: "stone",
          shapes: [{ type: "box", min: [-8, 4, 0], max: [8, 8, 12] }],
        },
        {
          name: "front",
          material: "wood",
          shapes: [{ type: "box", min: [-3, -6, 0], max: [3, -2, 8] }],
        },
      ],
    };
    const img = renderSpec(spec);
    const deep = colorKey(PALETTE.stone[OUTLINE.object.crease]);
    let crease = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        if (key(img, x, y) !== deep) continue;
        if (
          [key(img, x - 1, y), key(img, x + 1, y), key(img, x, y - 1)].some(
            (k) =>
              k.length && k !== deep && Object.values(PALETTE.wood).some((c) => colorKey(c) === k),
          )
        )
          crease++;
      }
    expect(crease).toBeGreaterThan(3);
  });

  it("creases fire in its shadow shade where a nearer glowing part overlaps it", () => {
    const glowing = (name: string, shape: ShapeSpec): PartSpec => ({
      name,
      material: "flame",
      glow: true,
      shapes: [shape],
    });
    const flat = (front: boolean): SpriteSpec => ({
      sprite: "decor/test_fire_crease",
      size: "object",
      parts: [
        glowing("back", { type: "box", min: [-8, 4, 0], max: [8, 8, 12] }),
        ...(front ? [glowing("front", { type: "box", min: [-3, -6, 0], max: [3, -2, 8] })] : []),
      ],
    });
    const shade = colorKey(PALETTE.flame[GLOW_OUTLINE.crease]);
    const count = (img: Image): number => {
      let n = 0;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) if (key(img, x, y) === shade) n++;
      return n;
    };
    expect(count(renderSpec(flat(true)))).toBeGreaterThan(count(renderSpec(flat(false))) + 3);
  });

  it("paints a mark where it is seen and not through what is in front of it", () => {
    const mark = { at: [0, -6, 6] as Vec3, material: "berry" as const, tone: "base" as const };
    const red = colorKey(PALETTE.berry.base);
    const seen = renderSpec(
      still({ type: "ellipsoid", center: [0, 0, 6], radii: [6, 6, 6] }, { marks: [mark] }),
    );
    const hidden = renderSpec(
      still(
        { type: "ellipsoid", center: [0, 0, 6], radii: [6, 6, 6] },
        { marks: [{ ...mark, at: [0, 6, 6] }] },
      ),
    );
    const has = (img: Image): boolean => {
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) if (key(img, x, y) === red) return true;
      return false;
    };
    expect(has(seen)).toBe(true);
    expect(has(hidden)).toBe(false);
  });

  it("makes fire glow brightest where it faces the camera, and glints on shiny parts", () => {
    const fire = still(
      { type: "ellipsoid", center: [0, 0, 6], radii: [6, 6, 6] },
      { material: "ember", glow: true },
    );
    const img = renderSpec(fire);
    const b = must(box(img));
    const mid = key(img, Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2));
    expect(mid).toBe(colorKey(PALETTE.ember.light));
    // Its own outline, in any sprite: the red rim on the lit side, a dark ember on the other.
    const row = Math.round((b[1] + b[3]) / 2);
    expect(key(img, b[0], row)).toBe(colorKey(PALETTE.ember[GLOW_OUTLINE.lit]));
    expect(key(img, b[2], row)).toBe(colorKey(PALETTE.ember[GLOW_OUTLINE.dark]));
    const metal = renderSpec(
      still(
        { type: "ellipsoid", center: [0, 0, 6], radii: [6, 6, 6] },
        { material: "iron", shiny: true },
      ),
    );
    const glint = colorKey(lighten(PALETTE.iron.light, 0.35));
    let n = 0;
    for (let y = 0; y < metal.height; y++)
      for (let x = 0; x < metal.width; x++) if (key(metal, x, y) === glint) n++;
    expect(n).toBeGreaterThan(0);
  });

  it("renders the east facing from the model, not as a mirrored west (the light stays left)", () => {
    const spec = critter();
    const w = renderSpec(spec, { action: "idle", dir: "w", frame: 0 });
    const e = renderSpec(spec, { action: "idle", dir: "e", frame: 0 });
    const mirrored = createImage(w.width, w.height);
    for (let y = 0; y < w.height; y++)
      for (let x = 0; x < w.width; x++)
        for (let c = 0; c < 4; c++)
          mirrored.data[(y * w.width + x) * 4 + c] =
            w.data[(y * w.width + (w.width - 1 - x)) * 4 + c] ?? 0;
    expect(silhouetteIoU(e, mirrored)).toBeGreaterThan(0.8); // the same shape...
    expect(encodePng(e).equals(encodePng(mirrored))).toBe(false); // ...lit from the same side
  });

  it("is deterministic, and its texture comes from the seed and moves with its part", () => {
    const tex = (dx: number): SpriteSpec =>
      still(
        { type: "box", min: [-6 + dx, -4, 0], max: [6 + dx, 4, 10] },
        { material: "boarFur", texture: { amount: 0.3, cell: [1.5, 1.5, 1.5] }, at: [0, 0, 0] },
      );
    const a = renderSpec(tex(0), undefined, 7);
    expect(encodePng(a).equals(encodePng(renderSpec(tex(0), undefined, 7)))).toBe(true);
    expect(encodePng(a).equals(encodePng(renderSpec(tex(0), undefined, 8)))).toBe(false);
    // The same part moved 2 px by its joint: the texture shifts with it, pixel for pixel.
    const moved = renderSpec(
      { ...tex(0), parts: [{ ...must(tex(0).parts[0]), at: [2, 0, 0] }] },
      undefined,
      7,
    );
    for (let y = 0; y < a.height; y++)
      for (let x = 4; x < a.width - 4; x++)
        expect(key(moved, x + 2, y), `${x},${y}`).toBe(key(a, x, y));
  });
});

describe("quality gates", () => {
  const img = (
    w: number,
    h: number,
    paint: (x: number, y: number) => readonly number[] | undefined,
  ): Image => {
    const out = createImage(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = paint(x, y);
        if (c) out.data.set([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 255], (y * w + x) * 4);
      }
    return out;
  };

  it("catch partial alpha, colours outside the palette and pure black", () => {
    expect(
      partialAlpha(img(4, 4, (x, y) => (x === 1 && y === 2 ? [10, 10, 10, 128] : undefined))),
    ).toBe(1);
    const allowed = new Set(["1,2,3"]);
    expect(
      offPalette(
        img(4, 4, () => [1, 2, 3]),
        allowed,
      ),
    ).toEqual([]);
    expect(
      offPalette(
        img(4, 4, (x) => (x ? [1, 2, 3] : [9, 9, 9])),
        allowed,
      ),
    ).toEqual(["9,9,9"]);
    expect(
      offPalette(
        img(4, 4, () => [0, 0, 0]),
        new Set(["0,0,0"]),
      ),
    ).toEqual(["0,0,0"]);
  });

  it("measure checkerboard dithering (ART-6)", () => {
    const checker = img(8, 8, (x, y) => ((x + y) % 2 ? [200, 0, 0] : [0, 0, 200]));
    expect(ditherShare(checker)).toBeGreaterThan(0.5);
    expect(ditherShare(img(8, 8, () => [50, 50, 50]))).toBe(0);
  });

  it("measure outline coverage, loose pieces and silhouettes", () => {
    const ring = img(8, 8, (x, y) =>
      x > 0 && y > 0 && x < 7 && y < 7
        ? x === 1 || y === 1 || x === 6 || y === 6
          ? [5, 5, 5]
          : [99, 99, 99]
        : undefined,
    );
    expect(outlineCoverage(ring, new Set(["5,5,5"]))).toBe(1);
    expect(outlineCoverage(ring, new Set(["99,99,99"]))).toBe(0);
    const two = img(10, 4, (x) => (x < 3 || x > 7 ? [1, 1, 1] : undefined));
    expect(components(two)).toEqual([12, 8]);
    expect(silhouetteIoU(two, two)).toBe(1);
    expect(silhouetteIoU(two, ring)).toBeLessThan(0.5);
  });

  it("fail a spec whose part floats away, clips the canvas or does not move", () => {
    const c = critter();
    const floating = critter({}, [
      ...c.parts,
      {
        name: "kite",
        at: [0, 0, 40],
        material: "redCloth",
        shapes: [{ type: "ellipsoid", radii: [3, 3, 3] }],
      },
    ]);
    expect(gateProblems(floating).join("\n")).toMatch(/loose pieces/);
    const huge = critter({}, [
      {
        name: "body",
        at: [0, 0, 20],
        material: "fur",
        shapes: [{ type: "ellipsoid", radii: [40, 5, 5] }],
      },
    ]);
    expect(
      gateProblems({
        ...huge,
        actions: { idle: must(c.actions?.idle), walk: { frames: 2, keys: keys([0, {}]) } },
      }).join("\n"),
    ).toMatch(/clipped/);
    const frozen = { ...c, actions: { ...c.actions, walk: { frames: 4, keys: keys([0, {}]) } } };
    expect(gateProblems(frozen).join("\n")).toMatch(
      /walk [nesw] frames all have the same silhouette/,
    );
  });

  it("fail a creature that reads as a stripe from the front or the back", () => {
    const c = critter();
    const thin = critter(
      {},
      c.parts.map((p) =>
        p.name === "body"
          ? { ...p, shapes: [{ type: "ellipsoid", radii: [11, 2.5, 5] }] }
          : p.name === "head"
            ? { ...p, shapes: [{ type: "ellipsoid", center: [-2, 0, 0], radii: [3.5, 2, 3] }] }
            : p.name.startsWith("leg_")
              ? { ...p, at: [p.at?.[0] ?? 0, Math.sign(p.at?.[1] ?? 0) * 1.2, -4] }
              : p,
      ),
    );
    expect(gateProblems(thin).join("\n")).toMatch(/a stripe at 1x/);
    expect(gateProblems(c).join("\n")).not.toMatch(/a stripe at 1x/);
  });

  it("pass on a well-made creature", () => {
    expect(gateProblems(critter())).toEqual([]);
  });
});

describe("the engine sprites of the game", () => {
  it("pass every gate and match their assets/sprites.yaml hints (spritegen check)", () => {
    expect(engineProblems(root)).toEqual([]);
  });

  it("are spritegen recipes, one per ANI-4 frame name, so ONLY= filters them too", () => {
    for (const spec of ENGINE_SPECS) {
      const paths = framePaths(spec).map((f) => f.path);
      for (const p of paths) expect(RECIPES[p], p).toBeDefined();
      expect(
        recipePaths(`${spec.sprite}/`).length +
          recipePaths(spec.sprite).filter((p) => p === spec.sprite).length,
      ).toBe(paths.length);
      if (spec.actions)
        for (const p of paths)
          expect(p).toMatch(/\/(idle|walk|attack|shoot|cast|death)_[nesw]_\d+$/);
    }
  });

  it("have frame counts and timings inside ANI-2", () => {
    for (const spec of ENGINE_SPECS)
      for (const action of ACTION_ORDER) {
        const a = spec.actions?.[action];
        if (!a) continue;
        const rule = ACTIONS[action];
        expect(a.frames).toBeGreaterThanOrEqual(rule.frames[0]);
        expect(a.frames).toBeLessThanOrEqual(rule.frames[1]);
      }
  });

  it("render the same pixels every time (determinism)", () => {
    for (const spec of ENGINE_SPECS) {
      const again = { ...spec }; // a new object: the frame cache does not apply
      const a = engineFrames(spec);
      const b = engineFrames(again);
      a.forEach((f, i) =>
        expect(encodePng(f.image).equals(encodePng(must(b[i]).image)), f.path).toBe(true),
      );
    }
  });

  it("make a contact sheet with a row per action and facing, and a lineup", () => {
    const boar = must(ENGINE_SPECS.find((s) => s.sprite === "creatures/bristleback_boar"));
    const sheet = contactSheet(boar, 4);
    const one = contactSheet(
      { ...boar, actions: { idle: must(boar.actions?.idle), walk: must(boar.actions?.walk) } },
      4,
    );
    // 16 rows (4 actions x 4 facings) against 8: the sheet grows by the rows it adds.
    expect(sheet.height).toBeGreaterThan(one.height * 1.8);
    expect(reviewLineup(root, boar).width).toBeGreaterThan(64);
  });
});

describe("assets/sprites.yaml hints of an engine sprite", () => {
  const boar = must(ENGINE_SPECS.find((s) => s.sprite === "creatures/bristleback_boar"));
  const entry = (yaml: string) =>
    parseManifest(`animations:\n  creatures/bristleback_boar: ${yaml}\n`).manifest.animations.get(
      "creatures/bristleback_boar",
    );

  it("must be bc, contact shadow, no facing or mirror, and the rig's ms", () => {
    const good = "{ anchor: bc, shadow: ellipse, ms: { idle: 500, attack: 90, death: 120 } }";
    expect(hintProblems(boar, entry(good), false)).toEqual([]);
    expect(hintProblems(boar, undefined, false).join()).toMatch(/needs animations/);
    expect(hintProblems(boar, entry(good), true).join()).toMatch(/must not list it under sprites/);
    expect(
      hintProblems(
        boar,
        entry(
          "{ facing: left, anchor: bc, shadow: ellipse, ms: { idle: 500, attack: 90, death: 120 } }",
        ),
        false,
      ).join(),
    ).toMatch(/facing/);
    expect(
      hintProblems(
        boar,
        entry("{ anchor: bc, shadow: ellipse, ms: { idle: 500, attack: 60, death: 120 } }"),
        false,
      ).join(),
    ).toMatch(/ms.attack must be 90/);
    expect(
      hintProblems(
        boar,
        entry("{ anchor: br, shadow: baked, ms: { idle: 500, attack: 90, death: 120 } }"),
        false,
      ).join(),
    ).toMatch(/anchor must be bc.*shadow must be ellipse|shadow must be ellipse/);
  });

  it("the size classes keep the ART-2 canvases and anchors", () => {
    expect(SIZES.mediumAnimal.canvases).toEqual([[64, 64]]);
    expect(SIZES.humanoid.anchor).toBe("bc");
    expect(SIZES.object.anchor).toBe("br");
  });
});
