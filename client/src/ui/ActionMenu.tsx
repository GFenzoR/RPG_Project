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
/** Kept clear of the safe area's edges, CSS pixels. */
const MENU_MARGIN = 8;

/**
 * The safe area's insets (the notch, the rounded corners, the home indicator), CSS pixels:
 * what env(safe-area-inset-*) gives, which the game already takes as the padding of .game
 * (client.css, read by `paddingInsets`). 0 on any screen without them.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The insets from an element's computed padding (getComputedStyle of .game, whose padding
 * is env(safe-area-inset-*)): the menu is fixed to the screen, outside that padding, so it
 * takes the same insets once. Unreadable values count as 0.
 */
export function paddingInsets(
  style: Pick<CSSStyleDeclaration, "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft">,
): Insets {
  const px = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
}

/**
 * Whether a click on a button of the open menu acts. Lifting the long-press finger makes
 * the browser click whatever is under it, however long it was held: on a short screen (a
 * phone on its side) the menu opens under the finger, and that click would choose the
 * button there. So a click counts only after a press that started on the menu itself
 * (`pressed`), or when it comes from the keyboard or assistive technology (`detail` 0).
 * No timer: a slow device lifts the finger whenever it does.
 */
export const menuClickCounts = (pressed: boolean, detail: number): boolean =>
  pressed || detail === 0;

/** The menu's width (matches .touch-menu in touch.css), CSS pixels. */
export const MENU_WIDTH = 224;

/** Height of a menu with `buttons` buttons (cancel included) and maybe a title, CSS px
 * (the sizes of .touch-menu in touch.css). */
export function menuHeight(buttons: number, title: boolean): number {
  return 2 * 8 + 2 + (title ? 34 : 0) + buttons * 48 + Math.max(0, buttons - 1) * 6;
}

/**
 * Where the menu goes for a press at (x, y) on a vw x vh screen: centred on the finger and
 * kept inside the safe area (`insets`, with a margin), below the finger in the top half
 * of that area and above it in the bottom half (never under the finger, which would hide
 * it). Given the menu's height, on a screen too short for it on that side (a phone on its
 * side) the menu takes the safe area's height instead, scrolling inside if it must. The
 * side chosen is the roomier one, so the other never fits better. The result is relative
 * to the whole screen (the menu's layer is fixed to it, outside the padding of .game).
 */
export function menuPlacement(
  x: number,
  y: number,
  vw: number,
  vh: number,
  height = 0,
  insets: Insets = NO_INSETS,
): { left: number; top?: number; bottom?: number; maxHeight?: number } {
  const minLeft = insets.left + MENU_MARGIN;
  const maxLeft = Math.max(minLeft, vw - insets.right - MENU_WIDTH - MENU_MARGIN);
  const left = Math.round(Math.min(maxLeft, Math.max(minLeft, x - MENU_WIDTH / 2)));
  // The safe area's top and bottom edges, as distances from the screen's top.
  const top = insets.top;
  const bottom = vh - insets.bottom;
  if (y < (top + bottom) / 2) {
    if (y + MENU_GAP + height + MENU_MARGIN <= bottom)
      return { left, top: Math.round(Math.max(top + MENU_MARGIN, y + MENU_GAP)) };
  } else if (y - MENU_GAP - height - MENU_MARGIN >= top) {
    return {
      left,
      bottom: Math.round(Math.max(insets.bottom + MENU_MARGIN, vh - y + MENU_GAP)),
    };
  }
  const room = bottom - top;
  return {
    left,
    top: Math.round(top + Math.max(MENU_MARGIN, (room - height) / 2)),
    maxHeight: room - 2 * MENU_MARGIN,
  };
}

export function ActionMenu(props: {
  t: Translate;
  menu: ActionMenuView;
  game: Pick<Game, "menuChoose" | "closeMenu" | "menuPress" | "menuPressed"> | undefined;
  /** The screen size (window.innerWidth/innerHeight; fixed values in tests). */
  viewport: { width: number; height: number };
  /** The safe area's insets (paddingInsets of .game); none by default. */
  insets?: Insets | undefined;
}): JSX.Element {
  const { t, menu, game } = props;
  const at = menuPlacement(
    menu.x,
    menu.y,
    props.viewport.width,
    props.viewport.height,
    menuHeight(menu.actions.length + 1, menu.title !== ""),
    props.insets ?? NO_INSETS,
  );
  const style: JSX.CSSProperties = { left: `${at.left}px` };
  if (at.top !== undefined) style.top = `${at.top}px`;
  if (at.bottom !== undefined) style.bottom = `${at.bottom}px`;
  if (at.maxHeight !== undefined) style.maxHeight = `${at.maxHeight}px`;
  // Read when the click happens, not when the menu was drawn: the press that arms it comes
  // right before its click, maybe before any new render.
  const counts = (e: MouseEvent): boolean => menuClickCounts(game?.menuPressed ?? false, e.detail);
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
        // A finger (or pen, or mouse) pressed on the menu: its next click is a choice. The
        // finger that opened the menu went down on the map or the item, never here.
        onPointerDown={() => game?.menuPress()}
      >
        {menu.title && <div class="touch-menu-title">{menu.title}</div>}
        {menu.actions.map((kind) => (
          <button
            key={kind}
            type="button"
            role="menuitem"
            class="touch-menu-action"
            data-action={kind}
            onClick={(e) => {
              if (counts(e)) game?.menuChoose(kind);
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
          onClick={(e) => {
            if (counts(e)) game?.closeMenu();
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
