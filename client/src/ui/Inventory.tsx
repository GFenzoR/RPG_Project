// Inventory (T1.8), in the Diablo II style since 2026-11-18 (docs/17 UI-5; the owner: "creo
// que sería más cómodo estilo Diablo II"): the equipment slots over a figure on a grid of
// square cells (state/equipment.ts DOLL: big slots for big items, each icon at the largest
// whole scale its slot holds), the backpack worn on the back open under it (its grid, as
// that game's inventory; it opens by itself when the inventory shows: state/backpack.ts),
// and the load as a bar with its text. Only the layout idea comes from that game.
//
// Items are dragged with the pointer (Game.pressItem) and dropped on a slot, a container
// cell or the map; while one is dragged or picked, the slots that take it glow and the
// others tint red under the pointer (slotDrop; the backpack slot takes anything, into the
// backpack or, without one, the pockets). Shift+click looks at an item and
// shift+drag moves part of a stack (it asks how many where it is dropped). Every other open
// container is a window of its own on the desktop (ContainerView in a GameWindow); on
// tablets and phones they stay under the equipment. An empty slot shows what it takes
// (ui/slots/<slot>, own pixel art). A right click opens an item's menu with its card (or
// uses it, in the classic controls: Game.itemContextMenu), a double click does its default
// action (open, use with, eat, equip, use) and hovering shows its card (ui/ItemTooltip.tsx
// reads data-tip-item). Under the figure, above the backpack, the character's own pockets
// (docs/02 "Bolsillos"): a row of cells that are part of it, never an item, with the same
// drag and drop, menu and card. The server validates every move: this UI only shows what it
// says.
import { EquipmentSlot } from "@rpg/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import { tipMods } from "../state/mods.ts";
import { instanceName } from "../state/item-name.ts";
import type { NameMods } from "../state/item-name.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { sameRef } from "../input/actions.ts";
import { autoOpen } from "../state/backpack.ts";
import { deferredMeasure } from "./next-frame.ts";
import {
  DOLL,
  capacityLoad,
  dollCell,
  dollSize,
  iconScale,
  slotBox,
  slotDrop,
} from "../state/equipment.ts";
import { formatOz } from "../state/items.ts";
import { pocketCells, pocketRef } from "../state/pockets.ts";
import type { ItemRef } from "../state/items.ts";
import type { ContainerState, ItemView } from "../state/world.ts";
import { iconStyle } from "./ItemCard.tsx";

export const SLOT_KEYS: Record<number, string> = {
  [EquipmentSlot.HEAD]: "head",
  [EquipmentSlot.NECK]: "neck",
  [EquipmentSlot.BACKPACK]: "backpack",
  [EquipmentSlot.ARMOR]: "armor",
  [EquipmentSlot.RIGHT_HAND]: "right_hand",
  [EquipmentSlot.LEFT_HAND]: "left_hand",
  [EquipmentSlot.LEGS]: "legs",
  [EquipmentSlot.FEET]: "feet",
  [EquipmentSlot.RING]: "ring",
  [EquipmentSlot.AMMO]: "ammo",
};

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** The open containers under the equipment (tablets and phones); false on the desktop,
   * where each is a window of its own. The equipped backpack is under the figure in both. */
  containers?: boolean | undefined;
}

/** The width the figure has (its box, docked, floating or in a tab), CSS px. */
function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  // Before the paint: the figure shows at its size from the first frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    // A change seen by the observer is applied on the next frame (deferredMeasure): the
    // figure it resizes changes the box's height, and inside the observer's own delivery
    // that is a "ResizeObserver loop" error (a tab shown on a phone, WebKit reports it).
    const later = deferredMeasure(measure);
    const observer = new ResizeObserver(later.run);
    observer.observe(el);
    return () => {
      observer.disconnect();
      later.cancel();
    };
  }, []);
  return width;
}

