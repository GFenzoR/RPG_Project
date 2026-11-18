// Timing simulation of fluid walking (client/CLAUDE.md "Movimiento fluido"): the real
// WorldState of the walking player and of an observer, a 60 Hz frame loop like game.ts
// `frame`, and a small model of the server's walking rules (docs/05 "Caminar": 50 ms
// ticks, a step starts when the one before ends, keyboard steps queue up to
// max_queued_steps behind a walk epoch). Links add latency and jitter and keep order.
import { NO_SOUNDS } from "../audio/cues.ts";
import {
  CreatureKind,
  CreatureSchema,
  Direction,
  ItemStackSchema,
  MapAreaSchema,
  MapFloorSchema,
  TileSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { STEP_LEAD_MS, stalls } from "./motion.ts";
import { WorldState } from "./world.ts";
import type { CreatureState } from "./world.ts";

const content: ClientContent = {
  items: {
    1: {
      id: "grass",
      sprite: "ground/grass",
      ground: true,
      walkable: true,
      blocks: false,
      speed: 100,
      stackable: false,
      slots: 0,
      useWith: false,
    },
  },
  monsterSprites: {},
  vocations: [],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100, maxQueuedSteps: 4 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

type Msg = ServerMessage["message"];
const WALKER = 7;
const OBSERVER = 9;
const X0 = 100;
const Y = 200;
const TICK = 50;
const pos = (x: number) => ({ $typeName: "game.v1.Position" as const, x, y: Y, z: 7 });

/** An 80x3 grass corridor with the walker at (100, 200) and the observer behind it. */
function client(selfId: number, speed: number): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: { $typeName: "game.v1.Welcome", creatureId: selfId, serverTime: 0n, tickMs: TICK },
    },
    0,
  );
  const grass = create(TileSchema, { items: [create(ItemStackSchema, { itemId: 1 })] });
  const creature = (id: number, x: number) =>
    create(CreatureSchema, {
      id,
      kind: CreatureKind.PLAYER,
      name: `p${id}`,
      pos: { x, y: Y, z: 7 },
      speed,
    });
  const area = create(MapAreaSchema, {
    x: X0 - 4,
    y: Y - 1,
    width: 80,
    height: 3,
    palette: [grass],
    floors: [create(MapFloorSchema, { z: 7, tiles: new Array<number>(80 * 3).fill(0) })],
    creatures: [creature(WALKER, X0), creature(OBSERVER, X0 - 3)],
  });
  w.apply(
    { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area, walkEpoch: 1 } },
    0,
  );
  return w;
}

/** Deterministic jitter. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Run {
  rttMs: number;
  jitterMs: number;
  /** Hold the right arrow this long, or click 8 tiles east (a WalkPath). */
  mode: { hold: number } | { path: number };
  speed?: number;
  frameMs?: number;
  /** A creature the walker's client does not see stands on this tile. */
  blockedX?: number;
  seed?: number;
}

interface Result {
  /** Frames of the walker's own drawing that stood still or went back while walking. */
  ownStalls: number;
  /** The same in the observer's drawing of the walker. */
  observerStalls: number;
  /** Ticks the server waited between steps beyond their duration. */
  serverGaps: number;
  /** The biggest jump of the own drawing between two frames, tiles. */
  biggestJump: number;
  rejections: number;
  steps: number;
  serverX: number;
  own: WorldState;
}

