// One window of the desktop game screen (docs/17 UI-5): an iron frame with a title bar
// (icon, title, fold and close), docked in the column right of the map or floating over it.
// Where it is and whether it is open is ui/windows.ts; this only draws it and reports what
// the player does with it. Dragging is App.tsx's (it knows the dock and the map).
import type { ComponentChildren, JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import type { WindowId, WindowPlace } from "./windows.ts";

export interface GameWindowProps {
  t: Translate;
  id: WindowId;
  icon: IconName;
  title: string;
  place: WindowPlace;
  /** Stacking order among the floating windows (0 = bottom). */
  stack: number;
  /** Fading out: drawn for the close animation, no longer takes clicks. */
  closing?: boolean | undefined;
  /** data-testid of the window (e.g. "options"). */
  testid?: string | undefined;
  /** Width class of a floating window (client.css .gwin[data-size=…]). */
  size?: "narrow" | "normal" | "wide" | undefined;
  /** A dot on the title: something there waits for the player. */
  badge?: boolean | undefined;
  onClose(): void;
  onCollapse(collapsed: boolean): void;
  onFocus(): void;
  /** The title bar was pressed: App.tsx follows the pointer from here. */
  onGrab(e: PointerEvent, el: HTMLElement): void;
  children: ComponentChildren;
}

export function GameWindow(props: GameWindowProps): JSX.Element {
  const { t, id, place } = props;
  const titleId = `gwin-${id}-title`;
  const float = !place.dock;
  const placed = float && place.x !== undefined && place.y !== undefined;
  const style: JSX.CSSProperties | undefined = float
    ? {
        zIndex: 20 + props.stack,
        ...(placed ? { left: `${place.x}px`, top: `${place.y}px` } : {}),
      }
    : undefined;
  return (
    <section
      class="gwin"
      data-window={id}
      data-testid={props.testid}
      data-dock={place.dock ? "" : undefined}
      data-float={float ? "" : undefined}
      data-placed={placed ? "" : undefined}
      data-collapsed={place.collapsed ? "" : undefined}
      data-closing={props.closing ? "" : undefined}
      data-size={props.size}
      role={float ? "dialog" : "region"}
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
        <h2 id={titleId} class="gwin-title">
          {props.title}
        </h2>
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
        <button
          type="button"
          class="gwin-btn gwin-close"
          data-testid={`window-close-${id}`}
          aria-label={t("client.window.close", { title: props.title })}
          title={t("client.window.close", { title: props.title })}
          onClick={() => props.onClose()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div class="gwin-body" id={`gwin-${id}-body`} hidden={place.collapsed}>
        {props.children}
      </div>
    </section>
  );
}
