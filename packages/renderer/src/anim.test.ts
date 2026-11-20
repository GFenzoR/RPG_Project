import { describe, expect, it } from "vitest";
import {
  APPEAR_MS,
  DEATH_FADE_MS,
  DEATH_MS,
  HIT_FLASH_MS,
  HIT_MS,
  IDLE_AFTER_MS,
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

  it("plays the death clip, fades its last frame and says when it is done", () => {
    const { s, in_, out } = setup();
    startDeath(s, 0);
    startDeath(s, 50); // the first death counts
    in_.now = 250;
    expect(animate(s, LPC, in_, out)).toMatchObject({ action: "death", frame: 2, done: false });
    in_.now = clipMs(LPC, "death") + DEATH_FADE_MS / 2;
    expect(animate(s, LPC, in_, out)).toMatchObject({ frame: 5, alpha: 0.5, done: false });
    in_.now = clipMs(LPC, "death") + DEATH_FADE_MS;
    expect(animate(s, LPC, in_, out).done).toBe(true);
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

  it("falls flat and fades when it dies", () => {
    const { s, in_, out } = setup();
    startDeath(s, 0);
    in_.now = DEATH_MS / 2;
    expect(animate(s, STILL, in_, out)).toMatchObject({ scaleY: 0.75, alpha: 0.5, done: false });
    in_.now = DEATH_MS;
    expect(animate(s, STILL, in_, out).done).toBe(true);
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