function simulate(run: Run): Result {
  const speed = run.speed ?? 200;
  const frameMs = run.frameMs ?? 1000 / 60;
  const rand = rng(run.seed ?? 7);
  const delay = () => run.rttMs / 2 + rand() * run.jitterMs;
  const own = client(WALKER, speed);
  const obs = client(OBSERVER, speed);

  // Links: in order, each message no earlier than the one before.
  type Up = { at: number; walk?: { dir: Direction; walkEpoch: number }; path?: Direction[] };
  type Down = { at: number; tick: number; msgs: Msg[] };
  const up: Up[] = [];
  const toOwn: Down[] = [];
  const toObs: Down[] = [];
  let upLast = 0;
  let ownLast = 0;
  let obsLast = 0;

  // The server's walker (session/move.go).
  let x = X0;
  let queue: Direction[] = [];
  let keyWalk = false;
  let epoch = 1;
  let readyAt = 0;
  let lastStep = -1;
  let lastTicks = 0;
  let serverGaps = 0;
  let rejections = 0;
  let steps = 0;
  const reject = (out: Msg[], dir: Direction) => {
    queue = [];
    keyWalk = false;
    epoch++;
    rejections++;
    out.push({
      case: "walkRejected",
      value: { $typeName: "game.v1.WalkRejected", pos: pos(x), dir, walkEpoch: epoch },
    });
  };

  const ownTrail: { t: number; x: number; y: number }[] = [];
  const obsTrail: { t: number; x: number; y: number }[] = [];
  const holdUntil = "hold" in run.mode ? run.mode.hold : 0;
  let nextFrame = 0;
  let clicked = false;
  for (let t = 0; t <= 12_000; t++) {
    if (t % TICK === 0) {
      const tick = t / TICK;
      const out: Msg[] = [];
      while (up[0] && up[0].at <= t) {
        const m = up.shift() as Up;
        if (m.path) {
          queue = [...m.path];
          keyWalk = false;
        } else if (m.walk) {
          if (m.walk.walkEpoch !== 0 && m.walk.walkEpoch !== epoch) continue;
          if (!keyWalk) queue = [];
          if (queue.length >= content.movement.maxQueuedSteps) reject(out, m.walk.dir);
          else {
            queue.push(m.walk.dir);
            keyWalk = true;
          }
        }
      }
      if (queue.length > 0 && tick >= readyAt) {
        const dir = queue[0] as Direction;
        if (run.blockedX === x + 1) reject(out, dir);
        else {
          queue.shift();
          if (queue.length === 0) keyWalk = false;
          const ticks = Math.max(Math.ceil((1000 * 100) / speed / TICK), 1);
          if (lastStep >= 0) serverGaps += tick - (lastStep + lastTicks);
          lastStep = tick;
          lastTicks = ticks;
          readyAt = tick + ticks;
          steps++;
          const mv: Msg = {
            case: "creatureMove",
            value: {
              $typeName: "game.v1.CreatureMove",
              id: WALKER,
              from: pos(x),
              to: pos(x + 1),
              durationMs: ticks * TICK,
            },
          };
          x++;
          out.push(mv);
          obsLast = Math.max(obsLast, t + delay());
          toObs.push({ at: obsLast, tick, msgs: [mv] });
        }
      }
      if (out.length > 0) {
        ownLast = Math.max(ownLast, t + delay());
        toOwn.push({ at: ownLast, tick, msgs: out });
      }
    }
    for (const [link, w] of [
      [toOwn, own],
      [toObs, obs],
    ] as const) {
      while (link[0] && link[0].at <= t) {
        const b = link.shift() as Down;
        const at = w.batchTime(b.tick, t);
        for (const m of b.msgs) w.apply(m, t, at);
      }
    }
    if (t >= nextFrame) {
      nextFrame += frameMs;
      // game.ts frame(): decide the next step just before the drawn one ends.
      if ("hold" in run.mode && t < holdUntil && own.canStep(t)) {
        const step = own.chooseStep(Direction.EAST, t);
        if (step?.kind === "walk") {
          upLast = Math.max(upLast, t + delay());
          up.push({ at: upLast, walk: { dir: step.dir, walkEpoch: own.walkEpoch } });
        }
      }
      if ("path" in run.mode && !clicked && t >= 100) {
        clicked = true;
        upLast = Math.max(upLast, t + delay());
        up.push({ at: upLast, path: new Array<Direction>(run.mode.path).fill(Direction.EAST) });
      }
      const self = own.self as CreatureState;
      ownTrail.push({ t, ...own.drawPos(self, t) });
      const seen = obs.creatures.get(WALKER) as CreatureState;
      obsTrail.push({ t, ...obs.drawPos(seen, t) });
    }
  }
  // While walking: from the first frame that left the start to the first that reached
  // the end.
  const walking = (trail: typeof ownTrail) => {
    const end = Math.max(...trail.map((s) => s.x));
    const a = trail.findIndex((s) => s.x > X0);
    const b = trail.findIndex((s) => s.x >= end);
    return trail.slice(Math.max(a - 1, 0), b + 1);
  };
  let biggestJump = 0;
  for (let i = 1; i < ownTrail.length; i++)
    biggestJump = Math.max(
      biggestJump,
      Math.abs((ownTrail[i]?.x ?? 0) - (ownTrail[i - 1]?.x ?? 0)),
    );
  return {
    ownStalls: stalls(walking(ownTrail), 1, 0),
    observerStalls: stalls(walking(obsTrail), 1, 0),
    serverGaps,
    biggestJump,
    rejections,
    steps,
    serverX: x,
    own,
  };
}

