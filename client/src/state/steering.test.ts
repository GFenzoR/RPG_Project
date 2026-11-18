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
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { PREDICT_TIMEOUT_MS, STEP_LEAD_MS } from "./motion.ts";
import { NO_WAY_MS, ROUTE_REFUSALS, ROUTE_REPLANS, Steering } from "./steering.ts";
import type { StepChoice } from "./steering.ts";
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
    2: {
      id: "crate",
      sprite: "deco/crate",
      ground: false,
      walkable: false,
      blocks: true,
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

const SELF = 7;
const X0 = 100;
const Y0 = 200;
/** One step at speed 200 on grass. */
const STEP = 500;

/**
 * A world from rows of text ('.' grass, '#' a crate, '@' the player on grass, 'm' a monster
 * on grass), its top-left tile at (X0, Y0).
 */
function world(rows: string[]): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: {
        $typeName: "game.v1.Welcome",
        creatureId: SELF,
        serverTime: 0n,
        tickMs: 50,
        maxQueuedSteps: 4,
        viewWidth: 31,
        viewHeight: 21,
      },
    },
    0,
  );
  const width = rows[0]?.length ?? 0;
  const tiles: number[] = [];
  const creatures = [];
  let id = 100;
  for (const [y, row] of rows.entries())
    for (const [x, c] of [...row].entries()) {
      tiles.push(c === "#" ? 1 : 0);
      const pos = { x: X0 + x, y: Y0 + y, z: 7 };
      if (c === "@")
        creatures.push(
          create(CreatureSchema, {
            id: SELF,
            kind: CreatureKind.PLAYER,
            name: "me",
            pos,
            speed: 200,
          }),
        );
      if (c === "m")
        creatures.push(
          create(CreatureSchema, {
            id: id++,
            kind: CreatureKind.MONSTER,
            name: "m",
            pos,
            speed: 100,
          }),
        );
    }
  const area = create(MapAreaSchema, {
    x: X0,
    y: Y0,
    width,
    height: rows.length,
    palette: [
      create(TileSchema, { items: [create(ItemStackSchema, { itemId: 1 })] }),
      create(TileSchema, {
        items: [create(ItemStackSchema, { itemId: 1 }), create(ItemStackSchema, { itemId: 2 })],
      }),
    ],
    floors: [create(MapFloorSchema, { z: 7, tiles })],
    creatures,
  });
  w.apply(
    { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area, walkEpoch: 1 } },
    0,
  );
  return w;
}

const steer = () => new Steering({ diagonalCost: 1.5, maxPathTiles: 100 });
const self = (w: WorldState) => w.self as CreatureState;
const at = (x: number, y: number) => ({ x: X0 + x, y: Y0 + y, z: 7 });
const pos = (x: number, y: number) => ({ $typeName: "game.v1.Position" as const, x, y, z: 7 });

/** The server takes the oldest predicted step (its CreatureMove with the Walk's seq). */
function confirm(w: WorldState, now: number): void {
  const p = w.predicted[0];
  if (!p) throw new Error("nothing predicted");
  w.apply(
    {
      case: "creatureMove",
      value: {
        $typeName: "game.v1.CreatureMove",
        id: SELF,
        from: pos(p.from.x, p.from.y),
        to: pos(p.to.x, p.to.y),
        durationMs: p.walk.duration,
        walkSeq: p.seq,
      },
    },
    now,
  );
}

/**
 * Runs the steering every 10 ms from `t0` to `t1` like game.ts `frame`, the server
 * confirming each step 100 ms after it was sent; returns the directions sent.
 */
function run(
  w: WorldState,
  s: Steering,
  t0: number,
  t1: number,
  input: (t: number) => Parameters<Steering["next"]>[2] = () => ({}),
): Direction[] {
  const sent: Direction[] = [];
  const due: number[] = [];
  for (let t = t0; t <= t1; t += 10) {
    while (due[0] !== undefined && due[0] <= t) {
      due.shift();
      confirm(w, t);
    }
    const c = s.next(w, t, input(t));
    if (c?.kind === "walk") {
      sent.push(c.dir);
      due.push(t + 100);
    }
  }
  return sent;
}

