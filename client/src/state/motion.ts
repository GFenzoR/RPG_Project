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

/** A correction longer than this (tiles) jumps: it is a teleport, not a slip. */
export const SLIDE_MAX_TILES = 3;

/**
 * The jitter buffer for the steps the server takes (Playout): its delay aims at the
 * latest arrivals (their envelope, which forgets a late one at 5 ms a second) plus this
 * margin, so a batch somewhat later than the ones before still starts its steps when
 * the steps before end.
 */
export const PLAYOUT_MARGIN_MS = 40;

/** How fast the envelope of the arrivals forgets a late one, ms per ms. */
export const PLAYOUT_FORGET = 0.005;

/**
 * How fast the delay moves toward its aim, ms per ms: up 5 ms a second, down 10. Moving
 * it shifts the next step by as much: a few ms per step, under a frame, so no frame
 * stands still for it.
 */
export const PLAYOUT_RISE = 0.005;
export const PLAYOUT_FALL = 0.01;

/**
 * Server ticks to local time for the steps of other creatures (and the own steps the
 * server takes, a click-to-walk path): a jitter buffer. A step starts at
 * `tick × tickMs + delay`; steps the server takes back to back are drawn back to back,
 * whatever jitter the network adds, at the cost of a delay a bit longer than that jitter
 * (`delay` = local time − tick time of the latest arrivals, plus PLAYOUT_MARGIN_MS). A batch
 * later than the delay moves it up at once (that step starts late: the only stop left).
 */
export class Playout {
  private delay: number | undefined;
  private envelope = 0;
  private at = 0;

  constructor(private readonly tickMs = 50) {}

  /** Local time at which the events of `tick`, arriving at `now`, start (never before now). */
  time(tick: number, now: number): number {
    const sample = now - tick * this.tickMs;
    const dt = Math.max(0, now - this.at);
    this.at = now;
    if (this.delay === undefined) {
      this.envelope = sample;
      this.delay = sample + PLAYOUT_MARGIN_MS;
    } else {
      this.envelope = Math.max(sample, this.envelope - dt * PLAYOUT_FORGET);
      const aim = this.envelope + PLAYOUT_MARGIN_MS;
      this.delay =
        this.delay < aim
          ? Math.min(aim, this.delay + dt * PLAYOUT_RISE)
          : Math.max(aim, this.delay - dt * PLAYOUT_FALL);
      this.delay = Math.max(this.delay, sample);
    }
    return tick * this.tickMs + this.delay;
  }

  /** Forgets the delay (a new connection: a new server clock). */
  reset(): void {
    this.delay = undefined;
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
 * there is nothing to smooth (the same place) or the jump is a teleport.
 */
export function slideBetween(
  before: { x: number; y: number },
  after: { x: number; y: number },
  now: number,
): Slide | undefined {
  const x = before.x - after.x;
  const y = before.y - after.y;
  const d = Math.max(Math.abs(x), Math.abs(y));
  if (d < 1e-3 || d > SLIDE_MAX_TILES) return undefined;
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
 * The steps to try for a wanted direction, in order: the direction, and for a diagonal its
 * horizontal then its vertical half. Walking north-east along a wall to the north slides
 * east instead of stopping.
 */
export function stepChoices(d: Direction): Direction[] {
  const [dx, dy] = delta(d);
  if (dx === 0 || dy === 0) return [d];
  const h = dx > 0 ? Direction.EAST : Direction.WEST;
  const v = dy > 0 ? Direction.SOUTH : Direction.NORTH;
  return [d, h, v];
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
