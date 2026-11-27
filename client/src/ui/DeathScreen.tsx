import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { DeathState } from "../state/world.ts";

/**
 * The death screen over the map (docs/02 "Muerte"): what the death cost and, when the novice
 * protection covered it (death.died's novice_until), that nothing fell and up to which
 * level. A plain function, no hooks: the caller owns "seen".
 */
export function DeathScreen(props: {
  t: Translate;
  death: DeathState;
  onOk: () => void;
}): JSX.Element {
  const { t, death } = props;
  return (
    <div class="death" role="alertdialog" aria-labelledby="death-title" data-testid="death-screen">
      <h2 id="death-title">{t("client.death.title")}</h2>
      <p>{t("client.death.experience", { experience: death.experience })}</p>
      <p>
        {death.blessings > 0
          ? t("client.death.blessings", { blessings: death.blessings })
          : t("client.death.no_blessings")}
      </p>
      {death.noviceUntil > 0 && (
        <p data-testid="death-novice">{t("client.death.novice", { level: death.noviceUntil })}</p>
      )}
      <p>{t("client.death.temple")}</p>
      <button type="button" onClick={props.onOk}>
        {t("client.death.ok")}
      </button>
    </div>
  );
}
