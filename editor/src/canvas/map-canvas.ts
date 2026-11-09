// The map canvas: a PixiJS application with the shared MapView, the editor overlays
// (island bounds, grid, brush cursor) and mouse/keyboard input mapped to controller calls.
import { Application, Graphics, TextureStyle } from "pixi.js";
import type { Texture } from "pixi.js";
import { chunkKey } from "@rpg/map-format/ops";
import { Atlas, MISSING_TEXTURE, MapView, screenToTile, tilePixels } from "@rpg/renderer";
import type { TileSource } from "@rpg/renderer";
import type { EditorController } from "../state/editor.ts";
import { TOOL_KEYS, brushCells } from "../tools/tools.ts";
import { entityKey, entityPos } from "../state/editor.ts";

/** Below this zoom the 1px grid lines alias into stripes, so the grid is hidden. */
const GRID_MIN_ZOOM = 0.6;

const COLORS = {
  background: 0x0e1116,
  island: 0xe0b84a,
  house: 0xd070ff,
  grid: 0xffffff,
  cursor: 0xffffff,
  eraser: 0xff5a5a,
  selection: 0x4ad0ff,
  paste: 0x7dff7a,
  spawn: 0xff4040,
  npc: 0xffd84a,
  portal: 0xff4aff,
  selected: 0xffffff,
  /** Review: tiles that differ from the loaded world, and patch conflicts. */
  changed: 0xff4aff,
  conflict: 0xff2020,
};

