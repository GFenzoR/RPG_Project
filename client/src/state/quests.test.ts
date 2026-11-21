import { describe, expect, it } from "vitest";
import {
  QuestLogEntrySchema,
  QuestLogSchema,
  QuestLogState,
  WelcomeSchema,
  create,
} from "@rpg/protocol";
import { cooldownLeft, questLogFrom, questTabs, timeLeft } from "./quests.ts";
import type { QuestEntryView } from "./quests.ts";

const entry = (e: Parameters<typeof create<typeof QuestLogEntrySchema>>[1]) =>
  create(QuestLogEntrySchema, e);

describe("quest log", () => {
  it("reads a QuestLog: active steps with their kills, finished quests and tasks", () => {
    const log = questLogFrom(
      create(QuestLogSchema, {
        entries: [
          entry({
            questId: "ch2_roots",
            name: "quest.ch2_roots.name",
            chapter: 2,
            state: QuestLogState.ACTIVE,
            stepId: "cull_toads",
            stepText: "quest.ch2_roots.step_cull_toads",
            kills: 9, // more than the step needs (a stale count): capped
            killsNeeded: 8,
          }),
          entry({
            questId: "bounty",
            state: QuestLogState.COOLING,
            repeatable: true,
            availableAt: 5_000n,
            stepId: "ignored",
          }),
          entry({ questId: "ch1_shipwreck", chapter: 1, state: QuestLogState.DONE }),
          entry({ questId: "newer", state: 7 as QuestLogState }), // a newer server's state
          entry({ questId: "", state: QuestLogState.DONE }),
        ],
      }),
    );
    expect(log.entries).toEqual([
      {
        id: "ch2_roots",
        name: "quest.ch2_roots.name",
        chapter: 2,
        state: "active",
        stepId: "cull_toads",
        stepText: "quest.ch2_roots.step_cull_toads",
        kills: 8,
        killsNeeded: 8,
        repeatable: false,
        availableAt: 0,
      },
      {
        id: "bounty",
        name: "quest.bounty.name", // the server sent none: the convention
        chapter: 0,
        state: "cooling",
        stepId: "",
        stepText: "",
        kills: 0,
        killsNeeded: 0,
        repeatable: true,
        availableAt: 5000,
      },
      expect.objectContaining({ id: "ch1_shipwreck", state: "done", chapter: 1 }),
    ]);
  });

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

  it("counts a task's cooldown on the server's clock, never below zero", () => {
    const task = view({ id: "bounty", state: "cooling", repeatable: true, availableAt: 10_000 });
    expect(cooldownLeft(task, 4_000)).toBe(6_000);
    expect(cooldownLeft(task, 10_000)).toBe(0);
    expect(cooldownLeft(task, 12_000)).toBe(0);
    // Only a finished task cools down.
    expect(cooldownLeft({ ...task, state: "active" }, 0)).toBe(0);
    expect(cooldownLeft({ ...task, repeatable: false }, 0)).toBe(0);
  });

  it("splits the tabs: main line first by chapter; tasks cooling down first, the soonest first", () => {
    const log = {
      entries: [
        view({ id: "a_side", state: "active" }),
        view({ id: "ch3", chapter: 3, state: "active" }),
        view({ id: "ch1", chapter: 1, state: "active" }),
        view({ id: "b_done", chapter: 0 }),
        view({ id: "ch2_done", chapter: 2 }),
        view({ id: "late_task", state: "cooling", repeatable: true, availableAt: 9_000 }),
        view({ id: "soon_task", state: "cooling", repeatable: true, availableAt: 3_000 }),
        view({ id: "back_task", state: "cooling", repeatable: true, availableAt: 1_000 }),
      ],
    };
    const tabs = questTabs(log, 2_000);
    expect(tabs.active.map((e) => e.id)).toEqual(["ch1", "ch3", "a_side"]);
    // back_task's cooldown ended at 1 000: it sorts with the finished ones.
    expect(tabs.finished.map((e) => e.id)).toEqual([
      "soon_task",
      "late_task",
      "ch2_done",
      "b_done",
      "back_task",
    ]);
    expect(questTabs(undefined, 0)).toEqual({ active: [], milestones: [], finished: [] });
  });

  it("says a time left in hours and minutes, minutes and seconds, or seconds, rounded up", () => {
    expect(timeLeft(2 * 3600_000 + 14 * 60_000 + 20_000)).toEqual({
      key: "client.quests.time_hm",
      params: { h: 2, m: 15 },
    });
    expect(timeLeft(3600_000)).toEqual({ key: "client.quests.time_hm", params: { h: 1, m: 0 } });
    expect(timeLeft(59 * 60_000 + 59_500)).toEqual({
      key: "client.quests.time_hm",
      params: { h: 1, m: 0 },
    });
    expect(timeLeft(4 * 60_000 + 30_000)).toEqual({
      key: "client.quests.time_ms",
      params: { m: 4, s: 30 },
    });
    expect(timeLeft(12_001)).toEqual({ key: "client.quests.time_s", params: { s: 13 } });
    expect(timeLeft(-5)).toEqual({ key: "client.quests.time_s", params: { s: 0 } });
  });
});

