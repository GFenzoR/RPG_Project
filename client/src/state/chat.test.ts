import { NO_SOUNDS } from "../audio/cues.ts";
import { MessageKind, MessageSchema, TextParamSchema, create } from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatChat } from "./messages.ts";
import { CHAT_SIZE, WorldState } from "./world.ts";

type Msg = ServerMessage["message"];

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

const t = translator(
  {
    "client.chat.line.say": "{name} dice: {text}",
    "client.chat.line.global": "[Global] {name}: {text}",
    "client.chat.line.npc": "{name}: {text}",
    "npc.ferryman.name": "Barquero",
    "dialog.hello": "Hola {name}",
  },
  "es",
);

const chat = (kind: MessageKind, text: string, speakerName = "Mira"): Msg => ({
  case: "chatMessage",
  value: create(MessageSchema, { kind, speakerName, body: { case: "text", value: text } }),
});

describe("chat", () => {
  it("keeps chat lines apart from the system log, the last CHAT_SIZE", () => {
    const w = new WorldState(content);
    for (let i = 0; i < CHAT_SIZE + 3; i++) w.apply(chat(MessageKind.SAY, `m${i}`), i);
    expect(w.log).toHaveLength(0);
    expect(w.chat).toHaveLength(CHAT_SIZE);
    expect(w.chat[0]?.text).toBe("m3");
  });

  it("formats each kind and leaves player text untouched", () => {
    const w = new WorldState(content);
    w.apply(chat(MessageKind.SAY, "<img src=x onerror=alert(1)> {name}"), 0);
    w.apply(chat(MessageKind.GLOBAL, "hi"), 0);
    w.apply(
      {
        case: "chatMessage",
        value: create(MessageSchema, {
          kind: MessageKind.NPC,
          speakerContentId: "ferryman",
          body: {
            case: "localized",
            value: {
              key: "dialog.hello",
              params: [
                create(TextParamSchema, { name: "name", value: { case: "text", value: "Mira" } }),
              ],
            },
          },
        }),
      },
      0,
    );
    const lines = w.chat.map((l) => formatChat(l, content, t));
    expect(lines).toEqual([
      "Mira dice: <img src=x onerror=alert(1)> {name}",
      "[Global] Mira: hi",
      "Barquero: Hola Mira",
    ]);
  });
});
