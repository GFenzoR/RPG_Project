// Where the own creature walks besides the keys (docs/17 MOV-3 and MOV-4, client/CLAUDE.md
// "Movimiento fluido"): a click's route and the mouse held on the map. Both go through the
// keyboard's step queue: each step is predicted and sent as a Walk just before the drawn
// one ends (WorldState.canStep), so the drawing never waits for the server, and the server
// validates every step and keeps the pace (readyAt, max_queued_steps). No WalkPath: the
// client plans the route, and plans it again when the server refuses a step or the way
// closes. Pure: no DOM, no clock (callers pass `now`).
import { Direction } from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { delta, samePos, step } from "./geometry.ts";
import type { Pos } from "./geometry.ts";
import { stepChoices, towardDirection } from "./motion.ts";
import { findFarPath } from "./far-path.ts";
import { findPath } from "./path.ts";
import { movesOnStep, pathPassable } from "./portals.ts";
import type { Portals } from "./portals.ts";
import type { WorldState } from "./world.ts";

/** What to send for one own step: a Walk (with its seq) or a Turn. */
export type StepChoice = NonNullable<ReturnType<WorldState["chooseStep"]>>;

/**
 * How many times one click's route is planned again (a refused step, a creature in the
 * way, the server took another step) before the client gives it up.
 */
export const ROUTE_REPLANS = 10;

/**
 * The refused step that ends a click's route: the first is planned round (a creature the
 * client did not see), the second ends it. Some refusals bring a message each (a house
 * door, a protection zone while the PvP lock lasts): a route trying tile after tile of a
 * zone it may not enter would repeat it.
 */
export const ROUTE_REFUSALS = 2;

/**
 * How long a search toward the held cursor that found no way (or a way whose first step
 * cannot be taken) is not tried again from the same tile to the same one: the mouse held
 * against a wall decides every frame (canStep stays open while the player stands), and an
 * A* over the known area each frame is waste.
 */
export const NO_WAY_MS = 250;

/** How long the mark of a click-to-walk shows (docs/17 MOV-7: a ring of 300 ms). */
export const MARK_MS = 300;

/** The mark of the last click-to-walk: where, when, and whether there is a way there. */
export interface WalkMark {
  pos: Pos;
  at: number;
  reachable: boolean;
}

/** What the steering needs of the content (ClientContent.portals and .movement). */
export interface SteerConfig {
  portals?: Portals | undefined;
  diagonalCost: number;
  maxPathTiles: number;
  /**
   * Whether a tile the client holds no map of can be walked, as far as the minimap knows
   * (explored and not coloured by something that blocks): the ground of a far route
   * (walkFar). Without it a far route only crosses the map the client holds.
   */
  farPassable?: ((x: number, y: number, z: number) => boolean) | undefined;
}

/** A far route (a click on the minimap) is planned again every this many steps. */
export const FAR_REPLAN_STEPS = 6;

/** The input of one step decision. */
export interface SteerInput {
  /** A movement key or the pad: it always wins, and ends a click's route. */
  key?: Direction | undefined;
  /**
   * The mouse held on the map: the point under the cursor, in fractional tiles of the own
   * floor (tile x spans [x, x + 1)). The camera follows the player, so a cursor held still
   * on the screen keeps pointing the same way.
   */
  toward?: { x: number; y: number } | undefined;
}

interface Route {
  goal: Pos;
  /** The steps left, the next first. */
  steps: Direction[];
  /** Where the next step starts: the client's position when it was planned or last stepped. */
  from: Pos;
  replans: number;
  /** Steps of this route the server refused (ROUTE_REFUSALS). */
  refusals: number;
  /** Tiles the server refused during this route: plans keep off them. */
  avoid: Pos[];
  /** The server refused a step: plan again before the next one. */
  stale: boolean;
  /**
   * A detour of the mouse held (the way toward the cursor was blocked): kept while the
   * cursor points this way. Undefined for a click's route.
   */
  heading?: Direction | undefined;
  /**
   * A click on the minimap (walkFar): planned over the explored tiles beyond the view,
   * and again every FAR_REPLAN_STEPS steps (sinceplan) as the map comes into view.
   */
  far?: boolean | undefined;
  sincePlan?: number | undefined;
}

