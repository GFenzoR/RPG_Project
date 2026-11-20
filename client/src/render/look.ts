// Who is drawn as an engine humanoid and in what (docs/17 "Humanoides del motor", docs/06
// "Looks"). Pure, no Pixi: game-canvas.ts asks these for every person it builds and stacks
// the layers of packages/renderer look.ts in a CreatureBody.
//
// - An NPC or a humanoid monster: its `look` of data/npcs or data/monsters.
// - A player: until feat/character-look sends each character's own look, the body of its
//   outfit (data/outfits.yaml `look`) and, for the own player, what its Inventory has on;
//   the others are drawn in their outfit's clothes. The default outfit's clothes show only
//   where nothing is equipped; a shop outfit (a costume) covers the torso, legs and feet even
//   over armour, and the helmet, the shield and the weapon still show.
import { EquipmentSlot } from "@rpg/protocol";
import { lookSprites } from "@rpg/renderer";
import type { LayerSlot, Look, LookTables, Worn, WornSlot } from "@rpg/renderer";
import type { ItemDef, OutfitDef } from "../content-types.ts";

/** The equipment slots that show something on the figure. */
const SHOWN: readonly EquipmentSlot[] = [
  EquipmentSlot.HEAD,
  EquipmentSlot.ARMOR,
  EquipmentSlot.LEGS,
  EquipmentSlot.FEET,
  EquipmentSlot.LEFT_HAND,
  EquipmentSlot.RIGHT_HAND,
];

/** The figure's slot of an equipped item: by what it is, whatever hand it is in. */
export function wornSlotOf(def: ItemDef): WornSlot | undefined {
  if (def.weapon) return "weapon";
  if (def.shield || def.kind === "shield") return "shield";
  switch (def.armor?.slot) {
    case "head":
      return "head";
    case "body":
      return "torso";
    case "legs":
      return "legs";
    case "feet":
      return "feet";
    default:
      return undefined;
  }
}

/**
 * What the equipment shows (slot -> item id; jewellery, the backpack and the ammo never
 * show): every equipped piece with `worn`, at its figure slot. A piece without `worn`
 * shows nothing.
 */
export function wornFromEquipment(
  equipment: ReadonlyMap<EquipmentSlot, { itemId: number }>,
  items: Readonly<Record<number, ItemDef>>,
): Worn {
  const out: Worn = {};
  for (const slot of SHOWN) {
    const it = equipment.get(slot);
    const def = it ? items[it.itemId] : undefined;
    if (!def?.worn) continue;
    const at = wornSlotOf(def);
    if (at) out[at] = def.worn;
  }
  return out;
}

/** The clothes slots an outfit dresses. */
const CLOTHES: readonly WornSlot[] = ["torso", "legs", "feet"];

/** A player dressed: what is drawn, and which slots show the outfit's clothes. */
export interface Dressed {
  worn: Worn;
  /** Slots drawn in the outfit's clothes (the outfit colour cosmetic tints them, T5.7). */
  clothes: ReadonlySet<WornSlot>;
}

/**
 * A player in its outfit wearing `equipped`: the default outfit's clothes fill the empty
 * clothes slots; a costume's cover them.
 */
export function dressPlayer(outfit: OutfitDef | undefined, equipped: Worn): Dressed {
  const worn: Worn = { ...equipped };
  const clothes = new Set<WornSlot>();
  for (const slot of CLOTHES) {
    const piece = outfit?.clothes?.[slot];
    if (!piece || (worn[slot] && !outfit?.costume)) continue;
    worn[slot] = piece;
    clothes.add(slot);
  }
  return { worn, clothes };
}

/** A stable key of what a figure wears: the figure is built again when it changes. */
export function wornKey(worn: Worn): string {
  let key = "";
  for (const slot of ["head", "torso", "legs", "feet", "shield", "weapon"] as const) {
    const p = worn[slot];
    key += p ? `${slot}:${p.shape}:${p.tint};` : "";
  }
  return key;
}

/** Multiplies two tints channel by channel (0xffffff leaves the other as it is). */
export function mulTint(a: number, b: number): number {
  const ch = (shift: number): number =>
    Math.round((((a >> shift) & 0xff) * ((b >> shift) & 0xff)) / 255);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** One layer of a figure: its slot, its atlas sprite and its tint (0xrrggbb, a multiply). */
export interface DollSprite {
  slot: LayerSlot;
  sprite: string;
  tint: number;
}

/**
 * The layers of a figure (packages/renderer look.ts lookSprites), with the outfit colour
 * cosmetic (T5.7) multiplied into the slots drawn in the outfit's clothes: what the canvas
 * stacks in a CreatureBody (game-canvas.ts dollOf), in no particular order.
 */
export function dollSprites(
  look: Look,
  dressed: Dressed,
  tables: LookTables,
  outfitTint = 0xffffff,
): DollSprite[] {
  const out: DollSprite[] = [];
  for (const [slot, s] of Object.entries(lookSprites(look, dressed.worn, tables)) as [
    LayerSlot,
    { sprite: string; tint: number },
  ][]) {
    const clothes = dressed.clothes.has(slot as WornSlot);
    out.push({ slot, sprite: s.sprite, tint: clothes ? mulTint(s.tint, outfitTint) : s.tint });
  }
  return out;
}
