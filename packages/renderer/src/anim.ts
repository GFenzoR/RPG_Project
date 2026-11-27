// Creature animation (docs/17 ANI): which frame of a creature's clips to draw and how to
// move, squash or fade it, from the time, its step and what just happened to it. Pure and
// allocation-free per frame: the caller keeps one AnimState per creature and one Pose that
// animate() overwrites (docs/07). Sprites with frame strips (assets/sprites.yaml
// `animations`, atlas.json `anims`) play them; single-frame sprites get the procedural
// motion of ANI-5 (a hop per tile, a lean, breathing, a lunge, a fall), so every creature
// moves.

export type AnimAction = "idle" | "walk" | "attack" | "shoot" | "cast" | "death";
/**
 * The clip an attack plays (ANI-2, ANI-7): attack for a melee blow (the LPC slash), shoot
 * for a ranged one (the bow), cast for a spell. A sprite without that clip plays attack.
 */
export type AttackAction = "attack" | "shoot" | "cast";
/**
 * A facing (ANI-1): the four straight ones, and the diagonals of the engine humanoids. A
 * sprite has the diagonals only when its clips were drawn in all eight (ClipSet.eight in
 * the client); every other sprite faces four ways.
 */
export type AnimDir = "n" | "e" | "s" | "w" | "ne" | "se" | "sw" | "nw";
/** The straight facings, then the diagonals (indices 0-3 are the four facings of old). */
export const ANIM_DIRS: readonly AnimDir[] = ["n", "e", "s", "w", "ne", "se", "sw", "nw"];
/** The four straight facings: what a sprite without diagonals is drawn in. */
export const STRAIGHT_DIRS: readonly AnimDir[] = ["n", "e", "s", "w"];
/** The diagonal facings. */
export const DIAGONAL_DIRS: readonly AnimDir[] = ["ne", "se", "sw", "nw"];

/** Index of a facing in ANIM_DIRS. */
export const dirIndex = (d: AnimDir): number => ANIM_DIRS.indexOf(d);

/** The facing of a step or a look (dx, dy) on the map: its signs only (y grows south). */
export function dirOf(dx: number, dy: number): AnimDir {
  // A table by sign, not a string built per call: it runs for every creature every frame,
  // and drawing a frame creates nothing (docs/07).
  return DIR_BY_SIGN[(Math.sign(dy) + 1) * 3 + Math.sign(dx) + 1] ?? "s";
}

/** dirOf's facings by (sign(dy) + 1) × 3 + sign(dx) + 1; no direction looks south. */
const DIR_BY_SIGN: readonly AnimDir[] = ["nw", "n", "ne", "w", "s", "e", "sw", "s", "se"];

/**
 * The facing a creature turns to for a direction (dx, dy), from `prev`, the way it faces
 * now (docs/17 ANI-1). A straight direction is that facing. A diagonal one is the diagonal
 * when the creature is drawn in eight facings (`eight`); with four, it keeps the half of
 * the diagonal it already faces (going north-east while facing north keeps north, while
 * facing east keeps east), and otherwise turns to the horizontal half (north-east after
 * south looks east), as in classic top-down games. No direction keeps `prev`, but never a
 * diagonal a four-facing figure cannot be drawn in (it lost a layer's diagonals while
 * facing one): that one turns to the diagonal's horizontal half.
 */
export function turnTo(prev: AnimDir, dx: number, dy: number, eight: boolean): AnimDir {
  if (dx === 0 && dy === 0) return eight || prev.length === 1 ? prev : (prev[1] as AnimDir);
  const want = dirOf(dx, dy);
  if (dx === 0 || dy === 0 || eight) return want;
  const v = dy < 0 ? "n" : "s";
  const h = dx > 0 ? "e" : "w";
  if (prev === v || prev === h) return prev;
  return h;
}

/**
 * Turns a creature for this frame and returns the facing to draw it in (docs/17 ANI-1):
 * towards its last attack while that plays (its clip, or the lunge), and after it until the
 * creature walks or looks another way, so a fighter standing still keeps facing its target
 * between blows; otherwise the way the world says it looks, (dx, dy), its step's while
 * `moving`. Both through turnTo, so a four-facing figure keeps its sticky half.
 */
