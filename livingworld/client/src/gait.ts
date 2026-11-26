// Footfalls (livingworld/README.md "Huellas"): the moment and the place each foot of a
// creature touches the ground, read from the walk cycle the client draws, so a footprint,
// a ripple, a puff of dust and the step's sound are one beat with the animation.
//
// A gait (data/livingworld/gaits.yaml) lists the contacts of one walk cycle: when in the
// cycle (0 to 1) each foot lands, on which side of the path, and how far along the body.
// The client tells the tracker, every frame, where the cycle of each creature in view is
// (packages/renderer anim.ts `Pose.walk`) and where its feet are drawn; when the cycle
// passes a contact, the tracker reports a footfall at that foot's place. Nothing is
// reported while the cycle stands still (standing, turning in place) or while the creature
// is not walking on its legs (a slide of a correction moves the drawing, not the cycle).
// Pure, deterministic and allocation-free per frame: one state per creature, one Footfall
// reused for every report (docs/07).

/** Which mark a foot leaves: livingworld/fx/footprint_<kind>. */
export const PRINT_KINDS = ["feet", "paw", "big_paw", "dot", "trail"] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

/** One foot touching the ground in a gait's cycle. */
export interface GaitContact {
  /** When in the cycle it lands, 0 (inclusive) to 1. */
  at: number;
  /** Which side of the path's centre line: -1 left, 1 right, 0 on it. */
  side: number;
  /** Sprite pixels along the body from its middle: front feet +, hind feet -. */
  along: number;
}

/** How a kind of body walks (data/livingworld/gaits.yaml `gaits`). */
export interface Gait {
  name: string;
  print: PrintKind;
  /** Sprite pixels from the path's centre line to each foot (the stance's half width). */
  stance: number;
  /**
   * How far ahead of the body's middle a foot lands, as a share of the distance one cycle
   * travels (a biped's foot lands half a stride ahead: 0.25).
   */
  reach: number;
  /**
   * Sprite pixels from the lowest pixel of its walk frames up to the ground point under
   * the middle of its body (the near feet and their outline are drawn below that point).
   */
  rise: number;
  /** Size of its prints (1: the sprite as drawn). */
  scale: number;
  /** How deep its prints are: their opacity while fresh, 0 to 1. */
  depth: number;
  /**
   * Sprite pixels on screen a print is drawn out to its foot's side of the path, over where
   * the foot really stands: the 3/4 view squeezes the feet of a body walking east or west
   * into one line, and both feet's marks must read as two rows.
   */
  spread: number;
  contacts: readonly GaitContact[];
}

/** data/livingworld/gaits.yaml as the client uses it. */
export interface GaitData {
  /**
   * The 3/4 view's foreshortening of the map's north-south axis (0.58 for the engine's
   * sprites, tools/spritegen style.ts PROJECTION.depth): what is across a body walking
   * east is drawn this much shorter down the screen.
   */
  viewDepth: number;
  /** A drawing gliding over a correction further than this (sprite px) leaves no print. */
  slidePx: number;
  gaits: Readonly<Record<string, Gait>>;
  /** The gait of each kind of body. */
  defaults: Readonly<Record<BodyKind, string>>;
  /** The gait of a creature by its content id (data/monsters, data/npcs), over the default. */
  creatures: Readonly<Record<string, string>>;
}

export const BODY_KINDS = ["humanoid", "beast", "big_beast", "flying"] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const SIDES: Readonly<Record<string, number>> = { left: -1, right: 1, centre: 0 };

/**
 * The client's view of data/livingworld/gaits.yaml (already parsed YAML). Lenient, like
 * parseLivingWorldData: make validate checks the file against its schema, so anything
 * malformed here is skipped rather than thrown. Undefined without the file.
 */
