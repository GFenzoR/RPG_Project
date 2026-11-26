// Fluid movement (client/CLAUDE.md "Movimiento fluido"): the pure pieces that make walking
// look continuous while the server stays the judge of every step. No PixiJS, no DOM, no
// clock: callers pass `now` (ms, performance.now()).
import { Direction } from "@rpg/protocol";
import { delta } from "./geometry.ts";

/**
 * How long before the drawn step ends the next one is decided and its Walk sent. The
 * server queues it (docs/05 "Caminar") and starts it the tick the current one ends, and
 * the client draws it right after the current one: no frame stands still between tiles.
 * One tick: a key let go in the last 50 ms of a step still walks the next one.
 */
export const STEP_LEAD_MS = 50;

/** How long a correction (a refused step, a step the server took otherwise) glides. */
export const SLIDE_MS = 160;

/**
 * A correction longer than this (tiles) jumps: it is a teleport, not a slip. The own
 * creature's corrections allow more (ownSlideMaxTiles): its predictions run ahead.
 */
export const SLIDE_MAX_TILES = 3;

/**
 * The longest correction of the own creature that still glides with `maxQueued` steps
 * predicted (Welcome.max_queued_steps): drawn on the last of them, up to that many tiles
 * ahead of where a WalkRejected (or a prediction given up) puts it back, plus one of
 * margin (a slide not over yet, a step the server took otherwise). Never less than
 * SLIDE_MAX_TILES.
 */
export function ownSlideMaxTiles(maxQueued: number): number {
  return Math.max(SLIDE_MAX_TILES, maxQueued + 1);
}

/**
 * How long an own step may go unanswered after it was drawn before the client gives it up:
 * its Walk was lost on the way (the gateway drops what a client sends over its rate), and
 * nothing would answer it. A late answer still comes through (WorldState: a step of the
 * server that no prediction waits for).
 */
export const PREDICT_TIMEOUT_MS = 3000;

/**
 * The jitter buffer for the steps the server takes (Playout): its delay aims at the
 * latest arrival of the last PLAYOUT_WINDOW_MS (but no more than PLAYOUT_MAX_JITTER_MS
 * after the earliest one) plus this margin, so a batch somewhat later than the ones
 * before still starts its steps when the steps before end.
 */
export const PLAYOUT_MARGIN_MS = 40;

/** How long an arrival counts for the delay's aim: a late one is forgotten after this. */
export const PLAYOUT_WINDOW_MS = 2000;

/**
 * The most jitter the delay covers. An arrival later than this after the earliest of the
 * window (a stall of the link, a resend, a tab back from the background) does not move
 * the delay: its steps start when they arrive. And no batch waits more than this plus the
 * margin after it arrived, whatever came before.
 */
export const PLAYOUT_MAX_JITTER_MS = 200;

/**
 * How fast the delay falls to its aim once a late arrival is forgotten, ms per ms (100 ms
 * a second). Steps then start a bit before the one drawn ends: they follow it and catch up
 * (PLAYOUT_CATCH_UP), so the fall shows no jump.
 */
export const PLAYOUT_FALL = 0.1;

/**
 * A step of the server drawn behind its time (it follows one that is still drawn) is
 * drawn up to this much faster than its duration until the drawing is back on time.
 */
export const PLAYOUT_CATCH_UP = 0.25;

/**
 * A drawing further behind its time than this skips ahead (gliding, `slideBetween`)
 * instead of catching up: a burst of steps after a stall of the link.
 */
export const PLAYOUT_MAX_LAG_MS = 500;

const PLAYOUT_BUCKETS = 8;
const PLAYOUT_BUCKET_MS = PLAYOUT_WINDOW_MS / PLAYOUT_BUCKETS;

/**
 * Server ticks to local time for the steps of other creatures (and the own steps the
 * server takes, a click-to-walk path): a jitter buffer. A step starts at
 * `tick × tickMs + delay`; steps the server takes back to back are drawn back to back,
 * whatever jitter the network adds, at the cost of a delay a bit longer than that jitter.
 * `delay` (local time − tick time) aims at the latest arrivals of the last
 * PLAYOUT_WINDOW_MS, capped to PLAYOUT_MAX_JITTER_MS over the earliest, plus
 * PLAYOUT_MARGIN_MS. A later arrival raises it at once (within the cap); it falls back at
 * PLAYOUT_FALL when the window forgets that arrival. A batch later than the delay starts
 * its steps when it arrives (the only stop left), and none waits more than the cap and
 * the margin after it arrived: a stall of the link costs a stop, never a lasting lag.
 */