export function faceTo(
  s: AnimState,
  meta: AnimMeta | undefined,
  now: number,
  dx: number,
  dy: number,
  moving: boolean,
  eight: boolean,
): AnimDir {
  if (s.attackTurn && Number.isNaN(s.diedAt)) {
    const dir = turnTo(s.facing, s.attackDx, s.attackDy, eight);
    const clip = attackClip(meta, s.attackAction, dir);
    const ms = clip ? clip.frames * clip.ms : LUNGE_OUT_MS + LUNGE_BACK_MS;
    const since = now - s.attackAt;
    const playing = since >= 0 && since < ms;
    if (playing || (!moving && dx === s.lookDx && dy === s.lookDy)) {
      s.facing = dir;
      return dir;
    }
    s.attackTurn = false;
  }
  s.lookDx = dx;
  s.lookDy = dy;
  s.facing = turnTo(s.facing, dx, dy, eight);
  return s.facing;
}

/** One action of an animated sprite, as atlas.json describes it (tools/spritepack anims.ts). */
export interface AnimActionMeta {
  frames: number;
  /** Ms per frame (walk: 0, it plays by distance). */
  ms: number;
  /** Walk: frames per tile walked. */
  perTile?: number;
  /**
   * Walk facing north or south, when it differs (the engine humanoids, docs/17 "La regla de
   * la zancada"): the 3/4 view foreshortens the model's depth, not the map's tiles, so the
   * cycle is longer on screen there for the planted foot to hold.
   */
  perTileNS?: number;
  /**
   * Facings with frames. Facing another way, walk and death use "s" (or the first);
   * idle and attack (OWN_FACINGS) get the procedural motion instead: the standing frame of
   * that facing, and the lunge.
   */
  dirs: AnimDir[];
}

/**
 * Actions drawn only facing a way they have frames for. A sheet can come with a bite to the
 * side and none to the front (the Gemini monsters, assets/README.md): turning the creature
 * sideways to bite south would be wrong, so it lunges with its own facing's frame (ANI-5).
 */
export const OWN_FACINGS: ReadonlySet<AnimAction> = new Set<AnimAction>([
  "idle",
  "attack",
  "shoot",
  "cast",
]);

/** The action's clip when it may be drawn facing `dir` (see OWN_FACINGS). */
export function clipFacing(
  meta: AnimMeta | undefined,
  action: AnimAction,
  dir: AnimDir,
): AnimActionMeta | undefined {
  const a = meta?.actions[action];
  if (!a || (OWN_FACINGS.has(action) && !a.dirs.includes(dir))) return undefined;
  return a;
}

/** atlas.json `anims[sprite]`: frames and drawing hints of a creature sprite. */
export interface AnimMeta {
  w: number;
  h: number;
  /** br: bottom-right on the tile's (every sprite's default); bc: centred, feet on the tile. */
  anchor: "br" | "bc";
  /** Transparent rows under the feet. */
  foot: number;
  /** Height of the drawing above its feet, pixels. */
  top: number;
  /** baked: drawn in the sprite (Dungeon Crawl); ellipse: the renderer's contact shadow. */
  shadow: "baked" | "ellipse" | "none";
  /** Single-frame sprites: the side the drawing looks at; it is mirrored to look the other way. */
  facing?: "left" | "right";
  /** Hovers: bobs all the time and never hops. */
  flying?: boolean;
  /**
   * How its body walks (assets/sprites.yaml `body`, docs/17 "Criaturas al ritmo de su paso"):
   * it picks the default stride and the procedural gait of a sprite without walk frames.
   * Absent: the older rule, a whole clip (or one hop) per perTile.
   */
  body?: BodyGait;
  /**
   * Sprite pixels of ground one walk cycle covers (assets/sprites.yaml `stride`); absent,
   * the default of its `body` (DEFAULT_STRIDE). The cycle advances with the distance
   * walked over it, so a planted foot holds its ground point at any speed.
   */
  stride?: number;
  /**
   * Where it stands, per facing (tools/spritepack measureStance): [foot, x0, x1], the
   * transparent rows under the lowest pixel of its standing pose and the columns (from the
   * frame's left edge, x1 exclusive) its lowest rows span. `foot` above is the lowest reach
   * of the walk (a foot stepping toward the viewer goes lower than the body stands).
   * Absent in older atlases.
   */
  stance?: Partial<Record<AnimDir, Stance>>;
  /**
   * Transparent rows under its fallen body (tools/spritepack restOf): the last frame of its
   * death facing south, or its single image tipped over. Its corpse is that body moved to
   * the feet line (tools/spritegen recipes/corpses.ts), so the fall ends there (fallShift).
   * Absent in older atlases and for a drawing nothing can be said of.
   */
  rest?: number;
  actions: Partial<Record<AnimAction, AnimActionMeta>>;
}

export type Stance = readonly [foot: number, x0: number, x1: number];

/**
 * The kinds of body a creature walks with: two legs, four, many (spiders, crabs, beetles),
 * a body dragged in waves, a jumper, and a flier (wings beat by time, it never plants a foot).
 */
