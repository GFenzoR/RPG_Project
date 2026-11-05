// Inventory (T1.8): the equipment slots and the open container windows. Items are
// dragged with the pointer (Game.pressItem) and dropped on a slot, a container cell or
// the map; right click uses an item (opens a container, eats) and shift+click looks at
// it. The server validates every move: this UI only shows what it says.
import { EquipmentSlot } from "@rpg/protocol";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { formatOz } from "../state/items.ts";
import type { ItemRef } from "../state/items.ts";
import type { ItemView } from "../state/world.ts";

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

const SLOT_KEYS: Record<number, string> = {
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
}

export function InventoryPanel({ t, content, game, ui }: Props): JSX.Element {
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
            >
              <ItemCell
                t={t}
                content={content}
                game={game}
                item={ui.inventory.get(slot)}
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
      {ui.containers.map((c) => (
        <div
          key={c.id}
          class="container"
          data-testid="container"
          data-container-item={content.items[c.itemId]?.id ?? ""}
        >
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
          <div class="cells">
            {Array.from({ length: Math.max(c.capacity, c.items.length) }, (_, i) => (
              <div key={i} class="slot" data-drop="container" data-container={c.id} data-index={i}>
                <ItemCell
                  t={t}
                  content={content}
                  game={game}
                  item={c.items[i]}
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
      ))}
    </section>
  );
}

function itemName(content: ClientContent, t: Translate, itemId: number): string {
  const def = content.items[itemId];
  return def ? t(`item.${def.id}.name`) : String(itemId);
}

function ItemCell(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  item: ItemView | undefined;
  itemRef(it: ItemView): ItemRef;
}): JSX.Element | null {
  const { item, game } = props;
  if (!item) return null;
  const ref = props.itemRef(item);
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
      class={icon ? "item" : "item missing"}
      style={style}
      title={name}
      aria-label={
        item.count > 1 ? props.t("client.log.item_count", { count: item.count, name }) : name
      }
      data-item={props.content.items[item.itemId]?.id ?? item.itemId}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (e.shiftKey) game?.lookAt(ref);
        else game?.pressItem(ref, e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        game?.useItem(ref);
      }}
    >
      {!icon && name.slice(0, 2)}
      {item.count > 1 && <span class="count">{item.count}</span>}
    </span>
  );
}