export class Playout {
  private delay: number | undefined;
  private at = 0;
  /** The arrivals of the window by bucket of PLAYOUT_BUCKET_MS: their latest and earliest. */
  private readonly ids: number[] = new Array<number>(PLAYOUT_BUCKETS).fill(-Infinity);
  private readonly his: number[] = new Array<number>(PLAYOUT_BUCKETS).fill(0);
  private readonly los: number[] = new Array<number>(PLAYOUT_BUCKETS).fill(0);

  constructor(private readonly tickMs = 50) {}

  /** Local time at which the events of `tick`, arriving at `now`, start (never before now). */
  time(tick: number, now: number): number {
    const sample = now - tick * this.tickMs;
    const b = Math.floor(now / PLAYOUT_BUCKET_MS);
    const i = ((b % PLAYOUT_BUCKETS) + PLAYOUT_BUCKETS) % PLAYOUT_BUCKETS;
    if (this.ids[i] !== b) {
      this.ids[i] = b;
      this.his[i] = sample;
      this.los[i] = sample;
    } else {
      this.his[i] = Math.max(this.his[i] ?? sample, sample);
      this.los[i] = Math.min(this.los[i] ?? sample, sample);
    }
    let hi = sample;
    let lo = sample;
    for (let k = 0; k < PLAYOUT_BUCKETS; k++) {
      if ((this.ids[k] ?? -Infinity) <= b - PLAYOUT_BUCKETS) continue;
      hi = Math.max(hi, this.his[k] ?? hi);
      lo = Math.min(lo, this.los[k] ?? lo);
    }
    const aim = Math.min(hi, lo + PLAYOUT_MAX_JITTER_MS) + PLAYOUT_MARGIN_MS;
    const dt = Math.max(0, now - this.at);
    this.at = now;
    if (this.delay === undefined || aim >= this.delay) this.delay = aim;
    else this.delay = Math.max(aim, this.delay - dt * PLAYOUT_FALL);
    this.delay = Math.min(this.delay, sample + PLAYOUT_MAX_JITTER_MS + PLAYOUT_MARGIN_MS);
    return Math.max(tick * this.tickMs + this.delay, now);
  }
}

/** A correction of where a creature is drawn, gliding away from `start`. */
export interface Slide {
  /** Offset in tiles at `start` (drawn − real). */
  x: number;
  y: number;
  start: number;
}

/**
 * A slide that takes the drawing from `before` to `after` smoothly, or undefined when
 * there is nothing to smooth (the same place) or the jump is a teleport (longer than
 * `maxTiles`).
 */
export function slideBetween(
  before: { x: number; y: number },
  after: { x: number; y: number },
  now: number,
  maxTiles = SLIDE_MAX_TILES,
): Slide | undefined {
  const x = before.x - after.x;
  const y = before.y - after.y;
  const d = Math.max(Math.abs(x), Math.abs(y));
  if (d < 1e-3 || d > maxTiles) return undefined;
  return { x, y, start: now };
}

/** What is left of a slide at `now` (ease-out), or undefined once it is over. */
export function slideLeft(s: Slide | undefined, now: number): { x: number; y: number } | undefined {
  if (!s) return undefined;
  const t = (now - s.start) / SLIDE_MS;
  if (t >= 1) return undefined;
  const k = (1 - Math.max(0, t)) ** 2;
  return { x: s.x * k, y: s.y * k };
}

/**
 * How far a slide still is from its end at `now`, in tiles (the longer axis); 0 without
 * one. A number, nothing made: the canvas asks for every creature every frame.
 */
export function slideSize(s: Slide | undefined, now: number): number {
  if (!s) return 0;
  const t = (now - s.start) / SLIDE_MS;
  if (t >= 1) return 0;
  return Math.max(Math.abs(s.x), Math.abs(s.y)) * (1 - Math.max(0, t)) ** 2;
}

function choicesOf(d: Direction): readonly Direction[] {
  const [dx, dy] = delta(d);
  if (dx === 0 || dy === 0) return Object.freeze([d]);
  const h = dx > 0 ? Direction.EAST : Direction.WEST;
  const v = dy > 0 ? Direction.SOUTH : Direction.NORTH;
  return Object.freeze([d, h, v]);
}

