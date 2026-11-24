// The name a player reads for an item instance, everywhere it is named (look, the hover
// hint, the menu's title, the card, a container window, the loot and log lines): the
// remains a death leaves after whose they are ("restos de lobo", "wolf remains"; "cuerpo de
// Ana", docs/02 "Muerte"), a refined piece with its level ("+7 espada", docs/02 "Forja"),
// anything else by its data/items name.
import type { ItemDef } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { refinedName } from "./forge.ts";

/** What of an instance's mods its name depends on (ItemMods, or a part of it). */
export interface NameMods {
  refine?: number | undefined;
  remainsOf?: string | undefined;
  bodyOf?: string | undefined;
}

/**
 * The name of item `itemId` (`def` its definition, undefined when the client does not know
 * it: its number) with the instance's `mods`.
 */
export function instanceName(
  t: Translate,
  def: Pick<ItemDef, "id"> | undefined,
  itemId: number,
  mods?: NameMods | undefined,
): string {
  if (mods?.remainsOf)
    return t("client.item.remains_of", { monster: t(`monster.${mods.remainsOf}.name`) });
  if (mods?.bodyOf) return t("client.item.body_of", { player: mods.bodyOf });
  return refinedName(t, def ? t(`item.${def.id}.name`) : String(itemId), mods?.refine);
}