export type BodyGait = "biped" | "quadruped" | "many_legs" | "slither" | "hop" | "flyer";
export const BODY_GAITS: readonly BodyGait[] = [
  "biped",
  "quadruped",
  "many_legs",
  "slither",
  "hop",
  "flyer",
];

/** Sprite pixels a tile measures: the distance of one straight step. */
export const STEP_PX = 32;

/**
 * Ground one walk cycle covers, sprite px, for a body without its own `stride`: a biped's
 * two steps (the engine humanoid's: a tile), a walking beast's four footfalls, the quick
 * short cycle of many legs, one wave of a dragged body, one jump. A flier has none.
 */
export const DEFAULT_STRIDE: Readonly<Record<BodyGait, number>> = {
  biped: 32,
  quadruped: 40,
  many_legs: 16,
  slither: 24,
  hop: 32,
  flyer: 0,
};

/** Whether it flies: wings by time, a bob, and never a footfall. */
export const isFlyer = (meta: AnimMeta | undefined): boolean =>
  meta?.flying === true || meta?.body === "flyer";

/**
 * The stride of a creature, sprite px per walk cycle: its own, else its body's default;
 * undefined for a flier and for a sprite that declares neither (the older per-tile rule).
 */
export function strideOf(meta: AnimMeta | undefined): number | undefined {
  if (!meta || isFlyer(meta)) return undefined;
  if (meta.stride !== undefined && meta.stride > 0) return meta.stride;
  return meta.body ? DEFAULT_STRIDE[meta.body] : undefined;
}

/**
 * The stance of `meta` facing `dir`: its own, else the south one, else any; undefined for
 * an atlas without them (the caller falls back on `foot`).
 */
export function stanceOf(meta: AnimMeta | undefined, dir: AnimDir): Stance | undefined {
  const st = meta?.stance;
  if (!st) return undefined;
  return st[dir] ?? st.s ?? Object.values(st)[0];
}

/** Feet line: pixels above the tile's bottom edge where bc sprites stand and shadows sit. */
export const FEET_LINE = 4;
/** Contact shadow (ART-5): an ellipse of SHADOW_W x SHADOW_H px, black at SHADOW_ALPHA. */
export const SHADOW_W = 20;
export const SHADOW_H = 6;
export const SHADOW_ALPHA = 0.35;

/** ANI-3: the idle pose comes back this long after the last step ended. */
export const IDLE_AFTER_MS = 100;
/** ANI-5 timings and distances (sprite pixels). */
export const HOP_PX = 2;
export const BREATH_MS = 400;
export const BREATH_PERIOD_MS = 1600;
export const BREATH_SPREAD_MS = 800;
export const FLY_PX = 2;
export const FLY_MS = 600;
/** A flier's wings: ms per frame of its walk clip, moving or hovering (never by distance). */
export const WING_BEAT_MS = 90;
/** A flier of a single image: it flattens 1 px for half of every FLAP_MS (the wing beat). */
export const FLAP_MS = 240;
/** The rise of a walker without walk frames between two footfalls, sprite px. */
export const STEP_BOB_PX = 1;
export const LUNGE_PX = 6;
export const LUNGE_OUT_MS = 90;
export const LUNGE_BACK_MS = 160;
export const HIT_FLASH_MS = 60;
export const HIT_MS = 180;
export const KNOCK_PX = 2;
export const DEATH_MS = 400;
/**
 * A fallen body holds its last pose this long while it fades over its corpse, which the
 * map shows from the end of the fall (docs/17 "Muerte continua"): a crossfade from the
 * living colours to the corpse's, both drawn on the same pixels.
 */
export const DEATH_SETTLE_MS = 100;
/** A single image tipped over is flattened to this share of its height (spritegen tipOver). */
export const TIP_SQUASH = 3 / 5;

/** How long the fall of a death lasts, ms: its clip, or the procedural tip (DEATH_MS). */
export function fallMs(meta: AnimMeta | undefined): number {
  const clip = meta?.actions.death;
  return clip && clip.frames > 0 && clip.ms > 0 ? clip.frames * clip.ms : DEATH_MS;
}

/**
 * How far down (sprite px, negative: up) a body `rest` rows over the bottom of its frame
 * moves while it falls, to lie where its corpse sprite does: the corpse has its lowest
 * pixel FEET_LINE over the tile's bottom, the body is drawn with its frame's bottom on the
 * tile's (br) or `foot` rows under the feet line (bc). 0 when the atlas does not say.
 */
