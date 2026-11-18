// Timing simulation of fluid walking (client/CLAUDE.md "Movimiento fluido"): the real
// WorldState of the walking player and of an observer, a 60 Hz frame loop like game.ts
// `frame` (the real Steering: a held key, the mouse held on the map, a click's route),
// and a small model of the server's walking rules (docs/05 "Caminar": 50 ms ticks, a step
// starts when the one before ends, Walks queue up to max_queued_steps behind a walk epoch,
// each own step carries its Walk's seq back). Links add latency and jitter and keep order.
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
import { delta } from "./geometry.ts";
import { STEP_LEAD_MS, stalls } from "./motion.ts";
import { Steering } from "./steering.ts";
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
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

type Msg = ServerMessage["message"];
/** Welcome.max_queued_steps (balance.yaml movement.max_queued_steps). */
const MAX_QUEUED = 4;
const WALKER = 7;
const OBSERVER = 9;
const X0 = 100;
const Y = 200;
const TICK = 50;
const pos = (x: number, y = Y) => ({ $typeName: "game.v1.Position" as const, x, y, z: 7 });

/** An 80x3 grass corridor with the walker at (100, 200) and the observer behind it. */
function client(selfId: number, speed: number): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: {
        $typeName: "game.v1.Welcome",
        creatureId: selfId,
        serverTime: 0n,
        tickMs: TICK,
        maxQueuedSteps: MAX_QUEUED,
        viewWidth: 31,
        viewHeight: 21,
        attackEvents: false,
      },
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
  /**
   * Hold the right arrow this long; or hold the mouse on the map this long, the cursor
   * still 3 tiles east of the player on the screen (docs/17 MOV-3); or click the tile `path`
   * tiles east at 100 ms (MOV-4), and with `holdFrom` hold the right arrow from then until
   * `holdUntil` too (click, then arrow).
   */
  mode:
    { hold: number } | { mouse: number } | { path: number; holdFrom?: number; holdUntil?: number };
  /** Which Walks (1 = the first sent) the gateway drops (over its rate limit, a full loop queue). */
  lost?: number[];
  /**
   * A cut of the observer's link (Wi-Fi, a resend, a tab in the background): what the
   * server sends from `at` for `ms` arrives at once when it ends.
   */
  cut?: { at: number; ms: number };
  /** How long the simulation runs, ms (12 s by default). */
  runMs?: number;
  speed?: number;
  frameMs?: number;
  /** A creature the walker's client does not see stands on this tile (y = 200). */
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
  serverY: number;
  /** Where the client had the player (its last prediction) when the key was let go. */
  ownXAtRelease: number;
  /** How long after the server's last step ended the observer drew the walker there. */
  observerLateMs: number;
  /** How long after the click (or the press) the own drawing first left its tile. */
  firstMoveMs: number;
  own: WorldState;
}

const CLICK_AT = 100;
/**
 * The step starts on the frame of the click (or the press): drawn there at its start, it
 * shows moved one frame later.
 */
const FIRST_FRAME_MS = 1000 / 60 + 1;