/**
 * The click's route and the mouse held: decides the next own step when one can start
 * (`next`), from a key first, then the cursor, then the route.
 */
export class Steering {
  private route: Route | undefined;
  /** The last click-to-walk's mark (MOV-7), for MARK_MS. */
  mark: WalkMark | undefined;
  /** The last search toward the held cursor that found no way (NO_WAY_MS). */
  private noWay: { from: Pos; goal: Pos; at: number } | undefined;
  /** Where the own creature is drawn, written each frame of a hold (no object per frame). */
  private readonly drawn = { x: 0, y: 0 };

  constructor(private readonly cfg: SteerConfig) {}

  /** Where the click's route goes, while it lasts. */
  get goal(): Pos | undefined {
    return this.route?.heading === undefined ? this.route?.goal : undefined;
  }

  /**
   * A click to walk to `goal` (docs/17 MOV-4): plans the route from where the client has
   * the player (after the steps it already predicted, which still run) and replaces the
   * route before. No way there (or the own tile): the route ends there. Returns whether
   * there is one; the mark says it either way (not for the own tile). A click is a fresh
   * intent, like a fresh key press: a step the server refused is tried again
   * (WorldState.retryWalk), one refusal and one message a click.
   */
  walkTo(world: WorldState, goal: Pos, now: number): boolean {
    this.route = undefined;
    world.retryWalk();
    const s = world.self;
    if (!s) return false;
    if (samePos(s.pos, goal)) return false;
    const steps = this.plan(world, s.pos, goal, []);
    const reachable = steps !== undefined && steps.length > 0;
    this.mark = { pos: { ...goal }, at: now, reachable };
    if (!reachable) return false;
    this.route = {
      goal: { ...goal },
      steps,
      from: s.pos,
      replans: 0,
      refusals: 0,
      avoid: [],
      stale: false,
    };
    return true;
  }

  /** Where a click on the minimap leads, while its route lasts (the minimap's mark). */
  get farGoal(): Pos | undefined {
    return this.route?.far ? this.route.goal : undefined;
  }

  /**
   * A click on the minimap (docs/17 "Minimapa"): walks to `goal` on the own floor over
   * the map the client holds and, beyond it, the explored tiles of the minimap
   * (SteerConfig.farPassable). A goal that cannot be reached (a wall, water, unexplored)
   * becomes the reachable tile nearest to it. Every step is a predicted Walk like a
   * click's on the map, so a key, the pad, a click or the mouse held on the map, a
   * teleport or a second refusal end it the same way; cancelFar is Escape. Returns where
   * it leads, or undefined when there is nowhere nearer to go.
   */
  walkFar(world: WorldState, goal: { x: number; y: number }, now: number): Pos | undefined {
    this.route = undefined;
    world.retryWalk();
    const s = world.self;
    if (!s) return undefined;
    const to = { x: goal.x, y: goal.y, z: s.pos.z };
    const path = this.planFar(world, s.pos, to, []);
    const end = { x: path.end.x, y: path.end.y, z: s.pos.z };
    const reachable = path.steps.length > 0;
    if (!samePos(s.pos, to)) this.mark = { pos: reachable ? end : to, at: now, reachable };
    if (!reachable) return undefined;
    this.route = {
      goal: end,
      steps: path.steps,
      from: s.pos,
      replans: 0,
      refusals: 0,
      avoid: [],
      stale: false,
      far: true,
      sincePlan: 0,
    };
    return end;
  }

  /** Ends the route of a click on the minimap (Escape); whether there was one. */
  cancelFar(): boolean {
    if (!this.route?.far) return false;
    this.route = undefined;
    return true;
  }

  /** Drops the route (a double click meant its action, not walking there). */
  cancel(): void {
    this.route = undefined;
  }