export function InventoryPanel({ t, content, game, ui, containers }: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const cell = dollCell(width);
  const size = dollSize(cell);
  // docs/17 UI-5: the backpack on the back opens by itself when the inventory shows.
  const worn = ui.inventory.get(EquipmentSlot.BACKPACK);
  const equipped = worn && (content.items[worn.itemId]?.slots ?? 0) > 0 ? worn.itemId : undefined;
  const docked = ui.backpack !== undefined;
  const tutorial = ui.tutorial !== undefined;
  const lookalike =
    equipped !== undefined && ui.containers.some((c) => c.itemId === equipped && !c.hasParent);
  const done = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!game) return; // nothing is asked (nor remembered) before the session's Game is up
    const waiting = game.backpackWaiting();
    const next = autoOpen({ equipped, docked, tutorial, lookalike, waiting, done: done.current });
    done.current = next.done;
    if (next.open) game.openBackpack();
  }, [equipped, docked, tutorial, lookalike, game]);
  // While an item is dragged or picked, the slots that take it glow.
  const held = ui.dragging ?? ui.picked;
  const heldDef = held ? content.items[held.itemId] : undefined;
  return (
    <section
      class="inventory"
      data-testid="inventory"
      data-tutorial="inventory"
      aria-label={t("client.inventory.title")}
    >
      <h2>{t("client.inventory.title")}</h2>
      <div class="doll-box" ref={box}>
        <div
          class="equipment doll"
          data-holding={held ? "" : undefined}
          style={{
            "--doll-cell": `${cell}px`,
            width: `${size.width}px`,
            height: `${size.height}px`,
            marginLeft: `${Math.max(0, Math.floor((width - size.width) / 2))}px`,
          }}
        >
          {DOLL.map((place) => {
            const { slot } = place;
            const key = SLOT_KEYS[slot] ?? String(slot);
            const item = ui.inventory.get(slot);
            const sbox = slotBox(place, cell);
            const style: JSX.CSSProperties = {
              gridColumn: `${place.col} / span ${place.w}`,
              gridRow: `${place.row} / span ${place.h}`,
              ...(item ? {} : emptySlotStyle(game, slot, sbox)),
            };
            return (
              <div
                key={slot}
                class="slot"
                data-drop="slot"
                data-slot={slot}
                data-testid={`slot-${key}`}
                data-accepts={held ? slotDrop(heldDef, slot) : undefined}
                // The slot's name while it is empty (its item names itself, and its card shows).
                title={item ? undefined : t(`client.inventory.slot.${key}`)}
                style={style}
              >
                <ItemCell
                  t={t}
                  content={content}
                  game={game}
                  item={item}
                  picked={ui.picked}
                  box={sbox}
                  itemRef={(it) => ({
                    loc: { kind: "slot", slot },
                    itemId: it.itemId,
                    stackIndex: 0,
                    count: it.count,
                    mods: it.mods,
                  })}
                />
              </div>
            );
          })}
        </div>
      </div>
      <PocketsRow t={t} content={content} game={game} ui={ui} />
      {ui.backpack && (
        <ContainerView t={t} content={content} game={game} ui={ui} container={ui.backpack} docked />
      )}
      {ui.stats && <Capacity t={t} free={ui.stats.capacity} max={ui.stats.maxCapacity} />}
      {containers !== false &&
        ui.containers.map((c) => (
          <ContainerView key={c.id} t={t} content={content} game={game} ui={ui} container={c} />
        ))}
    </section>
  );
}

/**
 * The character's pockets (docs/02 "Bolsillos"): a row of its built-in cells under the
 * figure, above the docked backpack. Each cell is a drop target (`data-drop="pocket"`, the
 * ItemLocation.pocket of the cell) and its item has the menu, the card and the drag of any
 * other. Nothing before the first Inventory (no cells).
 */