export function fallShift(
  meta: AnimMeta | undefined,
  rest: number | undefined = meta?.rest,
): number {
  if (!meta || rest === undefined) return 0;
  return rest - (meta.anchor === "bc" ? meta.foot : FEET_LINE);
}

/** How a sprite anchored at its bottom centre is set to draw a tipped pose (tipPlacement). */
export interface TipPlacement {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  skewX: number;
  skewY: number;
}

/**
 * Fills `out` with the Pixi transform (rotation 0) of a frame `h` px high, anchored at its
 * bottom centre, turned `tip` radians clockwise about its middle and then flattened to
 * `squash` of its height against its bottom edge: what spritegen's tipOver does to make the
 * corpse of a single image, so a quarter turn at TIP_SQUASH lands on the corpse's pixels.
 * A point (u, v) from the anchor is drawn at
 * (x + u cos - v sin, y + squash (u sin + v cos)).
 */
export function tipPlacement(
  tip: number,
  squash: number,
  h: number,
  out: TipPlacement,
): TipPlacement {
  const cos = Math.cos(tip);
  const sin = Math.sin(tip);
  // Pixi: a = cos(skewY) sx, b = sin(skewY) sx, c = sin(skewX) sy, d = cos(skewX) sy.
  out.scaleX = Math.hypot(cos, squash * sin);
  out.skewY = Math.atan2(squash * sin, cos);
  out.scaleY = Math.hypot(sin, squash * cos);
  out.skewX = Math.atan2(-sin, squash * cos);
  out.x = 0 - (sin * h) / 2;
  out.y = (squash * (cos - 1) * h) / 2;
  return out;
}
export const APPEAR_MS = 300;
/**
 * Leaving by a teleport or a logout (ANI-7): it narrows into a pale flickering sliver and
 * fades out in VANISH_MS, never the fall of a death. The flicker toggles every VANISH_FLICKER_MS.
 */
export const VANISH_MS = 350;
export const VANISH_FLICKER_MS = 50;

/** What a creature's animation remembers between frames. One per creature, mutated in place. */
export interface AnimState {
  /** Phase spread for idle cycles (ANI-3: a pack does not breathe in unison). */
  seed: number;
  /** Start of the step being counted, NaN before the first one. */
  walkStart: number;
  /**
   * Walk frames played by the steps finished before the current one (the cycle plays by
   * distance), kept within the clip. Counted in frames, not steps: a step facing north or
   * south plays more frames per tile (perTileNS), so turning mid-walk carries on from the
   * frame drawn instead of jumping to where that many steps would be at the other pace.
   */
  walkPhase: number;
  /** Walk frames per tile of the current step (what it adds to walkPhase when it ends). */
  walkPer: number;
  /** When the last step ended (ANI-3), -Infinity if it never walked. */
  stepEnd: number;
  /** Walk frame drawn last, held between chained steps. */
  walkFrame: number;
  /** Last attack: when, its clip, and the unit direction towards the target (the lunge). */
  attackAt: number;
  attackAction: AttackAction;
  attackDx: number;
  attackDy: number;
  /** It still faces that attack (faceTo): until it walks or looks another way. */
  attackTurn: boolean;
  /** The way the world last said it looks, outside an attack (faceTo tells a turn by it). */
  lookDx: number;
  lookDy: number;
  /** Last hit taken: when, and the unit direction it is pushed. */
  hitAt: number;
  hitDx: number;
  hitDy: number;
  /** When it appeared (fades in). */
  bornAt: number;
  /** When it died (NaN while alive). */
  diedAt: number;
  /** How far down its body moves as it falls, to lie where its corpse does (fallShift). */
  fallY: number;
  /** When it left by a teleport or a logout (NaN while here). */
  vanishAt: number;
  /** Single-frame sprites with `facing`: drawn mirrored (kept while walking north or south). */
  flip: boolean;
  /** The facing it is drawn in (turnTo keeps it between directions). */
  facing: AnimDir;
}

export function newAnimState(id: number, now: number): AnimState {
  return {
    seed: hashId(id),
    walkStart: Number.NaN,
    walkPhase: 0,
    walkPer: 0,
    stepEnd: Number.NEGATIVE_INFINITY,
    walkFrame: 0,
    attackAt: Number.NEGATIVE_INFINITY,
    attackAction: "attack",
    attackDx: 0,
    attackDy: 0,
    attackTurn: false,
    lookDx: 0,
    lookDy: 0,
    hitAt: Number.NEGATIVE_INFINITY,
    hitDx: 0,
    hitDy: 0,
    bornAt: now,
    diedAt: Number.NaN,
    fallY: 0,
    vanishAt: Number.NaN,
    flip: false,
    facing: "s",
  };
}

