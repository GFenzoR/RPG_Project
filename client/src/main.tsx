// Client entry point: picks the language, then mounts the screens (login → characters →
// game). Content (items, movement constants, texts) is bundled from data/ and i18n/.
// Pixi without eval/new Function: the desktop app's CSP (apps/desktop) has no 'unsafe-eval'.
import "pixi.js/unsafe-eval";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import content from "virtual:rpg-content";
import { initDesktop } from "./net/desktop.ts";
import { LANGUAGE_STORAGE_KEY, pickLanguage, takeLangParam, translator } from "./i18n/i18n.ts";
import { App } from "./ui/App.tsx";
import { LanguagePicker } from "./ui/LanguagePicker.tsx";
import { AudioOptions, SoundOptions } from "./ui/AudioOptions.tsx";
import { TouchPadToggle } from "./ui/TouchPad.tsx";
import { ControlsOptions } from "./ui/ControlsOptions.tsx";
import { loadControls, saveControls } from "./state/controls.ts";
import { coarsePointer, loadTouchPad, saveTouchPad } from "./state/touch-prefs.ts";
import {
  applyEffects,
  deviceHints,
  loadEffects,
  loadTouchPrefs,
  saveEffects,
  saveTouchPrefs,
} from "./state/touch-controls.ts";
import { browserVibrate } from "./state/haptics.ts";
import { TouchOptions } from "./ui/TouchOptions.tsx";
import { AppModeButtons } from "./ui/AppMode.tsx";
import { appMode } from "./ui/app-mode.ts";
import {
  applyReducedMotion,
  applyChatOpacity,
  applyScales,
  loadCameraShake,
  loadChatBubbles,
  loadChatOpacity,
  loadNameSize,
  loadReducedMotion,
  loadTextScale,
  loadUiScale,
  saveCameraShake,
  saveChatBubbles,
  saveChatOpacity,
  saveNameSize,
  saveReducedMotion,
  saveTextScale,
  saveUiScale,
} from "./state/ui-prefs.ts";
import { InterfaceOptions } from "./ui/InterfaceOptions.tsx";
import { AudioEngine, browserPorts } from "./audio/engine.ts";
import type { MusicState } from "./audio/engine.ts";
import { loadPrefs } from "./audio/prefs.ts";
import { optionStorage } from "./state/option-storage.ts";
import "./ui/client.css";
// Installable web client (T5.6): registers the service worker on import (production only).
import "./pwa.ts";

const languages = Object.keys(content.i18n);

// One engine for the whole page (T3.7): the menus click too, and the context survives
// leaving and entering the game.
// Every option goes through the watched storage: a change reaches the account's saved
// options a moment later (state/option-storage.ts).
const storage = optionStorage();
// Lote 21: the app-mode store listens from the start (Chromium fires beforeinstallprompt
// once, early: ui/app-mode.ts keeps it for the install button).
appMode();
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
      loops(): { music: string | undefined; ambient: string | undefined; ambience: string[] };
      /** The music director's state: its pool and voices (audio/engine.ts MusicState). */
      music(): MusicState;
    };
  }
}
// E2E hook (docs/08): only in the dev server or an RPG_E2E_HOOKS=1 build (vite.config.ts).
if (__RPG_E2E_HOOKS__) {
  window.__rpgAudio = {
    unlocked: () => audio.unlocked,
    history: () => [...audio.history],
    loops: () => audio.playingLoops(),
    music: () => audio.musicState(),
  };
}

