// The item tooltip in the Diablo II style (docs/17 UI-6; the owner on 2026-11-18: "al poner
// el mouse sobre un item muestra su descripción como en diablo"): with no wait (it was
// 350 ms), the moment the mouse is over any DOM item with data-tip-item (equipment, backpack, containers, the shop, trade),
// or the keyboard focuses one, a compact card shows centred above it (below when there is
// no room), never under the cursor. Over the map, the card of the item lying on the tile
// under the mouse (GameUi.groundTip: the canvas follows the tile, the Game picks the item),
// above that tile. It never takes the pointer (pointer-events: none) and goes away when the
// mouse leaves, on any press, a scroll or Escape. Fingers never get it: a long press opens
// the menu with the full card. Only the idea comes from that game: the look is our own.
// After a window opens, nothing shows until the mouse moves (TipGate).
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { itemCard } from "../state/item-card.ts";
import { ItemCard } from "./ItemCard.tsx";

/**
 * How long the card waits after the mouse leaves an item before it goes, ms: sweeping a
 * grid crosses the gaps between the cells, and the next item takes the card over without
 * a blink.
 */
export const TOOLTIP_GRACE_MS = 80;
/** Space between the card and what it describes, and from the edges of the screen, CSS px. */
export const TIP_GAP = 6;
export const TIP_MARGIN = 6;
/**
 * Below the cursor on the map, the text of the default action (render/game-canvas.ts
 * HINT_OFFSET and its line): a card placed under a ground tile goes past it, CSS px.
 */
const GROUND_HINT_PX = 40;

/** A box in page coordinates. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the card goes: its corner, the side it took and, cut when no side fits, its height. */
export interface TipAt {
  left: number;
  top: number;
  side: "above" | "below";
  maxHeight?: number | undefined;
}

/**
 * Where a card of `size` goes for an item at `anchor` on a `view` screen (docs/17 UI-6):
 * centred above it; below when it does not fit above; when neither fits, on the side with
 * more room, cut to it. Never over the item (so never under the cursor that points at it),
 * and inside the screen by TIP_MARGIN.
 */
export function tipPlacement(
  anchor: Rect,
  size: { width: number; height: number },
  view: { width: number; height: number },
): TipAt {
  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.round(
    Math.max(TIP_MARGIN, Math.min(centred, view.width - TIP_MARGIN - size.width)),
  );
  const above = anchor.top - TIP_GAP - TIP_MARGIN;
  const belowTop = anchor.top + anchor.height + TIP_GAP;
  const below = view.height - TIP_MARGIN - belowTop;
  if (size.height <= above)
    return { left, top: Math.round(anchor.top - TIP_GAP - size.height), side: "above" };
  if (size.height <= below) return { left, top: Math.round(belowTop), side: "below" };
  if (above >= below)
    return { left, top: TIP_MARGIN, side: "above", maxHeight: Math.max(0, Math.floor(above)) };
  return {
    left,
    top: Math.round(belowTop),
    side: "below",
    maxHeight: Math.max(0, Math.floor(below)),
  };
}

/**
 * The box a ground item's card avoids: its tile and, under the cursor, the text of the
 * default action (a card placed below goes past it).
 */
export function groundAnchor(tile: Rect, cursorY: number): Rect {
  const bottom = Math.max(tile.top + tile.height, cursorY + GROUND_HINT_PX);
  return { left: tile.left, top: tile.top, width: tile.width, height: bottom - tile.top };
}

/**
 * No card until the mouse moves after a window opened (docs/17 UI-5). A window that opens
 * under a still mouse brings a pointerover from the browser, not from the player: the shop
 * opens left of its dialog, its grid where the dialog's button was clicked, and the card of
 * the item there covered the shop's filters. `opened` shuts the gate; a pointermove away
 * from where the mouse was then (or the first one, if that is unknown) opens it again.
 */
export class TipGate {
  private at: { x: number; y: number } | undefined;
  private shut = false;

  /** Whether a card may show. */
  get open(): boolean {
    return !this.shut;
  }

  /** A window opened (or closed, or folded): wait for the mouse to move. */
  opened(): void {
    this.shut = true;
  }

  /** The keyboard focused an item: its card shows whatever the mouse did. */
  release(): void {
    this.shut = false;
  }

  /** Where the mouse is, from any pointer event: a still mouse over the new window. */
  seen(x: number, y: number): void {
    this.at = { x, y };
  }

  /** A pointermove at x, y: true when it opened the gate. */
  moved(x: number, y: number): boolean {
    const away = !this.at || this.at.x !== x || this.at.y !== y;
    this.at = { x, y };
    if (!this.shut || !away) return false;
    this.shut = false;
    return true;
  }
}

interface Shown {
  itemId: number;
  count: number;
  anchor: Rect;
}

/** The item a data-tip-item element shows: its number and count, or undefined. */
export function tipOf(
  el: Element | null | undefined,
): { itemId: number; count: number } | undefined {
  const host = el?.closest<HTMLElement>("[data-tip-item]");
  if (!host) return undefined;
  const itemId = Number(host.dataset["tipItem"]);
  if (!Number.isFinite(itemId) || itemId <= 0) return undefined;
  const count = Number(host.dataset["tipCount"] ?? "1");
  return { itemId, count: Number.isFinite(count) && count > 0 ? count : 1 };
}