/** What happens to the creature this frame. The caller fills it (one object, reused). */
export interface AnimInput {
  now: number;
  dir: AnimDir;
  /** The step being drawn: its start and duration (ms); undefined start = not walking. */
  walkStart: number | undefined;
  walkMs: number;
  /** Horizontal direction of that step (-1, 0, 1), for the lean. */
  moveDx: number;
  /** Vertical direction of that step (-1, 0, 1): a diagonal one walks farther. */
  moveDy: number;
}

export const newAnimInput = (): AnimInput => ({
  now: 0,
  dir: "s",
  walkStart: undefined,
  walkMs: 0,
  moveDx: 0,
  moveDy: 0,
});

/** How to draw the creature this frame. animate() overwrites every field. */
export interface Pose {
  /** Clip and frame to draw (only meaningful when the sprite has that clip). */
  action: AnimAction;
  frame: number;
  /** Offset from its place on the tile, whole sprite pixels. */
  x: number;
  y: number;
  /** Scale around the feet; negative x = mirrored. */
  scaleX: number;
  scaleY: number;
  /** Horizontal shear of the upper part (radians, Pixi skew.x). */
  skewX: number;
  /**
   * A single image falling dead: turned this much clockwise about the middle of its frame
   * (radians), then squashed by scaleY against the floor (tipPlacement). 0 otherwise.
   */
  tip: number;
  alpha: number;
  /** Hit flash. */
  flash: boolean;
  /** Leaving by a teleport or a logout: drawn with a pale tint (VANISH_MS). */
  shimmer: boolean;
  /** Contact shadow scale (a flying creature's shrinks as it rises). */
  shadow: number;
  /** A death finished: the caller can drop the sprite. */
  done: boolean;
  /**
   * Where the walk cycle drawn this frame is, 0 to 1 (a clip: frame 0's start is 0; without
   * one, the hop of a step from take-off to landing), while the creature walks a step on its
   * legs; -1 when it does not (standing, between steps, an attack clip or a death playing, a
   * flier). The living world drops footprints by it (livingworld/README.md "Huellas").
   */
  walk: number;
}

export const newPose = (): Pose => ({
  action: "idle",
  frame: 0,
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  tip: 0,
  alpha: 1,
  flash: false,
  shimmer: false,
  shadow: 1,
  done: false,
  walk: -1,
});

/**
 * An attack towards (dx, dy) (any length; only its octant counts: a target far to the east
 * and a tile north is to the east, not the north-east): its clip (`action`, else attack)
 * or, without one, the lunge; and the creature turns that way (faceTo).
 */
export function startAttack(
  s: AnimState,
  now: number,
  dx: number,
  dy: number,
  action: AttackAction = "attack",
): void {
  s.attackAt = now;
  s.attackAction = action;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  s.attackDx = ax * 2 < ay ? 0 : Math.sign(dx);
  s.attackDy = ay * 2 < ax ? 0 : Math.sign(dy);
  s.attackTurn = s.attackDx !== 0 || s.attackDy !== 0;
}

/** A hit: flash, and a push towards (dx, dy) (only the sign counts). */
export function startHit(s: AnimState, now: number, dx: number, dy: number): void {
  s.hitAt = now;
  s.hitDx = Math.sign(dx);
  s.hitDy = Math.sign(dy);
}

/**
 * It died: the fall starts (the first one counts). `fallY` is how far down the body moves
 * while it falls so its last pose lies on its corpse (fallShift; 0: it falls in place).
 */
export function startDeath(s: AnimState, now: number, fallY = 0): void {
  if (!Number.isNaN(s.diedAt)) return;
  s.diedAt = now;
  s.fallY = fallY;
}

/** It leaves by a teleport or a logout: the shimmer of VANISH_MS (the first one counts). */
export function startVanish(s: AnimState, now: number): void {
  if (Number.isNaN(s.vanishAt)) s.vanishAt = now;
}

/** Duration of an action's clip, ms (0 without one). */
export function clipMs(meta: AnimMeta | undefined, action: AnimAction): number {
  const a = meta?.actions[action];
  return a ? a.frames * a.ms : 0;
}

/**
 * The clip an attack of `action` plays facing `dir`: its own (shoot, cast), else attack
 * (the melee swing), else none (the lunge). Which of the two it is: attackClipAction.
 */
export function attackClip(
  meta: AnimMeta | undefined,
  action: AttackAction,
  dir: AnimDir,
): AnimActionMeta | undefined {
  return (
    clipFacing(meta, action, dir) ??
    (action === "attack" ? undefined : clipFacing(meta, "attack", dir))
  );
}

