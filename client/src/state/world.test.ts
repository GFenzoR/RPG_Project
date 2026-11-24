import { NO_SOUNDS } from "../audio/cues.ts";
import {
  CreatureKind,
  CreatureSchema,
  Direction,
  MapAreaSchema,
  MapFloorSchema,
  TileSchema,
  ItemStackSchema,
  MarketUpdateSchema,
  MapSliceSchema,
  MinimapIndexSchema,
  MinimapSectorSchema,
  MinimapSectorsSchema,
  ActiveConditionSchema,
  PlayerConditionsSchema,
  PlayerStatsSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { PRESENCE_GRACE_MS, WorldState } from "./world.ts";
import { PLAYOUT_MARGIN_MS, PREDICT_TIMEOUT_MS, SLIDE_MS, STEP_LEAD_MS } from "./motion.ts";
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
      id: "sand",
      sprite: "ground/sand",
      ground: true,
      walkable: true,
      blocks: false,
      speed: 150,
      stackable: false,
      slots: 0,
      useWith: false,
    },
    3: {
      id: "water",
      sprite: "ground/water",
      ground: true,
      walkable: false,
      blocks: false,
      speed: 100,
      stackable: false,
      slots: 0,
      useWith: false,
    },
    4: {
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
  vocations: ["guardian"],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

type Msg = ServerMessage["message"];
const tile = (...ids: number[]) =>
  create(TileSchema, { items: ids.map((itemId) => create(ItemStackSchema, { itemId })) });

/**
 * A 4x3 area at (100, 200) on floor 7:
 *   grass grass sand  water
 *   grass crate grass grass
 *   grass grass grass (none)
 */
function fullView(): Msg {
  const palette = [tile(1), tile(2), tile(3), tile(1, 4)];
  const tiles = [0, 0, 1, 2, 0, 3, 0, 0, 0, 0, 0, -1];
  const self = create(CreatureSchema, {
    id: 7,
    kind: CreatureKind.PLAYER,
    name: "Mira",
    pos: { x: 100, y: 200, z: 7 },
    dir: Direction.SOUTH,
    speed: 200,
  });
  const other = create(CreatureSchema, {
    id: 9,
    kind: CreatureKind.PLAYER,
    name: "Tom",
    pos: { x: 100, y: 202, z: 7 },
    speed: 200,
  });
  const area = create(MapAreaSchema, {
    x: 100,
    y: 200,
    width: 4,
    height: 3,
    palette,
    floors: [create(MapFloorSchema, { z: 7, tiles })],
    creatures: [self, other],
  });
  return { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area, walkEpoch: 1 } };
}

function entered(): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: {
        $typeName: "game.v1.Welcome",
        creatureId: 7,
        serverTime: 0n,
        tickMs: 50,
        maxQueuedSteps: 4,
        viewWidth: 31,
        viewHeight: 21,
        attackEvents: false,
      },
    },
    0,
  );
  w.apply(fullView(), 0);
  return w;
}

/** entered(), then a FullMapView of an 8x1 grass row at (100, 200) with only Mira on it. */
function inRow(): WorldState {
  const w = entered();
  const area = create(MapAreaSchema, {
    x: 100,
    y: 200,
    width: 8,
    height: 1,
    palette: [tile(1)],
    floors: [create(MapFloorSchema, { z: 7, tiles: new Array<number>(8).fill(0) })],
    creatures: [
      create(CreatureSchema, {
        id: 7,
        kind: CreatureKind.PLAYER,
        name: "Mira",
        pos: { x: 100, y: 200, z: 7 },
        dir: Direction.EAST,
        speed: 200,
      }),
    ],
  });
  w.apply(
    { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area, walkEpoch: 1 } },
    0,
  );
  return w;
}

/** Predicts `n` steps east from (100, 200), each STEP_LEAD_MS before the one drawn ends. */
function predictEast(w: WorldState, n: number): void {
  for (let i = 0; i < n; i++)
    expect(w.predictStep(Direction.EAST, i * 500 - (i > 0 ? STEP_LEAD_MS : 0))).toBe(i + 1);
}

const rejected = (dir: Direction, x = 100, y = 200, walkEpoch = 2): Msg => ({
  case: "walkRejected",
  value: {
    $typeName: "game.v1.WalkRejected",
    pos: { $typeName: "game.v1.Position", x, y, z: 7 },
    dir,
    walkEpoch,
  },
});

