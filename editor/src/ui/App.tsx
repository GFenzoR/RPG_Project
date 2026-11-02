// Editor layout: toolbar on top, palette on the left, map in the middle, tile info and
// live validation on the right, status bar at the bottom.
import { useEffect, useRef, useState } from "preact/hooks";
import { formatDiagnosticShort } from "./format.ts";
import { Palette } from "../palette/Palette.tsx";
import { createMapCanvas } from "../canvas/map-canvas.ts";
import type { MapCanvas } from "../canvas/map-canvas.ts";
import type { EditorController, EditorState } from "../state/editor.ts";
import { BRUSH_SIZES, ERASE_LAYERS, TOOLS, tileAt } from "../tools/tools.ts";
import type { BrushSize } from "../tools/tools.ts";
import type { PaletteItem, WireDiagnostic } from "../io/wire.ts";

function useEditorState(ctl: EditorController): EditorState {
  const [state, setState] = useState(ctl.state);
  useEffect(() => ctl.subscribe(() => setState(ctl.state)), [ctl]);
  return state;
}

export function App({
  ctl,
  onCanvas,
}: {
  ctl: EditorController;
  onCanvas: (c: MapCanvas) => void;
}) {
  const s = useEditorState(ctl);
  const t = ctl.t;
  const host = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<MapCanvas>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!host.current) return;
    let made: MapCanvas | undefined;
    let cancelled = false;
    createMapCanvas(host.current, ctl)
      .then((c) => {
        if (cancelled) return c.destroy();
        made = c;
        setCanvas(c);
        onCanvas(c);
        void ctl.validateNow();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      made?.destroy();
    };
  }, [ctl]);

  const itemName = (id: string): string => {
    const i = ctl.items.get(id);
    return i ? t(i.name) : id;
  };
  const tile = s.hover ? tileAt(s.world, s.hover.x, s.hover.y, s.floor) : undefined;
  const jump = (d: WireDiagnostic): void => {
    if (d.pos && canvas) ctl.centerTile(d.pos.x, d.pos.y, d.pos.z, canvas.atlas.tileSize);
  };
  const v = s.validation;

  return (
    <div class="editor">
      <header class="toolbar">
        <h1>{t("editor.title")}</h1>
        <label class="group">
          {t("editor.island")}
          <select
            data-testid="island"
            value={s.island}
            disabled={!canvas}
            onChange={(e) => {
              const id = e.currentTarget.value;
              if (canvas) ctl.selectIsland(id, canvas.atlas.tileSize);
              const url = new URL(location.href);
              url.searchParams.set("island", id);
              history.replaceState(null, "", url);
            }}
          >
            {[...s.world.islands.values()].map((i) => (
              <option key={i.meta.id} value={i.meta.id}>
                {`${t(i.meta.name)} (${i.meta.id})`}
              </option>
            ))}
          </select>
        </label>
        <div class="group">
          {TOOLS.map((tool) => (
            <button
              key={tool}
              data-testid={`tool-${tool}`}
              class={s.tool === tool ? "active" : ""}
              onClick={() => ctl.setTool(tool)}
            >
              {t(`editor.tool.${tool}`)}
            </button>
          ))}
        </div>
        <label class="group">
          {t("editor.brush_size")}
          <select
            data-testid="brush-size"
            value={s.brushSize}
            onChange={(e) => ctl.setBrushSize(Number(e.currentTarget.value) as BrushSize)}
          >
            {BRUSH_SIZES.map((n) => (
              <option key={n} value={n}>{`${n}×${n}`}</option>
            ))}
          </select>
        </label>
        <label class="group">
          {t("editor.erase_layer")}
          <select
            data-testid="erase-layer"
            value={s.eraseLayer}
            onChange={(e) => ctl.setEraseLayer(e.currentTarget.value as EditorState["eraseLayer"])}
          >
            {ERASE_LAYERS.map((l) => (
              <option key={l} value={l}>
                {t(`editor.layer.${l}`)}
              </option>
            ))}
          </select>
        </label>
        <div class="group">
          <button
            data-testid="floor-up"
            title={t("editor.floor_up")}
            onClick={() => ctl.changeFloor(-1)}
          >
            ▲
          </button>
          <span data-testid="floor">{t("editor.floor", { z: s.floor })}</span>
          <button
            data-testid="floor-down"
            title={t("editor.floor_down")}
            onClick={() => ctl.changeFloor(1)}
          >
            ▼
          </button>
        </div>
        <span class="group">{t("editor.zoom", { percent: Math.round(s.camera.zoom * 100) })}</span>
        <label class="group">
          <input
            type="checkbox"
            data-testid="grid"
            checked={s.grid}
            onChange={() => ctl.toggleGrid()}
          />
          {t("editor.grid")}
        </label>
        <div class="group">
          <button data-testid="undo" disabled={!s.canUndo} onClick={() => ctl.undo()}>
            {t("editor.undo")}
          </button>
          <button data-testid="redo" disabled={!s.canRedo} onClick={() => ctl.redo()}>
            {t("editor.redo")}
          </button>
          <button
            data-testid="save"
            class={s.dirty ? "primary" : ""}
            disabled={s.loadErrors.length > 0}
            onClick={() => void ctl.save()}
          >
            {t("editor.save")}
          </button>
          <span data-testid="dirty" class={s.dirty ? "dirty" : "clean"}>
            {s.dirty ? t("editor.unsaved") : t("editor.no_changes")}
          </span>
        </div>
      </header>

      <aside class="left">
        <div class="selection">
          <div data-testid="selected-ground">
            {t("editor.selected_ground", { name: itemName(s.ground) })}
          </div>
          <div data-testid="selected-item">
            {t("editor.selected_item", { name: itemName(s.item) })}
          </div>
        </div>
        {canvas && (
          <Palette
            items={[...ctl.items.values()] as PaletteItem[]}
            atlas={canvas.atlas}
            t={t}
            ground={s.ground}
            item={s.item}
            onPick={(id) => ctl.pick(id)}
          />
        )}
      </aside>

      <main class="map" ref={host}>
        {!canvas && !error && <div class="overlay-msg">{t("editor.loading")}</div>}
        {error && <div class="overlay-msg error">{t("editor.load_failed", { error })}</div>}
      </main>

      <aside class="right">
        <section class="panel tile-info" data-testid="tile-info">
          {s.hover ? (
            <>
              <h2>{`${s.hover.x}, ${s.hover.y}, ${s.floor}`}</h2>
              {tile ? (
                <ul>
                  <li>{tile.ground ? itemName(tile.ground) : t("editor.tile_empty")}</li>
                  {tile.stack.map((id, i) => (
                    <li key={i}>{`↳ ${itemName(id)}`}</li>
                  ))}
                </ul>
              ) : (
                <p>{t("editor.tile_empty")}</p>
              )}
            </>
          ) : (
            <h2>—</h2>
          )}
        </section>
        <section class="panel validation" data-testid="validation">
          <h2>{t("editor.validation")}</h2>
          {s.loadErrors.length > 0 && (
            <>
              <h3>{t("editor.load_errors")}</h3>
              <ul class="diags">
                {s.loadErrors.map((d, i) => (
                  <li key={i} class="error">
                    {formatDiagnosticShort(d)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p data-testid="validation-summary" class={v && v.errors > 0 ? "bad" : "good"}>
            {s.validating && !v
              ? t("editor.validation.running")
              : v && v.diagnostics.length === 0
                ? t("editor.validation.ok")
                : v
                  ? t("editor.validation.summary", { errors: v.errors, warnings: v.warnings })
                  : ""}
            {s.validating && v ? " …" : ""}
          </p>
          <ul class="diags">
            {v?.diagnostics.map((d, i) => (
              <li key={i} class={d.severity}>
                <button data-testid="diagnostic" disabled={!d.pos} onClick={() => jump(d)}>
                  {formatDiagnosticShort(d)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      <footer class="status">
        <span data-testid="status">{s.status}</span>
        <span class="help">{t("editor.help")}</span>
      </footer>
    </div>
  );
}