/** The action whose frames attackClip gives (its own, or attack in its place). */
export const attackClipAction = (
  meta: AnimMeta | undefined,
  action: AttackAction,
  dir: AnimDir,
): AttackAction => (clipFacing(meta, action, dir) ? action : "attack");

/**
 * Fills `out` with the pose of a creature at `in_.now`: the clip frame (walk by distance,
 * idle by time with a per-creature phase, attack and death once) and the procedural offsets
 * of ANI-5 for what the sprite has no clip for.
 */
export function animate(s: AnimState, meta: AnimMeta | undefined, in_: AnimInput, out: Pose): Pose {
  const now = in_.now;
  out.action = "idle";
  out.frame = 0;
  out.x = 0;
  out.y = 0;
  out.scaleX = 1;
  out.scaleY = 1;
  out.skewX = 0;
  out.tip = 0;
  out.alpha = 1;
  out.flash = false;
  out.shimmer = false;
  out.shadow = 1;
  out.done = false;
  out.walk = -1;
  const top = Math.max(8, meta?.top ?? 24);

  // Steps: count each one when the next starts, so the cycle continues across tiles.
  let t: number | undefined;
  if (in_.walkStart !== undefined && in_.walkMs > 0) {
    if (in_.walkStart !== s.walkStart) {
      if (!Number.isNaN(s.walkStart)) s.walkPhase += s.walkPer;
      s.walkStart = in_.walkStart;
    }
    const end = in_.walkStart + in_.walkMs;
    if (now < end) {
      t = Math.max(0, (now - in_.walkStart) / in_.walkMs);
      s.stepEnd = end;
    }
  }
  if (meta?.facing && (in_.dir === "e" || in_.dir === "w"))
    s.flip = (in_.dir === "e") === (meta.facing === "left");

  let mirror = s.flip;
  if (!Number.isNaN(s.diedAt)) {
    // A single image tips over as its corpse was drawn, from the drawing as it is (never
    // mirrored): the body ends on the corpse's own pixels.
    if (dying(meta, now - s.diedAt, s.fallY, out)) mirror = false;
  } else {
    const sinceAttack = now - s.attackAt;
    const attack = attackClip(meta, s.attackAction, in_.dir);
    if (attack && sinceAttack >= 0 && sinceAttack < attack.frames * attack.ms) {
      out.action = attackClipAction(meta, s.attackAction, in_.dir);
      out.frame = Math.min(attack.frames - 1, Math.floor(sinceAttack / attack.ms));
    } else if (t !== undefined || now - s.stepEnd < IDLE_AFTER_MS) {
      walking(s, meta, in_, t, top, out);
    } else {
      idle(s, meta, in_.dir, now, top, out);
    }
    if (!attack && sinceAttack >= 0 && sinceAttack < LUNGE_OUT_MS + LUNGE_BACK_MS) {
      const d =
        sinceAttack < LUNGE_OUT_MS
          ? (LUNGE_PX * sinceAttack) / LUNGE_OUT_MS
          : LUNGE_PX * (1 - (sinceAttack - LUNGE_OUT_MS) / LUNGE_BACK_MS);
      out.x += Math.round(s.attackDx * d);
      out.y += Math.round(s.attackDy * d);
    }
  }

  if (isFlyer(meta)) {
    const phase = (now + s.seed) % FLY_MS;
    const lift = FLY_PX + Math.round(FLY_PX * Math.sin((2 * Math.PI * phase) / FLY_MS));
    out.y -= lift;
    out.shadow = 1 - lift / (4 * FLY_PX + 2);
    // A single image has no wings to move: it flattens a pixel on every beat instead.
    if (
      Number.isNaN(s.diedAt) &&
      !meta?.actions.walk &&
      !meta?.actions.idle &&
      (now + s.seed) % FLAP_MS < FLAP_MS / 2
    ) {
      out.scaleY *= (top - 1) / top;
      out.scaleX *= (top + 1) / top;
    }
  }

  const sinceHit = now - s.hitAt;
  if (sinceHit >= 0 && sinceHit < HIT_MS) {
    out.flash = sinceHit < HIT_FLASH_MS;
    const d =
      sinceHit < HIT_FLASH_MS
        ? KNOCK_PX
        : Math.round(KNOCK_PX * (1 - (sinceHit - HIT_FLASH_MS) / (HIT_MS - HIT_FLASH_MS)));
    out.x += s.hitDx * d;
    out.y += s.hitDy * d;
  }

  const sinceBorn = now - s.bornAt;
  if (sinceBorn >= 0 && sinceBorn < APPEAR_MS) out.alpha *= sinceBorn / APPEAR_MS;
  if (!Number.isNaN(s.vanishAt) && Number.isNaN(s.diedAt)) vanishing(now - s.vanishAt, out);
  if (mirror) out.scaleX = -out.scaleX;
  return out;
}