describe("fluid walking (timing simulation)", () => {
  const links = [
    { rttMs: 2, jitterMs: 2 },
    { rttMs: 60, jitterMs: 20 },
    { rttMs: 150, jitterMs: 40 },
    { rttMs: 300, jitterMs: 60 },
  ];

  it.each(links)("a held key walks on every frame (rtt $rttMs ms ± $jitterMs)", (link) => {
    const r = simulate({ ...link, mode: { hold: 3000 } });
    expect(r.ownStalls).toBe(0);
    expect(r.observerStalls).toBe(0);
    expect(r.serverGaps).toBe(0);
    expect(r.rejections).toBe(0);
    // 3 s at 500 ms a step, plus the one decided in the last STEP_LEAD_MS.
    expect(r.steps).toBeGreaterThanOrEqual(6);
    expect(r.steps).toBeLessThanOrEqual(7);
    // The client ends where the server is, with every step confirmed.
    expect(r.own.self?.pos.x).toBe(r.serverX);
    expect(r.own.unconfirmed).toBe(0);
    // One frame never covers more than a normal frame's way (1/30 of a tile at 500 ms).
    expect(r.biggestJump).toBeLessThan(0.05);
  });

  it("a fast walker (150 ms a step) on a slow link keeps going too", () => {
    const r = simulate({ rttMs: 250, jitterMs: 50, speed: 667, mode: { hold: 2000 } });
    expect(r.ownStalls).toBe(0);
    expect(r.observerStalls).toBe(0);
    expect(r.own.self?.pos.x).toBe(r.serverX);
  });

  it("holds up at 144 Hz and at a ragged 40 fps", () => {
    for (const frameMs of [1000 / 144, 25]) {
      const r = simulate({ rttMs: 80, jitterMs: 30, frameMs, mode: { hold: 2500 } });
      expect(r.ownStalls).toBe(0);
      expect(r.observerStalls).toBe(0);
    }
  });

  it.each(links)(
    "a click-to-walk path is drawn without stops (rtt $rttMs ms ± $jitterMs)",
    (link) => {
      const r = simulate({ ...link, mode: { path: 8 } });
      expect(r.steps).toBe(8);
      expect(r.ownStalls).toBe(0);
      expect(r.observerStalls).toBe(0);
      expect(r.own.self?.pos.x).toBe(X0 + 8);
    },
  );

  it("a step refused ahead (a creature the client did not see) glides back, once", () => {
    const r = simulate({ rttMs: 120, jitterMs: 30, blockedX: X0 + 4, mode: { hold: 4000 } });
    expect(r.serverX).toBe(X0 + 3);
    expect(r.rejections).toBe(1); // the refused step is not asked again while held
    expect(r.own.self?.pos.x).toBe(X0 + 3);
    expect(r.own.unconfirmed).toBe(0);
    // Back without a pop: never more than a few frames' way in one frame.
    expect(r.biggestJump).toBeLessThan(0.15);
  });
});

