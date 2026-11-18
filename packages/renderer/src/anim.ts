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
export type AnimDir = "n" | "e" | "s" | "w";
export const ANIM_DIRS: readonly AnimDir[] = ["n", "e", "s", "w"];

/** One action of an animated sprite, as atlas.json describes it (tools/spritepack anims.ts). */
export interface AnimActionMeta {
  frames: number;
  /** Ms per frame (walk: 0, it plays by distance). */
  ms: number;
  /** Walk: frames per tile walked. */
  perTile?: number;
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
  actions: Partial<Record<AnimAction, AnimActionMeta>>;
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
export const LUNGE_PX = 6;
export const LUNGE_OUT_MS = 90;
export const LUNGE_BACK_MS = 160;
export const HIT_FLASH_MS = 60;
export const HIT_MS = 180;
export const KNOCK_PX = 2;
export const DEATH_MS = 400;
/** A death clip holds its last frame this long while it fades. */
export const DEATH_FADE_MS = 150;
export const APPEAR_MS = 300;

/** What a creature's animation remembers between frames. One per creature, mutated in place. */
export interface AnimState {
  /** Phase spread for idle cycles (ANI-3: a pack does not breathe in unison). */
  seed: number;
  /** Start of the step being counted, NaN before the first one. */
  walkStart: number;
  /** Steps finished before the current one (the walk cycle plays by distance). */
  steps: number;
  /** When the last step ended (ANI-3), -Infinity if it never walked. */
  stepEnd: number;
  /** Walk frame drawn last, held between chained steps. */
  walkFrame: number;
  /** Last attack: when, its clip, and the unit direction towards the target (the lunge). */
  attackAt: number;
  attackAction: AttackAction;
  attackDx: number;
  attackDy: number;
  /** Last hit taken: when, and the unit direction it is pushed. */
  hitAt: number;
  hitDx: number;
  hitDy: number;
  /** When it appeared (fades in). */
  bornAt: number;
  /** When it died (NaN while alive). */
  diedAt: number;
  /** Single-frame sprites with `facing`: drawn mirrored (kept while walking north or south). */
  flip: boolean;
}

export function newAnimState(id: number, now: number): AnimState {
  return {
    seed: hashId(id),
    walkStart: Number.NaN,
    steps: 0,
    stepEnd: Number.NEGATIVE_INFINITY,
    walkFrame: 0,
    attackAt: Number.NEGATIVE_INFINITY,
    attackAction: "attack",
    attackDx: 0,
    attackDy: 0,
    hitAt: Number.NEGATIVE_INFINITY,
    hitDx: 0,
    hitDy: 0,
    bornAt: now,
    diedAt: Number.NaN,
    flip: false,
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
}

export const newAnimInput = (): AnimInput => ({
  now: 0,
  dir: "s",
  walkStart: undefined,
  walkMs: 0,
  moveDx: 0,
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
  alpha: number;
  /** Hit flash. */
  flash: boolean;
  /** Contact shadow scale (a flying creature's shrinks as it rises). */
  shadow: number;
  /** A death finished: the caller can drop the sprite. */
  done: boolean;
}

export const newPose = (): Pose => ({
  action: "idle",
  frame: 0,
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  alpha: 1,
  flash: false,
  shadow: 1,
  done: false,
});

/**
 * An attack towards (dx, dy) (any length; only the sign counts): its clip (`action`, else
 * attack) or, without one, the lunge.
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
  s.attackDx = Math.sign(dx);
  s.attackDy = Math.sign(dy);
}

/** A hit: flash, and a push towards (dx, dy) (only the sign counts). */
export function startHit(s: AnimState, now: number, dx: number, dy: number): void {
  s.hitAt = now;
  s.hitDx = Math.sign(dx);
  s.hitDy = Math.sign(dy);
}

export function startDeath(s: AnimState, now: number): void {
  if (Number.isNaN(s.diedAt)) s.diedAt = now;
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
  out.alpha = 1;
  out.flash = false;
  out.shadow = 1;
  out.done = false;
  const top = Math.max(8, meta?.top ?? 24);

  // Steps: count each one when the next starts, so the cycle continues across tiles.
  let t: number | undefined;
  if (in_.walkStart !== undefined && in_.walkMs > 0) {
    if (in_.walkStart !== s.walkStart) {
      if (!Number.isNaN(s.walkStart)) s.steps++;
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

  if (!Number.isNaN(s.diedAt)) {
    dying(meta, now - s.diedAt, out);
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

  if (meta?.flying) {
    const phase = (now + s.seed) % FLY_MS;
    const lift = FLY_PX + Math.round(FLY_PX * Math.sin((2 * Math.PI * phase) / FLY_MS));
    out.y -= lift;
    out.shadow = 1 - lift / (4 * FLY_PX + 2);
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
  if (s.flip) out.scaleX = -out.scaleX;
  return out;
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
  if (walk && walk.frames > 0) {
    out.action = "walk";
    // ANI-2: by distance, so feet do not slide when the speed changes; between chained
    // steps (t undefined, within IDLE_AFTER_MS) the last frame stays (ANI-3).
    if (t !== undefined) {
      const per = Math.max(1, walk.perTile ?? walk.frames);
      s.walkFrame = Math.floor((s.steps + t) * per) % walk.frames;
    }
    out.frame = s.walkFrame;
    return;
  }
  if (meta?.flying || t === undefined) return;
  // ANI-5: a hop per tile, the top leaning 1 px towards the move, a squash on landing.
  out.y -= Math.round(HOP_PX * Math.sin(Math.PI * t));
  if (in_.moveDx !== 0) out.skewX = -in_.moveDx * Math.asin(1 / top);
  if (t < 0.15 || t > 0.85) {
    out.scaleY = (top - 1) / top;
    out.scaleX = (top + 1) / top;
  }
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
  if (meta?.actions.walk || meta?.flying) return; // a walk clip's frame 0 stands still
  // ANI-5 breathing: 1 px taller for BREATH_MS every 1.6-2.4 s, phase by creature.
  const period = BREATH_PERIOD_MS + (s.seed % BREATH_SPREAD_MS);
  if ((now + s.seed) % period < BREATH_MS) out.scaleY = (top + 1) / top;
}

function dying(meta: AnimMeta | undefined, el: number, out: Pose): void {
  const clip = meta?.actions.death;
  out.action = "death";
  if (clip && clip.frames > 0 && clip.ms > 0) {
    const ms = clip.frames * clip.ms;
    out.frame = Math.min(clip.frames - 1, Math.floor(Math.max(0, el) / clip.ms));
    if (el > ms) out.alpha = Math.max(0, 1 - (el - ms) / DEATH_FADE_MS);
    out.done = el >= ms + DEATH_FADE_MS;
    return;
  }
  // ANI-5: a flash, then squashed to half its height against the floor while it fades.
  const t = Math.min(1, Math.max(0, el) / DEATH_MS);
  out.flash = el < HIT_FLASH_MS;
  out.scaleY = 1 - 0.5 * t;
  out.scaleX = 1 + 0.25 * t;
  out.alpha = 1 - t;
  out.done = el >= DEATH_MS;
}

/** A well-spread non-negative integer from a creature id (idle phases). */
export function hashId(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 100000;
}
