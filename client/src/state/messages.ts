// Turns server messages (an i18n key plus typed parameters, docs/05 "LocalizedText")
// into text in the player's language. The server never sends assembled text.
import { CreatureKind } from "@rpg/protocol";
import type { TextParam } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { CreatureState, LogMessage } from "./world.ts";

/** The translated name of a creature: players by name, monsters and NPCs by content id. */
export function creatureName(c: CreatureState, t: Translate): string {
  if (c.kind === CreatureKind.MONSTER) return t(`monster.${c.contentId}.name`);
  if (c.kind === CreatureKind.NPC) return t(`npc.${c.contentId}.name`);
  return c.name;
}

/** "3 piel de lobo" for a stack, the plain name for a single item. */
function itemText(p: TextParam, content: ClientContent, t: Translate): string {
  if (p.value.case !== "item") return "";
  const def = content.items[p.value.value.itemId];
  const name = def ? t(`item.${def.id}.name`) : String(p.value.value.itemId);
  const count = p.value.value.count;
  return count > 1 ? t("client.log.item_count", { count, name }) : name;
}

/**
 * Formats a log message. Repeated "item" parameters become one comma-separated
 * {items} list (the loot message); a content id is a monster or NPC by its parameter name.
 */
export function formatMessage(m: LogMessage, content: ClientContent, t: Translate): string {
  const params: Record<string, string | number> = {};
  const items: string[] = [];
  for (const p of m.params) {
    switch (p.value.case) {
      case "text":
        params[p.name] = p.value.value;
        break;
      case "number":
        params[p.name] = Number(p.value.value);
        break;
      case "contentId":
        params[p.name] =
          p.name === "npc" ? t(`npc.${p.value.value}.name`) : t(`monster.${p.value.value}.name`);
        break;
      case "item":
        items.push(itemText(p, content, t));
        break;
      default:
        break;
    }
  }
  if (items.length > 0) params["items"] = items.join(", ");
  return t(m.key, params);
}
