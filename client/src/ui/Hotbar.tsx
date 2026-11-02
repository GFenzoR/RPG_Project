// Spell hotkey bar F1–F12 (T1.9): click or press the key to cast, pick a spell per slot
// in edit mode. The dimmed part of a slot is the cooldown left (own or group).
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";

/** Repaint interval of the cooldown shades, ms. */
const COOLDOWN_REFRESH_MS = 100;

export function Hotbar(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t, game } = props;
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), COOLDOWN_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const name = (id: string): string => t(`spell.${id}.name`);
  return (
    <section class="hotbar" data-testid="hotbar" aria-label={t("client.hotbar.title")}>
      <ol>
        {props.ui.hotkeys.map((id, i) => {
          const key = `F${i + 1}`;
          const left = id && game ? game.spellCooldown(id, now) : 0;
          return (
            <li key={key} data-hotkey={key}>
              {editing ? (
                <select
                  aria-label={t("client.hotbar.assign", { key })}
                  value={id ?? ""}
                  onChange={(e) => game?.setHotkey(i, e.currentTarget.value || undefined)}
                >
                  <option value="">{t("client.hotbar.none")}</option>
                  {props.content.spells.map((s) => (
                    <option key={s.id} value={s.id}>
                      {name(s.id)}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  disabled={!id}
                  data-spell={id}
                  title={
                    id
                      ? left > 0
                        ? t("client.hotbar.cooldown", { name: name(id) })
                        : name(id)
                      : undefined
                  }
                  onClick={() => id && game?.castSpell(id)}
                >
                  <span class="key">{key}</span>
                  <span class="spell">{id ? name(id) : t("client.hotbar.empty")}</span>
                  {left > 0 && <span class="cd" style={{ height: `${Math.round(left * 100)}%` }} />}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        class="edit"
        aria-pressed={editing}
        title={t("client.hotbar.title")}
        onClick={() => setEditing(!editing)}
      >
        ✎
      </button>
    </section>
  );
}

/** The "say" line: spoken words cast spells (the chat itself arrives with T1.13). */
export function SayLine(props: { t: Translate; game: Game | undefined }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <form
      class="say"
      data-testid="say"
      onSubmit={(e) => {
        e.preventDefault();
        props.game?.say(text);
        setText("");
      }}
    >
      <label>
        {props.t("client.say.label")}
        <input
          type="text"
          maxLength={255}
          value={text}
          placeholder={props.t("client.say.placeholder")}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
    </form>
  );
}
