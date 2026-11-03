// Client entry point: picks the language, then mounts the screens (login → characters →
// game). Content (items, movement constants, texts) is bundled from data/ and i18n/.
// Pixi without eval/new Function: the desktop app's CSP (apps/desktop) has no 'unsafe-eval'.
import "pixi.js/unsafe-eval";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import content from "virtual:rpg-content";
import { initDesktop } from "./net/desktop.ts";
import { LANGUAGE_STORAGE_KEY, pickLanguage, translator } from "./i18n/i18n.ts";
import { App } from "./ui/App.tsx";
import { LanguagePicker } from "./ui/LanguagePicker.tsx";
import "./ui/client.css";

const languages = Object.keys(content.i18n);

function readStored(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(lang: string): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // storage blocked: the choice lasts until the page reloads
  }
}

/** Holds the language: changing it re-renders every screen, the game included. */
function Root(): JSX.Element {
  const [lang, setLang] = useState(() =>
    pickLanguage(
      languages,
      new URLSearchParams(location.search).get("lang"),
      navigator.language,
      readStored(),
    ),
  );
  const t = useMemo(() => translator(content.i18n[lang] ?? {}, lang), [lang]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("client.title");
  }, [lang, t]);
  const picker = (
    <LanguagePicker
      t={t}
      lang={lang}
      languages={languages}
      onChange={(l) => {
        store(l);
        setLang(l);
      }}
    />
  );
  return <App content={content} t={t} locale={lang} languagePicker={picker} />;
}

const root = document.getElementById("app");
// In the desktop app, ask it for the game server first (net/desktop.ts); on the web this
// resolves at once.
if (root)
  initDesktop().then(
    () => render(<Root />, root),
    (err: unknown) => {
      console.error("desktop: no server info", err);
      render(<Root />, root);
    },
  );