export function parseGaits(raw: unknown): GaitData | undefined {
  if (!isObj(raw) || !isObj(raw["gaits"])) return undefined;
  const gaits: Record<string, Gait> = {};
  for (const [name, g] of Object.entries(raw["gaits"])) {
    if (!isObj(g)) continue;
    const print = (PRINT_KINDS as readonly unknown[]).includes(g["print"])
      ? (g["print"] as PrintKind)
      : "feet";
    const contacts: GaitContact[] = [];
    for (const c of Array.isArray(g["contacts"]) ? g["contacts"] : []) {
      if (!isObj(c)) continue;
      const at = num(c["at"], 0);
      if (at < 0 || at > 1) continue;
      contacts.push({
        // 1 is the cycle's end, which is its start.
        at: at >= 1 ? 0 : at,
        side: SIDES[typeof c["side"] === "string" ? c["side"] : "centre"] ?? 0,
        along: num(c["along"], 0),
      });
    }
    gaits[name] = {
      name,
      print,
      stance: Math.max(0, num(g["stance"], 0)),
      reach: num(g["reach"], 0),
      rise: num(g["rise"], 0),
      scale: Math.max(0.25, num(g["scale"], 1)),
      depth: Math.min(1, Math.max(0, num(g["depth"], 1))),
      spread: Math.max(0, num(g["print_spread"], 0)),
      contacts,
    };
  }
  const d = isObj(raw["defaults"]) ? raw["defaults"] : {};
  const pick = (k: BodyKind, fallback: string): string => {
    const v = d[k];
    return typeof v === "string" && gaits[v] ? v : fallback;
  };
  const creatures: Record<string, string> = {};
  if (isObj(raw["creatures"]))
    for (const [id, g] of Object.entries(raw["creatures"]))
      if (typeof g === "string" && gaits[g]) creatures[id] = g;
  const view = isObj(raw["view"]) ? raw["view"] : {};
  return {
    viewDepth: Math.min(1, Math.max(0.1, num(view["depth"], 1))),
    slidePx: Math.max(0, num(raw["slide_px"], 2)),
    gaits,
    defaults: {
      humanoid: pick("humanoid", ""),
      beast: pick("beast", ""),
      big_beast: pick("big_beast", pick("beast", "")),
      flying: pick("flying", ""),
    },
    creatures,
  };
}

/**
 * The gait of a creature: its own (`creatures`, by content id), else its body kind's.
 * Undefined when it leaves no footfalls (no data, an unknown gait, one without contacts:
 * a flier).
 */
export function gaitOf(
  data: GaitData | undefined,
  contentId: string | undefined,
  body: BodyKind,
): Gait | undefined {
  if (!data) return undefined;
  const name = (contentId ? data.creatures[contentId] : undefined) ?? data.defaults[body];
  const g = data.gaits[name];
  return g && g.contacts.length > 0 ? g : undefined;
}

/** What the client says about a creature in view each frame (one object, reused). */
export interface WalkSample {
  id: number;
  /**
   * Where its feet are drawn: the middle of its body across, the lowest row of its walk
   * frames down (Gait.rise lifts it to the ground point under the body); sprite pixels in
   * world space.
   */
  x: number;
  y: number;
  /** Its floor. */
  z: number;
  /** The walk cycle drawn, 0 to 1; -1 while it does not walk (anim.ts Pose.walk). */
  phase: number;
  /** Frames of the walk clip (contacts land on a frame's first drawing); 0 without one. */
  frames: number;
  /** The way it moves on the map: -1, 0 or 1 each. */
  dx: number;
  dy: number;
  /** Sprite pixels its body travels on screen while one whole cycle plays. */
  cyclePx: number;
  gait: Gait | undefined;
  /** The drawing is gliding over a correction (GaitData.slidePx): no prints. */
  sliding: boolean;
  /** The own player's creature (its footfalls sound). */
  self: boolean;
  /** How long the step it walks takes, ms (a run raises dust). */
  stepMs: number;
}

export const newWalkSample = (): WalkSample => ({
  id: 0,
  x: 0,
  y: 0,
  z: 0,
  phase: -1,
  frames: 0,
  dx: 0,
  dy: 0,
  cyclePx: 0,
  gait: undefined,
  sliding: false,
  self: false,
  stepMs: 0,
});

