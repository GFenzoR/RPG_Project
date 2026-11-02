import {
  CreatureKind,
  CreatureSchema,
  Direction,
  MapAreaSchema,
  MapFloorSchema,
  TileSchema,
  ItemStackSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
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
    },
    2: {
      id: "sand",
      sprite: "ground/sand",
      ground: true,
      walkable: true,
      blocks: false,
      speed: 150,
    },
    3: {
      id: "water",
      sprite: "ground/water",
      ground: true,
      walkable: false,
      blocks: false,
      speed: 100,
    },
    4: {
      id: "crate",
      sprite: "deco/crate",
      ground: false,
      walkable: false,
      blocks: true,
      speed: 100,
    },
  },
  monsterSprites: {},
  vocations: ["guardian"],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
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
