// What a creature looks like, as the server says (docs/05 "Apariencia y equipo visible").
import {
  BodyLookSchema,
  CreatureKind,
  CreatureLookSchema,
  CreatureSchema,
  MapAreaSchema,
  VisibleEquipmentSchema,
  WornPieceSchema,
  WornSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { NO_EQUIPMENT, equipmentView, lookView, sameLook, stableWorn, wornView } from "./look.ts";
import { WorldState } from "./world.ts";

const content = { items: {} } as unknown as ClientContent;
const ev = (m: ServerMessage["message"]): ServerMessage["message"] => m;

const MIRA = {
  body: "slender",
  skin: "olive",
  hair: "ponytail",
  hairColor: "auburn",
  beard: "none",
};
const TOM = { body: "sturdy", skin: "deep", hair: "crop", hairColor: "grey", beard: "full" };

describe("a creature's look", () => {
  it("reads the body, the visible equipment and the worn pieces of the protocol", () => {
    expect(lookView(undefined)).toBeUndefined();
    expect(lookView(create(BodyLookSchema, {}))).toBeUndefined(); // no body: no look
    expect(lookView(create(BodyLookSchema, MIRA))).toEqual(MIRA);
    expect(equipmentView(undefined)).toBe(NO_EQUIPMENT);
    expect(equipmentView(create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }))).toEqual({
      ...NO_EQUIPMENT,
      torso: 64,
      rightHand: 60,
    });
    expect(wornView(undefined)).toBeUndefined();
    expect(
      wornView(
        create(WornSchema, {
          head: create(WornPieceSchema, { shape: "cap", tint: "wine" }),
          weapon: create(WornPieceSchema, { shape: "sword", tint: "rust" }),
        }),
      ),
    ).toEqual({ head: { shape: "cap", tint: "wine" }, weapon: { shape: "sword", tint: "rust" } });
    expect(sameLook(MIRA, { ...MIRA })).toBe(true);
    expect(sameLook(MIRA, TOM)).toBe(false);
    expect(sameLook(undefined, MIRA)).toBe(false);
  });

  it("keeps one worn object while the pieces are the same (no redraw per render)", () => {
    const first = { weapon: { shape: "sword", tint: "rust" } };
    const again = { weapon: { shape: "sword", tint: "rust" } };
    expect(stableWorn(undefined, first)).toBe(first);
    expect(stableWorn(first, again)).toBe(first);
    const other = { weapon: { shape: "axe", tint: "rust" } };
    expect(stableWorn(first, other)).toBe(other);
  });

  it("keeps a creature's look and equipment and follows CreatureLook", () => {
    const w = new WorldState(content);
    w.apply(
      ev({
        case: "creatureAppear",
        value: {
          creature: create(CreatureSchema, {
            id: 7,
            kind: CreatureKind.PLAYER,
            name: "Mira",
            pos: { x: 5, y: 5, z: 7 },
            look: create(BodyLookSchema, MIRA),
            equipment: create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }),
          }),
        } as never,
      }),
      0,
    );
    const c = w.creatures.get(7);
    expect(c?.look).toEqual(MIRA);
    expect(c?.equipment.rightHand).toBe(60);
    expect(c?.worn).toBeUndefined();
    const rev = c?.lookRev ?? -1;

    // The sword taken off and a new body: both come whole.
    w.apply(
      ev({
        case: "creatureLook",
        value: create(CreatureLookSchema, {
          id: 7,
          look: create(BodyLookSchema, TOM),
          equipment: create(VisibleEquipmentSchema, { torso: 64 }),
        }),
      }),
      10,
    );
    expect(c?.look).toEqual(TOM);
    expect(c?.equipment).toEqual({ ...NO_EQUIPMENT, torso: 64 });
    expect(c?.lookRev).toBe(rev + 1); // the canvas builds the figure again

    // Everything taken off.
    w.apply(
      ev({
        case: "creatureLook",
        value: create(CreatureLookSchema, { id: 7, look: create(BodyLookSchema, TOM) }),
      }),
      20,
    );
    expect(c?.equipment).toEqual(NO_EQUIPMENT);
    expect(c?.lookRev).toBe(rev + 2);

    // Of a creature this client does not know: nothing.
    w.apply(ev({ case: "creatureLook", value: create(CreatureLookSchema, { id: 99 }) }), 30);
    expect(w.creatures.has(99)).toBe(false);
  });

  it("an NPC or a monster wears the pieces of its data", () => {
    const w = new WorldState(content);
    w.apply(
      ev({
        case: "creatureAppear",
        value: {
          creature: create(CreatureSchema, {
            id: 4000000013,
            kind: CreatureKind.MONSTER,
            contentId: "wreck_looter",
            pos: { x: 5, y: 6, z: 7 },
            look: create(BodyLookSchema, TOM),
            worn: create(WornSchema, {
              weapon: create(WornPieceSchema, { shape: "sword", tint: "rust" }),
            }),
          }),
        } as never,
      }),
      0,
    );
    const m = w.creatures.get(4000000013);
    expect(m?.look).toEqual(TOM);
    expect(m?.worn).toEqual({ weapon: { shape: "sword", tint: "rust" } });
    expect(m?.equipment).toBe(NO_EQUIPMENT);
  });

  it("builds the figure again only when what it is drawn from changed", () => {
    const w = new WorldState(content);
    const appear = (creature: Parameters<typeof create<typeof CreatureSchema>>[1]): void =>
      w.apply(
        ev({
          case: "creatureAppear",
          value: { creature: create(CreatureSchema, creature) } as never,
        }),
        0,
      );
    const monster = {
      id: 4000000013,
      kind: CreatureKind.MONSTER,
      contentId: "wreck_looter",
      pos: { x: 5, y: 6, z: 7 },
      look: create(BodyLookSchema, TOM),
      worn: create(WornSchema, {
        weapon: create(WornPieceSchema, { shape: "sword", tint: "rust" }),
      }),
    };
    const player = {
      id: 7,
      kind: CreatureKind.PLAYER,
      pos: { x: 6, y: 6, z: 7 },
      look: create(BodyLookSchema, MIRA),
      equipment: create(VisibleEquipmentSchema, { torso: 64 }),
    };
    appear(monster);
    appear(player);
    const rev = (id: number): number | undefined => w.creatures.get(id)?.lookRev;
    const [m0, p0] = [rev(4000000013), rev(7)];

    // Sent again unchanged (a teleport, another floor): the same figure.
    appear({ ...monster, pos: { x: 6, y: 7, z: 7 } });
    appear({ ...player, health: 50 } as typeof player);
    expect([rev(4000000013), rev(7)]).toEqual([m0, p0]);

    // Something it is drawn from changed: built again.
    appear({ ...monster, worn: create(WornSchema, {}) });
    appear({ ...player, equipment: create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }) });
    const [m1, p1] = [rev(4000000013) ?? 0, rev(7) ?? 0];
    expect(m1).toBeGreaterThan(m0 ?? 0);
    expect(p1).toBeGreaterThan(p0 ?? 0);
    appear({
      ...player,
      equipment: create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }),
      look: create(BodyLookSchema, TOM),
    });
    expect(rev(7)).toBeGreaterThan(p1);
  });

  it("keeps the look, equipment and worn objects of a creature sent again unchanged", () => {
    const w = new WorldState(content);
    const appear = (creature: Parameters<typeof create<typeof CreatureSchema>>[1]): void =>
      w.apply(
        ev({
          case: "creatureAppear",
          value: { creature: create(CreatureSchema, creature) } as never,
        }),
        0,
      );
    const monster = {
      id: 4000000013,
      kind: CreatureKind.MONSTER,
      pos: { x: 5, y: 6, z: 7 },
      look: create(BodyLookSchema, TOM),
      worn: create(WornSchema, {
        weapon: create(WornPieceSchema, { shape: "sword", tint: "rust" }),
      }),
    };
    const player = {
      id: 7,
      kind: CreatureKind.PLAYER,
      pos: { x: 6, y: 6, z: 7 },
      look: create(BodyLookSchema, MIRA),
      equipment: create(VisibleEquipmentSchema, { torso: 64 }),
    };
    appear(monster);
    appear(player);
    const m0 = w.creatures.get(4000000013);
    const p0 = w.creatures.get(7);
    appear({ ...monster, pos: { x: 6, y: 7, z: 7 } });
    appear({ ...player, pos: { x: 7, y: 6, z: 7 } });
    const m1 = w.creatures.get(4000000013);
    const p1 = w.creatures.get(7);
    expect(m1?.look).toBe(m0?.look);
    expect(m1?.worn).toBe(m0?.worn);
    expect(p1?.look).toBe(p0?.look);
    expect(p1?.equipment).toBe(p0?.equipment);

    // A change gives new objects with the new values.
    appear({
      ...monster,
      worn: create(WornSchema, { weapon: create(WornPieceSchema, { shape: "axe", tint: "rust" }) }),
    });
    appear({ ...player, equipment: create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }) });
    expect(w.creatures.get(4000000013)?.worn).toEqual({ weapon: { shape: "axe", tint: "rust" } });
    expect(w.creatures.get(7)?.equipment.rightHand).toBe(60);
    expect(w.creatures.get(7)?.look).toBe(p0?.look);
    // A piece that goes away is a change too.
    appear({ ...monster, worn: create(WornSchema, {}) });
    expect(w.creatures.get(4000000013)?.worn).toEqual({});
  });

  it("a creature sent again after a FullMapView never repeats the drawn lookRev", () => {
    // Died and lost its gear: the server sends the CreatureLook and then, in the same
    // batch, the FullMapView of the temple with the creature in it again.
    const w = new WorldState(content);
    const player = {
      id: 7,
      kind: CreatureKind.PLAYER,
      pos: { x: 6, y: 6, z: 7 },
      look: create(BodyLookSchema, MIRA),
      equipment: create(VisibleEquipmentSchema, { torso: 64, rightHand: 60 }),
    };
    w.apply(
      ev({ case: "creatureAppear", value: { creature: create(CreatureSchema, player) } as never }),
      0,
    );
    const drawn = w.creatures.get(7)?.lookRev; // what the canvas built the figure with
    w.apply(
      ev({
        case: "creatureLook",
        value: create(CreatureLookSchema, { id: 7, look: create(BodyLookSchema, MIRA) }),
      }),
      10,
    );
    w.apply(
      ev({
        case: "fullMapView",
        value: {
          walkEpoch: 1,
          area: create(MapAreaSchema, {
            creatures: [create(CreatureSchema, { ...player, equipment: undefined })],
          }),
        } as never,
      }),
      10,
    );
    const c = w.creatures.get(7);
    expect(c?.equipment).toEqual(NO_EQUIPMENT);
    expect(c?.lookRev).not.toBe(drawn);
  });
});