/** One foot touching the ground. The tracker reuses one: read it inside the callback. */
export interface Footfall {
  id: number;
  /** Where the foot lands: sprite pixels in world space. */
  x: number;
  y: number;
  z: number;
  /** The print's rotation, radians (0 = walking north, clockwise). */
  rot: number;
  /** The way it walks on the map: -1, 0 or 1 each. */
  dx: number;
  dy: number;
  /** -1 the left foot, 1 the right, 0 on the centre line. */
  side: number;
  /** Which of the gait's contacts it is. */
  contact: number;
  gait: Gait;
  sliding: boolean;
  self: boolean;
  stepMs: number;
}

/** The rotation of a step from (dx, dy) (tile deltas, -1..1): 0 north, clockwise. */
export function stepRotation(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dx, -dy);
}

/**
 * Where a foot stands relative to the ground point under the body's middle, written to
 * `out` (sprite pixels on screen). The body faces the way it moves on the map, (dx, dy);
 * `ahead` and `along` are sprite pixels along that way (`ahead` measured on screen, as the
 * body travels; `along` on the body, so the view foreshortens it going north or south),
 * `side` × `stance` across it. The map's north-south axis is drawn `viewDepth` times
 * shorter than its east-west one, so a diagonal on screen is a body turned 60°, not 45°,
 * and its feet are apart accordingly.
 */
