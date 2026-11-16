// The map's zoom buttons on touch screens (pinch does the same; a PC uses Ctrl+wheel).
// Whole scales only (render/zoom.ts): a button greys out at its end of the range, and the
// pair hides when the screen allows a single scale. No hooks: the scale and its limits
// come in GameUi.zoom.
import type { JSX } from "preact";
import type { Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { ZoomView } from "../render/zoom.ts";
import "./touch.css";

export function ZoomButtons(props: {
  t: Translate;
  game: Pick<Game, "zoom"> | undefined;
  zoom: ZoomView | undefined;
}): JSX.Element | null {
  const { t, game, zoom } = props;
  if (zoom && zoom.max <= zoom.min) return null;
  return (
    <div
      class="zoom-buttons"
      role="group"
      aria-label={t("client.zoom.label")}
      data-testid="zoom-buttons"
      data-scale={zoom?.scale}
    >
      <button
        type="button"
        class="zoom-button"
        data-testid="zoom-in"
        aria-label={t("client.zoom.in")}
        title={t("client.zoom.in")}
        disabled={!zoom || zoom.scale >= zoom.max}
        onClick={() => game?.zoom(1)}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        class="zoom-button"
        data-testid="zoom-out"
        aria-label={t("client.zoom.out")}
        title={t("client.zoom.out")}
        disabled={!zoom || zoom.scale <= zoom.min}
        onClick={() => game?.zoom(-1)}
      >
        <span aria-hidden="true">−</span>
      </button>
    </div>
  );
}
