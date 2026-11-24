// The contextual menu: a finger's long press (T5.6) and, since docs/17 UI-6, the mouse's
// right click on an item (menu controls) or Shift+right click (classic). It lists what can
// be done there (attack, talk, climb, use, open, use with, eat, equip, look, move, move part),
// the default action first and in bold, and under the buttons the card of the item. Also the
// banner of an item picked by a tap, waiting for a tap on its destination. Both are plain
// functions without hooks, so ActionMenu.test.ts walks their trees without a DOM. Every
// button sends the same intent as the mouse; the server validates it.
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { ActionMenuView, Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { halfStack, splitCount } from "../state/items.ts";
import { instanceName } from "../state/item-name.ts";
import { corpseSprite } from "../state/corpse-art.ts";
import type { ItemRef } from "../state/items.ts";
import { cardLines } from "../state/item-card.ts";
import { BigIcon, ItemCard } from "./ItemCard.tsx";
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
/** The width of a menu with an item card (.touch-menu.with-card), CSS pixels. */
export const CARD_MENU_WIDTH = 288;
/** Height of one line of the card in the menu (touch.css .item-card), CSS pixels. */
const CARD_LINE = 19;

/**
 * Height of a menu with `buttons` buttons (cancel included) and maybe a title, CSS px
 * (the sizes of .touch-menu in touch.css). `mouse`: the compact buttons of a menu opened
 * by the mouse; `cardLines`: the lines of an item card under the buttons (cardLines).
 */
export function menuHeight(buttons: number, title: boolean, mouse = false, cardLines = 0): number {
  const button = mouse ? 30 : 48;
  const gap = mouse ? 2 : 6;
  const card = cardLines > 0 ? 12 + cardLines * CARD_LINE : 0;
  // With a card the title carries the item's icon at 2x (64 px).
  const head = title ? (cardLines > 0 ? 68 : 34) : 0;
  return (
    2 * 8 +
    2 +
    head +
    buttons * button +
    Math.max(0, buttons - 1) * gap +
    (card > 0 ? gap + card : 0)
  );
}

/**
 * Where a menu (or a tooltip) opened by the mouse at (x, y) goes on a vw x vh screen: its
 * top left corner a little right of and below the pointer, as desktop context menus open;
 * left of it where the right edge is near, above it where the bottom is near; never off
 * the screen (a margin from each edge). When it fits on neither side vertically it takes
 * the screen's height and scrolls inside.
 */
export function mousePlacement(
  x: number,
  y: number,
  vw: number,
  vh: number,
  width: number,
  height: number,
): { left: number; top: number; maxHeight?: number } {
  const gap = 4;
  const m = MENU_MARGIN;
  let left = x + gap;
  if (left + width > vw - m) left = x - gap - width;
  left = Math.round(Math.min(Math.max(left, m), Math.max(m, vw - m - width)));
  if (y + gap + height <= vh - m) return { left, top: Math.round(y + gap) };
  if (y - gap - height >= m) return { left, top: Math.round(y - gap - height) };
  if (height <= vh - 2 * m) return { left, top: Math.round(vh - m - height) };
  return { left, top: m, maxHeight: vh - 2 * m };
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
  width = MENU_WIDTH,
): { left: number; top?: number; bottom?: number; maxHeight?: number } {
  const minLeft = insets.left + MENU_MARGIN;
  const maxLeft = Math.max(minLeft, vw - insets.right - width - MENU_MARGIN);
  const left = Math.round(Math.min(maxLeft, Math.max(minLeft, x - width / 2)));
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
  game:
    | (Pick<Game, "menuChoose" | "closeMenu" | "menuPress" | "menuPressed"> &
        Partial<Pick<Game, "menuSplit" | "itemIcon" | "spriteIcon">>)
    | undefined;
  /** The screen size (window.innerWidth/innerHeight; fixed values in tests). */
  viewport: { width: number; height: number };
  /** The safe area's insets (paddingInsets of .game); none by default. */
  insets?: Insets | undefined;
}): JSX.Element {
  const { t, menu, game } = props;
  const card = menu.card;
  const width = card ? CARD_MENU_WIDTH : MENU_WIDTH;
  const height = menuHeight(
    menu.actions.length + 1,
    menu.title !== "",
    menu.mouse === true,
    card ? cardLines(card, false) : 0,
  );
  const at = menu.mouse
    ? mousePlacement(menu.x, menu.y, props.viewport.width, props.viewport.height, width, height)
    : menuPlacement(
        menu.x,
        menu.y,
        props.viewport.width,
        props.viewport.height,
        height,
        props.insets ?? NO_INSETS,
        width,
      );
  const style: JSX.CSSProperties = { left: `${at.left}px` };
  if (at.top !== undefined) style.top = `${at.top}px`;
  if ("bottom" in at && at.bottom !== undefined) style.bottom = `${at.bottom}px`;
  // The height above is an estimate (a card's description wraps as it wraps): the menu
  // never goes past the safe area's edge on its side, it scrolls inside instead.
  const insets = props.insets ?? NO_INSETS;
  const vh = props.viewport.height;
  const room =
    at.top !== undefined
      ? vh - insets.bottom - MENU_MARGIN - at.top
      : "bottom" in at && at.bottom !== undefined
        ? vh - at.bottom - insets.top - MENU_MARGIN
        : undefined;
  const maxHeight = Math.min(at.maxHeight ?? Infinity, room ?? Infinity);
  if (Number.isFinite(maxHeight)) style.maxHeight = `${Math.max(0, maxHeight)}px`;
  // Read when the click happens, not when the menu was drawn: the press that arms it comes
  // right before its click, maybe before any new render.
  const counts = (e: MouseEvent): boolean => menuClickCounts(game?.menuPressed ?? false, e.detail);
  // The remains of a monster show its own corpse (state/corpse-art.ts), fitted to 64 px.
  const corpse = card?.remainsOf ? game?.spriteIcon?.(corpseSprite(card.remainsOf)) : undefined;
  const icon = corpse ?? (card ? game?.itemIcon?.(card.itemId) : undefined);
  const stack = menu.stack ?? 1;
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
        class={card ? "touch-menu with-card" : "touch-menu"}
        role="menu"
        aria-label={menu.title || t("client.touch.actions.label")}
        data-testid="action-menu"
        data-pointer={menu.mouse ? "mouse" : undefined}
        style={style}
        // A finger (or pen, or mouse) pressed on the menu: its next click is a choice. The
        // finger that opened the menu went down on the map or the item, never here.
        onPointerDown={() => game?.menuPress()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {menu.title && (
          <div class="touch-menu-title">
            {icon && (
              <BigIcon icon={icon} class="touch-menu-icon" {...(corpse ? { fit: 64 } : {})} />
            )}
            <span class={card?.quest ? "touch-menu-name quest" : "touch-menu-name"}>
              {menu.title}
            </span>
          </div>
        )}
        {menu.actions.map((kind, i) =>
          kind === "split" ? (
            // "Move part…": how many units, then the stack is picked with that count (the
            // next click or tap on a slot, a cell or a tile places them). A form without
            // hooks: the field is read when OK is pressed.
            <details key={kind} class="touch-menu-split">
              <summary role="menuitem" class="touch-menu-action" data-action="split">
                {t("client.touch.action.split")}
              </summary>
              <form
                class="touch-menu-split-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  // The field (no instanceof: the tests run without a DOM).
                  const el = e.currentTarget.elements.namedItem("count") as {
                    value?: string;
                  } | null;
                  const n = Number(el?.value ?? NaN);
                  game?.menuSplit?.(splitCount(n, stack));
                }}
              >
                <input
                  type="number"
                  name="count"
                  min={1}
                  max={Math.max(1, stack - 1)}
                  defaultValue={String(halfStack(stack))}
                  aria-label={t("client.touch.split_count")}
                  data-testid="split-count"
                />
                <button type="submit" data-testid="split-ok">
                  {t("client.touch.split_ok")}
                </button>
              </form>
            </details>
          ) : (
            <button
              key={kind}
              type="button"
              role="menuitem"
              class={i === 0 ? "touch-menu-action default" : "touch-menu-action"}
              data-action={kind}
              onClick={(e) => {
                if (counts(e)) game?.menuChoose(kind);
              }}
            >
              {t(`client.touch.action.${kind}`)}
            </button>
          ),
        )}
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
        {card && <ItemCard t={t} card={card} name={false} />}
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
  const name = instanceName(t, def, picked.itemId, picked.mods);
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
