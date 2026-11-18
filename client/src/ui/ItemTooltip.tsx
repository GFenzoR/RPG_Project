// The item card as a tooltip (docs/17 UI-6): 350 ms after the mouse rests on any DOM item
// with data-tip-item (inventory, containers, the shop, trade), or when the keyboard focuses
// one, its card shows beside it. It never takes the pointer (pointer-events: none) and goes
// away when the mouse leaves, on any press, a scroll or Escape. Fingers never get it: a
// long press opens the menu with the same card.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { cardLines, itemCard } from "../state/item-card.ts";
import { CARD_MENU_WIDTH, mousePlacement } from "./ActionMenu.tsx";
import { ItemCard } from "./ItemCard.tsx";

/** How long the mouse rests on an item before its card shows, ms (docs/17 UI-9). */
export const TOOLTIP_DELAY_MS = 350;
/** Height of a line of the card and its padding (client.css .item-tooltip), CSS px. */
const LINE = 19;
const PAD = 20;

interface Shown {
  itemId: number;
  count: number;
  x: number;
  y: number;
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

export function ItemTooltip(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Nothing shows while true (a menu is open, an item is picked). */
  blocked: boolean;
}): JSX.Element | null {
  const [shown, setShown] = useState<Shown | undefined>(undefined);
  const blocked = useRef(props.blocked);
  blocked.current = props.blocked;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over: Element | undefined;
    let at = { x: 0, y: 0 };
    const hide = (): void => {
      clearTimeout(timer);
      timer = undefined;
      setShown(undefined);
    };
    const onOver = (e: PointerEvent): void => {
      if (e.pointerType !== "mouse") return;
      const host = (e.target as Element | null)?.closest?.("[data-tip-item]") ?? undefined;
      if (host === over) return;
      over = host;
      hide();
      at = { x: e.clientX, y: e.clientY };
      const tip = tipOf(host);
      if (!tip || document.body.classList.contains("dragging-item")) return;
      timer = setTimeout(() => {
        if (blocked.current) return;
        setShown({ ...tip, ...at });
      }, TOOLTIP_DELAY_MS);
    };
    const onMove = (e: PointerEvent): void => {
      if (timer !== undefined) at = { x: e.clientX, y: e.clientY };
    };
    const onOut = (e: PointerEvent): void => {
      const to = e.relatedTarget as Node | null;
      if (over && to && over.contains(to)) return;
      over = undefined;
      hide();
    };
    const onFocus = (e: FocusEvent): void => {
      const el = e.target as Element | null;
      if (!el?.matches?.(":focus-visible")) return; // a click focuses too: only the keyboard
      const tip = tipOf(el);
      if (!tip || blocked.current) return;
      const r = el.getBoundingClientRect();
      setShown({ ...tip, x: r.right, y: r.bottom });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("wheel", hide, { passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("wheel", hide);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!shown || props.blocked) return null;
  const { ui } = props;
  const magic = ui.skills.find((s) => s.id === "magic");
  const card = itemCard(props.content.items[shown.itemId], shown.itemId, shown.count, {
    level: ui.stats?.level,
    vocation: ui.vocation,
    magicLevel: magic?.level,
  });
  const height = PAD + cardLines(card, true) * LINE + 40;
  const at = mousePlacement(
    shown.x + 12,
    shown.y + 12,
    window.innerWidth,
    window.innerHeight,
    CARD_MENU_WIDTH,
    height,
  );
  const style: JSX.CSSProperties = { left: `${at.left}px`, top: `${at.top}px` };
  if (at.maxHeight !== undefined) style.maxHeight = `${at.maxHeight}px`;
  return (
    <div class="item-tooltip" role="tooltip" data-testid="item-tooltip" style={style}>
      <ItemCard t={props.t} card={card} icon={props.game?.itemIcon(shown.itemId)} />
    </div>
  );
}
