// Turns server messages (an i18n key plus typed parameters, docs/05 "LocalizedText")
// into text in the player's language. The server never sends assembled text.
import { CreatureKind, MessageKind } from "@rpg/protocol";
import type { TextParam } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { formatOz } from "./items.ts";
import type { ChatLine, CreatureState, LogMessage } from "./world.ts";

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
 * {items} list (the loot message), and each one also fills its own name ({item}); a content id is a monster, NPC or skill by its
 * parameter name.
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
        // Weights travel in grams and show in oz.
        params[p.name] =
          p.name === "weight" ? formatOz(Number(p.value.value)) : Number(p.value.value);
        break;
      case "contentId":
        params[p.name] =
          p.name === "npc"
            ? t(`npc.${p.value.value}.name`)
            : p.name === "skill"
              ? t(`skill.${p.value.value}.name`)
              : p.name === "quest"
                ? t(`quest.${p.value.value}.name`)
                : p.name === "island"
                  ? t(`island.${p.value.value}.name`)
                  : t(`monster.${p.value.value}.name`);
        break;
      case "item": {
        // By its own name too: one item is {item} (gather.got, shop.bought), a list of
        // them is {items} (loot, look).
        const text = itemText(p, content, t);
        items.push(text);
        params[p.name] ??= text;
        break;
      }
      default:
        break;
    }
  }
  if (items.length > 0) params["items"] = items.join(", ");
  const text = t(m.key, params);
  // Looking at an item adds its description, when it has one.
  const looked = m.key.startsWith("look.")
    ? m.params.find((p) => p.value.case === "item")
    : undefined;
  if (looked?.value.case === "item") {
    const def = content.items[looked.value.value.itemId];
    const key = def ? `item.${def.id}.desc` : "";
    const desc = key ? t(key) : key;
    if (desc && desc !== key) return `${text} ${desc}`;
  }
  return text;
}

/** i18n key of a chat line by kind: "{name} says: {text}" and the like. */
const CHAT_KEYS: Partial<Record<MessageKind, string>> = {
  [MessageKind.SAY]: "client.chat.line.say",
  [MessageKind.YELL]: "client.chat.line.yell",
  [MessageKind.WHISPER]: "client.chat.line.whisper",
  [MessageKind.GLOBAL]: "client.chat.line.global",
  [MessageKind.NPC]: "client.chat.line.npc",
  [MessageKind.BROADCAST]: "client.chat.line.broadcast",
  [MessageKind.PARTY]: "client.chat.line.party",
};

/**
 * Formats a chat line. The player's text is a parameter value, so it is inserted as is
 * (never parsed as a template) and the UI renders the result as text, never as HTML.
 */
export function formatChat(line: ChatLine, content: ClientContent, t: Translate): string {
  const name = line.speakerName
    ? line.speakerName
    : line.speakerContentId
      ? t(
          line.kind === MessageKind.NPC
            ? `npc.${line.speakerContentId}.name`
            : `monster.${line.speakerContentId}.name`,
        )
      : "";
  const text = line.localized
    ? formatMessage(
        { key: line.localized.key, params: line.localized.params, at: line.at },
        content,
        t,
      )
    : (line.text ?? "");
  return t(CHAT_KEYS[line.kind] ?? "client.chat.line.say", { name, text });
}