describe("own steps predicted ahead", () => {
  const confirm = (w: WorldState, from: number, to: number, durationMs: number, now: number) =>
    w.apply(
      {
        case: "creatureMove",
        value: {
          $typeName: "game.v1.CreatureMove",
          id: WALKER,
          from: pos(from),
          to: pos(to),
          durationMs,
        },
      },
      now,
    );

  it("decides the next step just before the drawn one ends and draws it right after", () => {
    const w = client(WALKER, 200);
    const s = w.self as CreatureState;
    expect(w.chooseStep(Direction.EAST, 0)).toEqual({ kind: "walk", dir: Direction.EAST });
    expect(w.canStep(500 - STEP_LEAD_MS - 1)).toBe(false);
    expect(w.chooseStep(Direction.SOUTH_EAST, 400)).toBeUndefined(); // too soon: nothing
    expect(w.canStep(460)).toBe(true);
    // A diagonal: 750 ms, starting when the first step ends, not now.
    expect(w.chooseStep(Direction.NORTH_EAST, 460)).toEqual({
      kind: "walk",
      dir: Direction.NORTH_EAST,
    });
    expect(s.walk).toMatchObject({ start: 500, duration: 750 });
    expect(w.unconfirmed).toBe(2);
    expect(w.drawPos(s, 480).x).toBeCloseTo(X0 + 0.96); // still the first step
    expect(w.facing(s, 480)).toBe(Direction.EAST);
    expect(w.drawPos(s, 500)).toEqual({ x: X0 + 1, y: Y });
    expect(w.drawPos(s, 875)).toEqual({ x: X0 + 1.5, y: Y - 0.5 });
    expect(w.facing(s, 875)).toBe(Direction.NORTH_EAST);
    // The first one confirmed: the facing stays the newest step's.
    confirm(w, X0, X0 + 1, 500, 520);
    expect(w.unconfirmed).toBe(1);
    expect(s.dir).toBe(Direction.NORTH_EAST);
  });

  it("shifts the steps predicted after one the server took longer", () => {
    const w = client(WALKER, 200);
    const s = w.self as CreatureState;
    w.chooseStep(Direction.EAST, 0);
    w.chooseStep(Direction.EAST, 460);
    // The server slowed the player (paralyze) before the first step: 700 ms, not 500.
    confirm(w, X0, X0 + 1, 700, 480);
    expect(s.walk).toMatchObject({ start: 700, duration: 500 });
    expect(w.drawPos(s, 600).x).toBeCloseTo(X0 + 600 / 700); // no jump
  });

  it("keeps at most max_queued_steps unconfirmed", () => {
    const w = client(WALKER, 200);
    let now = 0;
    for (let i = 0; i < 4; i++) {
      expect(w.canStep(now)).toBe(true);
      w.chooseStep(Direction.EAST, now);
      now += 500;
    }
    expect(w.unconfirmed).toBe(content.movement.maxQueuedSteps);
    expect(w.canStep(now + 1000)).toBe(false); // waits for the server
    confirm(w, X0, X0 + 1, 500, now + 1000);
    expect(w.canStep(now + 1000)).toBe(true);
  });

  it("does not predict past stairs: the server moves the player elsewhere there", () => {
    const w = new WorldState({ ...content, portals: { [`${X0 + 1},${Y},7`]: "stairs" } });
    w.apply(
      {
        case: "welcome",
        value: { $typeName: "game.v1.Welcome", creatureId: WALKER, serverTime: 0n, tickMs: TICK },
      },
      0,
    );
    // The same corridor.
    w.apply(
      {
        case: "fullMapView",
        value: {
          $typeName: "game.v1.FullMapView",
          walkEpoch: 1,
          area: create(MapAreaSchema, {
            x: X0 - 4,
            y: Y - 1,
            width: 80,
            height: 3,
            palette: [create(TileSchema, { items: [create(ItemStackSchema, { itemId: 1 })] })],
            floors: [create(MapFloorSchema, { z: 7, tiles: new Array<number>(80 * 3).fill(0) })],
            creatures: [
              create(CreatureSchema, {
                id: WALKER,
                kind: CreatureKind.PLAYER,
                name: "p",
                pos: { x: X0, y: Y, z: 7 },
                speed: 200,
              }),
            ],
          }),
        },
      },
      0,
    );
    expect(w.chooseStep(Direction.EAST, 0)).toEqual({ kind: "walk", dir: Direction.EAST });
    expect(w.canStep(460)).toBe(false);
    expect(w.canStep(5000)).toBe(false); // until the server answers
  });
});