/**
 * Leaving by a teleport or a logout: the body narrows to a sliver and stretches up a
 * little, pale and flickering, while it fades out; done after VANISH_MS.
 */
function vanishing(el: number, out: Pose): void {
  const t = Math.min(1, Math.max(0, el) / VANISH_MS);
  const flicker = Math.floor(Math.max(0, el) / VANISH_FLICKER_MS) % 2 === 0 ? 1 : 0.6;
  out.scaleX *= 1 - 0.7 * t;
  out.scaleY *= 1 + 0.2 * t;
  out.alpha *= (1 - t) * flicker;
  out.shimmer = true;
  out.done = el >= VANISH_MS;
}

function walking(
  s: AnimState,
  meta: AnimMeta | undefined,
  in_: AnimInput,
  t: number | undefined,
  top: number,
  out: Pose,
): void {
  const walk = meta?.actions.walk;
  const clip = walk !== undefined && walk.frames > 0 ? walk : undefined;
  if (isFlyer(meta)) {
    // Wings beat by time, flying on or hovering between two steps; no foot ever lands.
    if (clip) {
      out.action = "walk";
      out.frame = wingFrame(s, clip, in_.now);
    }
    return;
  }
  const stride = strideOf(meta);
  if (clip) {
    out.action = "walk";
    // ANI-2: by distance, so feet do not slide when the speed changes; between chained
    // steps (t undefined, within IDLE_AFTER_MS) the last frame stays (ANI-3).
    if (t !== undefined) {
      s.walkPhase %= clip.frames;
      const per = walkPerStep(clip, in_, stride);
      s.walkPer = per;
      const at = s.walkPhase + t * per;
      s.walkFrame = Math.floor(at) % clip.frames;
      out.walk = (at % clip.frames) / clip.frames;
      if (meta?.body === "slither") wave(in_, out.walk, top, out);
    }
    out.frame = s.walkFrame;
    return;
  }
  if (t === undefined) return;
  if (stride === undefined) {
    out.walk = t;
    // ANI-5: a hop per tile, the top leaning 1 px towards the move, a squash on landing.
    hop(in_, t, top, out);
    return;
  }
  // No walk frames, a known stride: the procedural gait of its body, by distance. The
  // phase is kept in cycles (a clip of one frame), so it carries on across tiles.
  s.walkPhase %= 1;
  const per = stepPx(in_) / stride;
  s.walkPer = per;
  const p = (s.walkPhase + t * per) % 1;
  out.walk = p;
  switch (meta?.body) {
    case "hop":
      hop(in_, p, top, out);
      break;
    case "slither":
      wave(in_, p, top, out);
      break;
    case "many_legs":
      // Eight quick footfalls a cycle: the body trembles a pixel between them.
      out.y -= Math.floor(p * 8) % 2;
      break;
    default:
      // Two legs or four: the body rises between two footfalls (at 0 and at half the
      // cycle, where the gaits of the living world plant the feet) and leans into the move.
      out.y -= Math.round(STEP_BOB_PX * Math.abs(Math.sin(2 * Math.PI * p)));
      if (in_.moveDx !== 0) out.skewX = -in_.moveDx * Math.asin(1 / top);
  }
}

/** One jump from take-off (0) to landing (1): the arc, the lean and the squash at both ends. */
function hop(in_: AnimInput, p: number, top: number, out: Pose): void {
  out.y -= Math.round(HOP_PX * Math.sin(Math.PI * p));
  if (in_.moveDx !== 0) out.skewX = -in_.moveDx * Math.asin(1 / top);
  if (p < 0.15 || p > 0.85) {
    out.scaleY = (top - 1) / top;
    out.scaleX = (top + 1) / top;
  }
}

/**
 * A dragged body's wave at `p` of its cycle: moving across the screen it stretches and
 * gathers a pixel (never leaving the ground); moving up, down or diagonally it sways a
 * pixel from side to side.
 */
function wave(in_: AnimInput, p: number, top: number, out: Pose): void {
  const w = Math.round(Math.sin(2 * Math.PI * p));
  if (w === 0) return;
  if (in_.moveDy === 0) {
    out.scaleX = (top + w) / top;
    out.scaleY = (top - w) / top;
  } else {
    out.x += w;
  }
}

/** The frame of a flier's wing clip at `now` (by time, a phase per creature). */
function wingFrame(s: AnimState, clip: AnimActionMeta, now: number): number {
  return Math.floor(Math.max(0, now + s.seed) / WING_BEAT_MS) % clip.frames;
}

