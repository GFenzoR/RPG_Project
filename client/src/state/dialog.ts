// The NPC dialog's buttons (docs/17 UI-8): the options the server sent, grouped by topic
// (quests, trade, travel, services, talk; in that order, the server's order inside each)
// in a grid numbered 1–9, and "Back" and "Goodbye" on their own row (0 and Escape). The
// keys and the window use this same layout, so a number always picks the button that
// shows it. Pure, with tests.
import type { ClientContent, DialogTopic } from "../content-types.ts";
import type { DialogState } from "./world.ts";

export type DialogOption = DialogState["options"][number];

/** The grid's topics in the order they show. */
export const TOPIC_ORDER: readonly DialogTopic[] = [
  "quests",
  "trade",
  "travel",
  "services",
  "talk",
];

/** With more options than this the dialog offers a filter (docs/17 UI-8). */
export const FILTER_FROM = 10;

export interface DialogButton {
  option: DialogOption;
  topic: DialogTopic;
  /** The key 1–9 that picks it; undefined from the tenth button on. */
  key: number | undefined;
}

export interface DialogLayout {
  grid: DialogButton[];
  /** The node's "Back" option (key 0), if any. */
  back: DialogOption | undefined;
  /** The node's "Goodbye" option, if any (Escape closes the dialog either way). */
  bye: DialogOption | undefined;
}

/** The topic of an option of NPC `npc` (content.dialogTopics), "talk" if unknown. */
export function optionTopic(
  content: Pick<ClientContent, "dialogTopics">,
  npc: string,
  text: string,
): DialogTopic {
  const known = content.dialogTopics?.[npc]?.[text];
  if (known) return known;
  if (text === "dialog.back") return "back";
  if (text === "dialog.bye") return "bye";
  return "talk";
}

export function dialogLayout(
  content: Pick<ClientContent, "dialogTopics">,
  d: Pick<DialogState, "npcContentId" | "options">,
): DialogLayout {
  let back: DialogOption | undefined;
  let bye: DialogOption | undefined;
  const rest: { option: DialogOption; topic: DialogTopic; at: number }[] = [];
  d.options.forEach((option, at) => {
    const topic = optionTopic(content, d.npcContentId, option.text);
    if (topic === "back" && !back) back = option;
    else if (topic === "bye" && !bye) bye = option;
    else rest.push({ option, topic: topic === "back" || topic === "bye" ? "talk" : topic, at });
  });
  rest.sort((a, b) => TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic) || a.at - b.at);
  return {
    grid: rest.map((r, i) => ({
      option: r.option,
      topic: r.topic,
      key: i < 9 ? i + 1 : undefined,
    })),
    back,
    bye,
  };
}

/** The option a digit key picks (1–9 the grid, 0 "Back"), if any. */
export function optionForKey(layout: DialogLayout, digit: number): DialogOption | undefined {
  if (digit === 0) return layout.back;
  return layout.grid.find((b) => b.key === digit)?.option;
}

/**
 * The grid's buttons whose text has `query` (case and accents ignored), all of them for an
 * empty query. `text` gives an option's shown text.
 */
export function filterButtons(
  grid: readonly DialogButton[],
  query: string,
  text: (o: DialogOption) => string,
): DialogButton[] {
  const q = fold(query.trim());
  if (q === "") return [...grid];
  return grid.filter((b) => fold(text(b.option)).includes(q));
}

/** Lower case without accents: "Misión" and "mision" match. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
