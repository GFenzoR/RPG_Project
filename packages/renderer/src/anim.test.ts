import { describe, expect, it } from "vitest";
import {
  APPEAR_MS,
  FLY_MS,
  FLY_PX,
  DEATH_MS,
  DEATH_SETTLE_MS,
  FEET_LINE,
  TIP_SQUASH,
  fallMs,
  FALL_DIRS,
  fallArt,
  fallDir,
  fallShift,
  restFor,
  tipPlacement,
  HIT_FLASH_MS,
  HIT_MS,
  IDLE_AFTER_MS,
  STRAIGHT_DIRS,
  ANIM_DIRS,
  LUNGE_BACK_MS,
  LUNGE_OUT_MS,
  LUNGE_PX,
  VANISH_FLICKER_MS,
  VANISH_MS,
  animate,
  attackClip,
  attackClipAction,
  clipMs,
  hashId,
  newAnimInput,
  newAnimState,
  newPose,
  startAttack,
  startDeath,
  startHit,
  startVanish,
  dirOf,
  faceTo,
  turnTo,
  stanceOf,
  walkCyclesPerStep,
  walkPerStep,
} from "./anim.ts";
import type { AnimInput, AnimMeta, AnimState, Pose } from "./anim.ts";

const DIRS: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];

/** An LPC humanoid: 2 idle frames of 500 ms, 8 walk frames (4 per tile), slash, fall. */
const LPC: AnimMeta = {
  w: 64,
  h: 64,
  anchor: "bc",
  foot: 2,
  top: 46,
  shadow: "ellipse",
  actions: {
    idle: { frames: 2, ms: 500, dirs: DIRS },
    walk: { frames: 8, ms: 0, perTile: 4, dirs: DIRS },
    attack: { frames: 6, ms: 60, dirs: DIRS },
    death: { frames: 6, ms: 100, dirs: ["s"] },
  },
};

/** A single-frame monster that looks left (Dungeon Crawl). */
const STILL: AnimMeta = {
  w: 32,
  h: 32,
  anchor: "br",
  foot: 1,
  top: 24,
  shadow: "baked",
  facing: "left",
  actions: {},
};

/** A fresh creature born long ago (no fade-in) and a pose for it. */
function setup(id = 7): { s: AnimState; in_: AnimInput; out: Pose } {
  return { s: newAnimState(id, -10_000), in_: newAnimInput(), out: newPose() };
}

/** Walks `steps` tiles of `ms` each from t=0, sampling `at` (relative to the first step). */
function stepAt(
  s: AnimState,
  meta: AnimMeta | undefined,
  in_: AnimInput,
  out: Pose,
  ms: number,
  at: number,
): Pose {
  const step = Math.floor(at / ms);
  in_.now = at;
  in_.walkStart = step * ms;
  in_.walkMs = ms;
  in_.moveDx = 1;
  in_.dir = "e";
  // Every step starts while the previous one is drawn: the caller sees each start once.
  for (let k = 0; k <= step; k++) {
    const probe = { ...in_, now: k * ms, walkStart: k * ms };
    animate(s, meta, probe, out);
  }
  return animate(s, meta, in_, out);
}

describe("the walk cycle the pose reports (the living world's footfalls)", () => {
  it("runs 0 to 1 over a clip's frames by distance, and is -1 when no step is walked", () => {
    const { s, in_, out } = setup();
    // LPC: 8 frames, 4 per tile: half a cycle per tile.
    expect(stepAt(s, LPC, in_, out, 400, 0).walk).toBe(0);
    expect(stepAt(s, LPC, in_, out, 400, 200).walk).toBeCloseTo(0.25, 9);
    expect(out.frame).toBe(2);
    expect(stepAt(s, LPC, in_, out, 400, 600).walk).toBeCloseTo(0.75, 9);
    expect(walkCyclesPerStep(LPC, in_)).toBe(0.5);
    // The step over: the last frame is held (ANI-3), but nobody walks.
    in_.now = 840;
    expect(animate(s, LPC, in_, out).action).toBe("walk");
    expect(out.walk).toBe(-1);
    in_.walkStart = undefined;
    in_.now = 5000;
    expect(animate(s, LPC, in_, out).walk).toBe(-1);
  });

  it("is the hop of a step for a sprite without a walk clip, and nothing for a flier", () => {
    const { s, in_, out } = setup();
    expect(stepAt(s, STILL, in_, out, 400, 100).walk).toBeCloseTo(0.25, 9);
    expect(stepAt(s, STILL, in_, out, 400, 700).walk).toBeCloseTo(0.75, 9);
    expect(walkCyclesPerStep(STILL, in_)).toBe(1);
    expect(walkCyclesPerStep(undefined, in_)).toBe(1);
    const fly = setup();
    expect(stepAt(fly.s, { ...STILL, flying: true }, fly.in_, fly.out, 400, 100).walk).toBe(-1);
  });

  it("stops while an attack clip or a death plays over the step", () => {
    const { s, in_, out } = setup();
    stepAt(s, LPC, in_, out, 400, 100);
    startAttack(s, 100, 1, 0);
    expect(animate(s, LPC, in_, out).action).toBe("attack");
    expect(out.walk).toBe(-1);
    startDeath(s, 120);
    in_.now = 130;
    expect(animate(s, LPC, in_, out).walk).toBe(-1);
  });
});

