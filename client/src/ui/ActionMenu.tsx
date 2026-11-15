// T5.6: the contextual menu of a long press (what the right click and Shift+click do with a
// mouse: use, open, look, attack, talk, move) and the banner of an item picked by a tap,
// waiting for a tap on its destination. Both are plain functions without hooks, so
// ActionMenu.test.ts walks their trees without a DOM. Every button sends the same intent as
// the mouse; the server validates it.
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { ActionMenuView, Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { ItemRef } from "../state/items.ts";
import "./touch.css";

/** Gap between the finger and the menu, CSS pixels. */
const MENU_GAP = 16;
/** Kept clear of the screen edges, CSS pixels. */
const MENU_MARGIN = 8;
/**
 * How long after opening the buttons start taking clicks, ms. On a short screen the menu
 * may open under the finger, and lifting it sends a click to whatever is there.
 */
export const MENU_ARM_MS = 350;

/** The menu takes clicks (it opened long enough ago, or its opening time is unknown). */
const armed = (menu: ActionMenuView, now = performance.now()): boolean =>
  menu.at === undefined || now - menu.at >= MENU_ARM_MS;

/** The menu's width (matches .touch-menu in touch.css), CSS pixels. */
export const MENU_WIDTH = 224;

/** Height of a menu with `buttons` buttons (cancel included) and maybe a title, CSS px
 * (the sizes of .touch-menu in touch.css). */
export function menuHeight(buttons: number, title: boolean): number {
  return 2 * 8 + 2 + (title ? 34 : 0) + buttons * 48 + Math.max(0, buttons - 1) * 6;
}

/**
 * Where the menu goes for a press at (x, y) on a vw x vh screen: centred on the finger and
 * kept on screen, below it in the top half and above it in the bottom half (never under
 * the finger, which would hide it). Given the menu's height, on a screen too short for it
 * on that side (a phone on its side) the menu takes the screen's height instead, scrolling
 * inside if it must. The side chosen is the roomier one, so the other never fits better.
 */
export function menuPlacement(
  x: number,
  y: number,
  vw: number,
  vh: number,
  height = 0,
): { left: number; top?: number; bottom?: number; maxHeight?: number } {
  const maxLeft = Math.max(MENU_MARGIN, vw - MENU_WIDTH - MENU_MARGIN);
  const left = Math.round(Math.min(maxLeft, Math.max(MENU_MARGIN, x - MENU_WIDTH / 2)));
  if (y < vh / 2) {
    if (y + MENU_GAP + height + MENU_MARGIN <= vh) return { left, top: Math.round(y + MENU_GAP) };
  } else if (y - MENU_GAP - height - MENU_MARGIN >= 0) {
    return { left, bottom: Math.round(Math.max(MENU_MARGIN, vh - y + MENU_GAP)) };
  }
  return {
    left,
    top: Math.round(Math.max(MENU_MARGIN, (vh - height) / 2)),
    maxHeight: vh - 2 * MENU_MARGIN,
  };
}

export function ActionMenu(props: {
  t: Translate;
  menu: ActionMenuView;
  game: Pick<Game, "menuChoose" | "closeMenu"> | undefined;
  /** The screen size (window.innerWidth/innerHeight; fixed values in tests). */
  viewport: { width: number; height: number };
}): JSX.Element {
  const { t, menu, game } = props;
  const at = menuPlacement(
    menu.x,
    menu.y,
    props.viewport.width,
    props.viewport.height,
    menuHeight(menu.actions.length + 1, menu.title !== ""),
  );
  const style: JSX.CSSProperties = { left: `${at.left}px` };
  if (at.top !== undefined) style.top = `${at.top}px`;
  if (at.bottom !== undefined) style.bottom = `${at.bottom}px`;
  if (at.maxHeight !== undefined) style.maxHeight = `${at.maxHeight}px`;
  return (
    <div class="touch-menu-layer" data-testid="action-menu-layer">
      <div
        class="touch-menu-backdrop"
        aria-hidden="true"
        // On pointerdown, not click: the browser may send a click when the long-press
        // finger lifts, which would close the menu it just opened.
        onPointerDown={(e) => {
          e.preventDefault();
          game?.closeMenu();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        class="touch-menu"
        role="menu"
        aria-label={menu.title || t("client.touch.actions.label")}
        data-testid="action-menu"
        style={style}
      >
        {menu.title && <div class="touch-menu-title">{menu.title}</div>}
        {menu.actions.map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            class="touch-menu-action"
            data-action={kind}
            onClick={() => {
              if (armed(menu)) game?.menuChoose(kind);
            }}
          >
            {t(`client.touch.action.${kind}`)}
          </button>
        ))}
        <button
          type="button"
          role="menuitem"
          class="touch-menu-action touch-menu-cancel"
          data-action="cancel"
          onClick={() => {
            if (armed(menu)) game?.closeMenu();
          }}
        >
          {t("client.touch.action.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The item picked by a tap: "tap where it goes", with a big button to drop the pick. */
export function PickBanner(props: {
  t: Translate;
  content: ClientContent;
  picked: ItemRef;
  game: Pick<Game, "cancelPick"> | undefined;
}): JSX.Element {
  const { t, picked } = props;
  const def = props.content.items[picked.itemId];
  const name = def ? t(`item.${def.id}.name`) : String(picked.itemId);
  return (
    <div class="pick-banner" role="status" data-testid="pick-banner">
      <span class="pick-banner-text">
        <span class="pick-banner-item">{name}</span> {t("client.touch.pick_destination")}
      </span>
      <button
        type="button"
        class="pick-banner-cancel"
        data-testid="pick-cancel"
        onClick={() => props.game?.cancelPick()}
      >
        {t("client.touch.action.cancel")}
      </button>
    </div>
  );
}
