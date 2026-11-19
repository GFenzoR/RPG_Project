import { NO_SOUNDS } from "../audio/cues.ts";
import { ChatChannel, MessageKind, MessageSchema, TextParamSchema, create } from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatChat } from "./messages.ts";
import { CHAT_SIZE, WorldState } from "./world.ts";
import { CHAT_TABS, chatFilter, nextTab, tabChannel, unreadTabs } from "./chat.ts";
import type { ChatTab } from "./chat.ts";

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

describe("the chat window's tabs (docs/17 UI-10)", () => {
  const line = (kind: MessageKind, speakerName = "Mira", at = 0) => ({ kind, speakerName, at });
  const lines = [
    line(MessageKind.SAY),
    line(MessageKind.YELL),
    line(MessageKind.WHISPER),
    line(MessageKind.NPC, ""),
    line(MessageKind.PARTY),
    line(MessageKind.GUILD),
    line(MessageKind.GLOBAL),
    line(MessageKind.BROADCAST, "Staff"),
  ];
  const kinds = (tab: ChatTab) => chatFilter(lines, tab).map((l) => l.kind);

  it("filters the lines of each tab; a staff broadcast shows on every one", () => {
    expect(kinds("chat")).toHaveLength(lines.length);
    expect(kinds("local")).toEqual([
      MessageKind.SAY,
      MessageKind.YELL,
      MessageKind.WHISPER,
      MessageKind.NPC,
      MessageKind.BROADCAST,
    ]);
    expect(kinds("party")).toEqual([MessageKind.PARTY, MessageKind.BROADCAST]);
    expect(kinds("guild")).toEqual([MessageKind.GUILD, MessageKind.BROADCAST]);
    expect(kinds("global")).toEqual([MessageKind.GLOBAL, MessageKind.BROADCAST]);
    expect(kinds("log")).toEqual([]);
    expect(CHAT_TABS).toEqual(["chat", "local", "party", "guild", "global", "log"]);
  });

  it("filters WorldState.chat as it comes", () => {
    const w = new WorldState(content);
    w.apply(chat(MessageKind.SAY, "hola"), 0);
    w.apply(chat(MessageKind.GLOBAL, "a todos"), 1);
    expect(chatFilter(w.chat, "global").map((l) => l.text)).toEqual(["a todos"]);
    expect(chatFilter(w.chat, "local").map((l) => l.text)).toEqual(["hola"]);
  });

  it("starts the line to speak on the tab's channel; All and the log leave it", () => {
    expect(tabChannel("local")).toBe(ChatChannel.SAY);
    expect(tabChannel("party")).toBe(ChatChannel.PARTY);
    expect(tabChannel("guild")).toBe(ChatChannel.GUILD);
    expect(tabChannel("global")).toBe(ChatChannel.GLOBAL);
    expect(tabChannel("chat")).toBeUndefined();
    expect(tabChannel("log")).toBeUndefined();
  });

  it("marks the tabs with lines not seen, never for the player's own", () => {
    const party = line(MessageKind.PARTY);
    const global = line(MessageKind.GLOBAL);
    const mine = line(MessageKind.GUILD, "Aldric");
    const seen = new Set([party]);
    // On the Local tab: the global line was not seen anywhere; the party one was.
    const dots = unreadTabs([party, global, mine], (l) => seen.has(l), "local", "Aldric");
    expect([...dots].sort()).toEqual(["chat", "global"]);
    // The open tab never has a dot.
    expect(unreadTabs([global], () => false, "global", "Aldric").has("global")).toBe(false);
    // A broadcast not seen marks every tab but the open one.
    const all = unreadTabs([line(MessageKind.BROADCAST, "Staff")], () => false, "chat", "");
    expect([...all].sort()).toEqual(["global", "guild", "local", "party"]);
  });

  it("moves along the tabs with the arrows, wrapping around", () => {
    expect(nextTab("chat", 1)).toBe("local");
    expect(nextTab("log", 1)).toBe("chat");
    expect(nextTab("chat", -1)).toBe("log");
  });
});