/**
 * What the card's place depends on: the item it describes (its size) and where that item
 * is. The Game publishes about 20 times a second; the card is measured and placed again
 * only when this changes, not on every publish (a layout each time).
 */
export function placeKey(
  tip: { itemId: number; count: number; anchor: Rect } | undefined,
  card: string,
): string {
  if (!tip) return "";
  const a = tip.anchor;
  return `${tip.itemId}:${tip.count}:${a.left}:${a.top}:${a.width}:${a.height}:${card}`;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function ItemTooltip(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Nothing shows while true (a menu is open, an item is picked). */
  blocked: boolean;
  /**
   * Changes when a window opens, closes or folds (ui/windows.ts shownKey): no card until
   * the mouse moves (TipGate).
   */
  windows?: string | undefined;
}): JSX.Element | null {
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const blocked = useRef(props.blocked);
  blocked.current = props.blocked || props.ui.dragging !== undefined;
  const gate = useRef(new TipGate());
  const [quiet, setQuiet] = useState(false);
  const windows = useRef(props.windows);
  // Before the paint, so the browser's pointerover of the new window finds the gate shut.
  useLayoutEffect(() => {
    if (windows.current === props.windows) return;
    windows.current = props.windows;
    gate.current.opened();
    setQuiet(true);
    setShown(undefined);
  }, [props.windows]);
  useEffect(() => {
    let grace: ReturnType<typeof setTimeout> | undefined;
    let over: Element | undefined;
    const hide = (): void => {
      clearTimeout(grace);
      grace = undefined;
      setShown(undefined);
    };
    const show = (host: Element): void => {
      clearTimeout(grace);
      grace = undefined;
      const tip = tipOf(host);
      if (!tip || blocked.current || document.body.classList.contains("dragging-item")) {
        setShown(undefined);
        return;
      }
      setShown({ ...tip, anchor: rectOf(host) });
    };
    const onOver = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") return;
      gate.current.seen(e.clientX, e.clientY);
      if (!gate.current.open) return; // a window opened under a still mouse
      const host = (e.target as Element | null)?.closest?.("[data-tip-item]") ?? undefined;
      if (host === over) return;
      over = host;
      if (host) show(host); // a gap between cells: onOut's grace decides
    };
    // After a press (it hid the card), or a window that opened, the mouse still over an item
    // brings it back as it moves.
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") return;
      if (gate.current.moved(e.clientX, e.clientY)) {
        over = undefined;
        setQuiet(false);
      }
      if (!gate.current.open || over !== undefined || e.buttons !== 0) return;
      const host = (e.target as Element | null)?.closest?.("[data-tip-item]") ?? undefined;
      if (!host) return;
      over = host;
      show(host);
    };
    const onOut = (e: PointerEvent): void => {
      const to = e.relatedTarget as Node | null;
      if (over && to && over.contains(to)) return;
      over = undefined;
      clearTimeout(grace);
      grace = setTimeout(hide, TOOLTIP_GRACE_MS);
    };
    const onFocus = (e: FocusEvent): void => {
      const el = e.target as Element | null;
      if (!el?.matches?.(":focus-visible")) return; // a click focuses too: only the keyboard
      if (!tipOf(el)) return;
      gate.current.release();
      setQuiet(false);
      show(el);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") hide();
    };
    const onPress = (): void => {
      over = undefined;
      hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("wheel", onPress, { passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(grace);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("wheel", onPress);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const { ui } = props;
  // A DOM item's card first; else the one of the item on the map tile under the mouse
  // (Game.restTile), above that tile.
  const g = shown ? undefined : ui.groundTip;
  const tip: Shown | undefined =
    shown ?? (g && { itemId: g.itemId, count: g.count, anchor: groundAnchor(g.tile, g.y) });
  const hidden = !tip || blocked.current || quiet;
  const magic = ui.skills.find((s) => s.id === "magic");
  // What the card shows besides the item (a requirement met or not changes its lines).
  const reader = `${ui.stats?.level ?? ""}:${ui.vocation ?? ""}:${magic?.level ?? ""}`;
  const key = hidden ? "" : placeKey(tip, reader);
  // Measured before the paint, then placed: the card's real size, not a guess. Once per
  // card and place (placeKey): a new card element (hidden, then shown) changes the key.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !tip || hidden) return;
    const at = tipPlacement(
      tip.anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    el.style.maxHeight = at.maxHeight === undefined ? "" : `${at.maxHeight}px`;
    el.dataset["side"] = at.side;
    el.style.visibility = "visible";
  }, [key]);
  if (!tip || hidden) return null;
  const card = itemCard(props.content.items[tip.itemId], tip.itemId, tip.count, {
    level: ui.stats?.level,
    vocation: ui.vocation,
    magicLevel: magic?.level,
  });
  return (
    <div
      ref={box}
      class="item-tooltip"
      role="tooltip"
      data-testid="item-tooltip"
      data-ground={shown ? undefined : ""}
    >
      <ItemCard t={props.t} card={card} tip />
    </div>
  );
}
