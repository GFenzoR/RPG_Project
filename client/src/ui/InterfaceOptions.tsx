// Options → Interface (docs/17 UI-3, UI-9, UI-10, UI-11): the interface scale (the bottom bar
// and the windows), the text size, the camera shake on heavy hits, the chat's opacity and
// the speech bubbles over the heads. Without
// hooks: the choices live in main.tsx, kept per device in localStorage (state/ui-prefs.ts).
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { CHAT_OPACITY, TEXT_SCALES, UI_SCALES } from "../state/ui-prefs.ts";
import { NAME_SIZES } from "../render/label-style.ts";
import type { NameSize } from "../render/label-style.ts";

/** The label of each name size (literal keys: make validate checks them). */
const NAME_SIZE_KEYS: Record<NameSize, string> = {
  normal: "client.options.name_size_normal",
  large: "client.options.name_size_large",
};

/** "125 %" in the player's language. */
export const percent = (t: Translate, v: number): string =>
  t("client.options.percent", { percent: Math.round(v * 100) });

export function InterfaceOptions(props: {
  t: Translate;
  uiScale: number;
  textScale: number;
  shake: boolean;
  /** The chat background's opacity, percent (CHAT_OPACITY). */
  chatOpacity: number;
  /** What creatures say shows over their heads (docs/17 UI-11). */
  bubbles: boolean;
  /** How big the names over creatures are (render/label-style.ts). */
  nameSize: NameSize;
  onNameSize(v: NameSize): void;
  onUiScale(v: number): void;
  onTextScale(v: number): void;
  onShake(on: boolean): void;
  onChatOpacity(v: number): void;
  onBubbles(on: boolean): void;
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
      <label class="scale" title={t("client.options.name_size_hint")}>
        <span>{t("client.options.name_size")}</span>
        <select
          data-testid="name-size"
          value={props.nameSize}
          onChange={(e) => {
            const v = NAME_SIZES.find((s) => s === e.currentTarget.value);
            if (v) props.onNameSize(v);
          }}
        >
          {NAME_SIZES.map((v) => (
            <option key={v} value={v}>
              {t(NAME_SIZE_KEYS[v])}
            </option>
          ))}
        </select>
      </label>
      <label class="check" title={t("client.options.camera_shake_hint")}>
        <input
          type="checkbox"
          data-testid="camera-shake"
          checked={props.shake}
          onChange={(e) => props.onShake(e.currentTarget.checked)}
        />
        {t("client.options.camera_shake")}
      </label>
      <label class="scale chat-opacity" title={t("client.options.chat_opacity_hint")}>
        <span>{t("client.options.chat_opacity")}</span>
        <input
          type="range"
          data-testid="chat-opacity"
          min={CHAT_OPACITY.min}
          max={CHAT_OPACITY.max}
          step={CHAT_OPACITY.step}
          value={props.chatOpacity}
          aria-valuetext={t("client.options.percent", { percent: props.chatOpacity })}
          onInput={(e) => props.onChatOpacity(Number(e.currentTarget.value))}
        />
        <output>{t("client.options.percent", { percent: props.chatOpacity })}</output>
      </label>
      <label class="check" title={t("client.options.chat_bubbles_hint")}>
        <input
          type="checkbox"
          data-testid="chat-bubbles"
          checked={props.bubbles}
          onChange={(e) => props.onBubbles(e.currentTarget.checked)}
        />
        {t("client.options.chat_bubbles")}
      </label>
    </div>
  );
}