describe("clips", () => {
  it("plays the walk by distance: half a cycle per tile, continuous across steps", () => {
    const frames: number[] = [];
    for (let at = 0; at < 1000; at += 125) {
      const { s, in_, out } = setup();
      frames.push(stepAt(s, LPC, in_, out, 500, at).frame);
    }
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Faster steps play the same frames for the same distance (no sliding feet).
    const { s, in_, out } = setup();
    expect(stepAt(s, LPC, in_, out, 250, 375).frame).toBe(6);
    expect(out.action).toBe("walk");
  });

  it("plays an engine humanoid's walk at its stride: a cycle per tile, longer facing north or south", () => {
    // tools/spritegen specs/humanoid: 8 frames, 8 per tile; 13.86 facing n or s (the 3/4
    // view foreshortens the model's depth, not the map's tiles).
    const HUMAN: AnimMeta = {
      ...LPC,
      actions: {
        ...LPC.actions,
        walk: { frames: 8, ms: 0, perTile: 8, perTileNS: 13.86, dirs: DIRS },
      },
    };
    const east: number[] = [];
    for (let at = 0; at < 600; at += 50) {
      const { s, in_, out } = setup();
      east.push(stepAt(s, HUMAN, in_, out, 400, at).frame);
    }
    // A frame every 50 ms of a 400 ms step, across two chained steps: never a repeat
    // or a jump back, never the idle pose.
    expect(east).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3]);
    const { s, in_, out } = setup();
    stepAt(s, HUMAN, in_, out, 400, 0);
    in_.dir = "s";
    in_.now = 200;
    // Half a tile facing south: 13.86 / 2 frames in.
    expect(animate(s, HUMAN, in_, out).frame).toBe(6);
  });

  it("turns mid-walk without the legs jumping: the cycle goes on from the frame drawn", () => {
    const HUMAN: AnimMeta = {
      ...LPC,
      actions: {
        ...LPC.actions,
        walk: { frames: 8, ms: 0, perTile: 8, perTileNS: 13.86, dirs: DIRS },
      },
    };
    const { s, in_, out } = setup();
    in_.walkMs = 400;
    const at = (step: number, t: number, dir: "e" | "n"): number => {
      in_.dir = dir;
      in_.walkStart = step * 400;
      in_.now = step * 400 + t * 400;
      return animate(s, HUMAN, in_, out).frame;
    };
    // Five tiles east: a cycle each, the last frame of the fifth is 7.
    for (let step = 0; step < 5; step++) for (const t of [0, 0.5]) at(step, t, "e");
    expect(at(4, 0.99, "e")).toBe(7);
    // The sixth faces north: it starts on frame 0, the one after 7 (counting steps, 5 x
    // 13.86 put it on frame 5), and plays 13.86 frames over its tile.
    expect(at(5, 0, "n")).toBe(0);
    expect(at(5, 0.5, "n")).toBe(6);
    // And back east: from where the northern step left it (13.86 frames on), not a jump.
    expect(at(6, 0, "e")).toBe(Math.floor(13.86) % 8);
  });

  it("holds the last walk frame between chained steps, then idles (ANI-3)", () => {
    const { s, in_, out } = setup();
    stepAt(s, LPC, in_, out, 400, 300);
    const held = out.frame;
    in_.now = 400 + IDLE_AFTER_MS - 1;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "walk", frame: held });
    in_.now = 400 + IDLE_AFTER_MS;
    expect(animate(s, LPC, in_, out).action).toBe("idle");
  });

  it("idles with a phase of its own, so a pack does not breathe in unison", () => {
    const a = setup(1);
    const b = setup(2);
    const frames = (x: ReturnType<typeof setup>): number[] =>
      [0, 250, 500, 750, 1000].map((now) => {
        x.in_.now = now;
        return animate(x.s, LPC, x.in_, x.out).frame;
      });
    expect(hashId(1)).not.toBe(hashId(2));
    expect(frames(a)).not.toEqual(frames(b));
    expect(new Set(frames(a))).toEqual(new Set([0, 1]));
  });

  it("plays the attack clip once, then goes back to idle", () => {
    const { s, in_, out } = setup();
    startAttack(s, 1000, 1, 0);
    in_.now = 1000 + 130;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "attack", frame: 2, x: 0 });
    in_.now = 1000 + clipMs(LPC, "attack");
    expect(animate(s, LPC, in_, out).action).toBe("idle");
  });

  it("plays its own clip for a ranged attack or a spell, else the melee swing (ANI-2)", () => {
    // An LPC humanoid with every action: the bow (7 x 50 ms) and the spell (7 x 60 ms).
    const ALL: AnimMeta = {
      ...LPC,
      actions: {
        ...LPC.actions,
        shoot: { frames: 7, ms: 50, dirs: DIRS },
        cast: { frames: 7, ms: 60, dirs: DIRS },
      },
    };
    const { s, in_, out } = setup();
    in_.dir = "e";
    startAttack(s, 1000, 1, 0, "shoot");
    in_.now = 1000 + 120;
    expect(animate(s, ALL, in_, out)).toMatchObject({ action: "shoot", frame: 2, x: 0 });
    in_.now = 1000 + clipMs(ALL, "shoot") - 1;
    expect(animate(s, ALL, in_, out)).toMatchObject({ action: "shoot", frame: 6 });
    in_.now = 1000 + clipMs(ALL, "shoot");
    expect(animate(s, ALL, in_, out).action).toBe("idle");
    startAttack(s, 2000, 0, 1, "cast");
    in_.now = 2000 + 400;
    expect(animate(s, ALL, in_, out)).toMatchObject({ action: "cast", frame: 6 });
    // A melee blow after them plays the swing again.
    startAttack(s, 3000, 0, 1);
    in_.now = 3000 + 130;
    expect(animate(s, ALL, in_, out)).toMatchObject({ action: "attack", frame: 2 });
    // Without a cast clip (a monster that only throws), a spell swings; without any attack
    // clip it lunges (ANI-5).
    startAttack(s, 4000, 0, 1, "cast");
    in_.now = 4000 + 130;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "attack", frame: 2, y: 0 });
    expect(attackClipAction(LPC, "cast", "s")).toBe("attack");
    expect(attackClipAction(ALL, "cast", "s")).toBe("cast");
    expect(attackClip(STILL, "shoot", "s")).toBeUndefined();
    startAttack(s, 5000, 0, 1, "shoot");
    in_.now = 5000 + LUNGE_OUT_MS;
    expect(animate(s, STILL, in_, out)).toMatchObject({ x: 0, y: LUNGE_PX });
  });

  it("bites and idles only facing its own ways: else the lunge and the standing frame", () => {
    // A Gemini monster: walk all round, a bite only to the sides, an idle only facing south.
    const SIDE: AnimMeta = {
      ...LPC,
      actions: {
        idle: { frames: 2, ms: 500, dirs: ["s"] },
        walk: { frames: 4, ms: 0, perTile: 2, dirs: DIRS },
        attack: { frames: 3, ms: 110, dirs: ["e", "w"] },
        death: { frames: 3, ms: 200, dirs: ["s"] },
      },
    };
    const { s, in_, out } = setup();
    in_.dir = "w";
    startAttack(s, 1000, -1, 0);
    in_.now = 1000 + 120;
    expect(animate(s, SIDE, in_, out)).toMatchObject({ action: "attack", frame: 1, x: 0 });
    // Facing south it has no bite: it lunges with its standing frame (ANI-5).
    in_.dir = "s";
    startAttack(s, 2000, 0, 1);
    in_.now = 2000 + LUNGE_OUT_MS;
    expect(animate(s, SIDE, in_, out)).toMatchObject({ action: "idle", x: 0, y: LUNGE_PX });
    // Standing facing west, where it has no idle: the walk's standing frame, still.
    in_.dir = "w";
    for (const now of [5000, 5300, 5600, 5900]) {
      in_.now = now;
      expect(animate(s, SIDE, in_, out)).toMatchObject({ action: "idle", frame: 0, scaleY: 1 });
    }
    // Death keeps falling back to south, as LPC's fall does.
    startDeath(s, 7000);
    in_.now = 7000 + 250;
    expect(animate(s, SIDE, in_, out)).toMatchObject({ action: "death", frame: 1 });
  });

  it("plays the death clip whole, then fades its last frame over the corpse (docs/17)", () => {
    const { s, in_, out } = setup();
    startDeath(s, 0);
    startDeath(s, 50); // the first death counts
    in_.now = 250;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "death", frame: 2, done: false });
    // Never fainter while it falls: the corpse is hidden until the fall ends.
    expect(fallMs(LPC)).toBe(clipMs(LPC, "death"));
    in_.now = fallMs(LPC);
    expect(animate(s, LPC, in_, out)).toMatchObject({ frame: 5, alpha: 1, done: false });
    in_.now = fallMs(LPC) + DEATH_SETTLE_MS / 2;
    expect(animate(s, LPC, in_, out)).toMatchObject({ frame: 5, alpha: 0.5, done: false });
    in_.now = fallMs(LPC) + DEATH_SETTLE_MS;
    expect(animate(s, LPC, in_, out).done).toBe(true);
    expect(DEATH_SETTLE_MS).toBeLessThanOrEqual(100);
  });

  it("lowers a falling body frame by frame onto where its corpse lies", () => {
    // The corpse is the last frame with its lowest pixel on the feet line: a body that
    // rests 9 rows over its frame's bottom, drawn 2 rows (foot) under the line, moves 7.
    const meta: AnimMeta = { ...LPC, rest: 9 };
    expect(fallShift(meta)).toBe(7);
    expect(fallShift({ ...meta, anchor: "br" })).toBe(9 - FEET_LINE);
    expect(fallShift(LPC)).toBe(0); // an older atlas: it falls in place
    expect(fallShift(undefined)).toBe(0);
    expect(fallShift(meta, 4)).toBe(2); // a paper doll: the lowest of its layers
    const { s, in_, out } = setup();
    startDeath(s, 0, fallShift(meta));
    const ys: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      in_.now = frame * 100 + 1;
      ys.push(animate(s, meta, in_, out).y);
    }
    expect(ys[0]).toBe(0);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    // The whole last frame, and the fade after it, lie on the corpse.
    expect(ys[5]).toBe(7);
    in_.now = fallMs(meta) + DEATH_SETTLE_MS / 2;
    expect(animate(s, meta, in_, out)).toMatchObject({
      frame: 5,
      y: 7,
      x: 0,
      scaleX: 1,
      scaleY: 1,
    });
  });
});