describe("Steering: click-to-walk, predicted (docs/17 MOV-4)", () => {
  it("plans from where the client has the player and takes the first step at once", () => {
    const w = world(["@......."]);
    const s = steer();
    expect(s.walkTo(w, at(5, 0), 1000)).toBe(true);
    expect(s.mark).toEqual({ pos: at(5, 0), at: 1000, reachable: true });
    expect(s.goal).toEqual(at(5, 0));
    // The same frame: the first step is predicted and drawn from now, not after a round trip.
    expect(s.next(w, 1000, {})).toEqual({ kind: "walk", dir: Direction.EAST, seq: 1 });
    expect(self(w).walk).toMatchObject({ start: 1000, duration: STEP });
    // The next one waits until the drawn step is about to end, like a held key.
    expect(s.next(w, 1000 + STEP - STEP_LEAD_MS - 10, {})).toBeUndefined();
    expect(s.next(w, 1000 + STEP - STEP_LEAD_MS, {})?.kind).toBe("walk");
    expect(self(w).walk).toMatchObject({ start: 1000 + STEP }); // right after the first
  });

  it("walks the whole route as Walks, one step a step, and ends there", () => {
    const w = world(["@......", "...#...", "......."]);
    const s = steer();
    s.walkTo(w, at(6, 1), 0);
    const sent = run(w, s, 0, 5000);
    expect(sent.length).toBeGreaterThan(5);
    expect(self(w).pos).toEqual(at(6, 1));
    expect(s.goal).toBeUndefined();
    expect(w.unconfirmed).toBe(0);
  });

  it("starts after the steps already predicted: a click while walking does not wait", () => {
    const w = world(["@......."]);
    const s = steer();
    expect(w.chooseStep(Direction.EAST, 0)?.kind).toBe("walk"); // a key step, unconfirmed
    s.walkTo(w, at(4, 0), 100);
    expect(s.next(w, 100, {})).toBeUndefined(); // the key's step is still drawn
    expect(s.next(w, STEP - STEP_LEAD_MS, {})).toMatchObject({ kind: "walk", dir: Direction.EAST });
    expect(self(w).pos).toEqual(at(2, 0));
    expect(w.unconfirmed).toBe(2);
  });

  it("a key ends the route; a click on the own tile or with no way stops it", () => {
    const w = world(["@.....", "......", "###..."]);
    const s = steer();
    s.walkTo(w, at(5, 0), 0);
    expect(s.next(w, 0, { key: Direction.SOUTH })).toMatchObject({ dir: Direction.SOUTH });
    expect(s.goal).toBeUndefined();
    expect(s.walkTo(w, at(5, 0), 0)).toBe(true);
    expect(s.walkTo(w, at(0, 2), 600)).toBe(false); // a crate
    expect(s.mark).toMatchObject({ pos: at(0, 2), reachable: false });
    expect(s.goal).toBeUndefined();
    expect(s.walkTo(w, self(w).pos, 700)).toBe(false);
    expect(s.mark).toMatchObject({ pos: at(0, 2) }); // no mark on the own tile
  });

  it("goes round a creature that steps into the way", () => {
    const w = world(["@.....", "......"]);
    const s = steer();
    s.walkTo(w, at(5, 0), 0);
    expect(s.next(w, 0, {})).toMatchObject({ dir: Direction.EAST });
    // A monster walks onto the next tile of the route.
    w.apply(
      {
        case: "creatureAppear",
        value: {
          $typeName: "game.v1.CreatureAppear",
          creature: create(CreatureSchema, {
            id: 55,
            kind: CreatureKind.MONSTER,
            name: "m",
            pos: { x: X0 + 2, y: Y0, z: 7 },
            speed: 100,
          }),
        },
      },
      100,
    );
    // Round it (a path never cuts the corner of a blocked tile): south first.
    const c = s.next(w, STEP - STEP_LEAD_MS, {});
    expect(c).toMatchObject({ kind: "walk", dir: Direction.SOUTH });
    expect(s.goal).toEqual(at(5, 0));
  });

  it("plans again round a step the server refused; the second refusal ends it", () => {
    const w = world(["@.....", "......"]);
    const s = steer();
    s.walkTo(w, at(5, 0), 0);
    expect(s.next(w, 0, {})).toMatchObject({ dir: Direction.EAST });
    expect(s.next(w, STEP - STEP_LEAD_MS, {})).toMatchObject({ dir: Direction.EAST });
    // An invisible creature on (2, 0): the second step is refused, the first was taken.
    confirm(w, 300);
    const refusal = {
      case: "walkRejected" as const,
      value: {
        $typeName: "game.v1.WalkRejected" as const,
        pos: pos(X0 + 1, Y0),
        dir: Direction.EAST,
        walkEpoch: 2,
      },
    };
    w.apply(refusal, 600);
    s.heard(refusal);
    expect(self(w).pos).toEqual(at(1, 0));
    const c = s.next(w, 700, {});
    expect(c).toMatchObject({ kind: "walk", dir: Direction.SOUTH });
    expect(s.goal).toEqual(at(5, 0));
    // Refused again (a protection zone while the PvP lock lasts, each refusal with its
    // message): the route ends there instead of trying tile after tile.
    expect(ROUTE_REFUSALS).toBe(2);
    const again = {
      case: "walkRejected" as const,
      value: { ...refusal.value, dir: Direction.SOUTH, walkEpoch: 3 },
    };
    w.apply(again, 900);
    s.heard(again);
    expect(s.goal).toBeUndefined();
    expect(s.next(w, 1000, {})).toBeUndefined();
  });

  it("gives up after ROUTE_REPLANS, so a route never asks forever", () => {
    // Every step it sends is lost (no answer): the client gives the prediction up and the
    // player is back off the route, which is planned again each time.
    const w = world(["@.........."]);
    const s = steer();
    s.walkTo(w, at(10, 0), 0);
    let sent = 0;
    let t = 0;
    for (let k = 0; k <= ROUTE_REPLANS + 1 && s.goal; k++) {
      if (s.next(w, t, {})?.kind !== "walk") break;
      sent++;
      t += STEP + PREDICT_TIMEOUT_MS + 10;
      w.expirePredicted(t);
      expect(self(w).pos).toEqual(at(0, 0));
    }
    expect(s.goal).toBeUndefined();
    expect(sent).toBe(ROUTE_REPLANS + 1); // the first plan and its replans
  });

  it("is dropped by a teleport", () => {
    const w = world(["@....."]);
    const s = steer();
    s.walkTo(w, at(5, 0), 0);
    s.heard({
      case: "fullMapView",
      value: { $typeName: "game.v1.FullMapView", walkEpoch: 3 },
    });
    expect(s.goal).toBeUndefined();
  });
});

