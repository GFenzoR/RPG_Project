// Language selector (T1.13): every screen shows it; the choice is kept in localStorage
// (i18n.LANGUAGE_STORAGE_KEY) and wins over the browser language, not over ?lang=.
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";

export function LanguagePicker(props: {
  t: Translate;
  lang: string;
  languages: readonly string[];
  onChange(lang: string): void;
}): JSX.Element {
  const { t } = props;
  return (
    <label class="language">
      <span>{t("client.language.label")}</span>
      <select
        data-testid="language"
        value={props.lang}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        {props.languages.map((l) => (
          <option key={l} value={l}>
            {t(`client.language.${l}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
