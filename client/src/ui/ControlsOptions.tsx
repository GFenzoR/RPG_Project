// Options → Controls (docs/17 UI-6): what the right mouse button does on items. A radio
// pair without hooks (the choice lives in main.tsx, kept in localStorage "rpg.controls").
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { ControlsMode } from "../state/controls.ts";

const MODES: readonly ControlsMode[] = ["menu", "classic"];

export function ControlsOptions(props: {
  t: Translate;
  mode: ControlsMode;
  onChange(mode: ControlsMode): void;
}): JSX.Element {
  const { t } = props;
  return (
    <fieldset class="controls-mode" data-testid="controls-mode">
      <legend>{t("client.options.right_click")}</legend>
      {MODES.map((m) => (
        <label key={m} class="check" title={t(`client.options.right_click.${m}_hint`)}>
          <input
            type="radio"
            name="rpg-controls"
            value={m}
            data-controls={m}
            checked={props.mode === m}
            onChange={() => props.onChange(m)}
          />
          {t(`client.options.right_click.${m}`)}
        </label>
      ))}
    </fieldset>
  );
}