/** stepChoices of every direction, made once. */
const STEP_CHOICES: ReadonlyMap<Direction, readonly Direction[]> = new Map(
  [
    Direction.UNSPECIFIED,
    Direction.NORTH,
    Direction.NORTH_EAST,
    Direction.EAST,
    Direction.SOUTH_EAST,
    Direction.SOUTH,
    Direction.SOUTH_WEST,
    Direction.WEST,
    Direction.NORTH_WEST,
  ].map((d) => [d, choicesOf(d)]),
);

/**
 * The steps to try for a wanted direction, in order: the direction, and for a diagonal its
 * horizontal then its vertical half. Walking north-east along a wall to the north slides
 * east instead of stopping. The same frozen list every call: a key or the mouse held
 * against a wall asks every frame (docs/07: nothing made per frame).
 */
export function stepChoices(d: Direction): readonly Direction[] {
  return STEP_CHOICES.get(d) ?? choicesOf(d);
}

/** tan(22.5°): the edge between a straight sector and a diagonal one of the eight directions. */
const OCTANT_EDGE = Math.SQRT2 - 1;

/**
 * The direction (of 8) toward a point `(dx, dy)` tiles away from the centre of the own tile,
 * by its angle: each direction takes the 45° around it (docs/17 MOV-3, the mouse held on the
 * map). UNSPECIFIED while the point is on the own tile (less than half a tile on both axes).
 */
export function towardDirection(dx: number, dy: number): Direction {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < 0.5 && ay < 0.5) return Direction.UNSPECIFIED;
  const h = dx > 0 ? Direction.EAST : Direction.WEST;
  const v = dy > 0 ? Direction.SOUTH : Direction.NORTH;
  if (ay <= ax * OCTANT_EDGE) return h;
  if (ax <= ay * OCTANT_EDGE) return v;
  return combine(h, v) ?? h;
}

/** The diagonal between two perpendicular directions (north + east = north-east), if any. */
export function combine(a: Direction, b: Direction): Direction | undefined {
  const [ax, ay] = delta(a);
  const [bx, by] = delta(b);
  if (ax * bx !== 0 || ay * by !== 0) return undefined; // same axis
  const x = ax + bx;
  const y = ay + by;
  if (x === 0 || y === 0 || Math.abs(x) > 1 || Math.abs(y) > 1) return undefined;
  for (const d of DIAGONALS) {
    const [dx, dy] = delta(d);
    if (dx === x && dy === y) return d;
  }
  return undefined;
}

const DIAGONALS = [
  Direction.NORTH_EAST,
  Direction.SOUTH_EAST,
  Direction.SOUTH_WEST,
  Direction.NORTH_WEST,
] as const;

/**
 * The last frames' drawn own position, in a fixed ring (no allocation per frame, docs/07):
 * the E2E reads it to check that a held key moves on every frame.
 */
export class MotionTrail {
  private readonly buf: Float64Array;
  private next = 0;
  private size = 0;

  constructor(private readonly capacity = 1024) {
    this.buf = new Float64Array(capacity * 3);
  }

  record(t: number, x: number, y: number): void {
    const i = this.next * 3;
    this.buf[i] = t;
    this.buf[i + 1] = x;
    this.buf[i + 2] = y;
    this.next = (this.next + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  /** The samples from `t0` on, oldest first. */
  since(t0: number): { t: number; x: number; y: number }[] {
    const out: { t: number; x: number; y: number }[] = [];
    for (let k = this.size; k > 0; k--) {
      const i = ((this.next - k + this.capacity) % this.capacity) * 3;
      const t = this.buf[i] ?? 0;
      if (t >= t0) out.push({ t, x: this.buf[i + 1] ?? 0, y: this.buf[i + 2] ?? 0 });
    }
    return out;
  }
}

/**
 * Frames in `samples` (oldest first) where the drawing stood still or went back along
 * (dx, dy) while it should be walking: what the E2E and the timing tests count as a stall.
 */
export function stalls(
  samples: readonly { t: number; x: number; y: number }[],
  dx: number,
  dy: number,
): number {
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b || b.t - a.t < 1) continue; // two callbacks in the same millisecond
    if ((b.x - a.x) * dx + (b.y - a.y) * dy <= 1e-9) n++;
  }
  return n;
}
