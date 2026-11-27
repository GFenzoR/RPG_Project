// The minimap (docs/02 "Minimapa", docs/17 "Minimapa"): a corner of the map, top right, in
// an iron frame with the cardinal points on its sides. The terrain is a canvas painted
// from what the character explored (state/minimap.ts: black where it did not), one to four
// pixels per tile; the own position (a marker pointing where it faces), the party members
// in view and the tracked objective's estimate (a circle, or an arrow on the edge with the
// rough distance, and ▲/▼ when it is on another floor) are an SVG over it. Buttons zoom in
// and out and recenter; dragging pans. It folds to its title bar (phones start folded),
// remembered per device (localStorage rpg.minimap).
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Direction } from "@rpg/protocol";
import type { Game, MinimapUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import {
  CARDINALS,
  MINIMAP_SCALES,
  clickTile,
  hintMarker,
  paintTerrain,
  panBy,
  pressIsClick,
  pressMove,
  pressStart,
  tileToPixel,
  viewTiles,
} from "../state/minimap.ts";
import type { MinimapPress, MinimapView } from "../state/minimap.ts";
import { optionStorage } from "../state/option-storage.ts";
import "./minimap.css";

const MAX_SCALE = Math.max(...MINIMAP_SCALES);

/** Size of the terrain canvas in CSS pixels (square). */
export const MINIMAP_PX = 160;

const PREFS_KEY = "rpg.minimap";

interface MinimapPrefs {
  open: boolean;
  scale: number;
}

function loadPrefs(phone: boolean): MinimapPrefs {
  const fallback = { open: !phone, scale: 2 };
  try {
    const v = JSON.parse(
      optionStorage()?.getItem(PREFS_KEY) ?? "null",
    ) as Partial<MinimapPrefs> | null;
    if (!v) return fallback;
    const scale = MINIMAP_SCALES.includes(v.scale as 1) ? (v.scale as number) : 2;
    return { open: typeof v.open === "boolean" ? v.open : fallback.open, scale };
  } catch {
    return fallback;
  }
}

function savePrefs(p: MinimapPrefs): void {
  try {
    optionStorage()?.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** The facing marker's rotation, degrees clockwise from north. */
export function facingDegrees(dir: Direction): number {
  switch (dir) {
    case Direction.NORTH:
      return 0;
    case Direction.NORTH_EAST:
      return 45;
    case Direction.EAST:
      return 90;
    case Direction.SOUTH_EAST:
      return 135;
    case Direction.WEST:
      return 270;
    case Direction.NORTH_WEST:
      return 315;
    case Direction.SOUTH_WEST:
      return 225;
    default:
      return 180;
  }
}

/** The SVG over the terrain: party, self and the objective's estimate. No hooks. */
export function MinimapMarks(props: {
  t: Translate;
  mm: MinimapUi;
  view: MinimapView;
}): JSX.Element {
  const { t, mm, view } = props;
  const me = tileToPixel(view, mm.self.x, mm.self.y);
  const hint = mm.hint && hintMarker(view, mm.hint, mm.self);
  const floorMark = hint?.floor === "up" ? "▲" : hint?.floor === "down" ? "▼" : "";
  return (
    <svg
      class="minimap-marks"
      width={view.width}
      height={view.height}
      viewBox={`0 0 ${view.width} ${view.height}`}
      aria-hidden="true"
    >
      {hint?.kind === "area" && (
        <g data-testid="minimap-hint" data-kind="area" data-floor={hint.floor}>
          <circle class="minimap-hint-area" cx={hint.px} cy={hint.py} r={hint.r} />
          {floorMark && (
            <text class="minimap-floor" x={hint.px} y={hint.py + 4} text-anchor="middle">
              {floorMark}
            </text>
          )}
        </g>
      )}
      {hint?.kind === "arrow" && (
        <g data-testid="minimap-hint" data-kind="arrow" data-floor={hint.floor}>
          <polygon
            class="minimap-hint-arrow"
            points="7,0 -5,-5 -2,0 -5,5"
            transform={`translate(${hint.px} ${hint.py}) rotate(${(hint.angle * 180) / Math.PI})`}
          />
          <text
            class="minimap-distance"
            data-testid="minimap-distance"
            x={hint.px - Math.cos(hint.angle) * 16}
            y={hint.py - Math.sin(hint.angle) * 16 + 3}
            text-anchor="middle"
          >
            {t(
              hint.floor === "up"
                ? "client.minimap.distance_up"
                : hint.floor === "down"
                  ? "client.minimap.distance_down"
                  : "client.minimap.distance",
              { tiles: hint.distance },
            )}
          </text>
        </g>
      )}
      {mm.dest &&
        (() => {
          const at = tileToPixel(view, mm.dest.x, mm.dest.y);
          return (
            <path
              class="minimap-dest"
              data-testid="minimap-dest"
              data-x={mm.dest.x}
              data-y={mm.dest.y}
              d="M-3,-3 L3,3 M-3,3 L3,-3"
              transform={`translate(${at.px} ${at.py})`}
            />
          );
        })()}
      {mm.party.map((p) => {
        const at = tileToPixel(view, p.x, p.y);
        return <circle key={p.id} class="minimap-party" cx={at.px} cy={at.py} r={2.5} />;
      })}
      <polygon
        class="minimap-self"
        data-testid="minimap-self"
        points="0,-5 4,4 0,2 -4,4"
        transform={`translate(${me.px} ${me.py}) rotate(${facingDegrees(mm.self.dir)})`}
      />
    </svg>
  );
}

export function Minimap(props: {
  t: Translate;
  game: Pick<Game, "minimapSource" | "minimapRequest" | "minimapWalk"> | undefined;
  mm: MinimapUi | undefined;
  /** A phone: starts folded (the map is small). */
  phone: boolean;
}): JSX.Element | null {
  const { t, mm, game } = props;
  const [prefs, setPrefs] = useState<MinimapPrefs>(() => loadPrefs(props.phone));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Bumped when an unanswered request may go again: the effect below looks once more.
  const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  // A press that never dragged the map is a click: it walks there (state/minimap.ts).
  const drag = useRef<MinimapPress | undefined>(undefined);
  const update = (p: MinimapPrefs): void => {
    setPrefs(p);
    savePrefs(p);
  };
  const view: MinimapView | undefined = mm && {
    cx: mm.self.x + 0.5 + pan.x,
    cy: mm.self.y + 0.5 + pan.y,
    scale: prefs.scale,
    width: MINIMAP_PX,
    height: MINIMAP_PX,
  };
  // Paint the terrain when what is explored, where it looks or the zoom changed; ask the
  // server for the explored sectors in view it has not sent yet.
  const key =
    view &&
    `${mm?.version}/${mm?.self.z}/${view.cx}/${view.cy}/${view.scale}/${prefs.open}/${retry}`;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !view || !mm || !game || !prefs.open) return;
    const src = game.minimapSource();
    const tiles = viewTiles(view);
    const now = performance.now();
    game.minimapRequest(
      mm.self.z,
      src.state.wanted(mm.self.z, tiles.x0, tiles.y0, tiles.x1, tiles.y1, now),
    );
    // A request the server dropped (another floor by then, over its budget) gets no
    // answer: look again when it may be sent once more.
    const wait = src.state.retryIn(now);
    const timer = wait === undefined ? undefined : setTimeout(() => setRetry((r) => r + 1), wait);
    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
    };
    const ctx = el.getContext("2d");
    if (!ctx) return stop;
    const img = ctx.createImageData(view.width, view.height);
    paintTerrain(
      img,
      view,
      mm.self.z,
      (x, y, z) => src.state.isExplored(x, y, z),
      src.tileItem,
      src.colour,
    );
    ctx.putImageData(img, 0, 0);
    return stop;
  }, [key]);
  if (!mm || !view) return null;
  const zoomTo = (step: number): void => {
    const i = MINIMAP_SCALES.indexOf(prefs.scale as 1);
    const next = MINIMAP_SCALES[Math.min(Math.max(i + step, 0), MINIMAP_SCALES.length - 1)];
    if (next !== undefined) update({ ...prefs, scale: next });
  };
  const panned = pan.x !== 0 || pan.y !== 0;
  return (
    <section
      class="minimap"
      data-testid="minimap"
      data-open={prefs.open ? "" : undefined}
      data-scale={prefs.scale}
      data-tracked={mm.tracked || undefined}
      aria-label={t("client.minimap.title")}
    >
      <div class="minimap-bar">
        <button
          type="button"
          class="minimap-fold"
          data-testid="minimap-fold"
          aria-expanded={prefs.open}
          title={t(prefs.open ? "client.minimap.fold" : "client.minimap.unfold")}
          aria-label={t(prefs.open ? "client.minimap.fold" : "client.minimap.unfold")}
          onClick={() => update({ ...prefs, open: !prefs.open })}
        >
          <span class="minimap-title">{t("client.minimap.title")}</span>
          <span aria-hidden="true">{prefs.open ? "▾" : "▸"}</span>
        </button>
      </div>
      {prefs.open && (
        <div class="minimap-frame">
          {CARDINALS.map((c) => (
            <span
              key={c.side}
              class="minimap-cardinal"
              data-side={c.side}
              data-testid={`minimap-${c.side}`}
            >
              {t(c.key)}
            </span>
          ))}
          <div
            class="minimap-map"
            style={{ width: `${MINIMAP_PX}px`, height: `${MINIMAP_PX}px` }}
            onPointerDown={(e) => {
              drag.current = pressStart(e.pointerId, e.button, e.clientX, e.clientY);
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              const { press, dx, dy } = pressMove(d, e.clientX, e.clientY);
              drag.current = press;
              if (dx !== 0 || dy !== 0) setPan((p) => panBy(p, dx, dy, prefs.scale));
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = undefined;
              if (!d || d.id !== e.pointerId) return;
              if (!pressIsClick(d, e.clientX, e.clientY)) return;
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const tile = clickTile(view, box, e.clientX, e.clientY);
              if (tile) game?.minimapWalk(tile.x, tile.y);
            }}
            onPointerCancel={() => (drag.current = undefined)}
          >
            <canvas
              ref={canvas}
              class="minimap-canvas"
              data-testid="minimap-canvas"
              width={MINIMAP_PX}
              height={MINIMAP_PX}
            />
            <MinimapMarks t={t} mm={mm} view={view} />
          </div>
          <div class="minimap-buttons">
            <button
              type="button"
              data-testid="minimap-zoom-in"
              aria-label={t("client.minimap.zoom_in")}
              title={t("client.minimap.zoom_in")}
              disabled={prefs.scale >= MAX_SCALE}
              onClick={() => zoomTo(1)}
            >
              +
            </button>
            <button
              type="button"
              data-testid="minimap-zoom-out"
              aria-label={t("client.minimap.zoom_out")}
              title={t("client.minimap.zoom_out")}
              disabled={prefs.scale <= MINIMAP_SCALES[0]}
              onClick={() => zoomTo(-1)}
            >
              −
            </button>
            <button
              type="button"
              data-testid="minimap-recenter"
              aria-label={t("client.minimap.recenter")}
              title={t("client.minimap.recenter")}
              disabled={!panned}
              onClick={() => setPan({ x: 0, y: 0 })}
            >
              ⌖
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
