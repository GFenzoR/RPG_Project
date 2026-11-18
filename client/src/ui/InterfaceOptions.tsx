// Options → Interface (docs/17 UI-3, UI-9): the interface scale (the dock and the windows),
// the text size and the camera shake on heavy hits. Without hooks: the choices
// live in main.tsx, kept per device in localStorage (state/ui-prefs.ts).
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { TEXT_SCALES, UI_SCALES } from "../state/ui-prefs.ts";

/** "125 %" in the player's language. */
export const percent = (t: Translate, v: number): string =>
  t("client.options.percent", { percent: Math.round(v * 100) });

export function InterfaceOptions(props: {
  t: Translate;
  uiScale: number;
  textScale: number;
  shake: boolean;
  onUiScale(v: number): void;
  onTextScale(v: number): void;
  onShake(on: boolean): void;
}): JSX.Element {
  const { t } = props;
  const select = (
    testid: string,
    label: string,
    value: number,
    offered: readonly number[],
    onChange: (v: number) => void,
  ): JSX.Element => (
    <label class="scale">
      <span>{label}</span>
      <select
        data-testid={testid}
        value={String(value)}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      >
        {offered.map((v) => (
          <option key={v} value={String(v)}>
            {percent(t, v)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div class="interface-options" data-testid="interface-options">
      {select("ui-scale", t("client.options.ui_scale"), props.uiScale, UI_SCALES, props.onUiScale)}
      {select(
        "text-scale",
        t("client.options.text_scale"),
        props.textScale,
        TEXT_SCALES,
        props.onTextScale,
      )}
      <label class="check" title={t("client.options.camera_shake_hint")}>
        <input
          type="checkbox"
          data-testid="camera-shake"
          checked={props.shake}
          onChange={(e) => props.onShake(e.currentTarget.checked)}
        />
        {t("client.options.camera_shake")}
      </label>
    </div>
  );
}
