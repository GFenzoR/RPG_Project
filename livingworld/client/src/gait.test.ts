// Footfalls (gait.ts) over the walk the client really draws: the tests run packages/renderer
// anim.ts frame by frame, as the canvas does, and check when and where each foot lands.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  animate,
  newAnimInput,
  newAnimState,
  newPose,
  dirOf,
  walkCyclesPerStep,
} from "../../../packages/renderer/src/anim.ts";
import type { AnimMeta } from "../../../packages/renderer/src/anim.ts";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import {
  FootfallTracker,
  footOffset,
  gaitOf,
  newWalkSample,
  parseGaits,
  printOffset,
  stepRotation,
} from "./gait.ts";
import type { Gait, GaitData } from "./gait.ts";

const T = 32;
const DATA = parseGaits(
  parseYaml(readFileSync(new URL("../../../data/livingworld/gaits.yaml", import.meta.url), "utf8")),
) as GaitData;
const gait = (name: string): Gait => {
  const g = DATA.gaits[name];
  if (!g) throw new Error(name);
  return g;
};

const DIRS4: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];
/** The engine humanoid's walk (assets/sprites.yaml: per_tile 8 in every facing). */
const HUMAN: AnimMeta = {
  w: 64,
  h: 64,
  anchor: "bc",
  foot: 3,
  top: 38,
  shadow: "ellipse",
  actions: {
    idle: { frames: 2, ms: 500, dirs: DIRS4 },
    walk: { frames: 8, ms: 0, perTile: 8, dirs: DIRS4 },
  },
};
/** A beast with a four-frame walk clip, a cycle per tile. */
const BEAST: AnimMeta = {
  ...HUMAN,
  actions: { walk: { frames: 4, ms: 0, perTile: 4, dirs: DIRS4 } },
};
/** A single-frame monster: it hops once per tile (ANI-5). */
const STILL: AnimMeta = {
  w: 32,
  h: 32,
  anchor: "br",
  foot: 0,
  top: 24,
  shadow: "baked",
  actions: {},
};

interface Fall {
  t: number;
  x: number;
  y: number;
  rot: number;
  side: number;
  contact: number;
  frame: number;
  bodyX: number;
  bodyY: number;
  sliding: boolean;
}

interface Leg {
  dx: number;
  dy: number;
  /** Ms per tile; a leg with dx = dy = 0 stands still that long. */
  ms: number;
  /** While walking this leg, the drawing glides over a correction this far (px). */
  slide?: number;
  /** Before this leg, the body jumps this far (a teleport), tiles. */
  jump?: number;
}

/**
 * Walks `legs` (one tile each) from tile (10, 10), drawing a frame every `frameMs`, as
 * the canvas does: the body slides along the step, anim.ts picks the frame, the tracker
 * gets the sample. Returns the footfalls and the frames drawn.
 */
function walk(
  meta: AnimMeta,
  g: Gait | undefined,
  legs: readonly Leg[],
  frameMs = 1000 / 60,
  tracker = new FootfallTracker(DATA.viewDepth),
): { falls: Fall[]; frames: number[]; end: { x: number; y: number } } {
  const st = newAnimState(1, 0);
  const input = newAnimInput();
  const pose = newPose();
  const sample = newWalkSample();
  const falls: Fall[] = [];
  const frames: number[] = [];
  let x = 10;
  let y = 10;
  let start = 0;
  let now = 0;
  let facing = dirOf(0, 1);
  for (const leg of legs) {
    if (leg.jump) x += leg.jump;
    const moving = leg.dx !== 0 || leg.dy !== 0;
    if (moving) facing = dirOf(leg.dx, leg.dy);
    for (; now < start + leg.ms; now += frameMs) {
      const t = (now - start) / leg.ms;
      const bx = moving ? x + leg.dx * t : x;
      const by = moving ? y + leg.dy * t : y;
      input.now = now;
      input.dir = facing.length === 2 ? (facing[1] as "e" | "w") : facing;
      input.walkStart = moving ? start : undefined;
      input.walkMs = moving ? leg.ms : 0;
      input.moveDx = leg.dx;
      input.moveDy = leg.dy;
      animate(st, meta, input, pose);
      frames.push(pose.frame);
      tracker.tick();
      sample.id = 1;
      sample.x = (bx + 0.5) * T + (leg.slide ?? 0);
      sample.y = (by + 1) * T - 4;
      sample.z = 7;
      sample.phase = pose.walk;
      sample.frames = meta.actions.walk?.frames ?? 0;
      sample.dx = leg.dx;
      sample.dy = leg.dy;
      sample.cyclePx = (T * Math.hypot(leg.dx, leg.dy)) / walkCyclesPerStep(meta, input);
      sample.gait = g;
      sample.sliding = (leg.slide ?? 0) > DATA.slidePx;
      sample.self = true;
      sample.stepMs = leg.ms;
      tracker.sample(sample, (f) => {
        falls.push({
          t: now,
          x: f.x,
          y: f.y,
          rot: f.rot,
          side: f.side,
          contact: f.contact,
          frame: pose.frame,
          bodyX: sample.x,
          bodyY: sample.y,
          sliding: f.sliding,
        });
      });
    }
    start += leg.ms;
    x += leg.dx;
    y += leg.dy;
  }
  return { falls, frames, end: { x, y } };
}

