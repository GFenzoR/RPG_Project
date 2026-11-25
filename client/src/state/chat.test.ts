import { NO_SOUNDS } from "../audio/cues.ts";
import {
  ChatChannel,
  DialogOpenSchema,
  MessageKind,
  MessageSchema,
  PositionSchema,
  TextParamSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatChat } from "./messages.ts";
import { CHAT_SIZE, SPEECH_QUEUE, WorldState } from "./world.ts";
import {
  CHAT_TABS,
  WHEEL_LINE_PX,
  chatFilter,
  markSeen,
  nextTab,
  tabChannel,
  unreadTabs,
  viewedTab,
  wheelAlong,
} from "./chat.ts";
import type { ChatTab } from "./chat.ts";

type Msg = ServerMessage["message"];

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

describe("speech over the heads (docs/17 UI-11)", () => {
  const said = (kind: MessageKind, text: string, speakerId: number, seen: boolean): Msg => ({
    case: "chatMessage",
    value: create(MessageSchema, {
      kind,
      speakerId,
      speakerName: "Mira",
      ...(seen ? { pos: create(PositionSchema, { x: 1, y: 2, z: 7 }) } : {}),
      body: { case: "text", value: text },
    }),
  });

  it("queues what a seen speaker says, once, oldest first", () => {
    const w = new WorldState(content);
    w.apply(said(MessageKind.SAY, "hola", 4, true), 10);
    w.apply(said(MessageKind.YELL, "eh", 4, true), 20);
    const out = w.takeSpeech();
    expect(out.map((s) => [s.speakerId, s.kind, s.text, s.at])).toEqual([
      [4, MessageKind.SAY, "hola", 10],
      [4, MessageKind.YELL, "eh", 20],
    ]);
    expect(w.takeSpeech()).toEqual([]);
  });

  it("skips lines without the speaker's position: global, party, an unseen speaker", () => {
    const w = new WorldState(content);
    w.apply(said(MessageKind.GLOBAL, "hola", 4, false), 0);
    w.apply(said(MessageKind.PARTY, "hola", 4, false), 0);
    w.apply(said(MessageKind.SAY, "hola", 4, false), 0);
    expect(w.chat).toHaveLength(3);
    expect(w.takeSpeech()).toEqual([]);
  });

  it("keeps at most SPEECH_QUEUE while nothing takes it", () => {
    const w = new WorldState(content);
    for (let i = 0; i < SPEECH_QUEUE + 4; i++) w.apply(said(MessageKind.SAY, `m${i}`, 1, true), i);
    const out = w.takeSpeech();
    expect(out).toHaveLength(SPEECH_QUEUE);
    expect(out[0]?.text).toBe("m4");
  });

  it("an NPC's dialog line goes over its head too", () => {
    const w = new WorldState(content);
    w.apply(
      {
        case: "dialogOpen",
        value: create(DialogOpenSchema, {
          dialogId: 1,
          npcCreatureId: 77,
          text: { key: "dialog.hello", params: [] },
        }),
      },
      5,
    );
    const out = w.takeSpeech();
    expect(out).toHaveLength(1);
    expect(out[0]?.speakerId).toBe(77);
    expect(out[0]?.kind).toBe(MessageKind.NPC);
    expect(out[0]?.localized?.key).toBe("dialog.hello");
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

  it("does not count as seen the lines that come while the chat is folded", () => {
    const seen = new Set<object>();
    const unread = (all: readonly ReturnType<typeof line>[], viewed: ChatTab | undefined) =>
      [...unreadTabs(all, (l) => seen.has(l), viewed, "Aldric")].sort();
    // Folded on the Local tab: only its title bar (and the tabs) show.
    const say = line(MessageKind.SAY);
    const folded = viewedTab("local", false);
    expect(folded).toBeUndefined();
    markSeen([say], folded, seen);
    expect(seen.has(say)).toBe(false);
    // Its dot stays, on the open tab too: nothing of it was seen.
    expect(unread([say], folded)).toEqual(["chat", "local"]);
    // Unfolded, the open tab's lines are seen as they render; the other tabs' are not.
    const party = line(MessageKind.PARTY);
    const shown = viewedTab("local", true);
    markSeen([say, party], shown, seen);
    expect(seen.has(say) && !seen.has(party)).toBe(true);
    expect(unread([say, party], shown)).toEqual(["chat", "party"]);
    // The log's tab never marks a chat line.
    markSeen([party], viewedTab("log", true), seen);
    expect(seen.has(party)).toBe(false);
  });

  it("moves tabs too wide for the bar sideways with the wheel", () => {
    const row = { scrollLeft: 0, scrollWidth: 420, clientWidth: 360 };
    const down = { deltaX: 0, deltaY: 40, deltaMode: 0 };
    expect(wheelAlong(row, down)).toBe(40);
    // A line-based wheel (Firefox), to the end and no further.
    expect(wheelAlong(row, { deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(3 * WHEEL_LINE_PX);
    expect(wheelAlong({ ...row, scrollLeft: 50 }, down)).toBe(60);
    expect(wheelAlong({ ...row, scrollLeft: 60 }, down)).toBeUndefined();
    expect(wheelAlong({ ...row, scrollLeft: 20 }, { ...down, deltaY: -40 })).toBe(0);
    // Tabs that fit, or a sideways turn (the browser scrolls it), are left alone.
    expect(wheelAlong({ ...row, scrollWidth: 360 }, down)).toBeUndefined();
    expect(wheelAlong(row, { deltaX: 30, deltaY: 4, deltaMode: 0 })).toBeUndefined();
  });

  it("moves along the tabs with the arrows, wrapping around", () => {
    expect(nextTab("chat", 1)).toBe("local");
    expect(nextTab("log", 1)).toBe("chat");
    expect(nextTab("chat", -1)).toBe("log");
  });
});
