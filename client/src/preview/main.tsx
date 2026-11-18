// UI preview (make ui-preview): the game screen's DOM with a made-up state and a picture of
// the map in place of the canvas, to look at the interface at any window size without a
// server, Postgres or a character (docs/08). Only built with RPG_UI_PREVIEW=1
// (vite.config.ts): it never ships.
//
//   /preview/?scene=game|windows|dialog|shop|dialog18|itemmenu|server|groundtip|danger|death|
//     login|characters&lang=es|en[&ui=1.25&text=1.15]
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
import { mapLift } from "../render/viewport.ts";
import { viewPixels, zoomRange } from "../render/zoom.ts";
import { loadIcons } from "../site/shop.ts";
import type { SpriteIcon } from "../site/shop.ts";
import type { Game } from "../game.ts";
import type { ItemDef } from "../content-types.ts";
import {
  baseScene,
  withDanger,
  withDeath,
  withDialog,
  withGroundTip,
  withItemMenu,
  withManyOptions,
  withServerWindows,
  withShop,
} from "./fixtures.ts";
import { InterfaceOptions } from "../ui/InterfaceOptions.tsx";
import { applyScales } from "../state/ui-prefs.ts";
import { SLOT_KEYS } from "../ui/Inventory.tsx";
import "../ui/client.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "game";
// docs/17 UI-3: ?ui=1.25&text=1.15 show the interface scale and the text size.
const uiScale = Number(params.get("ui") ?? 1) || 1;
const textScale = Number(params.get("text") ?? 1) || 1;
applyScales(document.documentElement, uiScale, textScale);
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
    spriteIcon: (path: string) => icons.get(path),
    menuPressed: false,
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
 * The server's window (Welcome.view_width/height, docs/05) and the area mapcli draws for
 * the picture: the window with its margin of one tile (e2e/ui-preview.ts MAP_AREA).
 */
const PREVIEW_VIEW = { width: 31, height: 21 } as const;
const PICTURE = { width: PREVIEW_VIEW.width + 2, height: PREVIEW_VIEW.height + 2 } as const;

/**
 * The map picture where the canvas goes, as large as the canvas would be at the fitted
 * zoom (render/zoom.ts, the same math as render/game-canvas.ts) and centred on the
 * picture's middle tile. mapcli render draws rulers on the top and left of its PNG: ?mapx=
 * and ?mapy= are their size, cut off.
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
    map.style.flex = "none";
    host.prepend(map);
    const fit = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const style = getComputedStyle(host);
      const px = (v: string): number => parseFloat(v) || 0;
      const boxW = Math.max(0, host.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
      const boxH = Math.max(0, host.clientHeight - px(style.paddingTop) - px(style.paddingBottom));
      const scale = zoomRange(boxW, boxH, dpr, 32, PREVIEW_VIEW).fit;
      const reserve = px(style.getPropertyValue("--map-reserve-bottom"));
      const view = viewPixels(
        Math.floor(boxW * dpr),
        Math.floor(boxH * dpr),
        scale,
        32,
        PREVIEW_VIEW,
        Math.ceil(reserve * dpr),
      );
      const k = scale / dpr; // CSS px per sprite px
      const w = view.width / dpr;
      const h = view.height / dpr;
      map.style.width = `${w}px`;
      map.style.height = `${h}px`;
      const lift = mapLift(boxH, h, reserve);
      map.style.marginBottom = lift > 0 ? `${lift}px` : "";
      map.style.backgroundSize = `${(PICTURE.width * 32 + ox) * k}px ${(PICTURE.height * 32 + oy) * k}px`;
      const cx = (ox + (PICTURE.width / 2) * 32) * k;
      const cy = (oy + (PICTURE.height / 2) * 32) * k;
      map.style.backgroundPosition = `${w / 2 - cx}px ${h / 2 - cy}px`;
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
  if (scene === "shop") s = withShop(content, s);
  if (scene === "dialog18") s = withManyOptions(content, s);
  if (scene === "itemmenu")
    s = withItemMenu(content, s, (id) => t(`item.${id}.name`), {
      x: Math.round(window.innerWidth * 0.45),
      y: Math.round(window.innerHeight * 0.3),
    });
  if (scene === "danger") s = withDanger(s, now);
  if (scene === "death") s = withDeath(s, now);
  if (scene === "server")
    s = withServerWindows(content, s, {
      x: Math.round(window.innerWidth * 0.35),
      y: Math.round(window.innerHeight * 0.55),
    });
  if (scene === "groundtip")
    s = withGroundTip(content, s, {
      x: Math.round(window.innerWidth * 0.3),
      y: Math.round(window.innerHeight * 0.35),
    });
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
    uiScale,
    cameraShake: true,
    interfaceOptions: (
      <InterfaceOptions
        t={t}
        uiScale={uiScale}
        textScale={textScale}
        shake={true}
        onUiScale={() => {}}
        onTextScale={() => {}}
        onShake={() => {}}
      />
    ),
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
    const names: string[] = [
      ...defs.flatMap((d) => (d.sprite ? [d.sprite] : [])),
      ...Object.values<string>(content.npcSprites ?? {}),
      // The empty equipment slots (docs/17 UI-5).
      ...Object.values(SLOT_KEYS).map((k) => `ui/slots/${k}`),
    ];
    loadIcons(names, { base: new URL("/atlas/", location.href).href }).then(
      (icons) => render(<Preview game={stubGame(icons)} />, root),
      () => render(<Preview game={stubGame(new Map())} />, root),
    );
  }
}
