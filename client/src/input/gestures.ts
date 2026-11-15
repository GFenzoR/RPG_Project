// Touch gestures (T5.6): a pure recognizer fed with plain pointer samples (id, position,
// time), so the rules are testable without a DOM. The canvas and the DOM item slots feed it
// from pointer events of pointerType "touch" or "pen"; the mouse keeps its own handlers.
//
// Gestures: a tap (press and release without travelling), a long press (held still for
// `longPressMs`: replaces the right click), a drag (travelled past `slopPx`: moves an item)
// and a pinch (two fingers; reported, the canvas may ignore it). The caller arms a timer for
// `deadline()` and calls `tick` then, so a long press fires while the finger is still down.

export interface GestureConfig {
  /** Travel (in the caller's pixels) that turns a press into a drag. */
  slopPx: number;
  /** Time held still that turns a press into a long press, ms. */
  longPressMs: number;
}

/** Fingers wobble more than a mouse: a larger slop than the mouse drag threshold. */
export const DEFAULT_GESTURES: GestureConfig = { slopPx: 10, longPressMs: 500 };

export type Gesture =
  | { kind: "tap"; x: number; y: number }
  | { kind: "longPress"; x: number; y: number }
  /** (startX, startY) is where the finger went down; (x, y) where it is now. */
  | { kind: "dragStart"; x: number; y: number; startX: number; startY: number }
  | { kind: "dragMove"; x: number; y: number }
  | { kind: "dragEnd"; x: number; y: number }
  | { kind: "pinchStart" }
  /** Current finger distance over the distance when the pinch started. */
  | { kind: "pinch"; scale: number }
  | { kind: "pinchEnd" }
  /** The press was abandoned (pointercancel, or a second finger turned it into a pinch). */
  | { kind: "cancel" };

interface Point {
  x: number;
  y: number;
}

type State =
  | { kind: "idle" }
  | { kind: "pressed"; id: number; start: Point; at: number }
  /** The long press fired: the rest of this press is ignored. */
  | { kind: "held"; id: number }
  | { kind: "dragging"; id: number }
  | { kind: "pinching"; a: number; b: number; d0: number }
  /** A gesture ended but fingers are still down: wait until they all lift. */
  | { kind: "draining" };

export class GestureRecognizer {
  private readonly cfg: GestureConfig;
  private state: State = { kind: "idle" };
  /** Every pointer down right now and where it is. */
  private readonly points = new Map<number, Point>();

  constructor(cfg: GestureConfig = DEFAULT_GESTURES) {
    this.cfg = cfg;
  }

  /** True while some pointer of a gesture is down. */
  get active(): boolean {
    return this.points.size > 0;
  }

  /** When `tick` must be called to fire a pending long press, or undefined. */
  deadline(): number | undefined {
    return this.state.kind === "pressed" ? this.state.at + this.cfg.longPressMs : undefined;
  }

  down(id: number, x: number, y: number, t: number): Gesture[] {
    this.points.set(id, { x, y });
    const s = this.state;
    if (s.kind === "idle") {
      this.state = { kind: "pressed", id, start: { x, y }, at: t };
      return [];
    }
    if (s.kind === "pressed") {
      // A second finger: the tap or long press becomes a pinch.
      const a = this.points.get(s.id);
      this.state = { kind: "pinching", a: s.id, b: id, d0: a ? dist(a, { x, y }) : 0 };
      return [{ kind: "cancel" }, { kind: "pinchStart" }];
    }
    return []; // extra fingers during a drag, a pinch or a held press are ignored
  }

  move(id: number, x: number, y: number, t: number): Gesture[] {
    if (!this.points.has(id)) return [];
    this.points.set(id, { x, y });
    const s = this.state;
    if (s.kind === "pressed" && s.id === id) {
      if (dist(s.start, { x, y }) < this.cfg.slopPx) return this.tick(t);
      this.state = { kind: "dragging", id };
      return [{ kind: "dragStart", x, y, startX: s.start.x, startY: s.start.y }];
    }
    if (s.kind === "dragging" && s.id === id) return [{ kind: "dragMove", x, y }];
    if (s.kind === "pinching" && (s.a === id || s.b === id)) {
      const a = this.points.get(s.a);
      const b = this.points.get(s.b);
      if (!a || !b || s.d0 <= 0) return [];
      return [{ kind: "pinch", scale: dist(a, b) / s.d0 }];
    }
    return [];
  }

  up(id: number, x: number, y: number, t: number): Gesture[] {
    if (!this.points.has(id)) return [];
    this.points.delete(id);
    const s = this.state;
    let out: Gesture[] = [];
    if (s.kind === "pressed" && s.id === id) {
      // A late timer must not turn a long press into a tap.
      const long = t - s.at >= this.cfg.longPressMs && dist(s.start, { x, y }) < this.cfg.slopPx;
      out = [long ? { kind: "longPress", x: s.start.x, y: s.start.y } : { kind: "tap", x, y }];
      this.state = { kind: "draining" };
    } else if (s.kind === "dragging" && s.id === id) {
      out = [{ kind: "dragEnd", x, y }];
      this.state = { kind: "draining" };
    } else if (s.kind === "held" && s.id === id) {
      this.state = { kind: "draining" };
    } else if (s.kind === "pinching" && (s.a === id || s.b === id)) {
      out = [{ kind: "pinchEnd" }];
      this.state = { kind: "draining" };
    }
    if (this.points.size === 0) this.state = { kind: "idle" };
    return out;
  }

  /** pointercancel (the browser took the touch, e.g. to scroll). */
  cancel(id: number): Gesture[] {
    if (!this.points.has(id)) return [];
    this.points.delete(id);
    const s = this.state;
    let out: Gesture[] = [];
    if ((s.kind === "pressed" || s.kind === "dragging" || s.kind === "held") && s.id === id) {
      out = [{ kind: "cancel" }];
      this.state = { kind: "draining" };
    } else if (s.kind === "pinching" && (s.a === id || s.b === id)) {
      out = [{ kind: "pinchEnd" }];
      this.state = { kind: "draining" };
    }
    if (this.points.size === 0) this.state = { kind: "idle" };
    return out;
  }

  /** Fires the long press once its time has come (call it at `deadline()`). */
  tick(t: number): Gesture[] {
    const s = this.state;
    if (s.kind !== "pressed" || t - s.at < this.cfg.longPressMs) return [];
    this.state = { kind: "held", id: s.id };
    return [{ kind: "longPress", x: s.start.x, y: s.start.y }];
  }

  /** Forgets every pointer (the element went away). */
  reset(): void {
    this.points.clear();
    this.state = { kind: "idle" };
  }
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** True for the pointers the touch controls handle; the mouse keeps its own handlers. */
export const isTouchPointer = (pointerType: string): boolean =>
  pointerType === "touch" || pointerType === "pen";
