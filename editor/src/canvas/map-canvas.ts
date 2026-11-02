// The map canvas: a PixiJS application with the shared MapView, the editor overlays
// (island bounds, grid, brush cursor) and mouse/keyboard input mapped to controller calls.
import { Application, Graphics, TextureStyle } from "pixi.js";
import type { Texture } from "pixi.js";
import { chunkKey } from "@rpg/map-format/ops";
import { Atlas, MISSING_TEXTURE, MapView, screenToTile, tilePixels } from "@rpg/renderer";
import type { TileSource } from "@rpg/renderer";
import type { EditorController } from "../state/editor.ts";
import { brushCells } from "../tools/tools.ts";

/** Below this zoom the 1px grid lines alias into stripes, so the grid is hidden. */
const GRID_MIN_ZOOM = 0.6;

const COLORS = {
  background: 0x0e1116,
  island: 0xe0b84a,
  grid: 0xffffff,
  cursor: 0xffffff,
  eraser: 0xff5a5a,
};

export interface MapCanvas {
  readonly atlas: Atlas;
  /** Client (page) coordinates of the centre of tile (x, y), for tests and tooling. */
  tileToClient(x: number, y: number): { x: number; y: number };
  destroy(): void;
}

export async function createMapCanvas(
  host: HTMLElement,
  ctl: EditorController,
): Promise<MapCanvas> {
  TextureStyle.defaultOptions.scaleMode = "nearest";
  const atlas = await Atlas.load(new URL("/atlas/", location.href).href);
  const T = atlas.tileSize;
  const app = new Application();
  await app.init({
    resizeTo: host,
    background: COLORS.background,
    antialias: false,
    preference: "webgl",
  });
  app.canvas.dataset["testid"] = "map-canvas";
  host.appendChild(app.canvas);

  const textures = new Map<string, Texture>();
  const texture = (id: string): Texture => {
    let tex = textures.get(id);
    if (!tex) {
      const sprite = ctl.items.get(id)?.sprite;
      tex = (sprite && atlas.texture(sprite)) || MISSING_TEXTURE;
      textures.set(id, tex);
    }
    return tex;
  };
  const source: TileSource = {
    chunk(z, cx, cy) {
      const key = chunkKey(z, cx, cy);
      for (const isl of ctl.state.world.islands.values()) {
        const c = isl.chunks.get(key);
        if (c) return c;
      }
      return undefined;
    },
  };
  const view = new MapView({ source, texture, tileSize: T, floor: ctl.state.floor });
  const bounds = new Graphics();
  const grid = new Graphics();
  const cursor = new Graphics();
  view.overlay.addChild(bounds, grid, cursor);
  app.stage.addChild(view.root);

  const size = (): { width: number; height: number } => ({
    width: app.screen.width,
    height: app.screen.height,
  });
  ctl.setView(size(), T);

  let drawn = {
    camera: ctl.state.camera,
    floor: NaN,
    grid: !ctl.state.grid,
    hover: ctl.state.hover,
    tool: "",
    brush: 0,
    w: 0,
    h: 0,
  };
  const redrawOverlays = (): void => {
    const s = ctl.state;
    const scr = size();
    const px = 1 / (tilePixels(s.camera, T) / T); // one screen pixel in world units
    bounds.clear();
    for (const isl of s.world.islands.values()) {
      if (!isl.meta.floors.includes(s.floor)) continue;
      const r = isl.meta.rect;
      bounds
        .rect(r.x * T, r.y * T, r.w * T, r.h * T)
        .stroke({ width: 2 * px, color: COLORS.island, alpha: 0.9 });
    }
    grid.clear();
    if (s.grid && s.camera.zoom >= GRID_MIN_ZOOM) {
      const p = tilePixels(s.camera, T);
      const x0 = Math.floor(s.camera.x);
      const y0 = Math.floor(s.camera.y);
      const x1 = Math.ceil(s.camera.x + scr.width / p);
      const y1 = Math.ceil(s.camera.y + scr.height / p);
      for (let x = x0; x <= x1; x++) grid.moveTo(x * T, y0 * T).lineTo(x * T, y1 * T);
      for (let y = y0; y <= y1; y++) grid.moveTo(x0 * T, y * T).lineTo(x1 * T, y * T);
      grid.stroke({ width: px, color: COLORS.grid, alpha: 0.12 });
    }
    cursor.clear();
    if (s.hover) {
      const cells = s.tool === "item" ? [s.hover] : brushCells(s.hover.x, s.hover.y, s.brushSize);
      const color = s.tool === "eraser" ? COLORS.eraser : COLORS.cursor;
      for (const c of cells) cursor.rect(c.x * T, c.y * T, T, T);
      cursor.stroke({ width: 2 * px, color, alpha: 0.9 });
    }
  };

  app.ticker.add(() => {
    const s = ctl.state;
    const scr = size();
    if (scr.width !== drawn.w || scr.height !== drawn.h) ctl.setView(scr, T);
    view.setFloor(s.floor);
    view.render(s.camera, scr);
    if (
      drawn.camera !== s.camera ||
      drawn.floor !== s.floor ||
      drawn.grid !== s.grid ||
      drawn.hover !== s.hover ||
      drawn.tool !== s.tool ||
      drawn.brush !== s.brushSize ||
      drawn.w !== scr.width ||
      drawn.h !== scr.height
    ) {
      redrawOverlays();
      drawn = {
        camera: s.camera,
        floor: s.floor,
        grid: s.grid,
        hover: s.hover,
        tool: s.tool,
        brush: s.brushSize,
        w: scr.width,
        h: scr.height,
      };
    }
  });

  // ---- input ---------------------------------------------------------------------------
  const canvas = app.canvas;
  let spaceHeld = false;
  let panning: { x: number; y: number } | undefined;
  let painting = false;
  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const tileOf = (e: PointerEvent | MouseEvent): { x: number; y: number } => {
    const p = local(e);
    return screenToTile(ctl.state.camera, p.x, p.y, T);
  };

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      panning = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    painting = true;
    const t = tileOf(e);
    ctl.strokeStart(t.x, t.y, e.button === 2 || e.shiftKey);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (panning) {
      ctl.pan(e.clientX - panning.x, e.clientY - panning.y, T);
      panning = { x: e.clientX, y: e.clientY };
      return;
    }
    const t = tileOf(e);
    ctl.setHover(t);
    if (painting) ctl.strokeMove(t.x, t.y);
  });
  const end = (): void => {
    panning = undefined;
    if (painting) ctl.strokeEnd();
    painting = false;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => ctl.setHover(undefined));
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = local(e);
      ctl.zoom(Math.pow(1.0015, -e.deltaY), p.x, p.y, T);
    },
    { passive: false },
  );

  const typing = (e: KeyboardEvent): boolean => {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void ctl.save();
      return;
    }
    if (typing(e)) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) ctl.redo();
      else ctl.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      ctl.redo();
    } else if (mod) {
      return;
    } else if (e.key === " ") {
      spaceHeld = true;
      e.preventDefault();
    } else if (e.key === "PageUp") {
      e.preventDefault();
      ctl.changeFloor(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      ctl.changeFloor(1);
    } else if (e.key === "b" || e.key === "B") ctl.setTool("brush");
    else if (e.key === "e" || e.key === "E") ctl.setTool("eraser");
    else if (e.key === "i" || e.key === "I") ctl.setTool("item");
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === " ") spaceHeld = false;
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return {
    atlas,
    tileToClient(x, y) {
      const r = canvas.getBoundingClientRect();
      const p = tilePixels(ctl.state.camera, T);
      return {
        x: r.left + (x + 0.5 - ctl.state.camera.x) * p,
        y: r.top + (y + 0.5 - ctl.state.camera.y) * p,
      };
    },
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      view.destroy();
      app.destroy(true);
    },
  };
}
