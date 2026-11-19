// The quest log's body renders without hooks: these tests walk its element tree without a
// DOM (expanding its own components, which have none either).
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { QuestEntryView, QuestLogView } from "../state/quests.ts";
import { QuestsBody, cooling } from "./Quests.tsx";
import type { QuestTab } from "./Quests.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Props = Record<string, unknown> & { children?: unknown; onClick?: () => void };

/** Every element of the tree, function components rendered in place. */
function nodes(n: unknown, out: VNode<Props>[] = []): VNode<Props>[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    if (typeof v.type === "function") {
      nodes((v.type as (p: Props) => unknown)(v.props), out);
      return out;
    }
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

function text(n: unknown): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    if (typeof v.type === "function") return text((v.type as (p: Props) => unknown)(v.props));
    return text(v.props.children);
  }
  return "";
}

const view = (e: Partial<QuestEntryView> & Pick<QuestEntryView, "id">): QuestEntryView => ({
  name: `quest.${e.id}.name`,
  chapter: 0,
  state: "done",
  stepId: "",
  stepText: "",
  kills: 0,
  killsNeeded: 0,
  repeatable: false,
  availableAt: 0,
  ...e,
});

const LOG: QuestLogView = {
  entries: [
    view({ id: "ch1_shipwreck", chapter: 1 }),
    view({
      id: "ch2_roots",
      chapter: 2,
      state: "active",
      stepText: "quest.ch2_roots.step_cull_toads",
      kills: 7,
      killsNeeded: 20,
    }),
    view({ id: "foreman_ore", state: "active", stepText: "quest.foreman_ore.step_gather_ore" }),
    view({ id: "bounty", state: "cooling", repeatable: true, availableAt: 100_000 }),
    view({ id: "tally", state: "done", repeatable: true, availableAt: 1_000 }),
  ],
};

function body(tab: QuestTab, opts: { log?: QuestLogView | undefined; serverNow?: number } = {}) {
  const log = "log" in opts ? opts.log : LOG;
  const serverNow = opts.serverNow ?? 10_000;
  const picked: QuestTab[] = [];
  const tree = QuestsBody({ t, log, tab, onTab: (id) => picked.push(id), serverNow });
  return { all: nodes(tree), tree, picked };
}

const byQuest = (all: VNode<Props>[], id: string): VNode<Props> | undefined =>
  all.find((v) => v.props["data-quest"] === id);

describe("quest log window", () => {
  it("has two tabs with their counts; a tab button asks for its tab", () => {
    const { all, picked } = body("active");
    const tabs = all.filter((v) => v.props["data-quest-tab"] !== undefined);
    expect(tabs.map((b) => [b.props["data-quest-tab"], b.props["aria-selected"], text(b)])).toEqual(
      [
        ["active", true, 'client.quests.tab_active{"count":2}'],
        ["finished", false, 'client.quests.tab_finished{"count":3}'],
      ],
    );
    tabs[1]?.props.onClick?.();
    expect(picked).toEqual(["finished"]);
  });

  it("shows each quest in progress: name, chapter, the step's text and the kills 7/20", () => {
    const { all } = body("active");
    const roots = byQuest(all, "ch2_roots");
    expect(text(roots)).toContain("quest.ch2_roots.name");
    expect(text(roots)).toContain('client.quests.chapter{"chapter":2}');
    expect(text(roots)).toContain("quest.ch2_roots.step_cull_toads");
    expect(text(roots)).toContain('client.quests.kills{"count":7,"total":20}');
    const bar = nodes(roots).find((v) => v.props["class"] === "quest-bar");
    expect(text(bar)).toBe("");
    const fill = nodes(bar?.props.children)[0];
    expect(fill?.props["style"]).toEqual({ transform: "scaleX(0.35)" });
    // A side quest with no kill step: no bar.
    const ore = byQuest(all, "foreman_ore");
    expect(text(ore)).toContain("client.quests.side");
    expect(nodes(ore).some((v) => v.props["data-testid"] === "quest-kills")).toBe(false);
    // Main line first.
    expect(all.filter((v) => v.props["data-quest"]).map((v) => v.props["data-quest"])).toEqual([
      "ch2_roots",
      "foreman_ore",
    ]);
  });

  it("shows the finished ones: a task's time left, a task back already, a done quest", () => {
    const { all } = body("finished");
    expect(all.filter((v) => v.props["data-quest"]).map((v) => v.props["data-quest"])).toEqual([
      "bounty",
      "ch1_shipwreck",
      "tally",
    ]);
    const bounty = byQuest(all, "bounty");
    expect(text(bounty)).toContain("client.quests.task");
    // 90 s left at 10 000 of 100 000.
    expect(text(bounty)).toContain(
      'client.quests.available_in{"time":"client.quests.time_ms{\\"m\\":1,\\"s\\":30}"}',
    );
    expect(text(byQuest(all, "tally"))).toContain("client.quests.available_again");
    expect(text(byQuest(all, "ch1_shipwreck"))).toContain("client.quests.done");
    // The task's cooldown passed: available again.
    const later = body("finished", { serverNow: 100_000 }).all;
    expect(text(byQuest(later, "bounty"))).toContain("client.quests.available_again");
  });

  it("says when a tab is empty, also before the server sent a log", () => {
    for (const tab of ["active", "finished"] as const) {
      const { all } = body(tab, { log: undefined });
      const empty = all.find((v) => v.props["data-testid"] === "quests-empty");
      expect(text(empty)).toBe(
        tab === "active" ? "client.quests.none_active" : "client.quests.none_finished",
      );
    }
  });

  it("counts down only while a task cools down", () => {
    expect(cooling(LOG, 10_000)).toBe(true);
    expect(cooling(LOG, 100_000)).toBe(false);
    expect(cooling(undefined, 0)).toBe(false);
  });
});
