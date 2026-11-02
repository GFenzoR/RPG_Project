// Client entry point: picks the language, then mounts the screens (login → characters →
// game). Content (items, movement constants, texts) is bundled from data/ and i18n/.
import { render } from "preact";
import content from "virtual:rpg-content";
import { pickLanguage, translator } from "./i18n/i18n.ts";
import { App } from "./ui/App.tsx";
import "./ui/client.css";

const root = document.getElementById("app");
if (root) {
  const lang = pickLanguage(
    Object.keys(content.i18n),
    new URLSearchParams(location.search).get("lang"),
    navigator.language,
  );
  document.documentElement.lang = lang;
  const t = translator(content.i18n[lang] ?? {});
  document.title = t("client.title");
  render(<App content={content} t={t} locale={lang} />, root);
}