describe("procedural motion of single-frame sprites (ANI-5)", () => {
  it("hops once per tile, leans towards the move and squashes on landing", () => {
    const { s, in_, out } = setup();
    expect(stepAt(s, STILL, in_, out, 400, 200)).toMatchObject({ y: -2, scaleY: 1 });
    expect(out.skewX).toBeCloseTo(-Math.asin(1 / 24));
    expect(stepAt(s, STILL, in_, out, 400, 410)).toMatchObject({ y: 0, scaleY: 23 / 24 });
    expect(out.scaleX).toBeCloseTo(-25 / 24); // looks left, walking east: mirrored
  });

  it("mirrors to face the move and keeps that side walking north or south", () => {
    const { s, in_, out } = setup();
    in_.now = 0;
    in_.dir = "e";
    expect(animate(s, STILL, in_, out).scaleX).toBeLessThan(0);
    in_.dir = "n";
    expect(animate(s, STILL, in_, out).scaleX).toBeLessThan(0);
    in_.dir = "w";
    expect(animate(s, STILL, in_, out).scaleX).toBeGreaterThan(0);
    // Without `facing` nothing is mirrored.
    const plain = setup();
    plain.in_.dir = "e";
    expect(animate(plain.s, undefined, plain.in_, plain.out).scaleX).toBeGreaterThan(0);
  });

  it("breathes 1 px for a while every couple of seconds", () => {
    const { s, in_, out } = setup();
    const tall = [];
    for (let now = 0; now < 2400; now += 50) {
      in_.now = now;
      tall.push(animate(s, STILL, in_, out).scaleY > 1);
    }
    const count = tall.filter(Boolean).length;
    expect(count).toBeGreaterThanOrEqual(8); // 400 ms of each 1.6-2.4 s
    expect(count).toBeLessThanOrEqual(16);
  });

  it("lunges towards the target and comes back", () => {
    const { s, in_, out } = setup();
    startAttack(s, 0, -3, 0);
    in_.now = LUNGE_OUT_MS;
    expect(animate(s, STILL, in_, out)).toMatchObject({ x: -LUNGE_PX, y: 0 });
    in_.now = 1000;
    expect(animate(s, STILL, in_, out).x).toBe(0);
  });

  it("flashes and is pushed back when hit, with any sprite", () => {
    const { s, in_, out } = setup();
    startHit(s, 0, 0, 1);
    in_.now = HIT_FLASH_MS / 2;
    expect(animate(s, LPC, in_, out)).toMatchObject({ flash: true, y: 2 });
    in_.now = HIT_FLASH_MS + 1;
    expect(animate(s, LPC, in_, out)).toMatchObject({ flash: false, y: 2 });
    in_.now = HIT_MS;
    expect(animate(s, LPC, in_, out)).toMatchObject({ flash: false, y: 0 });
  });

  it("flies: bobs above the floor, its shadow shrinking, and never hops", () => {
    const { s, in_, out } = setup();
    const bat: AnimMeta = { ...STILL, flying: true };
    const ys = new Set<number>();
    for (let now = 0; now < 600; now += 25) {
      in_.now = now;
      animate(s, bat, in_, out);
      ys.add(out.y);
      expect(out.shadow).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...ys)).toBe(0);
    expect(Math.min(...ys)).toBe(-4);
    expect(stepAt(s, bat, in_, out, 400, 200).skewX).toBe(0);
  });

  it("lands a flyer as it dies: no bob left when the fall ends, on the corpse's pixels", () => {
    const DEATH: AnimMeta = {
      ...STILL,
      flying: true,
      actions: { death: { frames: 4, ms: 90, dirs: ["s"] } },
    };
    for (const bat of [{ ...STILL, flying: true } as AnimMeta, DEATH]) {
      const { s, in_, out } = setup();
      // It dies at the top of its bob, 4 px up.
      const at = FLY_MS / 4 - (s.seed % FLY_MS) + FLY_MS;
      in_.now = at;
      expect(animate(s, bat, in_, out).y).toBe(-2 * FLY_PX);
      startDeath(s, at, 3);
      let last = -2 * FLY_PX;
      const ms = fallMs(bat);
      for (let el = 0; el <= ms; el += 30) {
        in_.now = at + el;
        const y = animate(s, bat, in_, out).y;
        expect(y).toBeGreaterThanOrEqual(last); // only ever down
        last = y;
      }
      // Fallen, and all through the crossfade: exactly where the corpse lies, full shadow.
      for (const el of [ms, ms + DEATH_SETTLE_MS / 2, ms + DEATH_SETTLE_MS - 1]) {
        in_.now = at + el;
        expect(animate(s, bat, in_, out)).toMatchObject({ y: 3, shadow: 1 });
      }
    }
  });

  it("tips over clockwise and flattens when it dies, ending as its corpse was drawn", () => {
    const { s, in_, out } = setup();
    expect(fallMs(STILL)).toBe(DEATH_MS);
    expect(fallMs(undefined)).toBe(DEATH_MS);
    startDeath(s, 0, 3);
    let last = -1;
    for (let now = 0; now <= DEATH_MS; now += 50) {
      in_.now = now;
      const p = animate(s, STILL, in_, out);
      expect(p).toMatchObject({ action: "death", alpha: 1, done: false });
      expect(p.tip).toBeGreaterThan(last); // one motion, always the same way
      last = p.tip;
    }
    // The end of the fall: a quarter turn, 3/5 as high, lowered onto the corpse.
    expect(out.tip).toBeCloseTo(Math.PI / 2);
    expect(out.scaleY).toBeCloseTo(TIP_SQUASH);
    expect(out).toMatchObject({ x: 0, y: 3, scaleX: 1 });
    in_.now = DEATH_MS + DEATH_SETTLE_MS / 2;
    expect(animate(s, STILL, in_, out)).toMatchObject({ alpha: 0.5, y: 3, done: false });
    expect(out.tip).toBeCloseTo(Math.PI / 2);
    in_.now = DEATH_MS + DEATH_SETTLE_MS;
    expect(animate(s, STILL, in_, out).done).toBe(true);
  });

  it("tips a mirrored single image over as its corpse was drawn, not as it looked alive", () => {
    const { s, in_, out } = setup();
    in_.dir = "e"; // STILL looks left: mirrored to look east
    in_.now = 0;
    expect(animate(s, STILL, in_, out).scaleX).toBe(-1);
    startDeath(s, 10);
    in_.now = 200;
    expect(animate(s, STILL, in_, out).scaleX).toBe(1);
  });

  it("falls one of four ways: a diagonal falls east or west (docs/17)", () => {
    expect(FALL_DIRS).toEqual(["s", "e", "n", "w"]);
    expect(ANIM_DIRS.map((d) => fallDir(d))).toEqual(["n", "e", "s", "w", "e", "e", "w", "w"]);
  });

  it("draws each fall from the art the creature has: its own facing, a mirror, a tip", () => {
    // The engine's creatures and humanoids: a death drawn in the four facings.
    for (const d of FALL_DIRS)
      expect(fallArt(["n", "e", "s", "w"], d)).toEqual({ clip: d, mirror: false, tip: 1 });
    // A hand-made monster: south only. East and west differ, and so do north and south.
    expect(fallArt(["s"], "s")).toEqual({ clip: "s", mirror: false, tip: 1 });
    expect(fallArt(["s"], "e")).toEqual({ clip: "s", mirror: false, tip: 1 });
    expect(fallArt(["s"], "n")).toEqual({ clip: "s", mirror: true, tip: 1 });
    expect(fallArt(["s"], "w")).toEqual({ clip: "s", mirror: true, tip: 1 });
    // A clip with some facings: its own where it has them.
    expect(fallArt(["s", "w"], "w")).toEqual({ clip: "w", mirror: false, tip: 1 });
    expect(fallArt(["s", "w"], "n")).toEqual({ clip: "s", mirror: true, tip: 1 });
    // A single image: four different bodies, south the one there always was.
    expect(fallArt(undefined, "s")).toEqual({ clip: "s", mirror: false, tip: 1 });
    expect(fallArt([], "e")).toEqual({ clip: "s", mirror: true, tip: 1 });
    expect(fallArt(undefined, "n")).toEqual({ clip: "s", mirror: true, tip: -1 });
    expect(fallArt(undefined, "w")).toEqual({ clip: "s", mirror: false, tip: -1 });
    const seen = new Set(FALL_DIRS.map((d) => JSON.stringify(fallArt(undefined, d))));
    expect(seen.size).toBe(4);
    // It fills the object it is given (the canvas draws without allocating).
    const out = { clip: "s" as const, mirror: false, tip: 1 as const };
    expect(fallArt(undefined, "n", out)).toBe(out);
  });

  it("rests where the atlas says for the way it fell, the south's without a word", () => {
    const meta = { ...LPC, rest: 9, rests: { e: 4, w: 12 } };
    expect(restFor(meta, "s")).toBe(9);
    expect(restFor(meta, "e")).toBe(4);
    expect(restFor(meta, "n")).toBe(9);
    expect(restFor(meta, "w")).toBe(12);
    expect(restFor(LPC, "e")).toBeUndefined(); // an older atlas
    expect(restFor(undefined, "e")).toBeUndefined();
  });

  it("mirrors the fall of a south-only death to the north and the west, the whole of it", () => {
    for (const [way, scaleX] of [
      ["s", 1],
      ["e", 1],
      ["n", -1],
      ["w", -1],
    ] as const) {
      const { s, in_, out } = setup();
      in_.dir = way;
      startDeath(s, 0, 3, way);
      expect(s.fallDir).toBe(way);
      for (const now of [0, 150, 599, 650]) {
        in_.now = now;
        const p = animate(s, LPC, in_, out);
        expect(p.action).toBe("death");
        expect(p.scaleX, `${way} at ${now}`).toBe(scaleX);
        expect(p.tip).toBe(0);
      }
    }
    // The way may change while it falls (the remains came a moment later).
    const { s, in_, out } = setup();
    startDeath(s, 0, 3, "e");
    in_.now = 20;
    expect(animate(s, LPC, in_, out).scaleX).toBe(1);
    s.fallDir = "w";
    in_.now = 40;
    expect(animate(s, LPC, in_, out).scaleX).toBe(-1);
    // By default a death falls facing south, as it always did.
    const old = setup();
    startDeath(old.s, 0);
    expect(old.s.fallDir).toBe("s");
  });

  it("tips a single image the way it fell: clockwise or counter, mirrored or not", () => {
    for (const [way, scaleX, tip] of [
      ["s", 1, 1],
      ["e", -1, 1],
      ["n", -1, -1],
      ["w", 1, -1],
    ] as const) {
      const { s, in_, out } = setup();
      in_.dir = "w"; // STILL looks left: drawn as it is while alive
      in_.now = 0;
      animate(s, STILL, in_, out);
      startDeath(s, 10, 0, way);
      in_.now = 10 + DEATH_MS;
      const p = animate(s, STILL, in_, out);
      expect(p.scaleX, way).toBe(scaleX);
      expect(p.tip, way).toBeCloseTo((Math.PI / 2) * tip);
      expect(p.scaleY, way).toBeCloseTo(TIP_SQUASH);
    }
  });

  it("places a frame tipped counter-clockwise as the mirror image of the clockwise one", () => {
    const n = 32;
    const mk = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 });
    const cw = tipPlacement(Math.PI / 2, TIP_SQUASH, n, mk());
    const ccw = tipPlacement(-Math.PI / 2, TIP_SQUASH, n, mk());
    const at = (t: typeof cw, u: number, v: number): [number, number] => [
      t.x + Math.cos(t.skewY) * t.scaleX * u + Math.sin(t.skewX) * t.scaleY * v,
      t.y + Math.sin(t.skewY) * t.scaleX * u + Math.cos(t.skewX) * t.scaleY * v,
    ];
    for (const [u, v] of [
      [-16, -32],
      [16, -32],
      [-16, 0],
      [5, -11],
    ] as const) {
      const [x, y] = at(cw, u, v);
      const [mx, my] = at(ccw, -u, v); // the mirrored drawing, tipped the other way
      expect(mx).toBeCloseTo(-x);
      expect(my).toBeCloseTo(y);
    }
  });

  it("places a tipped frame on the pixels spritegen's tipOver gives (the corpse)", () => {
    // tipOver: (x, y) of an n x n image goes to column n - 1 - y and, flattened to h rows
    // against the bottom, to the rows n - h + x h / n. The sprite is anchored at its
    // bottom centre: a point (u, v) from it is drawn at at + (a u + c v, b u + d v).
    const n = 32;
    const at = tipPlacement(Math.PI / 2, TIP_SQUASH, n, {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      skewX: 0,
      skewY: 0,
    });
    const a = Math.cos(at.skewY) * at.scaleX;
    const b = Math.sin(at.skewY) * at.scaleX;
    const c = Math.sin(at.skewX) * at.scaleY;
    const d = Math.cos(at.skewX) * at.scaleY;
    for (const [x, y] of [
      [0, 0],
      [31, 0],
      [0, 31],
      [31, 31],
      [12, 20],
    ] as const) {
      // The pixel's corners nearest the image's top-left, from the anchor (n / 2, n).
      const u = x - n / 2;
      const v = y - n;
      const px = at.x + a * u + c * v + n / 2;
      const py = at.y + b * u + d * v + n;
      expect(px).toBeCloseTo(n - y); // the right edge of column n - 1 - y
      expect(py).toBeCloseTo(n - TIP_SQUASH * n + x * TIP_SQUASH); // row x, flattened
    }
    // Standing (no tip, no squash) it is the sprite as it is.
    expect(tipPlacement(0, 1, n, at)).toMatchObject({ x: 0, scaleX: 1, scaleY: 1, skewY: 0 });
    expect(at.y).toBeCloseTo(0);
    expect(at.skewX).toBeCloseTo(0);
  });

  it("shimmers away when it leaves by a teleport or a logout, never falling (ANI-7)", () => {
    for (const meta of [LPC, STILL]) {
      const { s, in_, out } = setup();
      startVanish(s, 1000);
      startVanish(s, 1100); // the first one counts
      in_.now = 1000;
      expect(animate(s, meta, in_, out)).toMatchObject({ shimmer: true, alpha: 1, done: false });
      expect(out.action).toBe("idle"); // its stance: no death clip, no squash to the floor
      in_.now = 1000 + VANISH_MS / 2;
      animate(s, meta, in_, out);
      expect(out.action).not.toBe("death");
      expect(Math.abs(out.scaleX)).toBeCloseTo(0.65);
      expect(out.scaleY).toBeCloseTo(1.1);
      // It flickers while it fades: every VANISH_FLICKER_MS dimmer, then back.
      const alphas = [0, 1, 2, 3].map((k) => {
        in_.now = 1000 + 100 + k * VANISH_FLICKER_MS;
        return animate(s, meta, in_, out).alpha;
      });
      expect(alphas[1]).toBeLessThan(alphas[0] ?? 0);
      expect(alphas[2]).toBeGreaterThan(alphas[1] ?? 1);
      in_.now = 1000 + VANISH_MS;
      expect(animate(s, meta, in_, out)).toMatchObject({ alpha: 0, done: true });
    }
    // A death already under way keeps falling.
    const { s, in_, out } = setup();
    startDeath(s, 0);
    startVanish(s, 0);
    in_.now = 250;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "death", shimmer: false });
    // The pose is reused: the next creature drawn with it is not pale.
    const other = setup(8);
    in_.now = 250;
    expect(animate(other.s, LPC, in_, out).shimmer).toBe(false);
  });

  it("fades in when it appears", () => {
    const s = newAnimState(3, 1000);
    const in_ = newAnimInput();
    const out = newPose();
    in_.now = 1000 + APPEAR_MS / 2;
    expect(animate(s, undefined, in_, out).alpha).toBe(0.5);
    in_.now = 1000 + APPEAR_MS;
    expect(animate(s, undefined, in_, out).alpha).toBe(1);
  });

  it("allocates nothing per frame: the same pose object comes back", () => {
    const { s, in_, out } = setup();
    in_.now = 5;
    expect(animate(s, LPC, in_, out)).toBe(out);
  });
});