const repeat = (n: number, leg: Leg): Leg[] => Array.from({ length: n }, () => leg);

describe("gaits (data/livingworld/gaits.yaml)", () => {
  it("reads the file: the biped is the engine humanoid's walk", () => {
    const biped = gait("biped");
    expect(biped).toMatchObject({ print: "feet", stance: 2.2, reach: 0.25, rise: 6 });
    expect(biped.contacts).toEqual([
      { at: 0, side: 1, along: 0 },
      { at: 0.5, side: -1, along: 0 },
    ]);
    expect(DATA.viewDepth).toBeCloseTo(Math.tan(Math.PI / 6), 3);
    expect(gait("quadruped").contacts).toHaveLength(4);
    expect(gait("big_quadruped").scale).toBe(1);
    expect(gait("big_biped").scale).toBeGreaterThan(1);
    // A big body presses deeper than a small one.
    expect(gait("big_quadruped").depth).toBeGreaterThan(gait("quadruped").depth);
    expect(gait("many_legs").print).toBe("dot");
    expect(gait("slither").print).toBe("trail");
  });

  it("gives each body its gait: defaults by kind, a creature's own, none for a flier", () => {
    expect(gaitOf(DATA, undefined, "humanoid")?.name).toBe("biped");
    expect(gaitOf(DATA, "wolf", "beast")?.name).toBe("quadruped");
    expect(gaitOf(DATA, "bramble_stag", "big_beast")?.name).toBe("big_quadruped");
    expect(gaitOf(DATA, "moss_spider", "beast")?.name).toBe("many_legs");
    expect(gaitOf(DATA, "slag_golem", "big_beast")?.name).toBe("big_biped");
    expect(gaitOf(DATA, "gloom_bat", "flying")).toBeUndefined();
    expect(gaitOf(undefined, "wolf", "beast")).toBeUndefined();
  });

  it("is lenient with a malformed file and undefined without one", () => {
    expect(parseGaits(undefined)).toBeUndefined();
    const d = parseGaits({
      gaits: {
        odd: { print: "hoof", contacts: [{ at: 2 }, { at: 0.3, side: "up" }, "x"] },
      },
      defaults: { humanoid: "nope", beast: "odd" },
      creatures: { wolf: "nope", rat: "odd" },
    });
    expect(d?.gaits["odd"]).toMatchObject({ print: "feet", stance: 0, scale: 1, depth: 1 });
    expect(d?.gaits["odd"]?.contacts).toEqual([{ at: 0.3, side: 0, along: 0 }]);
    expect(d?.defaults).toMatchObject({ humanoid: "", beast: "odd", big_beast: "odd" });
    expect(d?.creatures).toEqual({ rat: "odd" });
    expect(gaitOf(d, undefined, "humanoid")).toBeUndefined();
  });
});

