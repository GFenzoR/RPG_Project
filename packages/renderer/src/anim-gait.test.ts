// Creatures walk in step with the ground they cover (docs/17 "Criaturas al ritmo de su
// paso"): the cycle of every body kind against the distance walked, the stride lookup, and
// what must not cycle (standing, pushed, teleported, a flier's feet).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  animate,
  BODY_GAITS,
  DEFAULT_STRIDE,
  FLAP_MS,
  isFlyer,
  newAnimInput,
  newAnimState,
  newPose,
  STEP_PX,
  strideOf,
  walkCyclesPerStep,
  walkPerStep,
  WING_BEAT_MS,
  type AnimActionMeta,
  type AnimDir,
  type AnimInput,
  type AnimMeta,
  type AnimState,
  type BodyGait,
  type Pose,
} from "./anim.ts";

const DIRS: AnimDir[] = ["n", "e", "s", "w"];
const WALK: AnimActionMeta = { frames: 4, ms: 0, perTile: 4, dirs: DIRS };

/** A drawn monster: 4 walk frames in every facing, 2 idle ones. */
const drawn = (body: BodyGait | undefined, stride?: number): AnimMeta => ({
  w: 64,
  h: 64,
  anchor: "bc",
  foot: 4,
  top: 30,
  shadow: "ellipse",
  ...(body ? { body } : {}),
  ...(stride !== undefined ? { stride } : {}),
  actions: {
    idle: { frames: 2, ms: 500, dirs: DIRS },
    walk: WALK,
  },
});

/** A single image: no walk frames at all. */
const single = (body: BodyGait | undefined, stride?: number): AnimMeta => ({
  w: 32,
  h: 32,
  anchor: "br",
  foot: 1,
  top: 24,
  shadow: "baked",
  ...(body ? { body } : {}),
  ...(stride !== undefined ? { stride } : {}),
  actions: {},
});

interface Walker {
  s: AnimState;
  in_: AnimInput;
  out: Pose;
}
const walker = (id = 7): Walker => ({
  s: newAnimState(id, -100_000),
  in_: newAnimInput(),
  out: newPose(),
});

/**
 * The pose after walking `px` sprite pixels in a straight line (dx, dy), one tile every
 * `ms`: every step starts while the one before is drawn, as the canvas sees them.
 */
function after(
  w: Walker,
  meta: AnimMeta,
  px: number,
  ms = 400,
  dx = 1,
  dy = 0,
  dir: AnimDir = "e",
): Pose {
  const tile = STEP_PX * Math.hypot(dx, dy);
  const at = (px / tile) * ms;
  const step = Math.floor(at / ms + 1e-9);
  const { s, in_, out } = w;
  in_.walkMs = ms;
  in_.moveDx = dx;
  in_.moveDy = dy;
  in_.dir = dir;
  for (let k = 0; k <= step; k++) {
    in_.now = k * ms;
    in_.walkStart = k * ms;
    animate(s, meta, in_, out);
  }
  in_.now = at;
  in_.walkStart = step * ms;
  return animate(s, meta, in_, out);
}

describe("the body kinds", () => {
  it("are the ones the atlas packer accepts (tools/spritepack anims.ts), in its order", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../tools/spritepack/src/anims.ts", import.meta.url)),
      "utf8",
    );
    const list = /export const BODY_GAITS = \[([^\]]*)\]/.exec(src)?.[1] ?? "";
    expect(list.match(/[a-z_]+/g)).toEqual([...BODY_GAITS]);
  });
});

describe("the stride of a creature", () => {
  it("is its own, else its body's default; a flier and an undeclared sprite have none", () => {
    expect(strideOf(drawn("quadruped", 52))).toBe(52);
    for (const body of BODY_GAITS) {
      const want = body === "flyer" ? undefined : DEFAULT_STRIDE[body];
      expect(strideOf(drawn(body)), body).toBe(want);
      expect(strideOf(single(body)), body).toBe(want);
    }
    expect(strideOf(drawn(undefined))).toBeUndefined();
    expect(strideOf(undefined)).toBeUndefined();
    expect(strideOf({ ...drawn("biped", 44), flying: true })).toBeUndefined();
    expect(strideOf(drawn("biped", 0))).toBe(DEFAULT_STRIDE.biped);
  });

  it("gives every walking body a default a step can be measured against", () => {
    for (const body of BODY_GAITS) {
      if (body === "flyer") continue;
      expect(DEFAULT_STRIDE[body], body).toBeGreaterThan(0);
    }
    expect(isFlyer(drawn("flyer"))).toBe(true);
    expect(isFlyer({ ...drawn(undefined), flying: true })).toBe(true);
    expect(isFlyer(drawn("biped"))).toBe(false);
  });

  it("turns into walk frames and cycles per step, a diagonal step that much longer", () => {
    const meta = drawn("quadruped", 40);
    const walk = WALK;
    const in_ = newAnimInput();
    in_.moveDx = 1;
    in_.dir = "e";
    expect(walkPerStep(walk, in_, strideOf(meta))).toBeCloseTo((4 * 32) / 40, 9);
    expect(walkCyclesPerStep(meta, in_)).toBeCloseTo(32 / 40, 9);
    in_.moveDx = 0;
    in_.moveDy = 1;
    in_.dir = "s";
    expect(walkCyclesPerStep(meta, in_)).toBeCloseTo(32 / 40, 9);
    in_.moveDx = 1;
    expect(walkCyclesPerStep(meta, in_)).toBeCloseTo((32 * Math.SQRT2) / 40, 9);
    // No walk frames: the same distance rule.
    expect(walkCyclesPerStep(single("many_legs"), in_)).toBeCloseTo((32 * Math.SQRT2) / 16, 9);
    // Neither body nor stride: the older rule (the clip's perTile, one hop per tile).
    in_.moveDy = 0;
    expect(walkCyclesPerStep(drawn(undefined), in_)).toBe(1);
    expect(walkCyclesPerStep(single(undefined), in_)).toBe(1);
  });
});

