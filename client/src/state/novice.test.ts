// The novice protection's notices (docs/02 "Muerte"): the death screen reads the level the
// protection reaches from death.died. The texts and the balance: client/vite/novice.test.ts.
import { MessageKind, MessageSchema, TextParamSchema, create } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { NO_SOUNDS } from "../audio/cues.ts";
import type { ClientContent } from "../content-types.ts";
import { WorldState } from "./world.ts";

const content: ClientContent = {
  items: {},
  monsterSprites: {},
  vocations: [],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.414, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

function died(w: WorldState, params: Record<string, number>): void {
  w.apply(
    {
      case: "chatMessage",
      value: create(MessageSchema, {
        kind: MessageKind.SYSTEM,
        body: {
          case: "localized",
          value: {
            key: "death.died",
            params: Object.entries(params).map(([name, number]) =>
              create(TextParamSchema, { name, value: { case: "number", value: BigInt(number) } }),
            ),
          },
        },
      }),
    },
    5,
  );
}

describe("novice protection notices", () => {
  it("keeps the protection's last level of a protected death", () => {
    const w = new WorldState(content);
    died(w, { experience: 12, blessings: 0, novice_until: 8 });
    expect(w.death).toEqual({ experience: 12, blessings: 0, noviceUntil: 8, at: 5 });
  });

  it("has no protection for an unprotected death or an older server", () => {
    const w = new WorldState(content);
    died(w, { experience: 900, blessings: 2 });
    expect(w.death?.noviceUntil).toBe(0);
  });
});
