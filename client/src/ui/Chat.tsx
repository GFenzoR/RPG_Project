// Chat panel (T1.13): the last lines of every channel and the line to speak, with the
// channel picker (say, yell, whisper, global, party, guild). Lines are DOM text: Preact escapes them,
// so nothing a player types can become markup. On the desktop the chat window's tab
// (docs/17 UI-10, state/chat.ts) filters the lines and sets the channel the line starts on.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { ChatChannel, MessageKind } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { formatChat } from "../state/messages.ts";
import { chatFilter, tabChannel } from "../state/chat.ts";
import type { ChatTab } from "../state/chat.ts";
import { chatFocusAction, enterIsFree } from "../state/chat-focus.ts";

const CHANNELS: { channel: ChatChannel; key: string }[] = [
  { channel: ChatChannel.SAY, key: "client.chat.channel.say" },
  { channel: ChatChannel.YELL, key: "client.chat.channel.yell" },
  { channel: ChatChannel.WHISPER, key: "client.chat.channel.whisper" },
  { channel: ChatChannel.GLOBAL, key: "client.chat.channel.global" },
  { channel: ChatChannel.PARTY, key: "client.chat.channel.party" },
  { channel: ChatChannel.GUILD, key: "client.chat.channel.guild" },
];

/**
 * How long a phone's virtual keyboard takes to slide in (ms): after that the chat line is
 * scrolled into the space left above it (App.tsx sizes the game to the visual viewport).
 */
const KEYBOARD_SETTLE_MS = 300;

const KIND_CLASS: Partial<Record<MessageKind, string>> = {
  [MessageKind.SAY]: "say",
  [MessageKind.YELL]: "yell",
  [MessageKind.WHISPER]: "whisper",
  [MessageKind.GLOBAL]: "global",
  [MessageKind.NPC]: "npc",
  [MessageKind.BROADCAST]: "broadcast",
  [MessageKind.PARTY]: "party",
  [MessageKind.GUILD]: "guild",
};

export function ChatPanel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** The chat window's tab (desktop): the lines it shows; All when absent. */
  tab?: ChatTab | undefined;
}): JSX.Element {
  const { t } = props;
  const tab = props.tab ?? "chat";
  const [text, setText] = useState("");
  const [channel, setChannel] = useState(ChatChannel.SAY);
  // A channel's tab chosen: the line to speak starts on that channel (the player can still
  // pick another in the selector).
  useEffect(() => {
    const c = tabChannel(tab);
    if (c !== undefined) setChannel(c);
  }, [tab]);
  const lines = chatFilter(props.ui.chat, tab);
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  // Enter with nothing focused puts the cursor in the chat line (state/chat-focus.ts);
  // keys already used by the game, a window or a focused button are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = field.current;
      if (!el || e.target === el) return;
      const action = chatFocusAction({
        key: e.key,
        inChat: false,
        claimed: e.defaultPrevented || !enterIsFree(document.activeElement),
        text: textRef.current,
        modified: e.repeat || e.ctrlKey || e.altKey || e.metaKey,
      });
      if (action !== "focus" || el.offsetParent === null) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const send = (): void => {
    if (text.trim() === "") return;
    props.game?.say(text, channel);
    setText("");
    field.current?.blur();
  };
  const last = lines[lines.length - 1];
  // Keep the newest line in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.at, lines.length, tab]);
  return (
    <section class="chat" data-tutorial="chat" aria-label={t("client.chat.title")}>
      <ul class="chat-lines" data-testid="chat-log" ref={list} aria-live="polite">
        {lines.map((l, i) => (
          <li key={`${l.at}-${i}`} class={KIND_CLASS[l.kind] ?? ""}>
            {formatChat(l, props.content, t)}
          </li>
        ))}
      </ul>
      <form
        class="say"
        data-testid="say"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <select
          aria-label={t("client.chat.channel.label")}
          data-testid="chat-channel"
          value={channel}
          onChange={(e) => setChannel(Number(e.currentTarget.value) as ChatChannel)}
        >
          {CHANNELS.map((c) => (
            <option key={c.channel} value={c.channel}>
              {t(c.key)}
            </option>
          ))}
        </select>
        <input
          type="text"
          ref={field}
          aria-label={t("client.say.label")}
          maxLength={props.content.chat.maxLength}
          value={text}
          placeholder={t("client.say.placeholder")}
          enterKeyHint="send"
          autoComplete="off"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            const action = chatFocusAction({
              key: e.key,
              inChat: true,
              claimed: false,
              text: e.currentTarget.value,
              modified: e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.isComposing,
            });
            if (action === "blur") {
              e.preventDefault();
              e.currentTarget.blur();
            }
            // "send": the form's submit does it (and gives the focus back).
          }}
          onFocus={(e) => {
            const el = e.currentTarget;
            setTimeout(() => el.scrollIntoView({ block: "nearest" }), KEYBOARD_SETTLE_MS);
          }}
        />
      </form>
    </section>
  );
}
