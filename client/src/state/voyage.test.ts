import { NO_SOUNDS } from "../audio/cues.ts";
import { MessageKind, MessageSchema, TextParamSchema, create } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatMessage } from "./messages.ts";
import { WorldState } from "./world.ts";

const content: ClientContent = {
  items: {},
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

describe("voyage (T3.5)", () => {
  it("keeps the last travel.sailed and names the island", () => {
    const w = new WorldState(content);
    w.apply(
      {
        case: "chatMessage",
        value: create(MessageSchema, {
          kind: MessageKind.SYSTEM,
          body: {
            case: "localized",
            value: {
              key: "travel.sailed",
              params: [
                create(TextParamSchema, {
                  name: "island",
                  value: { case: "contentId", value: "testisle" },
                }),
              ],
            },
          },
        }),
      },
      77,
    );
    expect(w.voyage).toEqual({ island: "testisle", at: 77 });
    const t = translator(
      {
        "travel.sailed": "You set sail for {island}.",
        "island.testisle.name": "Test Island",
      },
      "en",
    );
    const last = w.log[w.log.length - 1];
    if (!last) throw new Error("no log line");
    expect(formatMessage(last, content, t)).toBe("You set sail for Test Island.");
  });
});
