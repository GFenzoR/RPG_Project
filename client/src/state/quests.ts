// The quest log (docs/02 "Diario de misiones", docs/05 QuestLog): what the server says about
// every quest the character started or finished. Pure (tested in quests.test.ts): no DOM,
// no clock; the window passes the server's time (the client's clock plus the offset the
// Welcome gave) to tell a repeatable quest that still cools down from one that is back.
import { QuestLogState } from "@rpg/protocol";
import type { QuestLog } from "@rpg/protocol";

/** One quest of the log. */
export interface QuestEntryView {
  id: string;
  /** i18n key of the quest's name. */
  name: string;
  /** The main line's chapter; 0 for a side quest or a task. */
  chapter: number;
  /** active: in progress; done: completed (a task past its cooldown too); cooling: a task
   * that waits for availableAt. */
  state: "active" | "done" | "cooling";
  /** The current step (active): its id and the i18n key of its text. */
  stepId: string;
  stepText: string;
  /** A kill step: kills counted and kills it needs (killsNeeded 0: not a kill step). */
  kills: number;
  killsNeeded: number;
  /** A task: it can be done again after a cooldown. */
  repeatable: boolean;
  /** A finished task: when it can be taken again, server Unix ms (0: no cooldown). */
  availableAt: number;
}

/** The quest log, in the server's order (quest id). */
export interface QuestLogView {
  entries: QuestEntryView[];
}

const STATES: Readonly<Partial<Record<QuestLogState, QuestEntryView["state"]>>> = {
  [QuestLogState.ACTIVE]: "active",
  [QuestLogState.DONE]: "done",
  [QuestLogState.COOLING]: "cooling",
};

/** The log of a QuestLog: entries of an unknown state (a newer server) are left out. */
export function questLogFrom(msg: QuestLog): QuestLogView {
  const entries: QuestEntryView[] = [];
  for (const e of msg.entries) {
    const state = STATES[e.state];
    if (!state || e.questId === "") continue;
    entries.push({
      id: e.questId,
      name: e.name || `quest.${e.questId}.name`,
      chapter: e.chapter,
      state,
      stepId: state === "active" ? e.stepId : "",
      stepText: state === "active" ? e.stepText : "",
      kills: e.killsNeeded > 0 ? Math.min(e.kills, e.killsNeeded) : 0,
      killsNeeded: e.killsNeeded,
      repeatable: e.repeatable,
      availableAt: Number(e.availableAt),
    });
  }
  return { entries };
}

/** Milliseconds until a finished task can be taken again at serverNow; 0 when it can. */
export function cooldownLeft(e: QuestEntryView, serverNow: number): number {
  if (e.state === "active" || !e.repeatable) return 0;
  return Math.max(e.availableAt - serverNow, 0);
}

/**
 * Main line first, by chapter; then side quests and tasks, by id (the server's order). A
 * stable sort: equal chapters keep the server's order.
 */
function byChapter(a: QuestEntryView, b: QuestEntryView): number {
  const ka = a.chapter > 0 ? a.chapter : Number.MAX_SAFE_INTEGER;
  const kb = b.chapter > 0 ? b.chapter : Number.MAX_SAFE_INTEGER;
  return ka - kb;
}

/**
 * The window's two tabs at serverNow: the quests in progress, and the finished ones; among
 * these the tasks that still cool down come first (the sooner back, the higher), then the
 * rest by chapter.
 */
export function questTabs(
  log: QuestLogView | undefined,
  serverNow: number,
): { active: QuestEntryView[]; finished: QuestEntryView[] } {
  const entries = log?.entries ?? [];
  const active = entries.filter((e) => e.state === "active").sort(byChapter);
  const finished = entries
    .filter((e) => e.state !== "active")
    .sort((a, b) => {
      const la = cooldownLeft(a, serverNow);
      const lb = cooldownLeft(b, serverNow);
      if (la > 0 !== lb > 0) return la > 0 ? -1 : 1;
      if (la > 0) return la - lb;
      return byChapter(a, b);
    });
  return { active, finished };
}

/**
 * A time left as an i18n key and its parameters, rounded up: "2 h 5 min" from an hour
 * on, "4 min 30 s" from a minute on, "12 s" under that.
 */
export function timeLeft(ms: number): { key: string; params: Record<string, number> } {
  const s = Math.max(Math.ceil(ms / 1000), 0);
  if (s >= 3600) {
    const m = Math.ceil(s / 60);
    return { key: "client.quests.time_hm", params: { h: Math.floor(m / 60), m: m % 60 } };
  }
  if (s >= 60)
    return { key: "client.quests.time_ms", params: { m: Math.floor(s / 60), s: s % 60 } };
  return { key: "client.quests.time_s", params: { s } };
}