describe("facings (docs/17 ANI-1)", () => {
  it("names the facing of a direction by its signs", () => {
    expect(dirOf(1, -1)).toBe("ne");
    expect(dirOf(-3, 2)).toBe("sw");
    expect(dirOf(0, -1)).toBe("n");
    expect(dirOf(-1, 0)).toBe("w");
    expect(dirOf(0, 0)).toBe("s");
    // Every sign pair, from one table (no string built per call, docs/07).
    const want = ["nw", "n", "ne", "w", "s", "e", "sw", "s", "se"];
    for (const dy of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) expect(dirOf(dx * 4, dy * 9)).toBe(want[(dy + 1) * 3 + dx + 1]);
  });

  it("turns a figure to the attack it plays, and keeps it there until it walks or turns", () => {
    // Facing south, a blow to the north-east: the clip plays turned to it (eight facings).
    const { s, in_, out } = setup();
    const EIGHT: AnimMeta = {
      ...LPC,
      actions: { ...LPC.actions, attack: { frames: 6, ms: 60, dirs: [...ANIM_DIRS] } },
    };
    expect(faceTo(s, EIGHT, 900, 0, 1, false, true)).toBe("s");
    startAttack(s, 1000, 1, -1);
    expect(faceTo(s, EIGHT, 1000, 0, 1, false, true)).toBe("ne");
    in_.now = 1100;
    in_.dir = s.facing;
    expect(animate(s, EIGHT, in_, out).action).toBe("attack");
    // Walking away mid-clip does not turn it: the clip is drawn where it was aimed.
    expect(faceTo(s, EIGHT, 1200, -1, 0, true, true)).toBe("ne");
    // The clip over (6 × 60 ms): the step's facing.
    expect(faceTo(s, EIGHT, 1360, -1, 0, true, true)).toBe("w");
    expect(faceTo(s, EIGHT, 1400, 0, 1, false, true)).toBe("s");

    // Standing still it keeps facing its target between blows...
    startAttack(s, 2000, -1, 1);
    expect(faceTo(s, EIGHT, 2100, 0, 1, false, true)).toBe("sw");
    expect(faceTo(s, EIGHT, 5000, 0, 1, false, true)).toBe("sw");
    // ...until it looks another way (a Turn), and not back again after that.
    expect(faceTo(s, EIGHT, 5050, 1, 0, false, true)).toBe("e");
    expect(faceTo(s, EIGHT, 5100, 0, 1, false, true)).toBe("s");

    // A step in the direction it already looked also ends it.
    startAttack(s, 6000, 1, -1);
    expect(faceTo(s, EIGHT, 6500, 0, 1, false, true)).toBe("ne");
    expect(faceTo(s, EIGHT, 6550, 0, 1, true, true)).toBe("s");

    // Four facings: the half of the diagonal it already faces, else the horizontal one;
    // without a clip the turn lasts the lunge at least.
    const four = setup().s;
    faceTo(four, STILL, 0, 0, -1, false, false);
    startAttack(four, 100, 1, -1);
    expect(faceTo(four, STILL, 100, 0, -1, false, false)).toBe("n");
    startAttack(four, 200, -1, 1);
    expect(faceTo(four, STILL, 200, 0, -1, false, false)).toBe("w");
    expect(faceTo(four, STILL, 210, 1, 0, true, false)).toBe("w"); // the lunge still plays
    expect(faceTo(four, STILL, 200 + LUNGE_OUT_MS + LUNGE_BACK_MS, 1, 0, true, false)).toBe("e");

    // An attack on its own tile turns nothing; a dying figure no longer turns to one.
    startAttack(four, 1000, 0, 0);
    expect(faceTo(four, STILL, 1000, 1, 0, false, false)).toBe("e");
    startAttack(four, 2000, 0, 1);
    startDeath(four, 2001);
    expect(faceTo(four, STILL, 2002, 1, 0, false, false)).toBe("e");
  });

  it("aims an attack by its octant, not its signs", () => {
    const { s } = setup();
    startAttack(s, 0, 6, -1);
    expect([s.attackDx, s.attackDy]).toEqual([1, 0]);
    startAttack(s, 0, 1, -5);
    expect([s.attackDx, s.attackDy]).toEqual([0, -1]);
    startAttack(s, 0, -4, 3);
    expect([s.attackDx, s.attackDy]).toEqual([-1, 1]);
    startAttack(s, 0, 2, 1);
    expect([s.attackDx, s.attackDy]).toEqual([1, 1]);
  });

  it("turns an eight-facing figure to a diagonal direction", () => {
    expect(turnTo("n", 1, -1, true)).toBe("ne");
    expect(turnTo("e", -1, 1, true)).toBe("sw");
    expect(turnTo("ne", 0, 1, true)).toBe("s");
    expect(turnTo("nw", 0, 0, true)).toBe("nw"); // no direction keeps the facing
  });

  it("keeps, with four facings, the half of a diagonal it already faces", () => {
    // North-east after facing north stays north; after facing east, east.
    expect(turnTo("n", 1, -1, false)).toBe("n");
    expect(turnTo("e", 1, -1, false)).toBe("e");
    expect(turnTo("s", -1, 1, false)).toBe("s");
    expect(turnTo("w", -1, 1, false)).toBe("w");
    // Neither half: the horizontal one, as before.
    expect(turnTo("s", 1, -1, false)).toBe("e");
    expect(turnTo("e", -1, -1, false)).toBe("w");
    // A figure that was drawn eight ways and lost a layer's diagonals: never a diagonal.
    expect(turnTo("ne", 1, -1, false)).toBe("e");
    // Even with no direction to turn to: the diagonal's horizontal half, one of its four.
    expect(turnTo("ne", 0, 0, false)).toBe("e");
    expect(turnTo("se", 0, 0, false)).toBe("e");
    expect(turnTo("sw", 0, 0, false)).toBe("w");
    expect(turnTo("nw", 0, 0, false)).toBe("w");
    for (const d of STRAIGHT_DIRS) expect(turnTo(d, 0, 0, false)).toBe(d);
    // Straight directions are themselves.
    expect(turnTo("n", 0, 1, false)).toBe("s");
  });

  it("plays a diagonal step by distance: hypot of the frames across and down", () => {
    const walk = { frames: 8, ms: 0, perTile: 8, perTileNS: 13.86, dirs: DIRS };
    const in_ = newAnimInput();
    in_.dir = "e";
    in_.moveDx = 1;
    in_.moveDy = -1;
    expect(walkPerStep(walk, in_)).toBeCloseTo(Math.hypot(8, 13.86), 6);
    in_.moveDy = 0;
    expect(walkPerStep(walk, in_)).toBe(8);
    in_.moveDx = 0;
    in_.moveDy = 1;
    in_.dir = "s";
    expect(walkPerStep(walk, in_)).toBe(13.86);
    // An animal (no perTileNS): √2 times its frames per tile on a diagonal.
    const trot = { frames: 4, ms: 0, perTile: 2, dirs: DIRS };
    in_.moveDx = -1;
    expect(walkPerStep(trot, in_)).toBeCloseTo(2 * Math.SQRT2, 6);
  });

  it("walks the engine humanoid at one cadence in the eight directions", () => {
    // assets/sprites.yaml since 2026-11-26: per_tile 8 and no per_tile_ns. Before, facing
    // north or south played 13.86 frames per tile: at the same px/s the legs moved 73 %
    // faster than walking east, and up and down read as faster than sideways.
    const walk = { frames: 8, ms: 0, perTile: 8, dirs: DIRS };
    const in_ = newAnimInput();
    const per = (dir: (typeof DIRS)[number], dx: number, dy: number): number => {
      in_.dir = dir;
      in_.moveDx = dx;
      in_.moveDy = dy;
      return walkPerStep(walk, in_);
    };
    // The four straight steps: the same frames (footfalls) per tile, so per second.
    expect(per("n", 0, -1)).toBe(8);
    expect(per("s", 0, 1)).toBe(8);
    expect(per("e", 1, 0)).toBe(8);
    expect(per("w", -1, 0)).toBe(8);
    // A diagonal step lasts √2 as long (docs/02 diagonal_cost) and plays √2 as many.
    for (const [dx, dy] of [
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ] as const)
      expect(per(dx > 0 ? "e" : "w", dx, dy) / Math.SQRT2).toBeCloseTo(8, 9);
  });

  it("advances the cycle by the diagonal's length, so the feet do not slide", () => {
    const HUMAN: AnimMeta = {
      ...LPC,
      actions: {
        ...LPC.actions,
        walk: { frames: 8, ms: 0, perTile: 8, perTileNS: 13.86, dirs: DIRS },
      },
    };
    const { s, in_, out } = setup();
    in_.dir = "e";
    in_.moveDx = 1;
    in_.moveDy = 1;
    in_.walkStart = 0;
    in_.walkMs = 700;
    in_.now = 350; // half the step: hypot(8, 13.86) / 2 = 8.0 frames in
    expect(animate(s, HUMAN, in_, out).frame).toBe(Math.floor(Math.hypot(8, 13.86) / 2) % 8);
    in_.walkStart = 700;
    in_.now = 700;
    animate(s, HUMAN, in_, out);
    // The diagonal counted its whole length into the cycle (16 frames: two cycles).
    expect(s.walkPer).toBeCloseTo(Math.hypot(8, 13.86), 6);
    expect(s.walkPhase).toBeCloseTo(Math.hypot(8, 13.86) % 8, 6);
  });
});

describe("stanceOf (where a facing stands: the shadows start there)", () => {
  const meta = (stance: AnimMeta["stance"]): AnimMeta => ({
    w: 64,
    h: 64,
    anchor: "bc",
    foot: 2,
    top: 46,
    shadow: "ellipse",
    actions: {},
    ...(stance ? { stance } : {}),
  });

  it("gives the facing's own stance, else the south's, else any", () => {
    const m = meta({ s: [6, 24, 40], e: [4, 30, 44] });
    expect(stanceOf(m, "e")).toEqual([4, 30, 44]);
    expect(stanceOf(m, "nw")).toEqual([6, 24, 40]);
    expect(stanceOf(meta({ w: [3, 8, 24] }), "n")).toEqual([3, 8, 24]);
  });

  it("is undefined for an atlas without stances: the caller falls back on foot", () => {
    expect(stanceOf(meta(undefined), "s")).toBeUndefined();
    expect(stanceOf(undefined, "s")).toBeUndefined();
  });
});