export function footOffset(
  dx: number,
  dy: number,
  ahead: number,
  along: number,
  side: number,
  stance: number,
  viewDepth: number,
  out: { x: number; y: number },
): void {
  const len = Math.hypot(dx, dy);
  if (len === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  // The body's heading on the ground plane, where the screen's y is 1 / viewDepth longer.
  const gy = dy / viewDepth;
  const gl = Math.hypot(dx, gy);
  const hx = dx / gl;
  const hy = gy / gl;
  // Its right-hand side on the ground (y grows south: north's right is east).
  const across = side * stance;
  out.x = (dx / len) * ahead + hx * along - hy * across;
  out.y = (dy / len) * ahead + (hy * along + hx * across) * viewDepth;
}

/**
 * Where the print of a foot is drawn, from where the foot stands: `spread` sprite pixels on
 * screen out to its side of the path it walks, (dx, dy). Written to `out`.
 */
export function printOffset(
  dx: number,
  dy: number,
  side: number,
  spread: number,
  out: { x: number; y: number },
): void {
  const len = Math.hypot(dx, dy);
  if (len === 0 || side === 0 || spread === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  // The path's right-hand side on screen (y grows down: walking north, right is east).
  out.x = (-dy / len) * side * spread + 0; // + 0: never -0
  out.y = (dx / len) * side * spread + 0;
}

interface TrackState {
  /** The cycle last seen, 0 to 1; NaN before its first walking frame. */
  phase: number;
  /** The tracker's frame it was last sampled in. */
  seen: number;
}

/**
 * A creature seen walking for the first time this early in its cycle started it now: the
 * contacts up to there count. Later in the cycle it came into view mid-walk: none do.
 */
export const FRESH_START = 0.125;
/** States kept before the stale ones (not sampled for STALE_FRAMES) are dropped. */
export const MAX_TRACKED = 256;
const STALE_FRAMES = 600;

/** Follows every creature's walk cycle and reports the footfalls. */
export class FootfallTracker {
  private readonly states = new Map<number, TrackState>();
  private readonly free: TrackState[] = [];
  private frame = 0;
  private readonly fall: Footfall;
  private readonly off = { x: 0, y: 0 };

  /** GaitData.viewDepth (plain fields: the capture script runs this file in Node as is). */
  private readonly viewDepth: number;

  constructor(viewDepth = 1) {
    this.viewDepth = viewDepth;
    this.fall = {
      id: 0,
      x: 0,
      y: 0,
      z: 0,
      rot: 0,
      dx: 0,
      dy: 0,
      side: 0,
      contact: 0,
      gait: {
        name: "",
        print: "feet",
        stance: 0,
        reach: 0,
        rise: 0,
        scale: 1,
        depth: 1,
        spread: 0,
        contacts: [],
      },
      sliding: false,
      self: false,
      stepMs: 0,
    };
  }

  get tracked(): number {
    return this.states.size;
  }

  /** A new frame: call once before the frame's samples. */
  tick(): void {
    this.frame++;
    if (this.states.size <= MAX_TRACKED) return;
    for (const [id, st] of this.states)
      if (this.frame - st.seen > STALE_FRAMES) {
        this.states.delete(id);
        this.free.push(st);
      }
  }

  /** The creature left the view (its animation state went with it). */
  forget(id: number): void {
    const st = this.states.get(id);
    if (!st) return;
    this.states.delete(id);
    this.free.push(st);
  }

  clear(): void {
    for (const st of this.states.values()) this.free.push(st);
    this.states.clear();
  }

  /**
   * A creature this frame. Calls `emit` once per foot that touched the ground since its
   * last sample, in the cycle's order, with the reused Footfall.
   */
  sample(w: WalkSample, emit: (f: Footfall) => void): void {
    let st = this.states.get(w.id);
    if (!st) {
      st = this.free.pop() ?? { phase: Number.NaN, seen: 0 };
      st.phase = Number.NaN;
      this.states.set(w.id, st);
    }
    st.seen = this.frame;
    // Not walking: the cycle waits where it stopped (a chained step carries on from there).
    if (w.phase < 0) return;
    const cur = w.phase >= 1 ? w.phase % 1 : w.phase;
    let prev = st.phase;
    st.phase = cur;
    const gait = w.gait;
    if (!gait) return;
    let moved: number;
    if (Number.isNaN(prev)) {
      // Its first walking frame: the start of its first cycle, or already under way.
      if (cur > FRESH_START) return;
      // From a hair before the start, so a contact exactly at 0 counts.
      prev = -1e-9;
      moved = cur + 1e-9;
    } else {
      moved = cur - prev;
      if (moved < 0) moved += 1;
    }
    if (moved <= 0) return;
    const contacts = gait.contacts;
    // In the cycle's order from `prev`: a frame that passed two contacts reports the
    // earlier first (the feet alternate); two at the same moment, in the data's order.
    let lastK = -1;
    let lastI = -1;
    for (;;) {
      let next = -1;
      let nextK = 2;
      for (let i = 0; i < contacts.length; i++) {
        const k = contactAfter(contacts[i] as GaitContact, prev, w.frames);
        if (k > moved || k < lastK || (k === lastK && i <= lastI)) continue;
        if (k < nextK) {
          nextK = k;
          next = i;
        }
      }
      if (next < 0) return;
      this.report(w, gait, next, moved - nextK, emit);
      lastK = nextK;
      lastI = next;
    }
  }

  private report(
    w: WalkSample,
    gait: Gait,
    index: number,
    past: number,
    emit: (f: Footfall) => void,
  ): void {
    const c = gait.contacts[index] as GaitContact;
    const f = this.fall;
    // Where the body was when the foot landed (`past` of a cycle ago), then the foot.
    footOffset(
      w.dx,
      w.dy,
      (gait.reach - past) * w.cyclePx,
      c.along,
      c.side,
      gait.stance,
      this.viewDepth,
      this.off,
    );
    f.id = w.id;
    f.x = w.x + this.off.x;
    f.y = w.y - gait.rise + this.off.y;
    f.z = w.z;
    f.rot = stepRotation(w.dx, w.dy);
    f.dx = w.dx;
    f.dy = w.dy;
    f.side = c.side;
    f.contact = index;
    f.gait = gait;
    f.sliding = w.sliding;
    f.self = w.self;
    f.stepMs = w.stepMs;
    emit(f);
  }
}

/**
 * How far after `prev` (in cycles, 0 exclusive to 1 inclusive) a contact comes. A clip
 * shows a contact when the frame holding it is first drawn: it is snapped to a frame.
 */
function contactAfter(c: GaitContact, prev: number, frames: number): number {
  const at = frames > 0 ? (Math.round(c.at * frames) % frames) / frames : c.at;
  const k = at - prev;
  return k <= 0 ? k + 1 : k;
}
