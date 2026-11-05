// Entry point of the public website (T4.3): index.html at /. Shares the language choice,
// the translator and the base styles with the game page (/play/, src/main.tsx).
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import site from "virtual:rpg-site";
import { LANGUAGE_STORAGE_KEY, pickLanguage, takeLangParam, translator } from "../i18n/i18n.ts";
import { LanguagePicker } from "../ui/LanguagePicker.tsx";
import { Site } from "./Site.tsx";
import "../ui/client.css";
import "./site.css";

const languages = Object.keys(site.i18n);

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

// ?lang= is read once: stored as the choice and removed from the URL (takeLangParam).
const urlLang = takeLangParam(location.search);
if (urlLang.lang !== null) {
  if (languages.includes(urlLang.lang)) store(urlLang.lang);
  history.replaceState(history.state, "", location.pathname + urlLang.rest + location.hash);
}

function Root(): JSX.Element {
  const [lang, setLang] = useState(() =>
    pickLanguage(languages, urlLang.lang, navigator.language, readStored()),
  );
  const t = useMemo(() => translator(site.i18n[lang] ?? {}, lang), [lang]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t("site.hero.tagline"));
  }, [lang, t]);
  return (
    <Site
      site={site}
      t={t}
      lang={lang}
      languagePicker={
        <LanguagePicker
          t={t}
          lang={lang}
          languages={languages}
          onChange={(l) => {
            store(l);
            setLang(l);
          }}
        />
      }
    />
  );
}

const root = document.getElementById("site");
if (root) render(<Root />, root);