describe("footfalls over the walk cycle", () => {
  it("reports a foot when its contact frame is first drawn: right at 0, left at 4", () => {
    const { falls, frames } = walk(HUMAN, gait("biped"), repeat(3, { dx: 1, dy: 0, ms: 400 }));
    // Three tiles east: three cycles, two feet each.
    expect(falls.map((f) => f.side)).toEqual([1, -1, 1, -1, 1, -1]);
    expect(falls.map((f) => f.frame)).toEqual([0, 4, 0, 4, 0, 4]);
    // On the very frame the clip flips to it, not a frame late.
    const flips: number[] = [];
    let prev = -1;
    frames.forEach((fr, i) => {
      if (fr !== prev && (fr === 0 || fr === 4)) flips.push(i);
      prev = fr;
    });
    expect(falls.map((f) => Math.round(f.t / (1000 / 60)))).toEqual(flips);
  });

  it("never reports the foot in the air: between two contacts there is none", () => {
    const { falls } = walk(HUMAN, gait("biped"), repeat(4, { dx: 1, dy: 0, ms: 400 }));
    for (let i = 1; i < falls.length; i++) {
      const a = falls[i - 1] as Fall;
      const b = falls[i] as Fall;
      expect(b.side).toBe(-a.side);
      // Half a cycle apart: 200 ms at 400 ms a tile.
      expect(b.t - a.t).toBeGreaterThan(180);
      expect(b.t - a.t).toBeLessThan(220);
    }
  });

  const EIGHT: [string, number, number, number][] = [
    ["n", 0, -1, 8],
    ["ne", 1, -1, 8 * Math.SQRT2],
    ["e", 1, 0, 8],
    ["se", 1, 1, 8 * Math.SQRT2],
    ["s", 0, 1, 8],
    ["sw", -1, 1, 8 * Math.SQRT2],
    ["w", -1, 0, 8],
    ["nw", -1, -1, 8 * Math.SQRT2],
  ];
  for (const [name, dx, dy, per] of EIGHT)
    it(`walking ${name}: prints a stride apart, alternating, turned the way it walks`, () => {
      const { falls } = walk(HUMAN, gait("biped"), repeat(6, { dx, dy, ms: 500 }));
      expect(falls.length).toBeGreaterThanOrEqual(6);
      // The stride on screen: what the body travels in half a cycle (4 of `per` frames).
      const stride = (T * Math.hypot(dx, dy) * 4) / per;
      const len = Math.hypot(dx, dy);
      const off = { x: 0, y: 0 };
      for (let i = 1; i < falls.length; i++) {
        const a = falls[i - 1] as Fall;
        const b = falls[i] as Fall;
        expect(b.side).toBe(-a.side);
        expect(b.rot).toBeCloseTo(Math.atan2(dx, -dy), 9);
        // One stride along the path (whatever the frame rate caught), and across it from
        // one foot to the other: twice the stance, as the view draws it (on a diagonal the
        // feet are not square to the path on screen: the body is turned 60 degrees).
        footOffset(dx, dy, 0, 0, b.side, 2 * 2.2, DATA.viewDepth, off);
        expect(b.x - a.x - (dx / len) * stride).toBeCloseTo(off.x, 6);
        expect(b.y - a.y - (dy / len) * stride).toBeCloseTo(off.y, 6);
      }
    });

  it("puts the right foot on the right of the path and the left on the left", () => {
    const side = (dx: number, dy: number): { right: Fall; left: Fall } => {
      const { falls } = walk(HUMAN, gait("biped"), repeat(3, { dx, dy, ms: 400 }));
      return {
        right: falls.find((f) => f.side === 1) as Fall,
        left: falls.find((f) => f.side === -1) as Fall,
      };
    };
    // Going north, right is east; going south, west; going east, south (nearer the camera).
    const n = side(0, -1);
    expect(n.right.x - 10.5 * T).toBeCloseTo(2.2, 6);
    expect(n.left.x - 10.5 * T).toBeCloseTo(-2.2, 6);
    const s = side(0, 1);
    expect(s.right.x - 10.5 * T).toBeCloseTo(-2.2, 6);
    const e = side(1, 0);
    const line = 11 * T - 4 - 6; // the feet line, lifted by the gait's rise
    expect(e.right.y - line).toBeCloseTo(2.2 * DATA.viewDepth, 6);
    expect(e.left.y - line).toBeCloseTo(-2.2 * DATA.viewDepth, 6);
  });

  it("lands the foot half a stride ahead of where the body was at the contact", () => {
    const { falls } = walk(HUMAN, gait("biped"), repeat(2, { dx: 1, dy: 0, ms: 400 }), 7);
    for (const f of falls) {
      // The body when the frame was drawn is at most a frame's travel past the contact.
      const ahead = f.x - f.bodyX;
      expect(ahead).toBeLessThanOrEqual(8 + 1e-6);
      expect(ahead).toBeGreaterThan(8 - (T * 7) / 400 - 1e-6);
    }
    // The first contact is the very start of the walk: the body is at its tile's middle.
    expect((falls[0] as Fall).x).toBeCloseTo(10.5 * T + 8, 6);
  });

  it("keeps the prints in the same places at any frame rate and any speed", () => {
    const path = [...repeat(2, { dx: 1, dy: 0, ms: 400 }), ...repeat(2, { dx: 1, dy: 1, ms: 400 })];
    const at = (frameMs: number, ms: number): [number, number, number][] =>
      walk(
        HUMAN,
        gait("biped"),
        path.map((l) => ({ ...l, ms })),
        frameMs,
      ).falls.map((f) => [f.x, f.y, f.side]);
    const base = at(1000 / 60, 400);
    expect(base.length).toBeGreaterThan(6);
    for (const other of [at(1000 / 144, 400), at(50, 400), at(1000 / 60, 150), at(33, 900)]) {
      expect(other).toHaveLength(base.length);
      other.forEach((p, i) => {
        const b = base[i] as [number, number, number];
        expect(p[0]).toBeCloseTo(b[0], 5);
        expect(p[1]).toBeCloseTo(b[1], 5);
        expect(p[2]).toBe(b[2]);
      });
    }
  });

  it("carries the cycle through a turn: the feet keep alternating", () => {
    const { falls } = walk(HUMAN, gait("biped"), [
      ...repeat(2, { dx: 1, dy: 0, ms: 400 }),
      ...repeat(2, { dx: 0, dy: 1, ms: 400 }),
      ...repeat(2, { dx: -1, dy: -1, ms: 400 }),
    ]);
    for (let i = 1; i < falls.length; i++)
      expect((falls[i] as Fall).side).toBe(-(falls[i - 1] as Fall).side);
  });

  it("leaves nothing standing still or turning in place", () => {
    const { falls } = walk(HUMAN, gait("biped"), [
      { dx: 0, dy: 0, ms: 2000 },
      { dx: 0, dy: 0, ms: 2000 },
    ]);
    expect(falls).toHaveLength(0);
  });

  it("a stop mid-cycle leaves the last planted foot only, and the walk resumes from there", () => {
    // A diagonal step is 11.31 of the 8 frames: it stops in the middle of the second cycle.
    const tracker = new FootfallTracker(DATA.viewDepth);
    const { falls } = walk(
      HUMAN,
      gait("biped"),
      [
        { dx: 1, dy: -1, ms: 400 },
        { dx: 0, dy: 0, ms: 3000 },
      ],
      1000 / 60,
      tracker,
    );
    // Contacts at frames 0, 4, 8 (= 0): the last one planted before the stop.
    expect(falls.map((f) => f.side)).toEqual([1, -1, 1]);
    expect(Math.max(...falls.map((f) => f.t))).toBeLessThan(400);
  });

  it("walking one tile at a time loses no foot: a contact at the seam of two steps counts once", () => {
    // East, a tile is a whole cycle: each step ends exactly on the right foot's contact.
    const { falls } = walk(HUMAN, gait("biped"), [
      { dx: 1, dy: 0, ms: 400 },
      { dx: 0, dy: 0, ms: 700 },
      { dx: 1, dy: 0, ms: 400 },
      { dx: 0, dy: 0, ms: 700 },
      { dx: 1, dy: 0, ms: 400 },
    ]);
    expect(falls.map((f) => f.side)).toEqual([1, -1, 1, -1, 1, -1]);
    // Each right foot where that step starts, each left one half a tile on.
    expect(falls.map((f) => Math.round(f.x - 10.5 * T))).toEqual([8, 24, 40, 56, 72, 88]);
  });

  it("a teleport leaves no print: only walking does, from where the body is drawn", () => {
    const { falls } = walk(HUMAN, gait("biped"), [
      { dx: 1, dy: 0, ms: 400 },
      { dx: 0, dy: 0, ms: 100, jump: 30 },
      { dx: 0, dy: 0, ms: 500 },
      { dx: 1, dy: 0, ms: 400 },
    ]);
    // Nothing between the tile it left and the place it appeared at.
    for (const f of falls) {
      const tiles = f.x / T - 10.5;
      expect(tiles < 1.1 || tiles > 30.9).toBe(true);
    }
    expect(falls.filter((f) => f.x / T - 10.5 > 30.9).length).toBe(2);
  });

  it("marks the footfalls of a drawing that glides over a correction", () => {
    const { falls } = walk(HUMAN, gait("biped"), [
      { dx: 1, dy: 0, ms: 400 },
      { dx: 1, dy: 0, ms: 400, slide: 9 },
      { dx: 1, dy: 0, ms: 400, slide: 1 },
    ]);
    expect(falls.map((f) => f.sliding)).toEqual([false, false, true, true, false, false]);
  });

  it("a creature first seen in the middle of its walk starts with its next contact", () => {
    const tracker = new FootfallTracker(1);
    const s = newWalkSample();
    const seen: number[] = [];
    Object.assign(s, { id: 5, dx: 1, dy: 0, cyclePx: 32, frames: 8, gait: gait("biped") });
    for (const phase of [0.3, 0.4, 0.55, 0.9, 0.05]) {
      s.phase = phase;
      tracker.sample(s, (f) => seen.push(f.side));
    }
    expect(seen).toEqual([-1, 1]);
    // Forgotten (it left the view) and back at the start of a walk: the start counts.
    tracker.forget(5);
    seen.length = 0;
    s.phase = 0;
    tracker.sample(s, (f) => seen.push(f.side));
    expect(seen).toEqual([1]);
    expect(tracker.tracked).toBe(1);
  });

  it("a long frame that passed both feet reports them in order, each in its place", () => {
    const tracker = new FootfallTracker(1);
    const s = newWalkSample();
    Object.assign(s, { id: 5, dx: 1, dy: 0, cyclePx: 32, frames: 8, gait: gait("biped"), y: 0 });
    s.phase = 0.9;
    s.x = 0;
    tracker.sample(s, () => undefined);
    const got: [number, number][] = [];
    s.phase = 0.6; // 0.7 of a cycle later: 22.4 px on
    s.x = 22.4;
    tracker.sample(s, (f) => got.push([f.side, f.x]));
    expect(got.map((g) => g[0])).toEqual([1, -1]);
    // The right foot landed at phase 0 (body at 3.2), the left at 0.5 (body at 19.2).
    expect(got[0]?.[1]).toBeCloseTo(3.2 + 8, 6);
    expect(got[1]?.[1]).toBeCloseTo(19.2 + 8, 6);
  });
});

