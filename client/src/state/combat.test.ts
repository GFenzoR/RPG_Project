import {
  CreatureKind,
  CreatureSchema,
  FloatingTextKind,
  FloatingTextSchema,
  ItemStackSchema,
  MessageKind,
  MessageSchema,
  TextParamSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatMessage } from "./messages.ts";
import { FLOATING_TEXT_MS, WorldState } from "./world.ts";

type Msg = ServerMessage["message"];

const content: ClientContent = {
  items: {
    8: {
      id: "copper_coin",
      sprite: "",
      ground: false,
      walkable: false,
      blocks: false,
      speed: 100,
      stackable: false,
      slots: 0,
    },
  },
  monsterSprites: {},
  vocations: [],
  spells: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  i18n: {},
};

const t = translator({
  "combat.loot": "Loot of {monster}: {items}.",
  "monster.wolf.name": "wolf",
  "item.copper_coin.name": "copper coin",
  "client.log.item_count": "{count} {name}",
});

function world(): WorldState {
  const w = new WorldState(content);
  w.apply(
    {
      case: "welcome",
      value: { $typeName: "game.v1.Welcome", creatureId: 1, serverTime: 0n, tickMs: 50 },
    },
    0,
  );
  const mk = (id: number, x: number, kind: CreatureKind, contentId = "") =>
    create(CreatureSchema, { id, kind, contentId, pos: { x, y: 10, z: 7 }, healthPercent: 100 });
  w.apply(
    {
      case: "fullMapView",
      value: {
        $typeName: "game.v1.FullMapView",
        area: {
          $typeName: "game.v1.MapArea",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          palette: [],
          floors: [],
          creatures: [
            mk(1, 10, CreatureKind.PLAYER),
            mk(5, 14, CreatureKind.MONSTER, "wolf"),
            mk(6, 11, CreatureKind.MONSTER, "wolf"),
          ],
        },
      },
    },
    0,
  );
  return w;
}

describe("combat state", () => {
  it("lists the battle closest first and drops a target that disappears", () => {
    const w = world();
    expect(w.battleList().map((c) => c.id)).toEqual([6, 5]);
    w.target = 6;
    w.apply(
      {
        case: "creatureHealth",
        value: { $typeName: "game.v1.CreatureHealth", id: 6, healthPercent: 40 },
      },
      0,
    );
    expect(w.creatures.get(6)?.health).toBe(40);
    w.apply(
      { case: "creatureDisappear", value: { $typeName: "game.v1.CreatureDisappear", id: 6 } },
      0,
    );
    expect(w.target).toBeUndefined();
    expect(w.battleList().map((c) => c.id)).toEqual([5]);
  });

  it("keeps floating texts for their lifetime", () => {
    const w = world();
    const ft: Msg = {
      case: "floatingText",
      value: create(FloatingTextSchema, {
        pos: { x: 11, y: 10, z: 7 },
        kind: FloatingTextKind.DAMAGE,
        amount: 7n,
      }),
    };
    w.apply(ft, 100);
    w.expire(100 + FLOATING_TEXT_MS - 1);
    expect(w.floatingTexts).toHaveLength(1);
    expect(w.floatingTexts[0]?.amount).toBe(7);
    w.expire(100 + FLOATING_TEXT_MS);
    expect(w.floatingTexts).toHaveLength(0);
  });

  it("clears the target the server refused and logs the loot", () => {
    const w = world();
    w.target = 5;
    const sys = (
      key: string,
      params = [] as ReturnType<typeof create<typeof TextParamSchema>>[],
    ): Msg => ({
      case: "chatMessage",
      value: create(MessageSchema, {
        kind: MessageKind.SYSTEM,
        body: { case: "localized", value: { key, params } },
      }),
    });
    w.apply(sys("combat.cannot_attack"), 0);
    expect(w.target).toBeUndefined();
    w.apply(
      sys("combat.loot", [
        create(TextParamSchema, { name: "monster", value: { case: "contentId", value: "wolf" } }),
        create(TextParamSchema, {
          name: "item",
          value: { case: "item", value: create(ItemStackSchema, { itemId: 8, count: 3 }) },
        }),
      ]),
      1,
    );
    const last = w.log[w.log.length - 1];
    if (!last) throw new Error("no log");
    expect(formatMessage(last, content, t)).toBe("Loot of wolf: 3 copper coin.");
  });
});