/** Sprite pixels the step being drawn covers: a tile, or its diagonal. */
function stepPx(in_: AnimInput): number {
  return in_.moveDx !== 0 && in_.moveDy !== 0 ? STEP_PX * Math.SQRT2 : STEP_PX;
}

/**
 * Walk frames one step plays, by distance (ANI-2). With a `stride` (sprite px per cycle,
 * strideOf): the clip's frames times the step's length over it, the same in every facing.
 * Without one, the older rule: a diagonal step, a tile across and a tile down the screen,
 * plays the length of both, hypot(perTile, perTileNS); a straight one, perTileNS facing
 * north or south (the 3/4 view, specs/humanoid) and perTile otherwise.
 */
export function walkPerStep(walk: AnimActionMeta, in_: AnimInput, stride?: number): number {
  if (stride !== undefined && stride > 0) return (walk.frames * stepPx(in_)) / stride;
  const across = walk.perTile ?? walk.frames;
  const down = walk.perTileNS ?? across;
  if (in_.moveDx !== 0 && in_.moveDy !== 0) return Math.max(1, Math.hypot(across, down));
  return Math.max(1, in_.dir === "n" || in_.dir === "s" ? down : across);
}

/**
 * Walk cycles one step plays (the footprints' spacing, livingworld): a clip's frames per
 * step over its frames; without a walk clip, the step's length over its stride, or the one
 * hop of a step for a sprite that declares none.
 */
export function walkCyclesPerStep(meta: AnimMeta | undefined, in_: AnimInput): number {
  const walk = meta?.actions.walk;
  const stride = strideOf(meta);
  if (walk && walk.frames > 0) return walkPerStep(walk, in_, stride) / walk.frames;
  return stride === undefined ? 1 : stepPx(in_) / stride;
}

function idle(
  s: AnimState,
  meta: AnimMeta | undefined,
  dir: AnimDir,
  now: number,
  top: number,
  out: Pose,
): void {
  const clip = clipFacing(meta, "idle", dir);
  if (clip && clip.frames > 0 && clip.ms > 0) {
    const cycle = clip.frames * clip.ms;
    out.action = "idle";
    out.frame = Math.floor(((now + s.seed) % cycle) / clip.ms);
    return;
  }
  const walk = meta?.actions.walk;
  if (isFlyer(meta)) {
    // Hovering without an idle clip this way: the wings keep beating.
    if (walk && walk.frames > 0) {
      out.action = "walk";
      out.frame = wingFrame(s, walk, now);
    }
    return;
  }
  if (walk) return; // a walk clip's frame 0 stands still
  // ANI-5 breathing: 1 px taller for BREATH_MS every 1.6-2.4 s, phase by creature.
  const period = BREATH_PERIOD_MS + (s.seed % BREATH_SPREAD_MS);
  if ((now + s.seed) % period < BREATH_MS) out.scaleY = (top + 1) / top;
}

/**
 * The fall of a death (docs/17 "Muerte continua"), `el` ms after it: one motion that ends
 * in the pose of the corpse, `fallY` px lower, and holds it DEATH_SETTLE_MS fading over the
 * corpse the map shows by then. Answers whether it is the procedural tip of a single image.
 */
function dying(meta: AnimMeta | undefined, el: number, fallY: number, out: Pose): boolean {
  const clip = meta?.actions.death;
  const ms = fallMs(meta);
  out.action = "death";
  if (el > ms) out.alpha = Math.max(0, 1 - (el - ms) / DEATH_SETTLE_MS);
  out.done = el >= ms + DEATH_SETTLE_MS;
  if (clip && clip.frames > 0 && clip.ms > 0) {
    out.frame = Math.min(clip.frames - 1, Math.floor(Math.max(0, el) / clip.ms));
    // Lowered frame by frame: the last one, the fallen body, is already on the corpse.
    out.y = clip.frames > 1 ? Math.round((fallY * out.frame) / (clip.frames - 1)) : fallY;
    return false;
  }
  // ANI-5: a flash, then it tips over clockwise, faster as it goes, and flattens against
  // the floor: at the end, spritegen's tipOver of the same image.
  const t = Math.min(1, Math.max(0, el) / DEATH_MS);
  const e = t * t;
  out.flash = el < HIT_FLASH_MS;
  out.tip = (Math.PI / 2) * e;
  out.scaleY = 1 - (1 - TIP_SQUASH) * e;
  out.y = Math.round(fallY * e);
  return true;
}

/** A well-spread non-negative integer from a creature id (idle phases). */
export function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 100000;
}