/** Zone colours, as mapcli render draws them (docs/04-map-editor-and-ai.md). */
const ZONE_COLORS: Record<string, number> = {
  protection: 0x40e0e0,
  no_logout: 0xff9a30,
  pvp: 0xff3030,
  no_pvp: 0x40d040,
  community_plot: 0xb060ff,
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
      for (const isl of ctl.viewWorld().islands.values()) {
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
  const entities = new Graphics();
  const changes = new Graphics();
  view.overlay.addChild(bounds, changes, entities, grid, cursor);
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
    world: ctl.state.world,
    marks: "",
  };
  /** Selection/drag/paste/entity state the overlays depend on, as one comparable string. */
  const marks = (): string => {
    const s = ctl.state;
    return JSON.stringify([
      s.drag,
      s.selection,
      s.selectionFloor,
      s.pasting,
      s.entitySel,
      s.entityTab,
      s.review,
      s.reviewSide,
      s.patchConflicts.length,
    ]);
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
    drawChanges(px);
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
    if (s.selection && s.selectionFloor === s.floor) {
      const r = s.selection;
      cursor
        .rect(r.x * T, r.y * T, r.w * T, r.h * T)
        .fill({ color: COLORS.selection, alpha: 0.15 });
      cursor.stroke({ width: 2 * px, color: COLORS.selection, alpha: 1 });
    }
    if (s.drag) {
      const r = s.drag;
      const color = s.tool === "select" ? COLORS.selection : COLORS.cursor;
      cursor.rect(r.x * T, r.y * T, r.w * T, r.h * T).fill({ color, alpha: 0.2 });
      cursor.stroke({ width: 2 * px, color, alpha: 1 });
    } else if (s.hover && s.pasting && s.clipboard) {
      const c = s.clipboard;
      cursor
        .rect(s.hover.x * T, s.hover.y * T, c.w * T, c.h * T)
        .fill({ color: COLORS.paste, alpha: 0.2 });
      cursor.stroke({ width: 2 * px, color: COLORS.paste, alpha: 1 });
    } else if (s.hover) {
      const single =
        s.tool === "item" ||
        s.tool === "fill" ||
        s.tool === "rect" ||
        s.tool === "select" ||
        s.picking;
      const cells = single ? [s.hover] : brushCells(s.hover.x, s.hover.y, s.brushSize);
      const color = s.tool === "eraser" ? COLORS.eraser : COLORS.cursor;
      for (const c of cells) cursor.rect(c.x * T, c.y * T, T, T);
      cursor.stroke({ width: 2 * px, color, alpha: 0.9 });
    }
    drawEntities(px);
  };

  /** Review: changed tiles of the current floor (against the loaded world) and conflicts. */
  const drawChanges = (px: number): void => {
    const s = ctl.state;
    changes.clear();
    if (!s.review) return;
    for (const c of ctl.diff().chunks) {
      if (c.z !== s.floor) continue;
      for (const t of c.tiles) changes.rect(t.x * T, t.y * T, T, T);
    }
    changes.fill({ color: COLORS.changed, alpha: 0.18 });
    changes.stroke({ width: px, color: COLORS.changed, alpha: 0.8 });
    changes.beginPath();
    for (const c of s.patchConflicts)
      if (c.kind === "tile" && c.z === s.floor) changes.rect(c.x * T, c.y * T, T, T);
    changes.stroke({ width: 3 * px, color: COLORS.conflict, alpha: 1 });
  };

  /** Zones, spawns, NPCs and portals of the current floor (all islands). */
  const drawEntities = (px: number): void => {
    const s = ctl.state;
    entities.clear();
    const sel = (tab: string, key: string): boolean => s.entityTab === tab && s.entitySel === key;
    for (const isl of ctl.viewWorld().islands.values()) {
      for (const z of isl.zones) {
        if (!z.floors.includes(s.floor)) continue;
        const color = ZONE_COLORS[z.type] ?? COLORS.selected;
        for (const r of z.rects) {
          entities.rect(r.x * T, r.y * T, r.w * T, r.h * T).fill({ color, alpha: 0.12 });
          entities.stroke({
            width: (sel("zones", z.id) ? 3 : 1.5) * px,
            color: sel("zones", z.id) ? COLORS.selected : color,
            alpha: 0.9,
          });
        }
      }
      // Houses (T5.4): read-only outline, doors and exit (edited in houses.yaml).
      for (const h of isl.houses) {
        for (const r of h.rects) {
          if (r.z !== s.floor) continue;
          entities
            .rect(r.x * T, r.y * T, r.w * T, r.h * T)
            .fill({ color: COLORS.house, alpha: 0.1 });
          entities.stroke({ width: 2 * px, color: COLORS.house, alpha: 0.9 });
        }
        for (const d of h.doors) {
          if (d.z !== s.floor) continue;
          entities
            .rect((d.x + 0.25) * T, (d.y + 0.25) * T, T * 0.5, T * 0.5)
            .fill({ color: COLORS.house, alpha: 0.9 });
        }
        if (h.exit.z === s.floor)
          entities
            .circle((h.exit.x + 0.5) * T, (h.exit.y + 0.5) * T, T * 0.15)
            .fill({ color: COLORS.house, alpha: 0.9 });
      }
      for (const sp of isl.spawns) {
        if (sp.center.z !== s.floor) continue;
        const cx = (sp.center.x + 0.5) * T;
        const cy = (sp.center.y + 0.5) * T;
        const on = sel("spawns", sp.id);
        entities.circle(cx, cy, (sp.radius + 0.5) * T).stroke({
          width: (on ? 3 : 2) * px,
          color: on ? COLORS.selected : COLORS.spawn,
          alpha: 0.9,
        });
        entities.circle(cx, cy, T * 0.2).fill({ color: COLORS.spawn, alpha: 0.9 });
      }
      for (const p of isl.portals) {
        if (p.from.z !== s.floor) continue;
        const on = sel("portals", p.id);
        entities
          .rect((p.from.x + 0.2) * T, (p.from.y + 0.2) * T, T * 0.6, T * 0.6)
          .stroke({ width: (on ? 3 : 2) * px, color: on ? COLORS.selected : COLORS.portal });
      }
      for (const n of isl.npcs) {
        if (n.pos.z !== s.floor) continue;
        const on = sel("npcs", n.npc);
        const cx = (n.pos.x + 0.5) * T;
        const cy = (n.pos.y + 0.5) * T;
        const r = T * 0.35;
        entities
          .poly([cx, cy - r, cx + r, cy, cx, cy + r, cx - r, cy])
          .fill({ color: COLORS.npc, alpha: 0.8 })
          .stroke({ width: (on ? 3 : 1) * px, color: on ? COLORS.selected : 0x000000 });
      }
    }
    // The selected entity stands out even if it is on another floor than its marker.
    if (s.entitySel !== undefined) {
      const e = ctl.entities(s.entityTab).find((x) => entityKey(x) === s.entitySel);
      const p = e && entityPos(e);
      if (p && p.z === s.floor)
        entities
          .rect(p.x * T, p.y * T, T, T)
          .stroke({ width: 2 * px, color: COLORS.selected, alpha: 1 });
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
      drawn.h !== scr.height ||
      drawn.world !== s.world ||
      drawn.marks !== marks()
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
        world: s.world,
        marks: marks(),
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
    window.getSelection()?.removeAllRanges(); // map shortcuts (Ctrl+C) apply again
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

  // Shortcuts are off only while typing text. A focused checkbox, select or button would
  // otherwise take Space or the arrow keys, so those give the focus back to the page.
  const TEXT_INPUTS = new Set(["text", "search", "number", "email", "url", "password", "tel"]);
  const typing = (e: KeyboardEvent): boolean => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return false;
    if (el.isContentEditable || el.tagName === "TEXTAREA") return true;
    return el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type);
  };
  const release = (e: KeyboardEvent): void => {
    const el = e.target;
    if (el instanceof HTMLElement && el !== document.body && !typing(e)) el.blur();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void ctl.save();
      return;
    }
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    const handled = mod
      ? ["z", "y", "c", "x", "v"].includes(k)
      : [" ", "pageup", "pagedown", "escape", "delete", ...Object.keys(TOOL_KEYS)].includes(k);
    if (!handled) return; // Tab, arrows in a select, etc. keep their normal behaviour
    release(e);
    if (mod && (k === "c" || k === "x" || k === "v")) {
      // Leave the shortcut to the browser when there is nothing of the map to act on, or
      // when text of the page is selected (copying a diagnostic or the status bar).
      const textSelected = !(window.getSelection()?.isCollapsed ?? true);
      if (k !== "v" && (textSelected || !ctl.state.selection)) return;
      if (k === "v" && !ctl.state.clipboard) return;
      e.preventDefault();
      if (k === "c") ctl.copy();
      else if (k === "x") ctl.cut();
      else ctl.startPaste();
    } else if (k === "escape") {
      ctl.clearSelection();
    } else if (k === "delete") {
      ctl.deleteSelection();
    } else if (mod && e.key.toLowerCase() === "z") {
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
    } else {
      const tool = TOOL_KEYS[k];
      if (tool) ctl.setTool(tool);
    }
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
