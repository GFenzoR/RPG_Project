// The chat window's tabs (docs/17 UI-10): All, Local, Party, Guild, Global and the system
// log. Each tab shows the chat lines of its channels (chatFilter); a staff broadcast shows
// on every one. The tab chosen sets the channel the line to speak starts on (tabChannel),
// and a dot marks a tab with lines the player has not seen in any tab (unreadTabs). Pure,
// with tests: ui/GameView.tsx (ChatTabs) and ui/Chat.tsx draw it.
import { ChatChannel, MessageKind } from "@rpg/protocol";
import type { ChatLine } from "./world.ts";

/** The tabs, in their order on the title bar. `chat` is "All" (its test id stays). */
export const CHAT_TABS = ["chat", "local", "party", "guild", "global", "log"] as const;
export type ChatTab = (typeof CHAT_TABS)[number];

/** Label of each tab (i18n). */
export const CHAT_TAB_LABEL: Readonly<Record<ChatTab, string>> = {
  chat: "client.chat.tab.all",
  local: "client.chat.tab.local",
  party: "client.chat.tab.party",
  guild: "client.chat.tab.guild",
  global: "client.chat.tab.global",
  log: "client.chat.log",
};

/** What each channel tab shows: what is said around the player, the party, the guild... */
const KINDS: Readonly<Record<"local" | "party" | "guild" | "global", readonly MessageKind[]>> = {
  local: [MessageKind.SAY, MessageKind.YELL, MessageKind.WHISPER, MessageKind.NPC],
  party: [MessageKind.PARTY],
  guild: [MessageKind.GUILD],
  global: [MessageKind.GLOBAL],
};

export const isChatTab = (v: unknown): v is ChatTab =>
  typeof v === "string" && (CHAT_TABS as readonly string[]).includes(v);

/**
 * Whether a chat line shows on a tab: every line on All, a staff broadcast on every tab,
 * none on the log (the system's messages are not chat lines).
 */
export function inTab(line: Pick<ChatLine, "kind">, tab: ChatTab): boolean {
  if (tab === "log") return false;
  if (tab === "chat" || line.kind === MessageKind.BROADCAST) return true;
  return KINDS[tab].includes(line.kind);
}

/** The chat lines a tab shows, oldest first. */
export function chatFilter<L extends Pick<ChatLine, "kind">>(
  lines: readonly L[],
  tab: ChatTab,
): L[] {
  return tab === "chat" ? [...lines] : lines.filter((l) => inTab(l, tab));
}

/**
 * The channel the line to speak starts on with a tab: the tab's own (Local says); All and
 * the log leave it as it was.
 */
export function tabChannel(tab: ChatTab): ChatChannel | undefined {
  switch (tab) {
    case "local":
      return ChatChannel.SAY;
    case "party":
      return ChatChannel.PARTY;
    case "guild":
      return ChatChannel.GUILD;
    case "global":
      return ChatChannel.GLOBAL;
    default:
      return undefined;
  }
}

/**
 * The tabs other than `active` with a line the player has not seen (`seen`: it showed on
 * the tab that was open) said by someone else (`self`: the player's own name). The log's
 * dot is the caller's: its messages are not chat lines.
 */
export function unreadTabs<L extends Pick<ChatLine, "kind" | "speakerName">>(
  lines: readonly L[],
  seen: (line: L) => boolean,
  active: ChatTab,
  self: string,
): Set<ChatTab> {
  const out = new Set<ChatTab>();
  for (const l of lines) {
    if (seen(l) || (self !== "" && l.speakerName === self)) continue;
    for (const tab of CHAT_TABS) if (tab !== active && inTab(l, tab)) out.add(tab);
  }
  return out;
}

/** The next tab with the arrow keys (wraps around). */
export function nextTab(tab: ChatTab, step: 1 | -1): ChatTab {
  const i = CHAT_TABS.indexOf(tab);
  return CHAT_TABS[(i + step + CHAT_TABS.length) % CHAT_TABS.length] ?? "chat";
}
