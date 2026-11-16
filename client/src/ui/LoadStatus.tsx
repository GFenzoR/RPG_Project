// What the map shows before the canvas is up: "Connecting…", or, when the atlas could not
// be loaded after its retries (@rpg/renderer retry.ts), the error and a "Retry" button.
// Retrying starts the canvas again in the same session: no reload, no new login. No hooks,
// so LoadStatus.test.ts walks its tree without a DOM.
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";

export function LoadStatus(props: {
  t: Translate;
  /** The canvas failed to start and waits for the button. */
  failed: boolean;
  retry(): void;
}): JSX.Element {
  const { t } = props;
  if (!props.failed) return <p class="connecting">{t("client.game.connecting")}</p>;
  return (
    <div class="load-failed" role="alert" data-testid="load-failed">
      <p>{t("client.game.load_failed")}</p>
      <button type="button" data-testid="load-retry" onClick={() => props.retry()}>
        {t("client.game.load_retry")}
      </button>
    </div>
  );
}
