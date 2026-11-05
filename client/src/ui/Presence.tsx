import type { JSX } from "preact";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";

/**
 * The presence check (T4.1): a simple question from the server with its options, over
 * the map. It does not block the game (no key is taken), and the server replies the same
 * whatever the answer.
 */
export function PresenceCheck(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element | null {
  const { t } = props;
  const p = props.ui.presence;
  if (!p) return null;
  const minutes = Math.max(1, Math.ceil((p.until - performance.now()) / 60_000));
  return (
    <div
      class="presence"
      role="alertdialog"
      aria-labelledby="presence-title"
      data-testid="presence-check"
    >
      <h2 id="presence-title">{t("client.presence.title")}</h2>
      <p>{t(p.question)}</p>
      <div class="buttons">
        {p.options.map((o) => (
          <button key={o.id} type="button" onClick={() => props.game?.presenceAnswer(p.id, o.id)}>
            {t(o.key)}
          </button>
        ))}
      </div>
      <p class="hint">{t("client.presence.time_left", { minutes })}</p>
    </div>
  );
}
