import { NO_SOUNDS } from "../audio/cues.ts";
import {
  CreatureKind,
  CreatureSchema,
  Direction,
  MapAreaSchema,
  MapFloorSchema,
  TileSchema,
  ItemStackSchema,
  ActiveConditionSchema,
  PlayerConditionsSchema,
  PlayerStatsSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { PRESENCE_GRACE_MS, WorldState } from "./world.ts";
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
  return { case: "fullMapView", value: { $typeName: "game.v1.FullMapView", area } };
}

function entered(): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: { $typeName: "game.v1.Welcome", creatureId: 7, serverTime: 0n, tickMs: 50 },
    },
    0,
  );
  w.apply(fullView(), 0);
  return w;
}

const move = (
  id: number,
  from: [number, number],
  to: [number, number],
  durationMs: number,
): Msg => ({
  case: "creatureMove",
  value: {
    $typeName: "game.v1.CreatureMove",
    id,
    from: { $typeName: "game.v1.Position", x: from[0], y: from[1], z: 7 },
    to: { $typeName: "game.v1.Position", x: to[0], y: to[1], z: 7 },
    durationMs,
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

  it("predicts one step, keeps it on confirmation and takes the server's duration", () => {
    const w = entered();
    expect(w.predictStep(Direction.EAST, 1000)).toBe(true);
    expect(w.self?.pos).toEqual({ x: 101, y: 200, z: 7 });
    expect(w.self?.walk?.duration).toBe(500); // 1000 * 100% / 200
    expect(w.canStep(1100)).toBe(false);
    w.apply(move(7, [100, 200], [101, 200], 550), 1040);
    expect(w.pending).toBeUndefined();
    expect(w.self?.walk).toMatchObject({ start: 1000, duration: 550 });
    expect(w.drawPos(w.self as CreatureState, 1275)).toEqual({ x: 100.5, y: 200 });
    expect(w.canStep(1549)).toBe(false);
    expect(w.canStep(1550)).toBe(true);
  });

  it("does not predict into blocked tiles or creatures", () => {
    const w = entered();
    expect(w.predictStep(Direction.SOUTH_EAST, 0)).toBe(false); // crate
    expect(w.self?.dir).toBe(Direction.SOUTH_EAST);
    expect(w.predictStep(Direction.NORTH, 0)).toBe(false); // unknown tile
    expect(w.pending).toBeUndefined();
  });

  it("goes back to the server's position on WalkRejected", () => {
    const w = entered();
    w.predictStep(Direction.EAST, 0);
    w.apply(
      {
        case: "walkRejected",
        value: {
          $typeName: "game.v1.WalkRejected",
          pos: { $typeName: "game.v1.Position", x: 100, y: 200, z: 7 },
          dir: Direction.EAST,
        },
      },
      30,
    );
    expect(w.pending).toBeUndefined();
    expect(w.self?.pos).toEqual({ x: 100, y: 200, z: 7 });
    expect(w.self?.walk).toBeUndefined();
    expect(w.canStep(30)).toBe(true);
  });

  it("follows the server when it moves the own creature differently", () => {
    const w = entered();
    w.predictStep(Direction.EAST, 0);
    w.apply(move(7, [100, 200], [100, 201], 500), 20);
    expect(w.pending).toBeUndefined();
    expect(w.self?.pos).toEqual({ x: 100, y: 201, z: 7 });
    expect(w.self?.dir).toBe(Direction.SOUTH);
  });

  it("interpolates other creatures by duration_ms", () => {
    const w = entered();
    w.apply(move(9, [100, 202], [101, 202], 400), 2000);
    const tom = w.creatures.get(9) as CreatureState;
    expect(tom.pos).toEqual({ x: 101, y: 202, z: 7 });
    expect(w.drawPos(tom, 2100)).toEqual({ x: 100.25, y: 202 });
    expect(w.drawPos(tom, 2400)).toEqual({ x: 101, y: 202 });
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
          options: [{ optionId: 1, text: { key: "dialog.trade", params: [] } }],
        } as never,
      }),
      0,
    );
    expect(w.dialog?.npcContentId).toBe("puerto_provisioner");
    expect(w.dialog?.options).toEqual([{ id: 1, text: "dialog.trade" }]);
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
});

describe("presence check (T4.1)", () => {
  const check = (id: number, timeoutMs: number): ServerMessage["message"] => ({
    case: "presenceCheck",
    value: {
      checkId: id,
      question: { key: "presence.question.yellow", params: [] },
      options: [{ optionId: 1, text: { key: "presence.option.yellow", params: [] } }],
      timeoutMs,
    } as never,
  });
  it("closes before its time runs out (the server sends nothing on a timeout)", () => {
    const w = new WorldState(content);
    w.apply(check(4, 600_000), 1000);
    expect(w.activePresence(500_000)?.id).toBe(4);
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
      question: { key: "presence.question.red", params: [] },
      options: [{ optionId: 1, text: { key: "presence.option.red", params: [] } }],
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
