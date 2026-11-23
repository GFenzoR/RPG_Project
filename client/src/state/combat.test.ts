import { NO_SOUNDS } from "../audio/cues.ts";
import {
  AttackKind,
  CreatureAppearSchema,
  CreatureAttackSchema,
  CreatureDisappearSchema,
  CreatureKind,
  CreatureSchema,
  DisappearReason,
  EffectSchema,
  FloatingTextKind,
  FloatingTextSchema,
  ItemStackSchema,
  MapSliceSchema,
  MessageKind,
  MessageSchema,
  ProjectileSchema,
  TextParamSchema,
  WelcomeSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatMessage } from "./messages.ts";
import {
  ATTACK_MS,
  DEPARTURE_MS,
  EFFECT_MS,
  FLOATING_TEXT_MS,
  PROJECTILE_MS,
  WorldState,
} from "./world.ts";

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
      value: {
        $typeName: "game.v1.Welcome",
        creatureId: 1,
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
  const mk = (id: number, x: number, kind: CreatureKind, contentId = "") =>
    create(CreatureSchema, { id, kind, contentId, pos: { x, y: 10, z: 7 }, healthPercent: 100 });
  w.apply(
    {
      case: "fullMapView",
      value: {
        $typeName: "game.v1.FullMapView",
        walkEpoch: 1,
        area: {
          $typeName: "game.v1.MapArea",
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          palette: [],
          floors: [],
          wear: [],
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
  it("keeps the server's attacks and why creatures left, for the canvas (A9)", () => {
    const w = world();
    expect(w.attackEvents).toBe(false); // an older server: the canvas guesses
    w.apply(
      { case: "welcome", value: create(WelcomeSchema, { creatureId: 1, attackEvents: true }) },
      0,
    );
    expect(w.attackEvents).toBe(true);
    w.apply(
      {
        case: "creatureAttack",
        value: create(CreatureAttackSchema, {
          id: 5,
          kind: AttackKind.MELEE,
          targetId: 1,
          to: { x: 10, y: 10, z: 7 },
        }),
      },
      100,
    );
    expect(w.attacks).toEqual([
      {
        id: 5,
        kind: AttackKind.MELEE,
        targetId: 1,
        to: { x: 10, y: 10, z: 7 },
        radius: 0,
        start: 100,
      },
    ]);
    w.apply(
      {
        case: "creatureDisappear",
        value: create(CreatureDisappearSchema, { id: 6, reason: DisappearReason.DEATH }),
      },
      200,
    );
    w.apply(
      {
        case: "creatureDisappear",
        value: create(CreatureDisappearSchema, { id: 5, reason: DisappearReason.OUT_OF_VIEW }),
      },
      200,
    );
    expect(w.creatures.has(6)).toBe(false);
    expect(w.departureOf(6)).toBe(DisappearReason.DEATH);
    expect(w.departureOf(5)).toBe(DisappearReason.OUT_OF_VIEW);
    expect(w.departureOf(1)).toBeUndefined();
    w.expire(100 + ATTACK_MS);
    expect(w.attacks).toEqual([]);
    expect(w.departureOf(6)).toBe(DisappearReason.DEATH);
    w.expire(200 + DEPARTURE_MS);
    expect(w.departureOf(6)).toBeUndefined();
  });

  it("forgets why a creature left once it comes back, but keeps that it left (A9)", () => {
    const w = world();
    const died = create(CreatureDisappearSchema, { id: 6, reason: DisappearReason.DEATH });
    const back = create(CreatureSchema, {
      id: 6,
      kind: CreatureKind.PLAYER,
      name: "Back",
      pos: { x: 12, y: 10, z: 7 },
      healthPercent: 100,
    });
    // A player dies and wakes up in view in the same batch: leaving the drawn floor a
    // moment later is not a death.
    w.apply({ case: "creatureDisappear", value: died }, 100);
    w.apply({ case: "creatureDisappear", value: create(CreatureDisappearSchema, { id: 5 }) }, 100);
    w.apply(
      { case: "creatureAppear", value: create(CreatureAppearSchema, { creature: back }) },
      100,
    );
    expect(w.creatures.has(6)).toBe(true);
    expect(w.departureOf(6)).toBeUndefined();
    expect(w.departureOf(5)).toBe(DisappearReason.UNSPECIFIED); // the others stay
    // The canvas still sees that it died there, to leave the falling body at that spot.
    expect(w.departures).toContainEqual({
      id: 6,
      reason: DisappearReason.DEATH,
      start: 100,
      back: true,
    });
    // A creature back through a map area (a FullMapView after a teleport) too.
    w.apply({ case: "creatureDisappear", value: died }, 200);
    w.apply(
      { case: "mapSlice", value: create(MapSliceSchema, { area: { creatures: [back] } }) },
      200,
    );
    expect(w.creatures.has(6)).toBe(true);
    expect(w.departureOf(6)).toBeUndefined();
  });

  it("keeps no more than what is still live when no frame expires it (a hidden tab)", () => {
    const w = world();
    const at = { x: 10, y: 10, z: 7 };
    const batch: Msg[] = [
      {
        case: "creatureAttack",
        value: create(CreatureAttackSchema, { id: 5, kind: AttackKind.MELEE, targetId: 1, to: at }),
      },
      {
        case: "creatureDisappear",
        value: create(CreatureDisappearSchema, { id: 7, reason: DisappearReason.OUT_OF_VIEW }),
      },
      { case: "effect", value: create(EffectSchema, { pos: at, effectId: 1 }) },
      {
        case: "floatingText",
        value: create(FloatingTextSchema, { pos: at, kind: FloatingTextKind.DAMAGE, amount: 3n }),
      },
      {
        case: "projectile",
        value: create(ProjectileSchema, { from: at, to: at, projectileId: 1 }),
      },
    ];
    // Ten batches a second for a minute without a frame: the canvas never calls expire
    // (no requestAnimationFrame in a tab in the background).
    const step = 100;
    let last = 0;
    for (let now = step; now <= 60_000; now += step) {
      for (const m of batch) w.apply(m, now);
      last = now;
    }
    const live = (ms: number): number => Math.ceil(ms / step);
    expect(w.attacks.length).toBeLessThanOrEqual(live(ATTACK_MS));
    expect(w.departures.length).toBeLessThanOrEqual(live(DEPARTURE_MS));
    expect(w.effects.length).toBeLessThanOrEqual(live(EFFECT_MS));
    expect(w.floatingTexts.length).toBeLessThanOrEqual(live(FLOATING_TEXT_MS));
    expect(w.projectiles.length).toBeLessThanOrEqual(live(PROJECTILE_MS));
    // What is still live stays, in order.
    expect(w.attacks.at(-1)?.start).toBe(last);
    expect(w.departureOf(7)).toBe(DisappearReason.OUT_OF_VIEW);
    expect(w.projectiles.at(-1)?.start).toBe(last);
  });

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
      {
        case: "creatureDisappear",
        value: { $typeName: "game.v1.CreatureDisappear", id: 6, reason: 0 },
      },
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
    // T5.2: a refused attack on a player drops the target too.
    for (const key of ["pvp.zone", "pvp.safe_mode", "pvp.their_level"]) {
      w.target = 9;
      w.apply(sys(key), 0);
      expect(w.target).toBeUndefined();
    }
    w.target = 9;
    w.apply(sys("pvp.safe_off"), 0);
    expect(w.target).toBe(9);
    w.target = undefined;
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
