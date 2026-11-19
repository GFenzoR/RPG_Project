// The item card (docs/17 UI-6): what the right-click menu, the hover tooltip and the shop
// show of an item, from its ItemDef (vite/content.ts cardFields). Pure: the caller passes
// who looks (level, vocation, magic level) so a requirement can show whether it is met.
// The server's "look" text is still the one that knows live data (a house's owner,
// charges): "Look" in the menu keeps sending LookAt.
import { EquipmentSlot } from "@rpg/protocol";
import type { AttributeDef, ForgeRules, ItemDef, ItemMods } from "../content-types.ts";
import { refineGain, refineKind } from "./forge.ts";
import type { RefineKind } from "./forge.ts";
import { formatOz } from "./items.ts";

/** What the card needs to know of the player looking. Unknown fields skip the check. */
export interface Viewer {
  level?: number | undefined;
  vocation?: string | undefined;
  magicLevel?: number | undefined;
}

/** One stat line: its label's i18n key and the value (a number, or "1.20" oz). */
export interface CardStat {
  /** client.card.stat.<id> */
  id: "attack" | "defense" | "armor" | "range" | "slots" | "charges" | "weight";
  value: number | string;
  /** For a stack: the whole stack's weight ("10.32"). */
  total?: string | undefined;
}

/** A requirement and whether the viewer meets it (undefined = unknown). */
export type CardRequirement =
  | { id: "level"; level: number; met: boolean | undefined }
  | { id: "magic"; level: number; met: boolean | undefined }
  | { id: "vocations"; vocations: string[]; met: boolean | undefined };

/** An effect line: i18n key client.card.effect.<id> with its value. */
export type CardEffect =
  | { id: "heal_hp" | "heal_mp"; value: number }
  | { id: "food"; seconds: number }
  | { id: "rune"; spell: string }
  | { id: "element"; element: string }
  | { id: "ammo"; ammo: string }
  | { id: "shoots"; ammo: string };

export interface ItemCardView {
  itemId: number;
  /** data/items id ("" when the client does not know the item). */
  id: string;
  count: number;
  /**
   * The type line as i18n keys: the first is the kind ("Weapon"), the rest qualify it
   * ("sword", "one hand"). The card joins them "Weapon — sword, one hand".
   */
  type: string[];
  stats: CardStat[];
  requires: CardRequirement[];
  effects: CardEffect[];
  /** i18n key of the description, if any. */
  desc?: string | undefined;
  /** i18n keys of the marks under it (client.card.mark.*). */
  marks: string[];
  /** A quest item (data/items `quest: true`): its name takes the quest colour. */
  quest?: boolean | undefined;
  /** Money (`kind: currency`): its name is gold in the tooltip (docs/17 UI-6). */
  currency?: boolean | undefined;
  /**
   * The instance's attribute (docs/02 "Atributos de items"), drawn in its own colour under
   * the stats: its line's i18n key with {value}. On an equipable seen without one,
   * `random` when it rolls one as it is made (a shop's, a recipe's output) and `any` when
   * it stands for any instance someone else picks (the market: a search, a buy offer, the
   * history). `retired` for an attribute no longer in the pool: the item keeps it, it does
   * nothing.
   */
  attribute?:
    | { text: string; value: number }
    | { random: true }
    | { any: true }
    | { retired: true }
    | undefined;
  /**
   * The instance's refine level (the forge, docs/02 "Forja"): the name says "+7" and a line
   * what it adds (gain points of kind, from balance.yaml forge; 0 when the client does not
   * know the forge's rules). Absent on a plain item.
   */
  refine?: { level: number; kind: RefineKind; gain: number } | undefined;
}

/**
 * Whether def is an equipable that rolls an attribute (the server's content.Rolls: a
 * weapon, a shield or an armor piece, never a stack).
 */
export function rollsAttribute(def: ItemDef | undefined): boolean {
  return !!def && !def.stackable && (!!def.weapon || !!def.shield || !!def.armor);
}