function readStored(): string | null {
  try {
    return storage?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function store(lang: string): void {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, lang);
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

/** Holds the language: changing it re-renders every screen, the game included. */
function Root(): JSX.Element {
  const [lang, setLang] = useState(() =>
    pickLanguage(languages, urlLang.lang, navigator.language, readStored()),
  );
  const t = useMemo(() => translator(content.i18n[lang] ?? {}, lang), [lang]);
  // T5.6: the on-screen direction pad, switched in Options (on by default on touch screens).
  const [touchPad, setTouchPad] = useState(() => loadTouchPad(storage, coarsePointer()));
  // Lote 21 (docs/15): the touch controls of this device and its effects preset (picked by
  // a quick capability check until the player chooses).
  const [touchPrefs, setTouchPrefs] = useState(() => loadTouchPrefs(storage));
  const [effects, setEffects] = useState(() => loadEffects(storage, deviceHints()));
  useEffect(() => {
    applyEffects(document.documentElement, effects);
  }, [effects]);
  // docs/17 UI-6: what the right button does on items (Options → Controls).
  const [controls, setControls] = useState(() => loadControls(storage));
  // docs/17 UI-9: "reduced animations" (Options), on top of prefers-reduced-motion.
  const [reducedMotion, setReducedMotion] = useState(() => loadReducedMotion(storage));
  useEffect(() => {
    applyReducedMotion(document.documentElement, reducedMotion);
  }, [reducedMotion]);
  // docs/17 UI-3, UI-9: the interface scale, the text size and the camera shake (Options).
  const [uiScale, setUiScale] = useState(() => loadUiScale(storage));
  const [textScale, setTextScale] = useState(() => loadTextScale(storage));
  const [shake, setShake] = useState(() => loadCameraShake(storage));
  // docs/17 UI-11: the speech bubbles over the heads (Options → Interface).
  const [bubbles, setBubbles] = useState(() => loadChatBubbles(storage));
  // docs/17 UI-3: how big the names over creatures are (Options → Interface).
  const [nameSize, setNameSize] = useState(() => loadNameSize(storage));
  useEffect(() => {
    applyScales(document.documentElement, uiScale, textScale);
  }, [uiScale, textScale]);
  // docs/17 UI-10: how much the chat's background covers the map (Options → Interface).
  const [chatOpacity, setChatOpacity] = useState(() => loadChatOpacity(storage));
  useEffect(() => {
    applyChatOpacity(document.documentElement, chatOpacity);
  }, [chatOpacity]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t("client.title");
  }, [lang, t]);
  // The account's saved options arrived after the login and differ from what this
  // browser had: every option state reads its value again (the server won).
  const [syncs, setSyncs] = useState(0);
  const reloadOptions = (): void => {
    const stored = readStored();
    if (stored !== null && languages.includes(stored)) setLang(stored);
    setTouchPad(loadTouchPad(storage, coarsePointer()));
    setTouchPrefs(loadTouchPrefs(storage));
    setEffects(loadEffects(storage, deviceHints()));
    setControls(loadControls(storage));
    setReducedMotion(loadReducedMotion(storage));
    setUiScale(loadUiScale(storage));
    setTextScale(loadTextScale(storage));
    setShake(loadCameraShake(storage));
    setBubbles(loadChatBubbles(storage));
    setNameSize(loadNameSize(storage));
    setChatOpacity(loadChatOpacity(storage));
    audio.setPrefs(loadPrefs(storage));
    setSyncs((n) => n + 1); // the sound sliders mount again with the engine's values
  };
  const language = (): JSX.Element => (
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
  const padToggle = (): JSX.Element => (
    <>
      <TouchPadToggle
        t={t}
        on={touchPad}
        onChange={(on) => {
          saveTouchPad(on, storage);
          setTouchPad(on);
        }}
      />
      <TouchOptions
        t={t}
        prefs={touchPrefs}
        canVibrate={browserVibrate(navigator, coarsePointer()) !== undefined}
        effects={effects}
        onChange={(next) => {
          saveTouchPrefs(next, storage);
          setTouchPrefs(next);
        }}
        onEffects={(next) => {
          saveEffects(next, storage);
          setEffects(next);
        }}
      />
    </>
  );
  const interfaceOptions = (): JSX.Element => (
    <InterfaceOptions
      t={t}
      uiScale={uiScale}
      textScale={textScale}
      shake={shake}
      chatOpacity={chatOpacity}
      bubbles={bubbles}
      nameSize={nameSize}
      onNameSize={(v) => {
        saveNameSize(v, storage);
        setNameSize(v);
      }}
      onUiScale={(v) => {
        saveUiScale(v, storage);
        setUiScale(v);
      }}
      onTextScale={(v) => {
        saveTextScale(v, storage);
        setTextScale(v);
      }}
      onShake={(on) => {
        saveCameraShake(on, storage);
        setShake(on);
      }}
      onChatOpacity={(v) => {
        saveChatOpacity(v, storage);
        setChatOpacity(v);
      }}
      onBubbles={(on) => {
        saveChatBubbles(on, storage);
        setBubbles(on);
      }}
    />
  );
  // The login screen's corner and the phone menu: the language and the Options button.
  const picker = (
    <>
      {language()}
      {/* Full screen and "install as an app" (docs/15): on the login and character screens
          and in the game's menu; once the install offer is dismissed it stays in Options. */}
      <AppModeButtons t={t} where="screen" />
      <AudioOptions key={syncs} t={t} audio={audio} storage={storage}>
        {padToggle()}
        {interfaceOptions()}
        <AppModeButtons t={t} where="options" fallback={true} />
      </AudioOptions>
    </>
  );
  return (
    <App
      content={content}
      t={t}
      locale={lang}
      languagePicker={picker}
      settings={{
        language: language(),
        sound: <SoundOptions key={syncs} t={t} audio={audio} storage={storage} />,
        touchPad: (
          <>
            {padToggle()}
            <AppModeButtons t={t} where="options" />
          </>
        ),
        controlsMode: controls,
        controls: (
          <ControlsOptions
            t={t}
            mode={controls}
            onChange={(m) => {
              saveControls(m, storage);
              setControls(m);
            }}
          />
        ),
        reducedMotion,
        setReducedMotion: (on) => {
          saveReducedMotion(on, storage);
          setReducedMotion(on);
        },
        uiScale,
        cameraShake: shake,
        chatBubbles: bubbles,
        nameSize,
        interfaceOptions: interfaceOptions(),
      }}
      audio={audio}
      touchPad={touchPad}
      touchControls={touchPrefs}
      onOptionsSynced={reloadOptions}
    />
  );
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