describe("other bodies", () => {
  it("a quadruped leaves four prints a cycle in its gait's pattern, fore and hind", () => {
    const g = gait("quadruped");
    const { falls } = walk(BEAST, g, repeat(2, { dx: 1, dy: 0, ms: 400 }));
    expect(falls.map((f) => f.contact)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(falls.map((f) => f.side)).toEqual([-1, -1, 1, 1, -1, -1, 1, 1]);
    // Hind left under the haunches, fore left ahead of it; left feet north of the line.
    const [hind, fore] = falls as [Fall, Fall];
    expect(hind.x).toBeCloseTo(10.5 * T - 5, 6);
    expect(fore.x).toBeCloseTo(10.5 * T + 8 + 5, 6);
    expect(hind.y).toBeLessThan(11 * T - 4 - g.rise);
    expect((falls[2] as Fall).y).toBeGreaterThan(11 * T - 4 - g.rise);
  });

  it("a creature without a walk clip hops: a jumper's two feet land where each hop ends", () => {
    const { falls } = walk(STILL, gait("hop"), repeat(3, { dx: 0, dy: 1, ms: 300 }));
    expect(falls.map((f) => f.side)).toEqual([-1, 1, -1, 1, -1, 1]);
    // Both at the tile each hop lands on (the feet line of tiles 11, 12, 13).
    const rows = falls.map((f) => Math.round((f.y + 4 + gait("hop").rise) / T));
    expect(rows).toEqual([12, 12, 13, 13, 14, 14]);
    expect((falls[0] as Fall).x).toBeCloseTo(10.5 * T + 4, 6);
    expect((falls[1] as Fall).x).toBeCloseTo(10.5 * T - 4, 6);
  });

  it("many legs leave a dotted line each side; a flier (no gait) nothing", () => {
    const { falls } = walk(BEAST, gait("many_legs"), repeat(2, { dx: 1, dy: 0, ms: 400 }));
    expect(falls).toHaveLength(16);
    expect(new Set(falls.map((f) => f.side))).toEqual(new Set([-1, 1]));
    expect(walk(BEAST, undefined, repeat(2, { dx: 1, dy: 0, ms: 400 })).falls).toHaveLength(0);
    expect(walk(BEAST, gait("none"), repeat(2, { dx: 1, dy: 0, ms: 400 })).falls).toHaveLength(0);
  });
});

describe("the print's place", () => {
  it("turns with the path: 0 north, clockwise, in the eight directions", () => {
    expect(stepRotation(0, -1)).toBeCloseTo(0);
    expect(stepRotation(1, -1)).toBeCloseTo(Math.PI / 4);
    expect(stepRotation(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(stepRotation(1, 1)).toBeCloseTo((3 * Math.PI) / 4);
    expect(stepRotation(0, 1)).toBeCloseTo(Math.PI);
    expect(stepRotation(-1, 1)).toBeCloseTo((-3 * Math.PI) / 4);
    expect(stepRotation(-1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(stepRotation(-1, -1)).toBeCloseTo(-Math.PI / 4);
  });

  it("offsets a foot across the path as the 3/4 view draws it", () => {
    const o = { x: 0, y: 0 };
    const k = 0.5;
    footOffset(1, 0, 10, 0, 1, 3, k, o); // east: ahead in x, the right foot down the screen
    expect(o).toEqual({ x: 10, y: 1.5 });
    footOffset(0, -1, 10, 0, 1, 3, k, o); // north: ahead up the screen, the right foot east
    expect(o.x).toBeCloseTo(3);
    expect(o.y).toBeCloseTo(-10);
    // A diagonal on screen is a body turned atan(1 / depth) on the ground: its feet are
    // apart along the perpendicular of that heading, drawn with the view's depth.
    footOffset(1, 1, 0, 0, 1, 3, k, o);
    const h = Math.hypot(1, 1 / k);
    expect(o.x).toBeCloseTo((-3 * (1 / k)) / h);
    expect(o.y).toBeCloseTo((3 * 1 * k) / h);
    // `along` runs on the body (foreshortened going north or south), `ahead` on screen.
    footOffset(0, 1, 0, 4, 0, 0, k, o);
    expect(o).toEqual({ x: 0, y: 2 });
    footOffset(0, 0, 5, 5, 1, 5, k, o);
    expect(o).toEqual({ x: 0, y: 0 });
  });

  describe('both feet, everywhere (owner, 2026-11-25: "pareciera que está cojeando")', () => {
    const DIRS8: [string, number, number][] = [
      ["north", 0, -1],
      ["north-east", 1, -1],
      ["east", 1, 0],
      ["south-east", 1, 1],
      ["south", 0, 1],
      ["south-west", -1, 1],
      ["west", -1, 0],
      ["north-west", -1, -1],
    ];
    // From a slowed crawl to a hasted sprint, ms per tile, at 30, 60 and 144 fps.
    const SPEEDS = [1200, 800, 500, 400, 300, 220, 150, 100];
    const RATES = [1000 / 30, 1000 / 60, 1000 / 144];

    for (const [name, dx, dy] of DIRS8) {
      it(`a biped walking ${name}: left and right in turn, evenly, at every speed and frame rate`, () => {
        for (const ms of SPEEDS)
          for (const frameMs of RATES) {
            const label = `${name} ${ms} ms/tile ${Math.round(1000 / frameMs)} fps`;
            const { falls } = walk(HUMAN, gait("biped"), repeat(8, { dx, dy, ms }), frameMs);
            expect(falls.length, label).toBeGreaterThanOrEqual(15);
            const left = falls.filter((f) => f.side === -1).length;
            const right = falls.filter((f) => f.side === 1).length;
            expect(left + right, label).toBe(falls.length);
            expect(Math.abs(left - right), label).toBeLessThanOrEqual(1);
            for (let i = 1; i < falls.length; i++)
              expect((falls[i] as Fall).side, `${label} #${i}`).toBe(-(falls[i - 1] as Fall).side);
            // No limp: every beat comes the same time after the one before, give or take
            // the frames it is drawn on.
            const gaps = falls.slice(1).map((f, i) => f.t - (falls[i] as Fall).t);
            const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            for (const g of gaps)
              expect(Math.abs(g - mean), label).toBeLessThanOrEqual(frameMs * 2 + 1);
          }
      });
    }

    it("the prints of the two feet lie on two lines either side of the path, in all 8 directions", () => {
      const o = { x: 0, y: 0 };
      for (const [name, dx, dy] of DIRS8) {
        const { falls } = walk(HUMAN, gait("biped"), repeat(6, { dx, dy, ms: 400 }));
        // Across the path on screen: the right-hand normal of the way it walks.
        const len = Math.hypot(dx, dy);
        const across = (f: Fall): number => {
          printOffset(dx, dy, f.side, gait("biped").spread, o);
          return ((f.x + o.x) * -dy + (f.y + o.y) * dx) / len;
        };
        const rights = falls.filter((f) => f.side === 1).map(across);
        const lefts = falls.filter((f) => f.side === -1).map(across);
        expect(rights.length, name).toBeGreaterThan(2);
        expect(lefts.length, name).toBeGreaterThan(2);
        // Two rows at least 3 px apart: they read as two feet, not one.
        expect(Math.min(...rights) - Math.max(...lefts), name).toBeGreaterThanOrEqual(3);
      }
    });

    it("draws a print out to its foot's own side, by the gait's spread", () => {
      const o = { x: 0, y: 0 };
      printOffset(1, 0, 1, 1.5, o); // east: the right foot is south
      expect(o).toEqual({ x: 0, y: 1.5 });
      printOffset(1, 0, -1, 1.5, o);
      expect(o).toEqual({ x: 0, y: -1.5 });
      printOffset(0, -1, 1, 2, o); // north: the right foot is east
      expect(o.x).toBe(2);
      printOffset(0, 1, 0, 2, o); // on the centre line: where it stands
      expect(o).toEqual({ x: 0, y: 0 });
      expect(gait("biped").spread).toBeGreaterThan(0);
      expect(gait("quadruped").spread).toBe(0);
    });

    it("every other body puts down both sides too: as many left feet as right", () => {
      for (const [name, meta] of [
        ["quadruped", BEAST],
        ["big_quadruped", BEAST],
        ["many_legs", BEAST],
        ["slither", BEAST],
        ["hop", STILL],
        ["big_biped", HUMAN],
      ] as const)
        for (const [dir, dx, dy] of DIRS8)
          for (const ms of [800, 400, 150]) {
            const { falls } = walk(meta, gait(name), repeat(8, { dx, dy, ms }));
            const left = falls.filter((f) => f.side === -1).length;
            const right = falls.filter((f) => f.side === 1).length;
            const label = `${name} ${dir} ${ms}`;
            expect(left, label).toBeGreaterThan(2);
            expect(Math.abs(left - right), label).toBeLessThanOrEqual(2);
          }
    });

    it("every gait of the data with feet has them on both sides", () => {
      for (const g of Object.values(DATA.gaits)) {
        if (g.contacts.length === 0) continue;
        expect(
          g.contacts.some((c) => c.side < 0),
          g.name,
        ).toBe(true);
        expect(
          g.contacts.some((c) => c.side > 0),
          g.name,
        ).toBe(true);
      }
    });
  });
});
