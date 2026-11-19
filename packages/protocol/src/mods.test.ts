// ItemMods on the wire (docs/05, docs/02 "Atributos de items"): an instance's attribute
// travels in every ItemStack and in the market's offers and forms.
import { describe, expect, it } from "vitest";
import { toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema,
  ServerBatchSchema,
  create,
  decodeServerBatch,
  encodeClientMessage,
} from "./index.ts";

describe("ItemMods", () => {
  it("decodes an equipped instance's mods and a sell offer's", () => {
    const batch = create(ServerBatchSchema, {
      tick: 1n,
      events: [
        {
          message: {
            case: "inventory",
            value: {
              slots: [{ slot: 5, item: { itemId: 60, mods: { attribute: "attack", value: 3 } } }],
            },
          },
        },
        {
          message: {
            case: "marketUpdate",
            value: {
              open: true,
              itemId: 60,
              sells: [
                {
                  offerId: 9n,
                  itemId: 60,
                  amount: 1,
                  mods: { attribute: "armor", value: 1, refine: 2 },
                },
              ],
              ownedMods: [{ attribute: "speed", value: 4 }, {}],
            },
          },
        },
      ],
    });
    const out = decodeServerBatch(toBinary(ServerBatchSchema, batch));
    const inv = out.events[0]?.message;
    expect(inv?.case).toBe("inventory");
    if (inv?.case !== "inventory") return;
    expect(inv.value.slots[0]?.item?.mods).toMatchObject({
      attribute: "attack",
      value: 3,
      refine: 0,
    });
    const mk = out.events[1]?.message;
    if (mk?.case !== "marketUpdate") throw new Error("no market update");
    expect(mk.value.sells[0]?.mods).toMatchObject({ attribute: "armor", value: 1, refine: 2 });
    expect(mk.value.ownedMods.map((m) => m.attribute)).toEqual(["speed", ""]);
  });

  it("encodes the instance a sale picks", () => {
    const msg = create(ClientMessageSchema, {
      message: {
        case: "marketCommand",
        value: {
          action: {
            case: "accept",
            value: { offerId: 4n, amount: 1, mods: { attribute: "attack", value: 2 } },
          },
        },
      },
    });
    const back = fromBinary(ClientMessageSchema, encodeClientMessage(msg));
    const cmd = back.message;
    if (cmd.case !== "marketCommand" || cmd.value.action.case !== "accept")
      throw new Error("not an accept");
    expect(cmd.value.action.value.mods).toMatchObject({ attribute: "attack", value: 2 });
  });
});