/** Kinds of items people carry (the rest are the map: ground, walls, decoration). */
const CARRIED = new Set([
  "container",
  "weapon",
  "armor",
  "shield",
  "tool",
  "consumable",
  "currency",
  "material",
  "rune",
  "ammo",
]);

/**
 * The card of an item (an unknown item gets an empty card with its number). mods are the
 * instance's (its attribute, named in attributes: content.attributes); without them an
 * equipable's card says it rolls one, or, with anyInstance (the market), that each piece
 * has its own.
 */
export function itemCard(
  def: ItemDef | undefined,
  itemId: number,
  count: number,
  who: Viewer = {},
  mods?: ItemMods | undefined,
  attributes?: Record<string, AttributeDef> | undefined,
  anyInstance = false,
  forge?: ForgeRules | undefined,
): ItemCardView {
  const card: ItemCardView = {
    itemId,
    id: def?.id ?? "",
    count: Math.max(count, 1),
    type: [],
    stats: [],
    requires: [],
    effects: [],
    marks: [],
  };
  if (!def) return card;
  const kind = def.kind ?? "";
  card.type = typeLine(def, kind);
  const w = def.weapon;
  if (w) {
    card.stats.push({ id: "attack", value: w.attack });
    if (w.defense > 0) card.stats.push({ id: "defense", value: w.defense });
    if (w.range > 0) card.stats.push({ id: "range", value: w.range });
    if (w.element) card.effects.push({ id: "element", element: w.element });
    if (w.ammo) card.effects.push({ id: "shoots", ammo: w.ammo });
  }
  if (def.ammo) {
    card.stats.push({ id: "attack", value: def.ammo.attack });
    card.effects.push({ id: "ammo", ammo: def.ammo.type });
  }
  if (def.armor && def.armor.armor > 0) card.stats.push({ id: "armor", value: def.armor.armor });
  if (def.shield) card.stats.push({ id: "defense", value: def.shield.defense });
  if (def.slots > 0) card.stats.push({ id: "slots", value: def.slots });
  if (mods && mods.attribute !== "") {
    const a = attributes?.[mods.attribute];
    if (a) card.attribute = { text: a.text, value: mods.value };
    else if (attributes) card.attribute = { retired: true }; // no pool given: no line
  } else if (rollsAttribute(def)) card.attribute = anyInstance ? { any: true } : { random: true };
  const refined = refineKind(def);
  if (refined && mods && mods.refine > 0)
    card.refine = {
      level: mods.refine,
      kind: refined,
      gain: forge ? refineGain(forge, def, mods.refine, mods.value) : 0,
    };
  if (def.rune) {
    card.stats.push({ id: "charges", value: def.rune.charges });
    card.effects.push({ id: "rune", spell: def.rune.spell });
  }
  const c = def.consumable;
  if (c) {
    if (c.healHp > 0) card.effects.push({ id: "heal_hp", value: c.healHp });
    if (c.healMp > 0) card.effects.push({ id: "heal_mp", value: c.healMp });
    if (c.foodMs > 0) card.effects.push({ id: "food", seconds: Math.round(c.foodMs / 1000) });
  }
  const carried = CARRIED.has(kind) && !def.fixed;
  if (carried && (def.weight ?? 0) > 0) {
    const grams = def.weight ?? 0;
    card.stats.push({
      id: "weight",
      value: formatOz(grams),
      total: card.count > 1 ? formatOz(grams * card.count) : undefined,
    });
  }
  const req = def.requires;
  if (req && req.level > 0)
    card.requires.push({
      id: "level",
      level: req.level,
      met: who.level === undefined ? undefined : who.level >= req.level,
    });
  if (req && req.vocations.length > 0)
    card.requires.push({
      id: "vocations",
      vocations: req.vocations,
      met: who.vocation === undefined ? undefined : req.vocations.includes(who.vocation),
    });
  if (def.rune && def.rune.magicLevel > 0)
    card.requires.push({
      id: "magic",
      level: def.rune.magicLevel,
      met: who.magicLevel === undefined ? undefined : who.magicLevel >= def.rune.magicLevel,
    });
  card.desc = def.desc;
  if (kind === "currency") card.currency = true;
  // docs/17 UI-6: the colour says it is a quest item; the mark says it without colour.
  if (def.quest === true) {
    card.quest = true;
    card.marks.push("client.card.mark.quest");
  }
  if (carried && kind !== "currency") {
    if (def.tradeable !== true) card.marks.push("client.card.mark.no_trade");
    else if (def.marketable !== true) card.marks.push("client.card.mark.no_market");
  }
  return card;
}