describe("quest log in the world state", () => {
  it("keeps the last QuestLog and the server's clock offset of the Welcome", async () => {
    const { WorldState } = await import("./world.ts");
    const w = new WorldState({ items: {} } as unknown as ConstructorParameters<
      typeof WorldState
    >[0]);
    expect(w.quests).toBeUndefined();
    const before = Date.now();
    w.apply(
      {
        case: "welcome",
        value: create(WelcomeSchema, { creatureId: 1, serverTime: BigInt(before + 60_000) }),
      },
      0,
    );
    expect(w.clockOffset).toBeGreaterThan(59_000);
    expect(w.clockOffset).toBeLessThanOrEqual(60_000);
    w.apply(
      {
        case: "questLog",
        value: create(QuestLogSchema, {
          entries: [entry({ questId: "ch1_shipwreck", chapter: 1, state: QuestLogState.DONE })],
        }),
      },
      0,
    );
    expect(w.quests?.entries.map((e) => e.id)).toEqual(["ch1_shipwreck"]);
    w.apply({ case: "questLog", value: create(QuestLogSchema, {}) }, 0);
    expect(w.quests).toEqual({ entries: [] });
  });
});

describe('milestones in the quest log (docs/02 "Quests de hito")', () => {
  const ms = (questId: string, state: QuestLogState) =>
    entry({
      questId,
      state,
      milestone: {
        title: `quest.${questId}.title`,
        level: 20,
        levelMet: true,
        gearItem: 42,
        gearEquipped: true,
        gearMet: false,
        players: 2,
        vocations: ["guardian", "druid"],
        vocationMet: true,
      },
    });

  it("reads a milestone's requirements and marks, and lists open ones apart", () => {
    const log = questLogFrom(
      create(QuestLogSchema, {
        entries: [
          ms("ms_done", QuestLogState.DONE),
          ms("ms_going", QuestLogState.ACTIVE),
          entry({ questId: "side", state: QuestLogState.ACTIVE, stepText: "x" }),
          ms("ms_open", QuestLogState.OPEN),
        ],
      }),
    );
    const open = log.entries.find((e) => e.id === "ms_open");
    expect(open?.state).toBe("open");
    expect(open?.milestone).toEqual({
      title: "quest.ms_open.title",
      level: 20,
      levelMet: true,
      gearItem: 42,
      gearEquipped: true,
      gearWeapon: "",
      gearMet: false,
      players: 2,
      vocations: ["guardian", "druid"],
      vocationMet: true,
    });
    const tabs = questTabs(log, 0);
    expect(tabs.active.map((e) => e.id)).toEqual(["side"]);
    expect(tabs.milestones.map((e) => e.id)).toEqual(["ms_open", "ms_going", "ms_done"]);
    expect(tabs.finished.map((e) => e.id)).toEqual(["ms_done"]);
  });
});
