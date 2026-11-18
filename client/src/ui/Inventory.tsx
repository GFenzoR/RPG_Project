// Inventory (T1.8): the equipment slots and the open container windows. Items are
// dragged with the pointer (Game.pressItem) and dropped on a slot, a container cell or
// the map; shift+click looks at an item and shift+drag moves part of a stack (it asks how
// many where it is dropped). On the desktop each container is a window of its own
// (docs/17 UI-5: ContainerView in a GameWindow); on tablets and phones they stay under
// the equipment. An empty slot shows what it takes (ui/slots/<slot>, own pixel art). Since docs/17 UI-6 a right click opens its menu
// with its card (or uses it, in the classic controls: Game.itemContextMenu), a double
// click does its default action (open, use with, eat, equip, use) and hovering shows its
// card (ui/ItemTooltip.tsx reads data-tip-item). The server validates every move: this UI
// only shows what it says.
import { EquipmentSlot } from "@rpg/protocol";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { sameRef } from "../input/actions.ts";
import { formatOz } from "../state/items.ts";
import type { ItemRef } from "../state/items.ts";
import type { ContainerState, ItemView } from "../state/world.ts";

/** Equipment grid, row by row (undefined = empty cell). */
const LAYOUT: (EquipmentSlot | undefined)[] = [
  EquipmentSlot.NECK,
  EquipmentSlot.HEAD,
  EquipmentSlot.BACKPACK,
  EquipmentSlot.LEFT_HAND,
  EquipmentSlot.ARMOR,
  EquipmentSlot.RIGHT_HAND,
  EquipmentSlot.RING,
  EquipmentSlot.LEGS,
  EquipmentSlot.AMMO,
  undefined,
  EquipmentSlot.FEET,
  undefined,
];

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
   * where each is a window of its own. */
  containers?: boolean | undefined;
}

export function InventoryPanel({ t, content, game, ui, containers }: Props): JSX.Element {
  return (
    <section
      class="inventory"
      data-testid="inventory"
      data-tutorial="inventory"
      aria-label={t("client.inventory.title")}
    >
      <h2>{t("client.inventory.title")}</h2>
      <div class="equipment">
        {LAYOUT.map((slot, i) =>
          slot === undefined ? (
            <span key={`gap-${i}`} class="slot gap" />
          ) : (
            <div
              key={slot}
              class="slot"
              data-drop="slot"
              data-slot={slot}
              data-testid={`slot-${SLOT_KEYS[slot] ?? slot}`}
              title={t(`client.inventory.slot.${SLOT_KEYS[slot] ?? ""}`)}
              style={ui.inventory.has(slot) ? undefined : emptySlotStyle(game, slot)}
            >
              <ItemCell
                t={t}
                content={content}
                game={game}
                item={ui.inventory.get(slot)}
                picked={ui.picked}
                itemRef={(it) => ({
                  loc: { kind: "slot", slot },
                  itemId: it.itemId,
                  stackIndex: 0,
                  count: it.count,
                })}
              />
            </div>
          ),
        )}
      </div>
      {ui.stats && (
        <p class="capacity" data-testid="capacity">
          {t("client.inventory.capacity", {
            free: formatOz(ui.stats.capacity),
            max: formatOz(ui.stats.maxCapacity),
          })}
        </p>
      )}
      {containers !== false &&
        ui.containers.map((c) => (
          <ContainerView key={c.id} t={t} content={content} game={game} ui={ui} container={c} />
        ))}
    </section>
  );
}

/**
 * One open container: its cells (as many as it holds, or its items if more). With `framed`
 * it is the body of its own GameWindow (the desktop), whose title bar names and closes it.
 */
export function ContainerView(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  container: ContainerState;
  framed?: boolean | undefined;
}): JSX.Element {
  const { t, content, game, ui, container: c } = props;
  return (
    <div
      class={props.framed ? "container framed" : "container"}
      data-testid="container"
      data-container-item={content.items[c.itemId]?.id ?? ""}
      data-container={c.id}
    >
      {!props.framed && (
        <header>
          <span>{itemName(content, t, c.itemId)}</span>
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
 * sprite ui/slots/<slot> as the slot's background, 1 CSS px per sprite px like the item
 * icons; nothing until the atlas is up (or without the sprite).
 */
export function emptySlotStyle(
  game: Pick<Game, "spriteIcon"> | undefined,
  slot: EquipmentSlot,
): JSX.CSSProperties | undefined {
  const key = SLOT_KEYS[slot];
  const icon = key ? game?.spriteIcon(`ui/slots/${key}`) : undefined;
  if (!icon || icon.width !== 32 || icon.height !== 32) return undefined;
  return {
    "--slot-icon": `url(${icon.url})`,
    "--slot-icon-pos": `-${icon.x}px -${icon.y}px`,
  };
}

export function itemName(content: ClientContent, t: Translate, itemId: number): string {
  const def = content.items[itemId];
  return def ? t(`item.${def.id}.name`) : String(itemId);
}

function ItemCell(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  item: ItemView | undefined;
  picked: ItemRef | undefined;
  itemRef(it: ItemView): ItemRef;
}): JSX.Element | null {
  const { item, game } = props;
  if (!item) return null;
  const ref = props.itemRef(item);
  // T5.6: the item picked by a tap (waiting for its destination) is outlined.
  const picked = props.picked !== undefined && sameRef(props.picked, ref);
  const name = itemName(props.content, props.t, item.itemId);
  const icon = game?.itemIcon(item.itemId);
  const style: JSX.CSSProperties = icon
    ? {
        backgroundImage: `url(${icon.url})`,
        backgroundPosition: `-${icon.x}px -${icon.y}px`,
        width: `${icon.width}px`,
        height: `${icon.height}px`,
      }
    : {};
  return (
    <span
      class={(icon ? "item" : "item missing") + (picked ? " picked" : "")}
      data-picked={picked ? "" : undefined}
      style={style}
      aria-label={
        item.count > 1 ? props.t("client.log.item_count", { count: item.count, name }) : name
      }
      data-item={props.content.items[item.itemId]?.id ?? item.itemId}
      data-quest={props.content.items[item.itemId]?.quest ? "" : undefined}
      // docs/17 UI-6: the card on hover and on keyboard focus (ui/ItemTooltip.tsx).
      data-tip-item={item.itemId}
      data-tip-count={item.count}
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
      {!icon && name.slice(0, 2)}
      {item.count > 1 && <span class="count">{item.count}</span>}
    </span>
  );
}
