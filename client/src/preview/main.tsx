// UI preview (make ui-preview): the game screen's DOM with a made-up state and a picture of
// the map in place of the canvas, to look at the interface at any window size without a
// server, Postgres or a character (docs/08). Only built with RPG_UI_PREVIEW=1
// (vite.config.ts): it never ships.
//
//   /preview/?scene=game|windows|dialog|danger|death|login|characters&lang=es|en
//
// The windows' state comes from localStorage (rpg.windows), as in the game: the screenshot
// script (e2e/ui-preview.ts) writes it for each scene.
import "pixi.js/unsafe-eval";
import { render } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import content from "virtual:rpg-content";
import { translator } from "../i18n/i18n.ts";
import { App } from "../ui/App.tsx";
import { GameView } from "../ui/GameView.tsx";
import type { GameSettings } from "../ui/GameView.tsx";
import { LanguagePicker } from "../ui/LanguagePicker.tsx";
import { TouchPadToggle } from "../ui/TouchPad.tsx";
import { SoundOptions } from "../ui/AudioOptions.tsx";
import { defaultPrefs } from "../audio/prefs.ts";
import type { AudioPrefs } from "../audio/prefs.ts";
import type { AudioEngine } from "../audio/engine.ts";
import { ControlsOptions } from "../ui/ControlsOptions.tsx";
import { pixelScale } from "../render/viewport.ts";
import { loadIcons } from "../site/shop.ts";
import type { SpriteIcon } from "../site/shop.ts";
import type { Game } from "../game.ts";
import type { ItemDef } from "../content-types.ts";
import { baseScene, withDanger, withDeath, withDialog } from "./fixtures.ts";
import "../ui/client.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "game";
const lang = params.get("lang") ?? "es";
const t = translator(content.i18n[lang] ?? {}, lang);
document.documentElement.lang = lang;

/** A Game that only answers what the UI reads (icons, cooldowns); every intent is dropped. */
function stubGame(icons: Map<string, SpriteIcon>): Game {
  const answers: Record<string, unknown> = {
    itemIcon: (id: number) => {
      const sprite = content.items[id]?.sprite;
      return sprite ? icons.get(sprite) : undefined;
    },
    markIcon: () => undefined,
    spellCooldown: (id: string) => (id === content.spells[1]?.id ? 0.6 : 0),
  };
  return new Proxy({} as Game, {
    get: (_, key) => answers[String(key)] ?? (() => undefined),
  });
}

/** An AudioEngine that only keeps its preferences: the Options window's sliders read it. */
function stubAudio(): AudioEngine {
  let prefs: AudioPrefs = defaultPrefs();
  const answers: Record<string, unknown> = {
    currentPrefs: () => prefs,
    setPrefs: (next: AudioPrefs) => {
      prefs = next;
    },
  };
  return new Proxy({} as AudioEngine, {
    get: (_, key) => answers[String(key)] ?? (() => undefined),
  });
}
const audio = stubAudio();

/**
 * The map picture where the canvas goes, as large as the canvas would be. mapcli render
 * draws rulers on the top and left of its PNG: ?mapx= and ?mapy= are their size, cut off.
 */
function MapPicture(props: { host: { current: HTMLDivElement | null } }): null {
  useEffect(() => {
    const host = props.host.current;
    if (!host) return undefined;
    const ox = Number(params.get("mapx") ?? 0);
    const oy = Number(params.get("mapy") ?? 0);
    const map = document.createElement("div");
    map.dataset["testid"] = "game-canvas";
    map.style.backgroundImage = "url(/preview-map.png)";
    map.style.backgroundRepeat = "no-repeat";
    map.style.imageRendering = "pixelated";
    host.prepend(map);
    const fit = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const k = pixelScale(host.clientWidth, host.clientHeight, dpr, 32) / dpr;
      map.style.width = `${15 * 32 * k}px`;
      map.style.height = `${11 * 32 * k}px`;
      map.style.backgroundSize = `${(15 * 32 + ox) * k}px ${(11 * 32 + oy) * k}px`;
      map.style.backgroundPosition = `${-ox * k}px ${-oy * k}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    fit();
    return () => {
      observer.disconnect();
      map.remove();
    };
  }, []);
  return null;
}

function Preview(props: { game: Game }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const now = performance.now();
  let s = baseScene(content, now);
  if (scene === "dialog") s = withDialog(content, s);
  if (scene === "danger") s = withDanger(s, now);
  if (scene === "death") s = withDeath(s, now);
  const settings: GameSettings = {
    language: (
      <LanguagePicker t={t} lang={lang} languages={Object.keys(content.i18n)} onChange={() => {}} />
    ),
    sound: <SoundOptions t={t} audio={audio} storage={undefined} />,
    touchPad: <TouchPadToggle t={t} on={false} onChange={() => {}} />,
    controlsMode: "menu",
    controls: <ControlsOptions t={t} mode="menu" onChange={() => {}} />,
    reducedMotion: false,
    setReducedMotion: () => {},
  };
  return (
    <>
      <GameView
        t={t}
        content={content}
        languagePicker={settings.language}
        settings={settings}
        touchPad={false}
        characterName={s.ui.selfName}
        ui={s.ui}
        game={props.game}
        entered={true}
        loadFailed={false}
        onRetry={() => {}}
        host={host}
        storage={window.localStorage}
      />
      <MapPicture host={host} />
    </>
  );
}

const root = document.getElementById("app");
if (root) {
  if (scene === "login" || scene === "characters") {
    render(<App content={content} t={t} locale={lang} />, root);
  } else {
    const defs: ItemDef[] = Object.values(content.items);
    const names = defs.flatMap((d) => (d.sprite ? [d.sprite] : []));
    loadIcons(names, { base: new URL("/atlas/", location.href).href }).then(
      (icons) => render(<Preview game={stubGame(icons)} />, root),
      () => render(<Preview game={stubGame(new Map())} />, root),
    );
  }
}
