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
import { AudioOptions } from "./ui/AudioOptions.tsx";
import { AudioEngine, browserPorts } from "./audio/engine.ts";
import { loadPrefs } from "./audio/prefs.ts";
import "./ui/client.css";

const languages = Object.keys(content.i18n);

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// One engine for the whole page (T3.7): the menus click too, and the context survives
// leaving and entering the game.
const storage = safeStorage();
const audio = new AudioEngine(content.sounds, loadPrefs(storage), browserPorts());
// Browsers only start audio after a gesture: the first one unlocks it. On touch screens
// pointerdown does not count as one (pointerup, touchend and click do).
const unlock = (): void => audio.unlock();
for (const ev of ["pointerdown", "pointerup", "touchend", "click", "keydown"])
  window.addEventListener(ev, unlock, { capture: true });
// Every button of the DOM UI clicks.
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest("button")) audio.play(["ui.click"]);
});

declare global {
  interface Window {
    /** Read-only audio hooks for the E2E tests. */
    __rpgAudio?: {
      unlocked(): boolean;
      history(): string[];
      loops(): { music: string | undefined; ambient: string | undefined };
    };
  }
}
window.__rpgAudio = {
  unlocked: () => audio.unlocked,
  history: () => [...audio.history],
  loops: () => audio.playingLoops(),
};

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
    <>
      <LanguagePicker
        t={t}
        lang={lang}
        languages={languages}
        onChange={(l) => {
          store(l);
          setLang(l);
        }}
      />
      <AudioOptions t={t} audio={audio} storage={storage} />
    </>
  );
  return <App content={content} t={t} locale={lang} languagePicker={picker} audio={audio} />;
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
