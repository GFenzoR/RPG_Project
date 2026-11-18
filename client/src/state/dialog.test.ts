import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import {
  TYPE_CPS,
  dialogLayout,
  filterButtons,
  fold,
  optionForKey,
  optionTopic,
  typedLength,
  typedParts,
  typingMs,
} from "./dialog.ts";

const content: Pick<ClientContent, "dialogTopics"> = {
  dialogTopics: {
    priest: {
      "npc.priest.opt_blessings": "services",
      "npc.priest.opt_heal": "services",
      "npc.priest.opt_faith": "talk",
      "npc.priest.opt_quest": "quests",
      "dialog.trade": "trade",
      "dialog.back": "back",
      "dialog.bye": "bye",
    },
  },
};

const opt = (id: number, text: string): { id: number; text: string; params: [] } => ({
  id,
  text,
  params: [],
});

describe("dialogLayout (docs/17 UI-8)", () => {
  it("groups by topic in a fixed order, keeps the server's order inside, numbers 1–9", () => {
    const layout = dialogLayout(content, {
      npcContentId: "priest",
      options: [
        opt(1, "npc.priest.opt_faith"),
        opt(2, "npc.priest.opt_blessings"),
        opt(3, "dialog.trade"),
        opt(4, "npc.priest.opt_heal"),
        opt(5, "npc.priest.opt_quest"),
        opt(6, "dialog.bye"),
      ],
    });
    expect(layout.grid.map((b) => [b.option.id, b.topic, b.key])).toEqual([
      [5, "quests", 1],
      [3, "trade", 2],
      [2, "services", 3],
      [4, "services", 4],
      [1, "talk", 5],
    ]);
    expect(layout.back).toBeUndefined();
    expect(layout.bye?.id).toBe(6);
  });

  it("puts Back and Goodbye on their own row; 0 is Back", () => {
    const layout = dialogLayout(content, {
      npcContentId: "priest",
      options: [opt(1, "npc.priest.opt_heal"), opt(2, "dialog.back"), opt(3, "dialog.bye")],
    });
    expect(layout.grid.map((b) => b.option.id)).toEqual([1]);
    expect(optionForKey(layout, 0)?.id).toBe(2);
    expect(optionForKey(layout, 1)?.id).toBe(1);
    expect(optionForKey(layout, 2)).toBeUndefined();
  });

  it("an unknown NPC or text is talk, but the shared back and bye keys", () => {
    expect(optionTopic({}, "someone", "npc.someone.opt_x")).toBe("talk");
    expect(optionTopic({}, "someone", "dialog.back")).toBe("back");
    expect(optionTopic({}, "someone", "dialog.bye")).toBe("bye");
  });

  it("the tenth button and later have no key", () => {
    const options = Array.from({ length: 12 }, (_, i) => opt(i + 1, `npc.x.opt_${i}`));
    const layout = dialogLayout({}, { npcContentId: "x", options });
    expect(layout.grid.map((b) => b.key)).toEqual([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      undefined,
      undefined,
      undefined,
    ]);
    expect(optionForKey(layout, 9)?.id).toBe(9);
  });

  it("a second back or bye option stays in the grid", () => {
    const layout = dialogLayout(content, {
      npcContentId: "priest",
      options: [opt(1, "dialog.bye"), opt(2, "dialog.bye")],
    });
    expect(layout.bye?.id).toBe(1);
    expect(layout.grid.map((b) => [b.option.id, b.topic])).toEqual([[2, "talk"]]);
  });
});

describe("filterButtons", () => {
  it("matches the shown text without case or accents", () => {
    const layout = dialogLayout(content, {
      npcContentId: "priest",
      options: [opt(1, "npc.priest.opt_heal"), opt(2, "npc.priest.opt_quest")],
    });
    const text = (o: { text: string }): string =>
      o.text === "npc.priest.opt_heal" ? "Cúrame, por favor" : "¿Una misión?";
    expect(filterButtons(layout.grid, "MISION", text).map((b) => b.option.id)).toEqual([2]);
    expect(filterButtons(layout.grid, "cura", text).map((b) => b.option.id)).toEqual([1]);
    expect(filterButtons(layout.grid, "  ", text)).toHaveLength(2);
    expect(fold("Ñandú")).toBe("nandu");
  });
});

describe("NPC text letter by letter (docs/17 UI-8)", () => {
  it("shows 90 characters a second, all once done", () => {
    expect(TYPE_CPS).toBe(90);
    expect(typedLength(300, 0)).toBe(0);
    expect(typedLength(300, 1000)).toBe(90);
    expect(typedLength(300, 60_000)).toBe(300);
    expect(typedLength(300, Number.NaN)).toBe(300);
    expect(typingMs(90)).toBe(1000);
  });

  it("cuts the text by the characters people see", () => {
    expect(typedParts("¡Hola, Ñandú!", 3)).toEqual({ shown: "¡Ho", rest: "la, Ñandú!" });
    expect(typedParts("a😀b", 2)).toEqual({ shown: "a😀", rest: "b" });
    expect(typedParts("abc", 9)).toEqual({ shown: "abc", rest: "" });
  });
});