/** A step of creature id; walkSeq: the own Walk it executes (0: a path's, a chase's). */
const move = (
  id: number,
  from: [number, number],
  to: [number, number],
  durationMs: number,
  walkSeq = 0,
): Msg => ({
  case: "creatureMove",
  value: {
    $typeName: "game.v1.CreatureMove",
    id,
    from: { $typeName: "game.v1.Position", x: from[0], y: from[1], z: 7 },
    to: { $typeName: "game.v1.Position", x: to[0], y: to[1], z: 7 },
    durationMs,
    walkSeq,
  },
});

describe("WorldState", () => {
  it("rebuilds tiles and creatures from FullMapView", () => {
    const w = entered();
    expect(w.self?.name).toBe("Mira");
    expect(w.creatures.size).toBe(2);
    expect(w.tile(102, 200, 7)).toEqual([2]);
    expect(w.tile(103, 202, 7)).toBeUndefined();
    expect(w.walkable(101, 201, 7)).toBe(false); // crate
    expect(w.walkable(103, 200, 7)).toBe(false); // water
    expect(w.free(100, 202, 7)).toBe(false); // Tom stands there
    const chunk = w.chunk(7, 3, 6);
    expect(chunk?.ground[(200 % 32) * 32 + (100 % 32)]).toBe("1");
    expect(chunk?.items).toEqual([{ x: 101 % 32, y: 201 % 32, stack: ["4"] }]);
    // Same object until something changes, so the renderer does not rebuild the chunk.
    expect(w.chunk(7, 3, 6)).toBe(chunk);
  });

  it("takes the server's window from the Welcome (15x11 before it)", () => {
    expect(new WorldState(content).view).toEqual({ width: 15, height: 11 });
    expect(entered().view).toEqual({ width: 31, height: 21 });
  });

  it("predicts a step, keeps it on confirmation and takes the server's duration", () => {
    const w = entered();
    expect(w.predictStep(Direction.EAST, 1000)).toBe(1); // its Walk's seq
    expect(w.self?.pos).toEqual({ x: 101, y: 200, z: 7 });
    expect(w.self?.walk?.duration).toBe(500); // 1000 * 100% / 200
    expect(w.unconfirmed).toBe(1);
    expect(w.canStep(1100)).toBe(false);
    w.apply(move(7, [100, 200], [101, 200], 550, 1), 1040);
    expect(w.unconfirmed).toBe(0);
    expect(w.self?.walk).toMatchObject({ start: 1000, duration: 550 });
    expect(w.drawPos(w.self as CreatureState, 1275)).toEqual({ x: 100.5, y: 200 });
    // The next step may be decided STEP_LEAD_MS before this one ends.
    expect(w.canStep(1500 - 1)).toBe(false);
    expect(w.canStep(1550 - STEP_LEAD_MS)).toBe(true);
  });

  it("does not predict into blocked tiles or creatures; a blocked diagonal slides", () => {
    const w = entered();
    expect(w.predictStep(Direction.SOUTH_EAST, 0)).toBeUndefined(); // crate
    expect(w.predictStep(Direction.NORTH, 0)).toBeUndefined(); // unknown tile
    expect(w.self?.dir).toBe(Direction.SOUTH);
    expect(w.unconfirmed).toBe(0);
    // Nothing open: the player turns, once.
    expect(w.chooseStep(Direction.NORTH, 0)).toEqual({ kind: "turn", dir: Direction.NORTH });
    expect(w.self?.dir).toBe(Direction.NORTH);
    expect(w.chooseStep(Direction.NORTH, 0)).toBeUndefined();
    // South-east is the crate: its east half is open.
    expect(w.chooseStep(Direction.SOUTH_EAST, 0)).toEqual({
      kind: "walk",
      dir: Direction.EAST,
      seq: 1,
    });
    expect(w.self?.pos).toEqual({ x: 101, y: 200, z: 7 });
  });

  it("turns only with every step confirmed: the server's queued steps would face elsewhere", () => {
    const w = entered();
    const s = w.self as CreatureState;
    // East onto (101,200); from there north is the unknown tile: nothing open.
    expect(w.predictStep(Direction.EAST, 0)).toBe(1);
    expect(w.canStep(500 - STEP_LEAD_MS)).toBe(true);
    expect(w.chooseStep(Direction.NORTH, 500 - STEP_LEAD_MS)).toBeUndefined();
    expect(s.dir).toBe(Direction.EAST); // as the server will have it after the step
    expect(w.unconfirmed).toBe(1);
    // Confirmed: the held key turns now.
    w.apply(move(7, [100, 200], [101, 200], 500, 1), 60);
    expect(w.chooseStep(Direction.NORTH, 500)).toEqual({ kind: "turn", dir: Direction.NORTH });
    expect(s.dir).toBe(Direction.NORTH);
  });

  it("goes back to the server's position on WalkRejected, gliding, in a new walk epoch", () => {
    const w = entered();
    expect(w.walkEpoch).toBe(1); // from the FullMapView
    w.predictStep(Direction.EAST, 0);
    w.apply(rejected(Direction.EAST, 100, 200, 2), 50);
    const s = w.self as CreatureState;
    expect(w.unconfirmed).toBe(0);
    expect(w.walkEpoch).toBe(2);
    expect(s.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(s.walk).toBeUndefined();
    expect(w.canStep(50)).toBe(true);
    // It was drawn a tenth of the way east: it glides back instead of jumping.
    expect(w.drawPos(s, 50).x).toBeCloseTo(100.1);
    // Into a reused object when given (the mouse held asks every frame, docs/07).
    const out = { x: 0, y: 0 };
    expect(w.drawPos(s, 50, out)).toBe(out);
    expect(out.x).toBeCloseTo(100.1);
    expect(w.drawPos(s, 50 + SLIDE_MS / 2).x).toBeCloseTo(100.025);
    expect(w.drawPos(s, 50 + SLIDE_MS, out)).toEqual({ x: 100, y: 200 });
    expect(w.drawPos(s, 50 + SLIDE_MS)).toEqual({ x: 100, y: 200 });
  });

  it("glides back from as many tiles ahead as max_queued_steps predicts, never jumps", () => {
    const w = inRow();
    const s = w.self as CreatureState;
    predictEast(w, 4); // Welcome.max_queued_steps
    expect(w.unconfirmed).toBe(4);
    // Drawn on the fourth step, 3.8 tiles ahead, when the first one is refused.
    expect(w.drawPos(s, 1900).x).toBeCloseTo(103.8);
    w.apply(rejected(Direction.EAST), 1900);
    expect(s.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(w.drawPos(s, 1900).x).toBeCloseTo(103.8); // no jump
    expect(w.drawPos(s, 1900 + SLIDE_MS / 2).x).toBeCloseTo(100.95);
    expect(w.drawPos(s, 1900 + SLIDE_MS)).toEqual({ x: 100, y: 200 });
  });

  it("glides back when it gives up max_queued_steps steps never answered", () => {
    const w = inRow();
    const s = w.self as CreatureState;
    predictEast(w, 4);
    const now = 500 + PREDICT_TIMEOUT_MS; // the first one's end, plus the timeout
    w.expirePredicted(now);
    expect(w.unconfirmed).toBe(0);
    expect(s.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(w.drawPos(s, now).x).toBeCloseTo(104); // all four drawn: no jump back
    expect(w.drawPos(s, now + SLIDE_MS)).toEqual({ x: 100, y: 200 });
  });

  it("keeps off a refused step until retryWalk, an own move or a new view (B10)", () => {
    const w = entered();
    // East onto (101,200), say stairs with no room at their other end (portal.blocked).
    expect(w.predictStep(Direction.EAST, 0)).toBe(1);
    w.apply(rejected(Direction.EAST), 30);
    // What the click's route and the mouse held plan round (state/steering.ts).
    expect(w.refusedStep).toEqual({ from: { x: 100, y: 200, z: 7 }, to: { x: 101, y: 200, z: 7 } });
    // A held key asks on every frame: no Walk, and no Turn (it already faces east).
    expect(w.predictStep(Direction.EAST, 40)).toBeUndefined();
    expect(w.chooseStep(Direction.EAST, 40)).toBeUndefined();
    expect(w.predictStep(Direction.EAST, 5000)).toBeUndefined();
    expect(w.unconfirmed).toBe(0);
    expect(w.self?.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(w.self?.dir).toBe(Direction.EAST);
    // A fresh press (or a release, a new pad direction) tries it once more.
    w.retryWalk();
    expect(w.refusedStep).toBeUndefined();
    expect(w.predictStep(Direction.EAST, 5000)).toBe(2);
    w.apply(rejected(Direction.EAST), 5030);
    expect(w.predictStep(Direction.EAST, 5040)).toBeUndefined();
    // Only that step: south walks, and moving off and back forgets the refusal.
    expect(w.predictStep(Direction.SOUTH, 6000)).toBe(3);
    w.apply(move(7, [100, 200], [100, 201], 500, 3), 6010);
    w.apply(move(7, [100, 201], [100, 200], 500), 6600);
    expect(w.predictStep(Direction.EAST, 7200)).toBe(4);
    w.apply(rejected(Direction.EAST), 7230);
    expect(w.predictStep(Direction.EAST, 7240)).toBeUndefined();
    // A full map view (a teleport) forgets it too.
    w.apply(fullView(), 7300);
    expect(w.predictStep(Direction.EAST, 7300)).toBe(5);
    // A refusal that is not of the predicted step (of another step, elsewhere or another
    // way) leaves the next step alone.
    w.apply(rejected(Direction.NORTH), 7330);
    expect(w.predictStep(Direction.EAST, 7340)).toBe(6);
    w.apply(rejected(Direction.EAST, 100, 201), 7350);
    w.apply(move(7, [100, 201], [100, 200], 500), 7360);
    expect(w.predictStep(Direction.EAST, 8000)).toBe(7);
  });

  it("pairs each own step with its Walk: a path's step first is not the key's (click, then arrow)", () => {
    const w = entered();
    const s = w.self as CreatureState;
    // A click-to-walk path east; the server took its next step before the arrow's Walk
    // arrived. The client, which had not heard of it yet, predicted east from 100,200.
    expect(w.predictStep(Direction.EAST, 0)).toBe(1);
    // The path's step (no walk_seq), the same tiles as the prediction: not its answer.
    w.apply(move(7, [100, 200], [101, 200], 500), 20);
    expect(w.unconfirmed).toBe(1);
    expect(s.pos).toEqual({ x: 102, y: 200, z: 7 }); // the Walk goes on from 101,200
    expect(w.drawPos(s, 250).x).toBeCloseTo(100.5); // the path's step, drawn in its place
    expect(w.drawPos(s, 750).x).toBeCloseTo(101.5); // then the key's
    // The Walk's own step answers it.
    w.apply(move(7, [101, 200], [102, 200], 500, 1), 520);
    expect(w.unconfirmed).toBe(0);
    expect(s.pos).toEqual({ x: 102, y: 200, z: 7 });
  });

  it("follows the server when it moves the own creature otherwise, gliding", () => {
    const w = entered();
    const s = w.self as CreatureState;
    w.predictStep(Direction.EAST, 0);
    // A chase step south came first: the Walk east goes on from 100,201 (the server will
    // refuse it there, the crate, and say so).
    w.apply(move(7, [100, 200], [100, 201], 500), 100);
    expect(w.unconfirmed).toBe(1);
    expect(s.pos).toEqual({ x: 101, y: 201, z: 7 });
    expect(s.dir).toBe(Direction.EAST);
    // Drawn a fifth of the way east, now a fifth of the way south: it glides over.
    expect(w.drawPos(s, 100).x).toBeCloseTo(100.2);
    expect(w.drawPos(s, 100 + SLIDE_MS).x).toBeCloseTo(100);
    expect(w.drawPos(s, 100 + SLIDE_MS).y).toBeCloseTo(200 + (100 + SLIDE_MS) / 500);
  });

  it("a lost Walk: the next one's step answers it and the drawing loses that step", () => {
    const w = entered();
    const s = w.self as CreatureState;
    expect(w.predictStep(Direction.EAST, 0)).toBe(1);
    expect(w.predictStep(Direction.EAST, 460)).toBe(2);
    // Walk 1 never reached the server: Walk 2 is its first step, from 100,200.
    w.apply(move(7, [100, 200], [101, 200], 500, 2), 480);
    expect(w.unconfirmed).toBe(0);
    expect(s.pos).toEqual({ x: 101, y: 200, z: 7 });
    expect(w.drawPos(s, 480).x).toBeCloseTo(100.96); // no jump
    expect(w.drawPos(s, 600)).toEqual({ x: 101, y: 200 });
  });

  it("gives up a step the server never answers, and still takes a late answer", () => {
    const w = entered();
    const s = w.self as CreatureState;
    expect(w.predictStep(Direction.EAST, 0)).toBe(1);
    w.expirePredicted(500 + PREDICT_TIMEOUT_MS - 1);
    expect(w.unconfirmed).toBe(1);
    w.expirePredicted(500 + PREDICT_TIMEOUT_MS);
    expect(w.unconfirmed).toBe(0); // a click may walk again
    expect(s.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(w.drawPos(s, 500 + PREDICT_TIMEOUT_MS).x).toBeCloseTo(101); // gliding back
    expect(w.drawPos(s, 500 + PREDICT_TIMEOUT_MS + SLIDE_MS)).toEqual({ x: 100, y: 200 });
    // It was only late: the server's step comes through as any step of the server.
    w.apply(move(7, [100, 200], [101, 200], 500, 1), 4000);
    expect(s.pos).toEqual({ x: 101, y: 200, z: 7 });
  });

  it("interpolates other creatures by duration_ms", () => {
    const w = entered();
    w.apply(move(9, [100, 202], [101, 202], 400), 2000);
    const tom = w.creatures.get(9) as CreatureState;
    expect(tom.pos).toEqual({ x: 101, y: 202, z: 7 });
    expect(w.drawPos(tom, 2100)).toEqual({ x: 100.25, y: 202 });
    expect(w.drawPos(tom, 2400)).toEqual({ x: 101, y: 202 });
  });

  it("draws the server's steps on its tick timeline, the next after the one drawn", () => {
    const w = entered();
    // Tick 100 arrives at 5000; tick 108 (the next step, 400 ms later on the server)
    // arrives early, at 5390: it still starts when the first one ends.
    const at1 = w.batchTime(100, 5000);
    expect(at1).toBe(5000 + PLAYOUT_MARGIN_MS); // the jitter buffer
    w.apply(move(9, [100, 202], [101, 202], 400), 5000, at1);
    const tom = w.creatures.get(9) as CreatureState;
    expect(w.drawPos(tom, 5000)).toEqual({ x: 100, y: 202 }); // waits for its start
    const at2 = w.batchTime(108, 5390);
    expect(Math.abs(at2 - (at1 + 400))).toBeLessThan(5); // back to back
    w.apply(move(9, [101, 202], [102, 202], 400), 5390, at2);
    expect(tom.pos).toEqual({ x: 102, y: 202, z: 7 });
    expect(w.drawPos(tom, at2 - 10).x).toBeGreaterThan(100.95); // still the first step
    expect(w.drawPos(tom, at2 - 10).x).toBeLessThan(101);
    expect(w.facing(tom, at2 - 10)).toBe(Direction.EAST);
    expect(w.drawPos(tom, at2)).toEqual({ x: 101, y: 202 });
    expect(w.drawPos(tom, at2 + 200)).toEqual({ x: 101.5, y: 202 });
  });

  it("computes step durations like the server", () => {
    const w = entered();
    // sand 150%, speed 200, diagonal ×1.5: 1000*150*1.5/200 = 1125 → 1150 (whole ticks)
    expect(w.stepDuration({ x: 102, y: 200, z: 7 }, 200, true)).toBe(1150);
    expect(w.stepDuration({ x: 100, y: 201, z: 7 }, 220, false)).toBe(500); // 455 → 500
  });
});

describe("NPC dialogs and shops (T1.10)", () => {
  const ev = (m: ServerMessage["message"]): ServerMessage["message"] => m;
  it("opens, refreshes and closes the dialog and its shop together", () => {
    const w = new WorldState(content);
    w.apply(
      ev({
        case: "creatureAppear",
        value: {
          creature: create(CreatureSchema, {
            id: 9,
            kind: CreatureKind.NPC,
            contentId: "puerto_provisioner",
            pos: { x: 5, y: 5, z: 7 },
          }),
        } as never,
      }),
      0,
    );
    w.apply(
      ev({
        case: "dialogOpen",
        value: {
          dialogId: 3,
          npcCreatureId: 9,
          text: { key: "npc.puerto_provisioner.greet", params: [] },
          options: [
            { optionId: 1, text: { key: "dialog.trade", params: [] } },
            // A blessing says its price, which grows with the level (content audit M6).
            {
              optionId: 2,
              text: {
                key: "npc.puerto_priest.bless_shore",
                params: [{ name: "price", value: { case: "number", value: 230n } }],
              },
            },
          ],
        } as never,
      }),
      0,
    );
    expect(w.dialog?.npcContentId).toBe("puerto_provisioner");
    expect(w.dialog?.options).toEqual([
      { id: 1, text: "dialog.trade", params: [] },
      {
        id: 2,
        text: "npc.puerto_priest.bless_shore",
        params: [{ name: "price", value: { case: "number", value: 230n } }],
      },
    ]);
    w.apply(
      ev({
        case: "shopOpen",
        value: {
          npcCreatureId: 9,
          dialogId: 3,
          money: 130n,
          offers: [{ itemId: 4, buyPrice: 50n, sellPrice: 15n, owned: 2 }],
        } as never,
      }),
      0,
    );
    expect(w.shop).toEqual({
      dialogId: 3,
      npcId: 9,
      money: 130,
      lines: [{ itemId: 4, buyPrice: 50, sellPrice: 15, owned: 2 }],
    });
    w.apply(ev({ case: "dialogClose", value: { dialogId: 2 } as never }), 0);
    expect(w.dialog).toBeDefined(); // another (old) dialog
    w.apply(ev({ case: "dialogClose", value: { dialogId: 3 } as never }), 0);
    expect(w.dialog).toBeUndefined();
    expect(w.shop).toBeUndefined();
  });
});

describe("conditions (T3.2)", () => {
  const conditions = (...cs: [string, number, number][]): Msg => ({
    case: "playerConditions",
    value: create(PlayerConditionsSchema, {
      conditions: cs.map(([conditionId, remainingMs, ticks]) =>
        create(ActiveConditionSchema, { conditionId, remainingMs, ticks }),
      ),
    }),
  });

  it("replaces the list with each PlayerConditions and knows when the player is invisible", () => {
    const w = entered();
    w.apply(conditions(["poison", 4000, 3], ["invisible", 9000, 0]), 1000);
    expect(w.conditions).toEqual([
      { id: "poison", until: 5000, ticks: 3 },
      { id: "invisible", until: 10000, ticks: 0 },
    ]);
    expect(w.invisible).toBe(true);
    w.apply(conditions(), 2000);
    expect(w.conditions).toEqual([]);
    expect(w.invisible).toBe(false);
  });

  it("keeps the statuses the server adds, one with no time as one with no end", () => {
    const w = entered();
    w.apply(conditions(["in_combat", 12000, 0], ["protection_zone", 0, 0]), 1000);
    expect(w.conditions).toEqual([
      { id: "in_combat", until: 13000, ticks: 0 },
      { id: "protection_zone", until: undefined, ticks: 0 },
    ]);
  });

  it("reads remaining_ms 0 as no end only for protection_zone (docs/05)", () => {
    // Any other id with nothing left is ending now: the tray drops it, it never stays.
    const w = entered();
    w.apply(conditions(["poison", 0, 0], ["in_combat", 0, 0], ["protection_zone", 0, 0]), 1000);
    expect(w.conditions.map((c) => [c.id, c.until])).toEqual([
      ["poison", 1000],
      ["in_combat", 1000],
      ["protection_zone", undefined],
    ]);
  });

  it("walks at the speed of its PlayerStats (haste)", () => {
    const w = entered();
    const before = w.self?.speed ?? 0;
    w.apply(
      {
        case: "playerStats",
        value: create(PlayerStatsSchema, { health: 1, maxHealth: 1, speed: before * 2 }),
      },
      0,
    );
    expect(w.self?.speed).toBe(before * 2);
  });

  it("notes when a heavy hit lands, for the camera shake (docs/17 UI-9)", () => {
    const w = entered();
    const stats = (health: number, at: number): void =>
      w.apply(
        { case: "playerStats", value: create(PlayerStatsSchema, { health, maxHealth: 200 }) },
        at,
      );
    stats(200, 10); // the first stats: no hit
    expect(w.heavyHitAt).toBeUndefined();
    stats(190, 20); // 5 %: light
    expect(w.heavyHitAt).toBeUndefined();
    stats(160, 30); // 15 %: heavy
    expect(w.heavyHitAt).toBe(30);
    stats(200, 40); // a heal changes nothing
    expect(w.heavyHitAt).toBe(30);
  });
});

describe("presence check (T4.1)", () => {
  const check = (id: number, timeoutMs: number): ServerMessage["message"] => ({
    case: "presenceCheck",
    value: {
      checkId: id,
      question: {
        key: "presence.question",
        params: [{ name: "swatch", value: { case: "number", value: 0xd8c22an } }],
      },
      options: [{ optionId: 1, text: { key: "presence.option.yellow", params: [] } }],
      timeoutMs,
    } as never,
  });
  it("closes before its time runs out (the server sends nothing on a timeout)", () => {
    const w = new WorldState(content);
    w.apply(check(4, 600_000), 1000);
    expect(w.activePresence(500_000)?.id).toBe(4);
    expect(w.activePresence(500_000)?.swatch).toBe("#d8c22a");
    expect(w.activePresence(601_000 - PRESENCE_GRACE_MS)).toBeUndefined();
    expect(w.presence).toBeUndefined();
  });
  it("is sent again with the time left after an idle stretch", () => {
    const w = new WorldState(content);
    w.apply(check(4, 600_000), 0);
    expect(w.activePresence(700_000)).toBeUndefined(); // idle: the server's clock stopped
    w.apply(check(4, 300_000), 700_000); // back: the time left
    expect(w.activePresence(900_000)?.id).toBe(4);
  });
  it("shows the swatch only from a valid number param (lote 16)", () => {
    const w = new WorldState(content);
    const bad = (value: unknown): ServerMessage["message"] => ({
      case: "presenceCheck",
      value: {
        checkId: 9,
        question: { key: "presence.question", params: [{ name: "swatch", value }] },
        options: [],
        timeoutMs: 600_000,
      } as never,
    });
    w.apply(bad({ case: "text", value: "red" }), 0);
    expect(w.presence?.swatch).toBeUndefined();
    w.apply(bad({ case: "number", value: 0x1000000n }), 0);
    expect(w.presence?.swatch).toBeUndefined();
    w.apply(bad({ case: "number", value: 0x0000ffn }), 0);
    expect(w.presence?.swatch).toBe("#0000ff");
  });
  it("ignores a resend of the check it already answered", () => {
    const w = new WorldState(content);
    w.apply(check(4, 600_000), 0);
    w.answerPresence(4);
    expect(w.presence).toBeUndefined();
    w.apply(check(4, 500_000), 10); // the resend crossed the answer
    expect(w.activePresence(20)).toBeUndefined();
    w.apply(check(5, 600_000), 30); // a new check opens
    expect(w.activePresence(40)?.id).toBe(5);
  });
});

describe("presence check after an idle stretch (T4.1)", () => {
  const check = (id: number, timeoutMs: number): ServerMessage["message"] => ({
    case: "presenceCheck",
    value: {
      checkId: id,
      question: { key: "presence.question", params: [] },
      options: [{ optionId: 1, text: { key: "presence.option.white", params: [] } }],
      timeoutMs,
    } as never,
  });
  it("says when the dialog closes, so it closes without a server batch", () => {
    const w = new WorldState(content);
    expect(w.presenceClosesIn(0)).toBeUndefined();
    w.apply(check(7, 600_000), 0);
    expect(w.presenceClosesIn(100_000)).toBe(600_000 - PRESENCE_GRACE_MS - 100_000);
    expect(w.presenceClosesIn(600_000)).toBeUndefined();
  });
  it("an answer to a check gone stale on screen is final (the client sends it)", () => {
    // Away 12 min: the dialog's time ran out here, the server's clock stopped. The click
    // is sent (Game.presenceAnswer always sends) and answers the check there; the
    // server's resend crossing it is ignored.
    const w = new WorldState(content);
    w.apply(check(7, 600_000), 0);
    expect(w.activePresence(720_000)).toBeUndefined();
    w.answerPresence(7);
    w.apply(check(7, 420_000), 721_000);
    expect(w.activePresence(722_000)).toBeUndefined();
  });
});

describe("tutorial (T4.2)", () => {
  const msg = (state: number, stepId: string): ServerMessage["message"] => ({
    case: "tutorialStep",
    value: {
      state,
      stepId,
      index: 1,
      total: 7,
      text: { key: `tutorial.step.${stepId}`, params: [] },
      highlight: "inventory",
      progress: 0,
      count: 1,
    } as never,
  });
  it("follows the server's step and closes when it ends", () => {
    const w = new WorldState(content);
    expect(w.tutorial).toBeUndefined();
    w.apply(msg(1, "open_backpack"), 0);
    expect(w.tutorial?.stepId).toBe("open_backpack");
    expect(w.tutorial?.highlight).toBe("inventory");
    w.apply(msg(3, ""), 10); // SKIPPED
    expect(w.tutorial).toBeUndefined();
  });
});

describe("cosmetics (T5.7)", () => {
  it("keeps each player's equipped cosmetics and the own shop state", () => {
    const w = entered();
    expect(w.creatures.get(9)?.cosmetics).toEqual({ outfit: "", color: "", nameEffect: "" });
    expect(w.cosmetics).toBeUndefined();
    w.apply(
      {
        case: "creatureCosmetics",
        value: { id: 9, cosmetics: { outfit: "outfit_sailor", nameEffect: "name_frost" } } as never,
      },
      0,
    );
    expect(w.creatures.get(9)?.cosmetics).toEqual({
      outfit: "outfit_sailor",
      color: "",
      nameEffect: "name_frost",
    });
    w.apply(
      {
        case: "cosmeticsState",
        value: {
          owned: ["color_tide", "outfit_noble"],
          balance: 250n,
          equipped: { outfit: "outfit_noble", color: "color_tide", nameEffect: "" },
        } as never,
      },
      0,
    );
    expect(w.cosmetics).toEqual({
      owned: ["color_tide", "outfit_noble"],
      balance: 250,
      equipped: { outfit: "outfit_noble", color: "color_tide", nameEffect: "" },
    });
    // The own creature wears what CosmeticsState says.
    expect(w.self?.cosmetics.outfit).toBe("outfit_noble");
    // A creature that appears brings its look.
    w.apply(
      {
        case: "creatureAppear",
        value: {
          creature: create(CreatureSchema, {
            id: 11,
            kind: CreatureKind.PLAYER,
            name: "Ana",
            pos: { x: 101, y: 200, z: 7 },
            cosmetics: { color: "color_moss" },
          }),
        } as never,
      },
      0,
    );
    expect(w.creatures.get(11)?.cosmetics.color).toBe("color_moss");
  });
});

describe("market window (T5.3)", () => {
  const update = (open: boolean, refresh: boolean, amount: number): Msg => ({
    case: "marketUpdate",
    value: create(MarketUpdateSchema, {
      open,
      refresh,
      itemId: 68,
      sells: [{ offerId: 9n, itemId: 68, amount, price: 7n, ownerName: "Sela" }],
    }),
  });

  it("follows the refreshes the server pushes while open, and ignores them once closed", () => {
    const w = new WorldState(content);
    w.apply(update(true, false, 10), 0);
    w.apply(update(true, true, 4), 10); // another player bought 6
    expect(w.market?.sells[0]?.amount).toBe(4);
    w.market = undefined; // the player closed it (Game.marketClose)
    w.apply(update(true, true, 2), 20); // a refresh already on its way
    expect(w.market).toBeUndefined();
    w.apply(update(false, false, 0), 30); // the server closes it too
    expect(w.market).toBeUndefined();
  });
});

describe('minimap colours (docs/02 "Minimapa")', () => {
  const explore = (w: WorldState): void => {
    w.minimap.revealView(100, 200, 7, w.view.width, w.view.height);
  };
  const coloured = (w: WorldState): void => {
    expect(w.minimap.isExplored(101, 201, 7)).toBe(true);
    expect(w.minimap.item(100, 200, 7)).toBe(1); // grass
    expect(w.minimap.item(102, 200, 7)).toBe(2); // sand
    expect(w.minimap.item(101, 201, 7)).toBe(4); // the crate over its grass
    expect(w.minimap.item(103, 202, 7)).toBe(0); // no tile
  };
  it("what was explored keeps its colour after a FullMapView (stairs, a teleport, dying)", () => {
    const w = entered();
    explore(w);
    coloured(w);
    const area = create(MapAreaSchema, {
      x: 900,
      y: 900,
      width: 1,
      height: 1,
      palette: [tile(2)],
      floors: [create(MapFloorSchema, { z: 8, tiles: [0] })],
      creatures: [
        create(CreatureSchema, {
          id: 7,
          kind: CreatureKind.PLAYER,
          name: "Mira",
          pos: { x: 900, y: 900, z: 8 },
          speed: 200,
        }),
      ],
    });
    w.apply(
      { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area, walkEpoch: 2 } },
      0,
    );
    expect(w.tile(101, 201, 7)).toBeUndefined(); // the map itself is gone
    coloured(w);
    expect(w.minimap.item(900, 900, 8)).toBe(2);
  });
  it("the login's first view keeps its colours: the MinimapIndex comes after it", () => {
    const w = entered();
    w.apply({ case: "minimapIndex", value: create(MinimapIndexSchema, { floors: [] }) }, 0);
    explore(w);
    coloured(w);
  });
  it("and after walking away from it (prune)", () => {
    const w = entered();
    explore(w);
    // Mira is now 300 tiles east; the next slice forgets the chunks far from her.
    const far = create(MapAreaSchema, {
      x: 400,
      y: 200,
      width: 1,
      height: 1,
      palette: [tile(1)],
      floors: [create(MapFloorSchema, { z: 7, tiles: [0] })],
      creatures: [
        create(CreatureSchema, {
          id: 7,
          kind: CreatureKind.PLAYER,
          name: "Mira",
          pos: { x: 400, y: 200, z: 7 },
          speed: 200,
        }),
      ],
    });
    w.apply({ case: "mapSlice", value: create(MapSliceSchema, { area: far }) }, 0);
    expect(w.self?.pos.x).toBe(400);
    expect(w.tile(101, 201, 7)).toBeUndefined();
    coloured(w);
  });
  it("a tile update in view changes the remembered colour (a door, a felled tree)", () => {
    const w = entered();
    w.apply(
      {
        case: "tileUpdate",
        value: {
          $typeName: "game.v1.TileUpdate",
          pos: { $typeName: "game.v1.Position", x: 101, y: 201, z: 7 },
          tile: tile(1),
        },
      },
      0,
    );
    expect(w.minimap.item(101, 201, 7)).toBe(1);
  });
  it("only an answer stops the asking: MinimapSectors.answer reaches the state", () => {
    const w = entered();
    const sectors = [
      create(MinimapSectorSchema, { z: 7, sector: 5, explored: new Uint8Array(128).fill(1) }),
    ];
    w.apply({ case: "minimapSectors", value: create(MinimapSectorsSchema, { sectors }) }, 0);
    expect(w.minimap.wanted(7, 0, 160, 31, 191, 0)).toEqual([5]);
    w.apply(
      { case: "minimapSectors", value: create(MinimapSectorsSchema, { sectors, answer: true }) },
      0,
    );
    expect(w.minimap.wanted(7, 0, 160, 31, 191, 1e9)).toEqual([]);
  });
});