describe("the walk cycle against the distance walked", () => {
  const STRIDES: [BodyGait, number | undefined][] = [
    ["biped", undefined],
    ["biped", 52],
    ["quadruped", undefined],
    ["quadruped", 22],
    ["many_legs", undefined],
    ["slither", undefined],
    ["hop", undefined],
  ];

  for (const [body, own] of STRIDES) {
    const label = `${body}${own ? ` (stride ${String(own)})` : ""}`;
    const stride = own ?? DEFAULT_STRIDE[body];

    it(`${label}: a clip's phase is the distance over the stride, at any speed`, () => {
      const meta = drawn(body, own);
      for (const ms of [250, 400, 900]) {
        for (const px of [0, 5, 16, 31, 40, 77, 123.5, 200]) {
          const pose = after(walker(), meta, px, ms);
          const want = (px / stride) % 1;
          expect(pose.action).toBe("walk");
          expect(pose.walk, `${String(px)} px at ${String(ms)} ms`).toBeCloseTo(want, 6);
          expect(pose.frame).toBe(Math.floor(want * 4 + 1e-6) % 4);
        }
      }
    });

    it(`${label}: without walk frames the procedural gait keeps the same phase`, () => {
      const meta = single(body, own);
      for (const px of [0, 5, 16, 31, 40, 77, 123.5, 200]) {
        const pose = after(walker(), meta, px, 400);
        expect(pose.walk, `${String(px)} px`).toBeCloseTo((px / stride) % 1, 6);
      }
    });
  }

  it("a whole stride later the same frame is drawn: the planted foot held its ground", () => {
    const meta = drawn("quadruped", 40);
    const a = after(walker(), meta, 12).frame;
    const b = after(walker(), meta, 52).frame;
    const c = after(walker(), meta, 92).frame;
    expect(b).toBe(a);
    expect(c).toBe(a);
    // The old rule played a whole cycle per tile whatever the body: it does not here.
    expect(after(walker(), meta, 32).frame).not.toBe(after(walker(), meta, 0).frame);
  });

  it("a diagonal step advances the cycle by its longer way", () => {
    const meta = drawn("quadruped", 40);
    const diagonal = STEP_PX * Math.SQRT2;
    const pose = after(walker(), meta, diagonal / 2, 400, 1, 1, "e");
    expect(pose.walk).toBeCloseTo((diagonal / 2 / 40) % 1, 6);
  });

  it("a biped without frames rises between its two footfalls and lands on each", () => {
    const meta = single("biped");
    expect(after(walker(), meta, 0).y).toBe(0);
    expect(after(walker(), meta, 8).y).toBe(-1);
    expect(after(walker(), meta, 16).y).toBeCloseTo(0, 9);
    expect(after(walker(), meta, 24).y).toBe(-1);
    expect(after(walker(), meta, 8).skewX).toBeLessThan(0);
  });

  it("a jumper without frames makes one arc per stride and squashes where it lands", () => {
    const meta = single("hop", 48);
    expect(after(walker(), meta, 24).y).toBe(-2);
    const landing = after(walker(), meta, 46);
    expect(landing.scaleY).toBeLessThan(1);
    expect(after(walker(), meta, 24).scaleY).toBe(1);
  });

  it("many legs tremble a pixel between quick footfalls", () => {
    const meta = single("many_legs");
    const ys = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => after(walker(), meta, k * 2 + 0.5).y);
    expect(ys).toEqual([0, -1, 0, -1, 0, -1, 0, -1]);
  });
});

