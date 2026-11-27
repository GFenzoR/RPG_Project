// The item hotkeys of the bottom bar (docs/02 "Teclas rapidas de items", the owner's request of
// 2026-11-27): six slots next to the spell hotbar that hold food, potions and runes, used with
// the keys 1-6 or a tap. A slot holds an item TYPE: the icon, how many units the character
// carries in all (the server counts closed containers too, ItemCounts) and, greyed out with 0,
// "none carried" (the assignment stays). Items are assigned by dragging them from the bag, the
// pockets or a container onto a slot, with "Assign to a quick key" of an item's menu, or with
// the pencil (a list per slot); a slot dragged away empties, or swaps with the one it lands on.
// The same component sits in the desktop bar, in the upright console and the line of a phone on
// its side; mobile.css and windows.css size it.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { hotkeyUsable, itemKeyLabel, slotView } from "../state/item-hotkeys.ts";
import { iconStyle } from "./ItemCard.tsx";
import { itemName } from "./Inventory.tsx";
import { FLASH_MS } from "./Hotbar.tsx";
import { tapProps } from "./tap.ts";

/** Repaint interval of the cooldown shades, ms (as the spell hotbar's). */
const COOLDOWN_REFRESH_MS = 100;

/** The assignable item types of the content, by their translated name. */
export function assignable(content: ClientContent, t: Translate): { id: number; name: string }[] {
  return Object.entries(content.items)
    .filter(([, def]) => hotkeyUsable(def))
    .map(([id]) => ({ id: Number(id), name: itemName(content, t, Number(id)) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** Whether the slot of `at` flashes at `now` (the key or tap that used it just now). */
export function itemFlashes(
  use: { slot: number; at: number } | undefined,
  slot: number,
  now: number,
): boolean {
  return use !== undefined && use.slot === slot && Math.abs(now - use.at) < FLASH_MS;
}

export function ItemHotbar(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Where it sits (CSS hook): the desktop bar, the upright console, over the map. */
  place: "bar" | "console" | "row";
}): JSX.Element {
  const { t, content, game, ui } = props;
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const any = ui.itemKeys.some((k) => k > 0);
  useEffect(() => {
    if (!any) return undefined;
    const timer = setInterval(() => setNow(performance.now()), COOLDOWN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [any]);
  // What an item shown here would be assigned: the one dragged or picked, if usable.
  const held = ui.dragging ?? ui.picked;
  const accepts = held ? hotkeyUsable(content.items[held.itemId]) : undefined;
  const choices = editing ? assignable(content, t) : [];
  return (
    <section
      class="itemkeys"
      data-testid="itemkeys"
      data-place={props.place}
      data-holding={held ? (accepts ? "yes" : "no") : undefined}
      aria-label={t("client.itemkeys.title")}
    >
      <ol>
        {ui.itemKeys.map((id, i) => {
          const key = itemKeyLabel(i);
          const view = slotView(id, ui.itemCounts);
          const def = content.items[id];
          const name = id > 0 ? itemName(content, t, id) : "";
          const left = id > 0 && game ? game.itemCooldown(id, now) : 0;
          const icon = id > 0 ? game?.itemIcon(id) : undefined;
          return (
            <li
              key={key}
              data-itemkey={key}
              data-drop="itemkey"
              data-index={i}
              data-accepts={held ? (accepts ? "yes" : "no") : undefined}
            >
              {editing ? (
                <select
                  aria-label={t("client.itemkeys.assign", { key })}
                  value={String(id)}
                  onChange={(e) => game?.setItemKey(i, Number(e.currentTarget.value))}
                >
                  <option value="0">{t("client.hotbar.none")}</option>
                  {choices.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  data-item-slot={id > 0 ? (def?.id ?? id) : undefined}
                  data-none={view.empty ? "" : undefined}
                  data-count={view.count}
                  aria-label={
                    id > 0
                      ? t("client.itemkeys.slot", { key, name, count: view.count ?? 0 })
                      : t("client.itemkeys.slot_empty", { key })
                  }
                  // The card on hover and on keyboard focus (ui/ItemTooltip.tsx).
                  data-tip-item={id > 0 ? id : undefined}
                  data-tip-count={id > 0 ? Math.max(1, view.count ?? 1) : undefined}
                  onPointerDown={(e) => game?.pressItemKey(i, e)}
                  // The keyboard empties a focused slot (the mouse drags it away).
                  onKeyDown={(e) => {
                    if (e.key === "Delete" || e.key === "Backspace") {
                      e.preventDefault();
                      game?.setItemKey(i, 0);
                    }
                  }}
                  // Any finger uses it (the other thumb may be on the pad), as the spells do.
                  {...tapProps(() => game?.useItemKeyTap(i))}
                >
                  <span class="key">{key}</span>
                  {icon && <span class="sprite" aria-hidden="true" style={iconStyle(icon)} />}
                  {id > 0 && !icon && <span class="name">{name.slice(0, 3)}</span>}
                  {id > 0 && view.count !== undefined && (
                    <span class="count" data-testid={`itemkey-count-${key}`}>
                      {view.count}
                    </span>
                  )}
                  {left > 0 && <span class="cd" style={{ height: `${Math.round(left * 100)}%` }} />}
                  {itemFlashes(ui.itemUse, i, now) && (
                    <span class="flash" key={ui.itemUse?.at} data-flash="" aria-hidden="true" />
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        class="edit"
        aria-pressed={editing}
        title={t("client.itemkeys.edit")}
        aria-label={t("client.itemkeys.edit")}
        onClick={() => setEditing(!editing)}
      >
        ✎
      </button>
    </section>
  );
}
