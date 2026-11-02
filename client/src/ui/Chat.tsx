// Chat panel (T1.13): the last lines of every channel and the line to speak, with the
// channel picker (say, yell, whisper, global). Lines are DOM text: Preact escapes them,
// so nothing a player types can become markup.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { ChatChannel, MessageKind } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { formatChat } from "../state/messages.ts";

const CHANNELS: { channel: ChatChannel; key: string }[] = [
  { channel: ChatChannel.SAY, key: "client.chat.channel.say" },
  { channel: ChatChannel.YELL, key: "client.chat.channel.yell" },
  { channel: ChatChannel.WHISPER, key: "client.chat.channel.whisper" },
  { channel: ChatChannel.GLOBAL, key: "client.chat.channel.global" },
];

const KIND_CLASS: Partial<Record<MessageKind, string>> = {
  [MessageKind.SAY]: "say",
  [MessageKind.YELL]: "yell",
  [MessageKind.WHISPER]: "whisper",
  [MessageKind.GLOBAL]: "global",
  [MessageKind.NPC]: "npc",
};

export function ChatPanel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t } = props;
  const [text, setText] = useState("");
  const [channel, setChannel] = useState(ChatChannel.SAY);
  const list = useRef<HTMLUListElement>(null);
  const last = props.ui.chat[props.ui.chat.length - 1];
  // Keep the newest line in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.at, props.ui.chat.length]);
  return (
    <section class="chat" aria-label={t("client.chat.title")}>
      <ul class="chat-lines" data-testid="chat-log" ref={list} aria-live="polite">
        {props.ui.chat.map((l, i) => (
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
          props.game?.say(text, channel);
          setText("");
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
          aria-label={t("client.say.label")}
          maxLength={props.content.chat.maxLength}
          value={text}
          placeholder={t("client.say.placeholder")}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </form>
    </section>
  );
}