describe("Steering: the mouse held on the map (docs/17 MOV-3)", () => {
  /** A cursor held still on the screen: `dx`, `dy` tiles from the drawn player's centre. */
  const cursor =
    (w: WorldState, dx: number, dy: number) =>
    (t: number): { toward: { x: number; y: number } } => {
      const d = w.drawPos(self(w), t);
      return { toward: { x: d.x + 0.5 + dx, y: d.y + 0.5 + dy } };
    };

  it("walks toward the cursor, tile after tile, while held", () => {
    const w = world(["@.........", "..........", ".........."]);
    const s = steer();
    const sent = run(w, s, 0, 2000, cursor(w, 3, 0.4));
    expect(sent).toEqual(new Array<Direction>(5).fill(Direction.EAST));
    // Down and to the right: the diagonal.
    const v = world(["@.........", "..........", ".........."]);
    expect(run(v, steer(), 0, 800, cursor(v, 2, 1.5))).toEqual([
      Direction.SOUTH_EAST,
      Direction.SOUTH_EAST,
    ]);
  });

  it("does nothing while the cursor is on the player, and ends a click's route", () => {
    const w = world(["@....."]);
    const s = steer();
    s.walkTo(w, at(5, 0), 0);
    expect(s.next(w, 0, cursor(w, 0.2, -0.3)(0))).toBeUndefined();
    expect(s.goal).toBeUndefined();
  });

  it("slides along a wall, and goes round a block without walking back into it", () => {
    // North-east with a wall to the north: east, along it.
    const w = world(["######", "@.....", "......"]);
    expect(run(w, steer(), 0, 900, cursor(w, 3, -3))).toEqual([Direction.EAST, Direction.EAST]);
    // A U of crates open to the west, the cursor east of it: the way out and round, not in
    // and out again.
    const u = world(["........", ".####...", "..@#....", ".####...", "........"]);
    const s = steer();
    const sent = run(u, s, 0, 6000, cursor(u, 3, 0));
    expect(sent.length).toBeGreaterThan(5);
    expect(self(u).pos.x).toBeGreaterThan(X0 + 3); // got past the U
    let back = 0;
    for (let i = 1; i < sent.length; i++)
      if (sent[i] === Direction.WEST && sent[i - 1] === Direction.EAST) back++;
    expect(back).toBe(0);
  });

  it("does not search again every frame while held toward a tile out of reach", () => {
    // Walled in with the tile below; the cursor on the free ground past the wall.
    const w = world(["#####", "#@#..", "#.#..", "###.."]);
    const s = steer();
    let looks = 0;
    const free = w.free.bind(w);
    w.free = (x, y, z) => {
      looks++;
      return free(x, y, z);
    };
    const held = cursor(w, 3, 0);
    s.next(w, 0, held(0));
    const search = looks; // the step ahead, the A* over the pocket, the turn
    expect(search).toBeGreaterThan(8);
    let frames = 0;
    for (let t = 10; t < NO_WAY_MS; t += 10, frames++) s.next(w, t, held(t));
    // Each frame only tries the step ahead and the turn: no A* again.
    expect(looks - search).toBeLessThanOrEqual(2 * frames);
    const before = looks;
    s.next(w, NO_WAY_MS + 10, held(NO_WAY_MS + 10));
    expect(looks - before).toBe(search); // after NO_WAY_MS it searches again
  });

  it("turns toward the cursor when no way leads there", () => {
    // A crate to the north and nothing known past it (a player faces south on arrival).
    const w = world(["###", "#@#", "#.#"]);
    const s = steer();
    const c: StepChoice | undefined = s.next(w, 0, cursor(w, 0, -2)(0));
    expect(c).toEqual({ kind: "turn", dir: Direction.NORTH });
  });

  it("a key wins over the held mouse", () => {
    const w = world(["......", "@.....", "......"]);
    const s = steer();
    expect(s.next(w, 0, { key: Direction.NORTH, ...cursor(w, 3, 0)(0) })).toMatchObject({
      dir: Direction.NORTH,
    });
  });
});