function typeLine(def: ItemDef, kind: string): string[] {
  const out = [`client.card.kind.${kind || "unknown"}`];
  if (def.weapon) {
    out.push(`client.card.weapon.${def.weapon.type}`);
    out.push(def.weapon.hands === 2 ? "client.card.hands.two" : "client.card.hands.one");
  } else if (def.armor) out.push(`client.card.slot.${def.armor.slot}`);
  else if (def.ammo) out.push(`client.card.ammo.${def.ammo.type}`);
  else if (def.toolUse) out.push(`client.card.tool.${def.toolUse}`);
  else if (def.consumable && def.consumable.foodMs > 0) out.push("client.card.food");
  return out;
}

/** The categories of the shop's filters (docs/17 UI-8), from an item's kind. */
export const SHOP_CATEGORIES = ["weapons", "armor", "tools", "consumables", "materials"] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export function shopCategory(def: ItemDef | undefined): ShopCategory {
  switch (def?.kind) {
    case "weapon":
    case "ammo":
      return "weapons";
    case "armor":
    case "shield":
      return "armor";
    case "tool":
    case "container":
      return "tools";
    case "consumable":
    case "rune":
      return "consumables";
    default:
      return "materials";
  }
}

/**
 * The equipment slot an item goes to when the menu's "Equip" moves it (docs/02 "Items":
 * a weapon in the right hand, a shield in the left, armor in its slot, ammo in the ammo
 * slot). Undefined for anything else; the server checks hands, level and vocation.
 */
export function equipSlot(def: ItemDef | undefined): EquipmentSlot | undefined {
  if (!def) return undefined;
  if (def.weapon) return EquipmentSlot.RIGHT_HAND;
  if (def.shield) return EquipmentSlot.LEFT_HAND;
  if (def.ammo) return EquipmentSlot.AMMO;
  switch (def.armor?.slot) {
    case "head":
      return EquipmentSlot.HEAD;
    case "body":
      return EquipmentSlot.ARMOR;
    case "legs":
      return EquipmentSlot.LEGS;
    case "feet":
      return EquipmentSlot.FEET;
    case "neck":
      return EquipmentSlot.NECK;
    case "ring":
      return EquipmentSlot.RING;
    default:
      return undefined;
  }
}

/** The lines a card takes when drawn (for placing a menu or a tooltip before it is drawn). */
export function cardLines(card: ItemCardView, withName: boolean): number {
  const desc = card.desc ? 3 : 0;
  return (
    (withName ? 1 : 0) +
    (card.type.length > 0 ? 1 : 0) +
    Math.ceil(card.stats.length / 2) +
    card.requires.length +
    (card.attribute ? 1 : 0) +
    card.effects.length +
    desc +
    card.marks.length
  );
}

/**
 * Whether an item lying on the map gets its card under a resting mouse (docs/17 UI-6): what
 * people carry and can pick up (a sword, a stack of coins, a corpse's loot), never the map
 * itself (grounds, walls, decoration, a station or a board: their use is the cursor's hint).
 */
export function groundCard(def: ItemDef | undefined): boolean {
  return def !== undefined && CARRIED.has(def.kind ?? "") && def.fixed !== true;
}