function simulate(run: Run): Result {
  const speed = run.speed ?? 200;
  const frameMs = run.frameMs ?? 1000 / 60;
  const rand = rng(run.seed ?? 7);
  const delay = () => run.rttMs / 2 + rand() * run.jitterMs;
  const own = client(WALKER, speed);
  const obs = client(OBSERVER, speed);
  const steer = new Steering({ diagonalCost: 1.5, maxPathTiles: 100 });

  // Links: in order, each message no earlier than the one before.
  type Up = { at: number; walk: { dir: Direction; walkEpoch: number; seq: number; nth: number } };
  type Down = { at: number; tick: number; msgs: Msg[] };
  const up: Up[] = [];
  const toOwn: Down[] = [];
  const toObs: Down[] = [];
  let upLast = 0;
  let ownLast = 0;
  let obsLast = 0;

  // The server's walker (session/move.go).
  let x = X0;
  let y = Y;
  let queue: { dir: Direction; seq: number }[] = [];
  let epoch = 1;
  let readyAt = 0;
  let lastStep = -1;
  let lastTicks = 0;
  let serverGaps = 0;
  let rejections = 0;
  let steps = 0;
  const reject = (out: Msg[], dir: Direction) => {
    queue = [];
    epoch++;
    rejections++;
    out.push({
      case: "walkRejected",
      value: { $typeName: "game.v1.WalkRejected", pos: pos(x, y), dir, walkEpoch: epoch },
    });
  };

  const ownTrail: { t: number; x: number; y: number }[] = [];
  const obsTrail: { t: number; x: number; y: number }[] = [];
  const mode = run.mode;
  const holdFrom = "hold" in mode ? 0 : "path" in mode ? (mode.holdFrom ?? Infinity) : Infinity;
  const holdUntil = "hold" in mode ? mode.hold : "path" in mode ? (mode.holdUntil ?? 0) : 0;
  const mouseUntil = "mouse" in mode ? mode.mouse : 0;
  const startAt = "path" in mode ? CLICK_AT : 0;
  let ownXAtRelease = X0;
  let sent = 0;
  let nextFrame = 0;
  let clicked = false;
  const send = (c: ReturnType<Steering["next"]>, t: number) => {
    if (c?.kind !== "walk") return;
    upLast = Math.max(upLast, t + delay());
    up.push({
      at: upLast,
      walk: { dir: c.dir, walkEpoch: own.walkEpoch, seq: c.seq, nth: ++sent },
    });
  };
  for (let t = 0; t <= (run.runMs ?? 12_000); t++) {
    if (t % TICK === 0) {
      const tick = t / TICK;
      const out: Msg[] = [];
      while (up[0] && up[0].at <= t) {
        const m = up.shift() as Up;
        if (run.lost?.includes(m.walk.nth)) continue; // dropped by the gateway
        if (m.walk.walkEpoch !== 0 && m.walk.walkEpoch !== epoch) continue;
        if (queue.length >= MAX_QUEUED) reject(out, Direction.UNSPECIFIED);
        else queue.push({ dir: m.walk.dir, seq: m.walk.seq });
      }
      if (queue.length > 0 && tick >= readyAt) {
        const { dir, seq } = queue[0] as { dir: Direction; seq: number };
        const [dx, dy] = delta(dir);
        if (run.blockedX === x + dx && Y === y + dy) reject(out, dir);
        else {
          queue.shift();
          const diagonal = dx !== 0 && dy !== 0;
          const ticks = Math.max(Math.ceil((1000 * 100 * (diagonal ? 1.5 : 1)) / speed / TICK), 1);
          if (lastStep >= 0) serverGaps += tick - (lastStep + lastTicks);
          lastStep = tick;
          lastTicks = ticks;
          readyAt = tick + ticks;
          steps++;
          const mv = (walkSeq: number): Msg => ({
            case: "creatureMove",
            value: {
              $typeName: "game.v1.CreatureMove",
              id: WALKER,
              from: pos(x, y),
              to: pos(x + dx, y + dy),
              durationMs: ticks * TICK,
              walkSeq,
            },
          });
          out.push(mv(seq)); // only the walker's own copy carries the seq
          let arrives = t + delay();
          if (run.cut && arrives >= run.cut.at && arrives < run.cut.at + run.cut.ms)
            arrives = run.cut.at + run.cut.ms;
          obsLast = Math.max(obsLast, arrives);
          toObs.push({ at: obsLast, tick, msgs: [mv(0)] });
          x += dx;
          y += dy;
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
        for (const m of b.msgs) {
          w.apply(m, t, at);
          if (w === own) steer.heard(m);
        }
      }
    }
    if (t >= nextFrame) {
      nextFrame += frameMs;
      // game.ts: a click plans the route and takes its first step at once.
      if ("path" in mode && !clicked && t >= CLICK_AT) {
        clicked = true;
        steer.walkTo(own, { x: X0 + mode.path, y: Y, z: 7 }, t);
        send(steer.next(own, t, {}), t);
      }
      // game.ts frame(): give up unanswered steps, decide the next step just before the
      // drawn one ends: a key first, then the cursor held, then the route.
      own.expirePredicted(t);
      const self = own.self as CreatureState;
      const drawn = own.drawPos(self, t);
      const key = t >= holdFrom && t < holdUntil ? Direction.EAST : undefined;
      const toward = t < mouseUntil ? { x: drawn.x + 0.5 + 3, y: drawn.y + 0.5 + 0.2 } : undefined;
      send(steer.next(own, t, { key, toward }), t);
      if (t < Math.max(holdUntil, mouseUntil)) ownXAtRelease = self.pos.x;
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
      Math.abs((ownTrail[i]?.y ?? 0) - (ownTrail[i - 1]?.y ?? 0)),
    );
  return {
    ownStalls: stalls(walking(ownTrail), 1, 0),
    observerStalls: stalls(walking(obsTrail), 1, 0),
    serverGaps,
    biggestJump,
    rejections,
    steps,
    serverX: x,
    serverY: y,
    ownXAtRelease,
    observerLateMs: (obsTrail.find((s) => s.x >= x)?.t ?? Infinity) - (lastStep + lastTicks) * TICK,
    firstMoveMs: (ownTrail.find((s) => s.x !== X0 || s.y !== Y)?.t ?? Infinity) - startAt,
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

  it.each(links)(
    "the mouse held on the map walks on every frame too (rtt $rttMs ms ± $jitterMs)",
    (link) => {
      const r = simulate({ ...link, mode: { mouse: 3000 } });
      expect(r.ownStalls).toBe(0);
      expect(r.observerStalls).toBe(0);
      expect(r.serverGaps).toBe(0);
      expect(r.rejections).toBe(0);
      expect(r.steps).toBeGreaterThanOrEqual(6);
      expect(r.steps).toBeLessThanOrEqual(7);
      expect(r.serverY).toBe(Y); // straight east: the cursor is 0.2 tiles low, within east's 45°
      expect(r.own.self?.pos.x).toBe(r.serverX);
      expect(r.ownXAtRelease).toBe(r.serverX); // let go: the steps sent are taken, no more
      expect(r.own.unconfirmed).toBe(0);
      expect(r.firstMoveMs).toBeLessThanOrEqual(FIRST_FRAME_MS);
      expect(r.biggestJump).toBeLessThan(0.05);
    },
  );

  it("a fast walker (150 ms a step) on a slow link keeps going too", () => {
    const r = simulate({ rttMs: 250, jitterMs: 50, speed: 667, mode: { hold: 2000 } });
    expect(r.ownStalls).toBe(0);
    expect(r.observerStalls).toBe(0);
    expect(r.own.self?.pos.x).toBe(r.serverX);
  });

  it("holds up at 144 Hz and at a ragged 40 fps", () => {
    for (const frameMs of [1000 / 144, 25]) {
      for (const mode of [{ hold: 2500 }, { mouse: 2500 }, { path: 6 }]) {
        const r = simulate({ rttMs: 80, jitterMs: 30, frameMs, mode });
        expect(r.ownStalls).toBe(0);
        expect(r.observerStalls).toBe(0);
      }
    }
  });

  it.each(links)(
    "a click-to-walk path is predicted: it leaves at once and never stops (rtt $rttMs ms ± $jitterMs)",
    (link) => {
      const r = simulate({ ...link, mode: { path: 8 } });
      expect(r.steps).toBe(8);
      expect(r.ownStalls).toBe(0);
      expect(r.observerStalls).toBe(0);
      expect(r.serverGaps).toBe(0);
      expect(r.rejections).toBe(0);
      expect(r.own.self?.pos.x).toBe(X0 + 8);
      expect(r.own.unconfirmed).toBe(0);
      // The first step is drawn from the click's frame on, not a round trip later.
      expect(r.firstMoveMs).toBeLessThanOrEqual(FIRST_FRAME_MS);
      expect(r.biggestJump).toBeLessThan(0.05);
    },
  );

  it.each(links)(
    "a click and then an arrow: each Walk is answered by its own step (rtt $rttMs ms ± $jitterMs)",
    (link) => {
      // The arrow ends the route at the next step's edge (docs/14: before, while the
      // server walked a WalkPath, an arrow almost never got in).
      for (const holdFrom of [1300, 1530, 1560, 1600, 1810]) {
        const r = simulate({ ...link, mode: { path: 8, holdFrom, holdUntil: holdFrom + 2000 } });
        expect(r.rejections).toBe(0);
        expect(r.ownXAtRelease).toBe(r.serverX);
        expect(r.own.self?.pos.x).toBe(r.serverX);
        expect(r.own.unconfirmed).toBe(0);
        expect(r.ownStalls).toBe(0);
      }
    },
  );

  it("a lost Walk: the next one answers it, and nothing is left waiting", () => {
    for (const lost of [[1], [3], [3, 4]]) {
      const r = simulate({ rttMs: 80, jitterMs: 20, mode: { hold: 3000 }, lost });
      expect(r.rejections).toBe(0);
      expect(r.own.unconfirmed).toBe(0);
      expect(r.own.self?.pos.x).toBe(r.serverX);
      expect(r.ownXAtRelease).toBe(r.serverX);
    }
  });

  it("a cut of the link costs a stop, not a lag that lasts", () => {
    // 1 s without anything from the server, 2 s into a 12 s walk: 9 s later the
    // observer draws the walker as close behind as ever (before, still ~1 s late).
    const link = { rttMs: 60, jitterMs: 20 };
    const steady = simulate({ ...link, mode: { hold: 12_000 }, runMs: 14_000 });
    const cut = simulate({
      ...link,
      mode: { hold: 12_000 },
      runMs: 14_000,
      cut: { at: 2000, ms: 1000 },
    });
    expect(cut.serverX).toBe(steady.serverX);
    expect(steady.observerLateMs).toBeLessThan(link.rttMs / 2 + link.jitterMs + 60);
    expect(cut.observerLateMs).toBeLessThan(steady.observerLateMs + 30);
  });

  it("a step refused ahead (a creature the client did not see) glides back, once", () => {
    const r = simulate({ rttMs: 120, jitterMs: 30, blockedX: X0 + 4, mode: { hold: 4000 } });
    expect(r.serverX).toBe(X0 + 3);
    expect(r.rejections).toBe(1); // the refused step is not asked again while held
    expect(r.own.self?.pos.x).toBe(X0 + 3);
    expect(r.own.unconfirmed).toBe(0);
    // Back without a pop: never more than a few frames' way in one frame.
    expect(r.biggestJump).toBeLessThan(0.15);
  });

  it.each(links)(
    "a click's route round a creature the client did not see: refused once, then round it (rtt $rttMs ms ± $jitterMs)",
    (link) => {
      const r = simulate({ ...link, blockedX: X0 + 4, mode: { path: 8 } });
      expect(r.rejections).toBe(1);
      expect([r.serverX, r.serverY]).toEqual([X0 + 8, Y]);
      expect(r.own.self?.pos).toEqual({ x: X0 + 8, y: Y, z: 7 });
      expect(r.own.unconfirmed).toBe(0);
      // Back from up to a tile ahead, gliding: a fifth of it in the first frame of the
      // 160 ms ease-out, never a pop.
      expect(r.biggestJump).toBeLessThan(0.25);
    },
  );
});

describe("own steps predicted ahead", () => {
  const confirm = (
    w: WorldState,
    from: number,
    to: number,
    durationMs: number,
    now: number,
    walkSeq: number,
  ) =>
    w.apply(
      {
        case: "creatureMove",
        value: {
          $typeName: "game.v1.CreatureMove",
          id: WALKER,
          from: pos(from),
          to: pos(to),
          durationMs,
          walkSeq,
        },
      },
      now,
    );

  it("stands still only with no step drawn and none predicted (MOV-2)", () => {
    const w = client(WALKER, 200);
    expect(w.standingStill(0)).toBe(true);
    w.chooseStep(Direction.EAST, 0);
    expect(w.standingStill(100)).toBe(false); // walking, predicted
    expect(w.standingStill(5000)).toBe(false); // drawn, but the server has not answered
    confirm(w, X0, X0 + 1, 500, 300, 1);
    expect(w.standingStill(400)).toBe(false); // confirmed, still drawn
    expect(w.standingStill(600)).toBe(true);
  });

  it("decides the next step just before the drawn one ends and draws it right after", () => {
    const w = client(WALKER, 200);
    const s = w.self as CreatureState;
    expect(w.chooseStep(Direction.EAST, 0)).toEqual({ kind: "walk", dir: Direction.EAST, seq: 1 });
    expect(w.canStep(500 - STEP_LEAD_MS - 1)).toBe(false);
    expect(w.chooseStep(Direction.SOUTH_EAST, 400)).toBeUndefined(); // too soon: nothing
    expect(w.canStep(460)).toBe(true);
    // A diagonal: 750 ms, starting when the first step ends, not now.
    expect(w.chooseStep(Direction.NORTH_EAST, 460)).toEqual({
      kind: "walk",
      dir: Direction.NORTH_EAST,
      seq: 2,
    });
    expect(s.walk).toMatchObject({ start: 500, duration: 750 });
    expect(w.unconfirmed).toBe(2);
    expect(w.drawPos(s, 480).x).toBeCloseTo(X0 + 0.96); // still the first step
    expect(w.facing(s, 480)).toBe(Direction.EAST);
    expect(w.drawPos(s, 500)).toEqual({ x: X0 + 1, y: Y });
    expect(w.drawPos(s, 875)).toEqual({ x: X0 + 1.5, y: Y - 0.5 });
    expect(w.facing(s, 875)).toBe(Direction.NORTH_EAST);
    // The first one confirmed: the facing stays the newest step's.
    confirm(w, X0, X0 + 1, 500, 520, 1);
    expect(w.unconfirmed).toBe(1);
    expect(s.dir).toBe(Direction.NORTH_EAST);
  });

  it("shifts the steps predicted after one the server took longer", () => {
    const w = client(WALKER, 200);
    const s = w.self as CreatureState;
    w.chooseStep(Direction.EAST, 0);
    w.chooseStep(Direction.EAST, 460);
    // The server slowed the player (paralyze) before the first step: 700 ms, not 500.
    confirm(w, X0, X0 + 1, 700, 480, 1);
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
    expect(w.unconfirmed).toBe(MAX_QUEUED);
    expect(w.canStep(now + 1000)).toBe(false); // waits for the server
    confirm(w, X0, X0 + 1, 500, now + 1000, 1);
    expect(w.canStep(now + 1000)).toBe(true);
  });

  it("does not predict past stairs: the server moves the player elsewhere there", () => {
    const w = new WorldState({ ...content, portals: { [`${X0 + 1},${Y},7`]: "stairs" } });
    w.apply(
      {
        case: "welcome",
        value: {
          $typeName: "game.v1.Welcome",
          creatureId: WALKER,
          serverTime: 0n,
          tickMs: TICK,
          maxQueuedSteps: MAX_QUEUED,
          viewWidth: 31,
          viewHeight: 21,
          attackEvents: false,
        },
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
    expect(w.chooseStep(Direction.EAST, 0)).toEqual({ kind: "walk", dir: Direction.EAST, seq: 1 });
    expect(w.canStep(460)).toBe(false);
    expect(w.canStep(5000)).toBe(false); // until the server answers
  });
});