  /**
   * A message of the server, after WorldState applied it: a refused step makes the route
   * plan again around that tile (the second ends it, ROUTE_REFUSALS); a teleport
   * (FullMapView) ends it.
   */
  heard(msg: ServerMessage["message"]): void {
    const r = this.route;
    if (!r) return;
    if (msg.case === "fullMapView") this.route = undefined;
    else if (msg.case === "walkRejected") {
      if (++r.refusals >= ROUTE_REFUSALS) {
        this.route = undefined;
        return;
      }
      r.stale = true;
      const at = msg.value.pos;
      if (at && msg.value.dir !== Direction.UNSPECIFIED)
        r.avoid.push(step({ x: at.x, y: at.y, z: at.z }, msg.value.dir));
    }
  }

  /**
   * The next own step, when one can start (WorldState.canStep): a key first (it ends the
   * route), else toward the held cursor, else the route's next step. Undefined: nothing to
   * send.
   */
  next(world: WorldState, now: number, input: SteerInput): StepChoice | undefined {
    if (!world.canStep(now)) return undefined;
    if (input.key !== undefined) {
      this.route = undefined;
      return world.chooseStep(input.key, now);
    }
    if (input.toward) return this.toward(world, input.toward, now);
    if (this.route?.heading !== undefined) this.route = undefined; // the hold ended
    return this.follow(world, now);
  }

  /**
   * MOV-3: one step toward the cursor, by its angle from the drawn player (8 directions);
   * a blocked diagonal slides along its free half, like a key. Never straight onto stairs,
   * a hole or a teleport on the way (the player would land on another floor): only onto
   * the tile under the cursor, like a click's route. Blocked: the first step of an A*
   * toward the tile under the cursor, kept as a detour while the cursor points the same way
   * (else, round a U of walls, the next step would walk straight back in). No way: the
   * player turns that way. Held against a wall it runs every frame: it makes no object then
   * (docs/07).
   */
  private toward(
    world: WorldState,
    at: { x: number; y: number },
    now: number,
  ): StepChoice | undefined {
    const s = world.self;
    if (!s) return undefined;
    const drawn = world.drawPos(s, now, this.drawn);
    const dir = towardDirection(at.x - drawn.x - 0.5, at.y - drawn.y - 0.5);
    if (dir === Direction.UNSPECIFIED) {
      this.route = undefined;
      return undefined;
    }
    if (this.route?.heading === dir) {
      const next = this.follow(world, now);
      if (next) return next;
    }
    this.route = undefined;
    const from = s.pos;
    const gx = Math.floor(at.x);
    const gy = Math.floor(at.y);
    for (const d of stepChoices(dir)) {
      const [dx, dy] = delta(d);
      const x = from.x + dx;
      const y = from.y + dy;
      if ((x !== gx || y !== gy) && movesOnStep(this.cfg.portals, x, y, from.z)) continue;
      const seq = world.predictStep(d, now);
      if (seq !== undefined) return { kind: "walk", dir: d, seq };
    }
    const n = this.noWay;
    if (
      n &&
      now - n.at < NO_WAY_MS &&
      samePos(n.from, from) &&
      n.goal.x === gx &&
      n.goal.y === gy &&
      n.goal.z === from.z
    )
      return world.turn(dir);
    const goal = { x: gx, y: gy, z: from.z };
    const steps = this.plan(world, from, goal, []);
    if (steps && steps.length > 0) {
      this.route = {
        goal,
        steps,
        from,
        replans: 0,
        refusals: 0,
        avoid: [],
        stale: false,
        heading: dir,
      };
      const next = this.follow(world, now);
      if (next) return next;
    }
    // No way, or its first step cannot be taken: not searched again for a while.
    this.noWay = { from, goal, at: now };
    return world.turn(dir); // the steps ahead were tried already: turn that way
  }