describe("a dragged body's wave", () => {
  it("stretches and gathers along the ground walking across, and never lifts", () => {
    const meta = drawn("slither", 24);
    const out = after(walker(), meta, 6); // a quarter of the wave
    expect(out.scaleX).toBeGreaterThan(1);
    expect(out.scaleY).toBeLessThan(1);
    expect(out.y).toBe(0);
    const back = after(walker(), meta, 18);
    expect(back.scaleX).toBeLessThan(1);
    expect(back.scaleY).toBeGreaterThan(1);
    expect(after(walker(), meta, 0).scaleX).toBe(1);
  });

  it("sways from side to side walking up or down the screen", () => {
    const meta = single("slither", 24);
    expect(after(walker(), meta, 6, 400, 0, 1, "s").x).toBe(1);
    expect(after(walker(), meta, 18, 400, 0, 1, "s").x).toBe(-1);
    expect(after(walker(), meta, 12, 400, 0, 1, "s").x).toBe(0);
  });
});

describe("a flier", () => {
  const bat: AnimMeta = { ...drawn("flyer"), flying: true };

  it("beats its wings by time, not by distance, and never plants a foot", () => {
    for (const px of [0, 7, 16, 40, 100]) {
      const w = walker();
      const pose = after(w, bat, px, 400);
      expect(pose.walk).toBe(-1);
      expect(pose.action).toBe("walk");
      expect(pose.frame).toBe(Math.floor((w.in_.now + w.s.seed) / WING_BEAT_MS) % 4);
    }
  });

  it("keeps beating while it hovers a way it has no idle frames for", () => {
    const meta: AnimMeta = {
      ...bat,
      actions: { walk: WALK, idle: { frames: 2, ms: 300, dirs: ["s"] } },
    };
    const { s, in_, out } = walker();
    in_.dir = "w";
    const frames = new Set<number>();
    for (let now = 0; now < 4 * WING_BEAT_MS; now += WING_BEAT_MS) {
      in_.now = now;
      const pose = animate(s, meta, in_, out);
      expect(pose.action).toBe("walk");
      expect(pose.walk).toBe(-1);
      frames.add(pose.frame);
    }
    expect(frames.size).toBe(4);
    in_.dir = "s";
    expect(animate(s, meta, in_, out).action).toBe("idle");
  });

  it("of a single image flattens a pixel on every beat and bobs, moving or not", () => {
    const gull: AnimMeta = { ...single(undefined), flying: true };
    const { s, in_, out } = walker();
    const flat = new Set<boolean>();
    const lifts = new Set<number>();
    for (let now = 0; now < 1200; now += FLAP_MS / 4) {
      in_.now = now;
      const pose = animate(s, gull, in_, out);
      flat.add(pose.scaleY < 1);
      lifts.add(pose.y);
      expect(pose.y).toBeLessThanOrEqual(0);
      expect(pose.walk).toBe(-1);
    }
    expect(flat).toEqual(new Set([true, false]));
    expect(lifts.size).toBeGreaterThan(1);
  });
});

describe("what must not walk", () => {
  it("a creature standing still does not cycle, whatever time passes", () => {
    for (const meta of [drawn("quadruped"), single("biped"), single("slither")]) {
      const { s, in_, out } = walker();
      // No idle clip here: the standing frame must hold.
      const still: AnimMeta = { ...meta, actions: { ...meta.actions } };
      delete still.actions.idle;
      const seen = new Set<string>();
      for (let now = 0; now < 5000; now += 130) {
        in_.now = now;
        const pose = animate(s, still, in_, out);
        expect(pose.walk).toBe(-1);
        seen.add(`${pose.action}:${String(pose.frame)}:${String(pose.x)}:${String(pose.y)}`);
      }
      expect(seen.size).toBe(1);
    }
  });

  it("a pushed or teleported creature (moved with no step) keeps its legs still", () => {
    for (const meta of [drawn("biped", 52), single("quadruped")]) {
      const w = walker();
      const walked = after(w, meta, 20);
      const frame = walked.frame;
      // The step ends; later the world moves it with no step (a push, a teleport: the
      // canvas slides or jumps the drawing, and gives animate no walk).
      const { s, in_, out } = w;
      in_.walkStart = undefined;
      in_.walkMs = 0;
      in_.moveDx = 0;
      in_.moveDy = 0;
      for (let now = 2000; now < 3000; now += 50) {
        in_.now = now;
        const pose = animate(s, meta, in_, out);
        expect(pose.walk).toBe(-1);
        expect(pose.action).toBe("idle");
        expect(pose.y).toBe(0);
        expect(pose.x).toBe(0);
      }
      // Walking on, the cycle carries on from where the legs were: no jump back.
      in_.walkStart = 3000;
      in_.walkMs = 400;
      in_.moveDx = 1;
      in_.now = 3000;
      const on = animate(s, meta, in_, out);
      if (meta.actions.walk) expect([frame, (frame + 1) % 4]).toContain(on.frame);
      expect(on.walk).toBeGreaterThanOrEqual(0);
    }
  });

  it("a step of no length (a turn in place) does not advance the cycle", () => {
    const { s, in_, out } = walker();
    in_.walkStart = 0;
    in_.walkMs = 0;
    in_.now = 10;
    expect(animate(s, drawn("biped"), in_, out).walk).toBe(-1);
  });
});
