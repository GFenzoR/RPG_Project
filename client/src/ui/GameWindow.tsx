// One window of the desktop game screen (docs/17 UI-5): an iron frame with gothic corners
// and a title bar (icon, title, fold and close), floating over the full-screen map. It
// moves by its title bar and resizes from its four corners (a grab zone over each corner
// ornament; the edges do not resize). Where it is, how big and whether it is open is
// ui/windows.ts; this only draws it and reports what the player does with it. Dragging and
// resizing (with the magnet) are GameView.tsx's (it knows the screen and the other
// windows), with ui/window-dom.ts.
//
// The toolbar's windows, the chat, the server's (dialog, shop, crafting, market, house,
// trade) and each open container use this same frame.
import type { ComponentChildren, JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { CORNERS } from "./windows.ts";
import type { AutoPlace, Corner, WinKey, WindowPlace } from "./windows.ts";
import { placeStyle } from "./window-dom.ts";

export interface GameWindowProps {
  t: Translate;
  id: WinKey;
  icon: IconName;
  title: string;
  place: WindowPlace;
  /**
   * Where it sits instead of its usual place while the player has not moved it: a factory
   * place that sees the windows open when it opened (ui/windows.ts defaultPlace).
   */
  auto?: AutoPlace | undefined;
  /** Stacking order among the windows (0 = bottom). */
  stack: number;
  /**
   * The interface scale (Options, CSS `zoom` of the windows): the state keeps screen
   * pixels, the window's own lengths are divided by it.
   */
  zoom?: number | undefined;
  /** Fading out: drawn for the close animation, no longer takes clicks. */
  closing?: boolean | undefined;
  /** data-testid of the window (e.g. "options"). */
  testid?: string | undefined;
  /** data-testid of its title (the house window's "house-name"). */
  titleTestid?: string | undefined;
  /** Width class (windows.css .gwin[data-size=…]). */
  size?: "narrow" | "normal" | "wide" | undefined;
  /** A dot on the title: something there waits for the player. */
  badge?: boolean | undefined;
  /** No close button (the shop closes with its dialog; the chat never closes). */
  closable?: boolean | undefined;
  /** The close button's name, when not "Close <title>" (the server's windows keep theirs). */
  closeLabel?: string | undefined;
  /**
   * More in the title bar, after the title (the chat's tabs); with `hideTitle` the title
   * is only read by screen readers and this takes its room.
   */
  barExtra?: ComponentChildren;
  hideTitle?: boolean | undefined;
  /** A default place of its kind (windows.css): the n-th container steps down from the last. */
  nth?: number | undefined;
  /** Gets the window's element (the equipment's is measured: GameView containersTop). */
  boxRef?: ((el: HTMLElement | null) => void) | undefined;
  onClose(): void;
  onCollapse(collapsed: boolean): void;
  onFocus(): void;
  /** The title bar was pressed: GameView follows the pointer from here. */
  onGrab(e: PointerEvent, el: HTMLElement): void;
  /** A resize corner was pressed. */
  onResize(corner: Corner, e: PointerEvent, el: HTMLElement): void;
  children: ComponentChildren;
}

export function GameWindow(props: GameWindowProps): JSX.Element {
  const { t, id, place } = props;
  const titleId = `gwin-${id}-title`;
  const placed = place.x !== undefined && place.y !== undefined;
  // Left, top and a max-height that never reaches under the bar, and the player's size
  // (ui/window-dom.ts: a drag that ends writes the same lengths).
  const style: JSX.CSSProperties = {
    zIndex: 20 + props.stack,
    ...placeStyle(place, props.zoom ?? 1, props.auto),
  };
  if (props.nth !== undefined && props.nth > 0) style["--nth"] = String(props.nth);
  const sized = place.w !== undefined || place.h !== undefined;
  return (
    <section
      ref={props.boxRef ?? null}
      class="gwin"
      data-window={id}
      data-testid={props.testid}
      data-placed={placed ? "" : undefined}
      data-auto={!placed && props.auto ? "" : undefined}
      data-sized={sized ? "" : undefined}
      data-collapsed={place.collapsed ? "" : undefined}
      data-closing={props.closing ? "" : undefined}
      data-size={props.size}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={style}
      onPointerDown={() => props.onFocus()}
    >
      <header
        class="gwin-bar"
        onPointerDown={(e) => {
          // The buttons of the bar click as buttons; the rest of the bar grabs the window.
          if (e.target instanceof Element && e.target.closest("button")) return;
          const el = e.currentTarget.parentElement;
          if (el) props.onGrab(e, el);
        }}
        onDblClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button")) return;
          props.onCollapse(!place.collapsed);
        }}
      >
        <Icon name={props.icon} class="gwin-icon" />
        <h2
          id={titleId}
          class={props.hideTitle ? "gwin-title visually-hidden" : "gwin-title"}
          data-testid={props.titleTestid}
        >
          {props.title}
        </h2>
        {props.barExtra}
        {props.badge && <span class="gwin-badge" aria-hidden="true" />}
        <button
          type="button"
          class="gwin-btn gwin-fold"
          data-testid={`window-fold-${id}`}
          aria-expanded={!place.collapsed}
          aria-controls={`gwin-${id}-body`}
          aria-label={t(place.collapsed ? "client.window.expand" : "client.window.collapse", {
            title: props.title,
          })}
          title={t(place.collapsed ? "client.window.expand" : "client.window.collapse", {
            title: props.title,
          })}
          onClick={() => props.onCollapse(!place.collapsed)}
        >
          <span aria-hidden="true">{place.collapsed ? "+" : "–"}</span>
        </button>
        {props.closable !== false && (
          <button
            type="button"
            class="gwin-btn gwin-close"
            data-testid={`window-close-${id}`}
            aria-label={props.closeLabel ?? t("client.window.close", { title: props.title })}
            title={props.closeLabel ?? t("client.window.close", { title: props.title })}
            onClick={() => props.onClose()}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </header>
      <div class="gwin-body" id={`gwin-${id}-body`} hidden={place.collapsed}>
        {props.children}
      </div>
      {!place.collapsed &&
        CORNERS.map((corner) => (
          <span
            key={corner}
            class="gwin-resize"
            data-corner={corner}
            aria-hidden="true"
            title={t("client.window.resize")}
            onPointerDown={(e) => {
              const el = e.currentTarget.parentElement;
              if (el) props.onResize(corner, e, el);
            }}
          />
        ))}
    </section>
  );
}
