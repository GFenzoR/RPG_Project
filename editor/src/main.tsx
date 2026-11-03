// Editor entry point: loads the world from the dev server and mounts the UI.
import { render } from "preact";
import { App } from "./ui/App.tsx";
import { pickLanguage, translator } from "./i18n.ts";
import { API_HEADER, fromWire } from "./io/wire.ts";
import type { Bootstrap } from "./io/wire.ts";
import { EditorController } from "./state/editor.ts";
import { tileAt } from "./tools/tools.ts";
import type { MapCanvas } from "./canvas/map-canvas.ts";
import "./ui/editor.css";

/** Read-only hooks for the E2E tests (editor/e2e). */
export interface EditorTestHooks {
  ready: boolean;
  tile(x: number, y: number, z: number): { ground: string | null; stack: string[] } | undefined;
  tileToClient(x: number, y: number): { x: number; y: number };
  centerOn(x: number, y: number, z: number): void;
  state(): {
    island: string;
    floor: number;
    zoom: number;
    dirty: boolean;
    validating: boolean;
  };
}

declare global {
  interface Window {
    __rpgEditor?: EditorTestHooks;
  }
}

async function start(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  const res = await fetch("/api/bootstrap", { headers: { [API_HEADER]: "1" } });
  const boot = (await res.json()) as Bootstrap;
  const lang = pickLanguage(
    Object.keys(boot.i18n),
    new URLSearchParams(location.search).get("lang"),
    navigator.language,
  );
  document.documentElement.lang = lang;
  const t = translator(boot.i18n[lang] ?? {});
  document.title = t("editor.title");
  const ctl = new EditorController({
    world: fromWire(boot.world),
    items: boot.items,
    t,
    loadErrors: boot.loadErrors,
    base: boot.base,
    borders: boot.borders,
    monsters: boot.monsters,
    npcs: boot.npcs,
    island: new URLSearchParams(location.search).get("island"),
  });
  // Unsaved changes: the browser asks before closing or reloading the page.
  window.addEventListener("beforeunload", (e) => {
    if (!ctl.state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });
  const onCanvas = (c: MapCanvas): void => {
    window.__rpgEditor = {
      ready: true,
      tile: (x, y, z) => tileAt(ctl.state.world, x, y, z),
      tileToClient: (x, y) => c.tileToClient(x, y),
      centerOn: (x, y, z) => ctl.centerTile(x, y, z, c.atlas.tileSize),
      state: () => ({
        island: ctl.state.island,
        floor: ctl.state.floor,
        zoom: ctl.state.camera.zoom,
        dirty: ctl.state.dirty,
        validating: ctl.state.validating,
      }),
    };
  };
  render(<App ctl={ctl} onCanvas={onCanvas} />, root);
}

void start();
