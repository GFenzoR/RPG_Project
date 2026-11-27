// Options → Controls, the touch part (lote 21, docs/15 "Controles táctiles"): pad or stick,
// the action buttons, the left-handed mirror, the size of the buttons, pinning them while a
// mouse or a keyboard is in use, vibration and the effects preset. No hooks: the choices
// live in main.tsx, kept on the device (state/touch-controls.ts).
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { PAD_STYLES, TOUCH_SIZES } from "../state/touch-controls.ts";
import type { EffectsPreset, TouchPrefs } from "../state/touch-controls.ts";

export function TouchOptions(props: {
  t: Translate;
  prefs: TouchPrefs;
  /** The device can vibrate (the switch shows only then). */
  canVibrate: boolean;
  effects: EffectsPreset;
  onChange(prefs: TouchPrefs): void;
  onEffects(preset: EffectsPreset): void;
}): JSX.Element {
  const { t, prefs } = props;
  const set = (patch: Partial<TouchPrefs>): void => props.onChange({ ...prefs, ...patch });
  const check = (
    key: "actions" | "mirrored" | "pinned" | "haptics",
    label: string,
  ): JSX.Element => (
    <label class="check">
      <input
        type="checkbox"
        data-testid={`touch-opt-${key}`}
        checked={prefs[key]}
        onChange={(e) => set({ [key]: e.currentTarget.checked })}
      />
      {t(label)}
    </label>
  );
  return (
    <fieldset class="touch-options" data-testid="touch-options">
      <legend>{t("client.options.touch")}</legend>
      <div class="touch-opt-row" role="radiogroup" aria-label={t("client.options.touch.pad")}>
        <span>{t("client.options.touch.pad")}</span>
        {PAD_STYLES.map((p) => (
          <label key={p} class="check">
            <input
              type="radio"
              name="rpg-touch-pad"
              value={p}
              data-touch-pad={p}
              checked={prefs.pad === p}
              onChange={() => set({ pad: p })}
            />
            {t(`client.options.touch.pad.${p}`)}
          </label>
        ))}
      </div>
      <label class="touch-opt-row">
        <span>{t("client.options.touch.size")}</span>
        <select
          data-testid="touch-opt-size"
          value={prefs.size}
          onChange={(e) => {
            const size = TOUCH_SIZES.find((s) => s === e.currentTarget.value);
            if (size) set({ size });
          }}
        >
          {TOUCH_SIZES.map((s) => (
            <option key={s} value={s}>
              {t(`client.options.touch.size.${s}`)}
            </option>
          ))}
        </select>
      </label>
      {check("actions", "client.options.touch.actions")}
      {check("mirrored", "client.options.touch.mirrored")}
      {check("pinned", "client.options.touch.pinned")}
      {props.canVibrate && check("haptics", "client.options.touch.haptics")}
      <label class="check" title={t("client.options.effects_hint")}>
        <input
          type="checkbox"
          data-testid="effects-reduced"
          checked={props.effects === "reduced"}
          onChange={(e) => props.onEffects(e.currentTarget.checked ? "reduced" : "full")}
        />
        {t("client.options.effects_reduced")}
      </label>
    </fieldset>
  );
}