  /** The route's next step, planned again first if the player is off it or it closed. */
  private follow(world: WorldState, now: number): StepChoice | undefined {
    const r = this.route;
    const s = world.self;
    if (!r || !s) return undefined;
    const d = r.steps[0];
    if (r.stale || d === undefined || !samePos(s.pos, r.from) || !world.stepOpen(d)) {
      if (!this.replan(world, r, s.pos)) return undefined;
    } else if (r.far && (r.sincePlan ?? 0) >= FAR_REPLAN_STEPS) {
      // The map that came into view may say more than the minimap did (a creature, a
      // hole): look again, without spending the route's replans. No way now: it ends.
      const steps = this.planFar(world, s.pos, r.goal, r.avoid);
      if (!steps.exact || steps.steps.length === 0) {
        this.route = undefined;
        return undefined;
      }
      r.steps = steps.steps;
      r.sincePlan = 0;
    }
    const dir = r.steps[0];
    const seq = dir === undefined ? undefined : world.predictStep(dir, now);
    if (dir === undefined || seq === undefined) {
      this.route = undefined;
      return undefined;
    }
    r.steps.shift();
    if (r.far) r.sincePlan = (r.sincePlan ?? 0) + 1;
    r.from = world.self?.pos ?? r.from;
    if (r.steps.length === 0) this.route = undefined;
    return { kind: "walk", dir, seq };
  }

  /** Plans `r` again from `from`, keeping off the tiles refused; false (and no route) if none. */
  private replan(world: WorldState, r: Route, from: Pos): boolean {
    let steps: Direction[] | undefined;
    if (r.replans < ROUTE_REPLANS) {
      if (r.far) {
        const far = this.planFar(world, from, r.goal, r.avoid);
        steps = far.exact ? far.steps : undefined;
        r.sincePlan = 0;
      } else steps = this.plan(world, from, r.goal, r.avoid);
    }
    if (!steps || steps.length === 0) {
      this.route = undefined;
      return false;
    }
    r.steps = steps;
    r.from = from;
    r.replans++;
    r.stale = false;
    return true;
  }

  /**
   * A* over the free tiles the client knows, round portals but the goal (state/path.ts),
   * and off the tile of the step the server refused (WorldState.refusedStep) when planning
   * from where that step started: predictStep would not take it, so a way through it would
   * lead nowhere.
   */
  private plan(
    world: WorldState,
    from: Pos,
    goal: Pos,
    avoid: readonly Pos[],
  ): Direction[] | undefined {
    const r = world.refusedStep;
    const refused = r && samePos(r.from, from) ? r.to : undefined;
    const passable = pathPassable(
      this.cfg.portals,
      goal,
      (x, y) =>
        world.free(x, y, goal.z) &&
        !(refused && refused.x === x && refused.y === y && refused.z === goal.z) &&
        !avoid.some((a) => a.x === x && a.y === y && a.z === goal.z),
    );
    return findPath(from, goal, passable, {
      diagonalCost: this.cfg.diagonalCost,
      maxSteps: this.cfg.maxPathTiles,
    });
  }

  /**
   * The far route's plan (state/far-path.ts): the tiles the client holds count as in a
   * click's route (free, round portals but the goal, off the refused ones); the ones it
   * does not, as the minimap knows them (SteerConfig.farPassable).
   */
  private planFar(
    world: WorldState,
    from: Pos,
    goal: Pos,
    avoid: readonly Pos[],
  ): ReturnType<typeof findFarPath> {
    const z = from.z;
    const r = world.refusedStep;
    const refused = r && samePos(r.from, from) ? r.to : undefined;
    const far = this.cfg.farPassable;
    const passable = pathPassable(
      this.cfg.portals,
      { ...goal, z },
      (x, y) =>
        (world.tile(x, y, z) !== undefined ? world.free(x, y, z) : far?.(x, y, z) === true) &&
        !(refused && refused.x === x && refused.y === y && refused.z === z) &&
        !avoid.some((a) => a.x === x && a.y === y && a.z === z),
    );
    return findFarPath(from, goal, passable, { diagonalCost: this.cfg.diagonalCost });
  }
}