export function PocketsRow(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element | null {
  const { t, content, game, ui } = props;
  const cells = pocketCells(ui.pockets);
  if (cells.length === 0) return null;
  const title = t("client.inventory.pockets");
  return (
    <div class="pockets" data-testid="pockets" role="group" aria-label={title}>
      <header>
        <span>{title}</span>
      </header>
      <div class="cells" style={{ "--pocket-cells": String(cells.length) }}>
        {cells.map((item, i) => (
          <div
            key={i}
            class="slot"
            data-drop="pocket"
            data-index={i}
            data-testid={`pocket-${i}`}
            // An empty cell names itself (its item names itself, and its card shows).
            title={item ? undefined : t("client.inventory.pocket")}
          >
            <ItemCell
              t={t}
              content={content}
              game={game}
              item={item}
              picked={ui.picked}
              itemRef={(it) => pocketRef(it, i)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The load under the grid (docs/17 UI-5): a thin bar of what is carried, and the text. */
function Capacity(props: { t: Translate; free: number; max: number }): JSX.Element {
  const load = capacityLoad(props.free, props.max);
  return (
    <div class="capacity" data-testid="capacity" data-load={load.level}>
      <span class="cap-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${load.fraction})` }} />
      </span>
      <p>
        {props.t("client.inventory.capacity", {
          free: formatOz(props.free),
          max: formatOz(props.max),
        })}
      </p>
    </div>
  );
}

/**
 * One open container: its cells (as many as it holds, or its items if more). With `framed`
 * it is the body of its own GameWindow (the desktop), whose title bar names and closes it;
 * `docked` is the equipped backpack under the figure (docs/17 UI-5), its grid filling the
 * inventory's width.
 */
export function ContainerView(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  container: ContainerState;
  framed?: boolean | undefined;
  docked?: boolean | undefined;
}): JSX.Element {
  const { t, content, game, ui, container: c } = props;
  return (
    <div
      class={props.framed ? "container framed" : props.docked ? "container docked" : "container"}
      data-testid="container"
      data-container-item={content.items[c.itemId]?.id ?? ""}
      data-container={c.id}
      data-docked={props.docked ? "" : undefined}
    >
      {!props.framed && (
        <header>
          <span>{itemName(content, t, c.itemId, c.mods)}</span>
          <button
            type="button"
            aria-label={t("client.inventory.close")}
            title={t("client.inventory.close")}
            onClick={() => game?.closeContainer(c.id)}
          >
            ×
          </button>
        </header>
      )}
      <div class="cells">
        {Array.from({ length: Math.max(c.capacity, c.items.length) }, (_, i) => (
          <div key={i} class="slot" data-drop="container" data-container={c.id} data-index={i}>
            <ItemCell
              t={t}
              content={content}
              game={game}
              item={c.items[i]}
              picked={ui.picked}
              itemRef={(it) => ({
                loc: { kind: "container", id: c.id, index: i },
                itemId: it.itemId,
                stackIndex: i,
                count: it.count,
                mods: it.mods,
              })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The faded silhouette of what an empty equipment slot takes (docs/17 UI-5): the atlas
 * sprite ui/slots/<slot> as the slot's background, at the whole scale an item's icon would
 * take in that slot (`box`, state/equipment.ts iconScale); nothing until the atlas is up (or
 * without the sprite).
 */
export function emptySlotStyle(
  game: Pick<Game, "spriteIcon"> | undefined,
  slot: EquipmentSlot,
  box?: { width: number; height: number },
): JSX.CSSProperties | undefined {
  const key = SLOT_KEYS[slot];
  const icon = key ? game?.spriteIcon(`ui/slots/${key}`) : undefined;
  if (!icon || icon.width !== 32 || icon.height !== 32) return undefined;
  return {
    "--slot-icon": `url(${icon.url})`,
    "--slot-icon-pos": `-${icon.x}px -${icon.y}px`,
    "--slot-scale": String(box ? iconScale(box, icon) : 1),
  };
}

/** An item's name, with the instance's mods when it has them (state/item-name.ts). */
export function itemName(
  content: ClientContent,
  t: Translate,
  itemId: number,
  mods?: NameMods | undefined,
): string {
  return instanceName(t, content.items[itemId], itemId, mods);
}

function ItemCell(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  item: ItemView | undefined;
  picked: ItemRef | undefined;
  /** The slot's box: the icon takes the largest whole scale that fits it (1x without). */
  box?: { width: number; height: number } | undefined;
  itemRef(it: ItemView): ItemRef;
}): JSX.Element | null {
  const { item, game } = props;
  if (!item) return null;
  const ref = props.itemRef(item);
  // T5.6: the item picked by a tap (waiting for its destination) is outlined.
  const picked = props.picked !== undefined && sameRef(props.picked, ref);
  const name = itemName(props.content, props.t, item.itemId);
  const icon = game?.itemIcon(item.itemId);
  const scale = icon && props.box ? iconScale(props.box, icon) : 1;
  const style: JSX.CSSProperties = icon
    ? { width: `${icon.width * scale}px`, height: `${icon.height * scale}px` }
    : {};
  return (
    <span
      class={(icon ? "item" : "item missing") + (picked ? " picked" : "")}
      data-picked={picked ? "" : undefined}
      data-scale={scale === 1 ? undefined : scale}
      style={style}
      aria-label={
        item.count > 1 ? props.t("client.log.item_count", { count: item.count, name }) : name
      }
      data-item={props.content.items[item.itemId]?.id ?? item.itemId}
      data-quest={props.content.items[item.itemId]?.quest ? "" : undefined}
      // docs/17 UI-6: the card on hover and on keyboard focus (ui/ItemTooltip.tsx).
      data-tip-item={item.itemId}
      data-tip-count={item.count}
      data-tip-mods={tipMods(item.mods)}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Shift: a click looks, a drag moves part of a stack (Game.pressItem).
        game?.pressItem(ref, e);
      }}
      onDblClick={(e) => {
        if (e.shiftKey) return;
        e.preventDefault();
        game?.itemDefault(ref);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // A finger's long press also fires contextmenu (T5.6): its menu, never a use.
        game?.itemContextMenu(ref, e);
      }}
      onKeyDown={(e) => {
        // The keyboard: Enter does the default action, the menu key (or Shift+F10) opens
        // the menu beside the item.
        if (e.key === "Enter") {
          e.preventDefault();
          game?.itemDefault(ref);
        } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          game?.itemContextMenu(ref, {
            clientX: r.right,
            clientY: r.bottom,
            shiftKey: true,
            ctrlKey: false,
          });
        }
      }}
    >
      {icon && (
        <span
          class="sprite"
          aria-hidden="true"
          style={{ ...iconStyle(icon), ...(scale === 1 ? {} : { transform: `scale(${scale})` }) }}
        />
      )}
      {!icon && name.slice(0, 2)}
      {item.count > 1 && <span class="count">{item.count}</span>}
    </span>
  );
}
