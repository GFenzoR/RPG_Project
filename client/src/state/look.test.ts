// What a creature looks like, as the server says (docs/05 "Apariencia y equipo visible").
import {
  BodyLookSchema,
  CreatureKind,
  CreatureLookSchema,
  CreatureSchema,
  VisibleEquipmentSchema,
  WornPieceSchema,
  WornSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { NO_EQUIPMENT, equipmentView, lookView, sameLook, wornView } from "./look.ts";
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
});
