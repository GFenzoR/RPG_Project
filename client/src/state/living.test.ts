// The living world in the client state (livingworld/README.md): the events wait for the
// canvas, and a key into a pushable object finds it.
import {
  CreatureKind,
  CreatureSchema,
  Direction,
  ItemStackSchema,
  LivingObjectEventSchema,
  LivingObjectKind,
  MapAreaSchema,
  MapFloorSchema,
  TileSchema,
  create,
} from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { NO_SOUNDS } from "../audio/cues.ts";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { WorldState } from "./world.ts";

const item = (id: string, extra: Partial<ItemDef>): ItemDef => ({
  id,
  sprite: `livingworld/${id}`,
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
  ...extra,
});

const content: ClientContent = {
  items: {
    1: item("grass", { ground: true, walkable: true }),
    2: item("mossy_boulder", { blocks: true, living: "pushable", livingEffect: "stone" }),
    3: item("weathered_crate", { blocks: true, living: "breakable", livingEffect: "wood" }),
  },
  monsterSprites: {},
  vocations: ["guardian"],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.414, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

const tile = (...ids: number[]) =>
  create(TileSchema, { items: ids.map((itemId) => create(ItemStackSchema, { itemId })) });

/** A 3x2 area at (100, 200): Mira at 100,200; a boulder east, a crate south. */
function world(): WorldState {
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
        attackEvents: true,
      },
    },
    0,
  );
  const area = create(MapAreaSchema, {
    x: 100,
    y: 200,
    width: 3,
    height: 2,
    palette: [tile(1), tile(1, 2), tile(1, 3)],
    floors: [create(MapFloorSchema, { z: 7, tiles: [0, 1, 0, 2, 0, 0] })],
    creatures: [
      create(CreatureSchema, {
        id: 7,
        kind: CreatureKind.PLAYER,
        name: "Mira",
        pos: { x: 100, y: 200, z: 7 },
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

describe("living world state", () => {
  it("finds the pushable object a straight step walks into", () => {
    const w = world();
    expect(w.pushableAhead(Direction.EAST)).toEqual({ x: 101, y: 200, z: 7 });
    expect(w.pushableAhead(Direction.SOUTH)).toBeUndefined(); // a crate breaks, it is not pushed
    expect(w.pushableAhead(Direction.SOUTH_EAST)).toBeUndefined(); // never diagonally
    expect(w.walkable(101, 200, 7)).toBe(false);
  });

  it("follows the object when a tile update moves it", () => {
    const w = world();
    w.apply(
      {
        case: "tileUpdate",
        value: {
          $typeName: "game.v1.TileUpdate",
          pos: { $typeName: "game.v1.Position", x: 101, y: 200, z: 7 },
          tile: tile(1),
        },
      },
      5,
    );
    expect(w.pushableAhead(Direction.EAST)).toBeUndefined();
    expect(w.walkable(101, 200, 7)).toBe(true);
  });

  it("keeps the events for the canvas, once, and at most a bounded queue", () => {
    const w = world();
    const ev = create(LivingObjectEventSchema, {
      kind: LivingObjectKind.BREAK,
      pos: { x: 100, y: 201, z: 7 },
      itemId: 3,
      effect: "wood",
    });
    w.apply({ case: "livingObject", value: ev }, 10);
    const got = w.takeLiving();
    expect(got).toHaveLength(1);
    expect(got[0]?.at).toBe(10);
    expect(w.takeLiving()).toHaveLength(0);
    for (let i = 0; i < 200; i++) w.apply({ case: "livingObject", value: ev }, i);
    expect(w.takeLiving().length).toBeLessThanOrEqual(64);
  });
});
