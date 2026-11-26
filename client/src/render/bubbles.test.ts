import { MessageKind } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import {
  BUBBLE_FADE_MS,
  BUBBLE_GAP,
  BUBBLE_MAX_MS,
  BUBBLE_MIN_MS,
  BUBBLE_STACK,
  SpeechBubbles,
  admitSpeech,
  bubbleAlpha,
  bubbleLife,
  bubbleMetrics,
  bubbleStyle,
  stackBubbles,
  wrapBubble,
} from "./bubbles.ts";
import type { BubbleBox } from "./bubbles.ts";

// Every character 6 px wide: a 30 px line holds 5.
const mono = (s: string): number => [...s].length * 6;

describe("wrapBubble", () => {
  it("keeps a short text on one line", () => {
    expect(wrapBubble("hola", 30, mono)).toEqual(["hola"]);
  });

  it("wraps on words to the width", () => {
    expect(wrapBubble("ab cd ef gh", 30, mono)).toEqual(["ab cd", "ef gh"]);
  });

  it("cuts a word wider than a line and collapses spaces", () => {
    expect(wrapBubble("  abcdefghijkl   xy ", 30, mono)).toEqual(["abcde", "fghij", "kl xy"]);
  });

  it("ends the last kept line with an ellipsis past the line limit", () => {
    const lines = wrapBubble("aa bb cc dd ee ff", 12, mono, 3);
    expect(lines).toEqual(["aa", "bb", "c…"]);
    for (const l of lines) expect(mono(l)).toBeLessThanOrEqual(12);
  });

  it("gives nothing for an empty or blank text", () => {
    expect(wrapBubble("", 30, mono)).toEqual([]);
    expect(wrapBubble("   ", 30, mono)).toEqual([]);
  });

  it("keeps markup as plain characters", () => {
    expect(wrapBubble("<b>hi</b>", 100, mono)).toEqual(["<b>hi</b>"]);
  });
});

describe("bubbleLife", () => {
  it("grows with the text's length between the limits", () => {
    expect(bubbleLife("hi", "say")).toBe(BUBBLE_MIN_MS);
    expect(bubbleLife("x".repeat(40), "say")).toBeGreaterThan(bubbleLife("x".repeat(20), "say"));
    expect(bubbleLife("x".repeat(255), "say")).toBe(BUBBLE_MAX_MS);
  });

  it("lasts longer for a yell and less for a whisper", () => {
    const text = "x".repeat(30);
    expect(bubbleLife(text, "yell")).toBeGreaterThan(bubbleLife(text, "say"));
    expect(bubbleLife(text, "whisper")).toBeLessThan(bubbleLife(text, "say"));
  });
});

describe("bubbleAlpha", () => {
  it("is opaque, then fades over the last ms, then gone", () => {
    const b = { end: 5000 };
    expect(bubbleAlpha(b, 1000)).toBe(1);
    expect(bubbleAlpha(b, 5000 - BUBBLE_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(bubbleAlpha(b, 5000)).toBe(0);
  });
});

describe("SpeechBubbles", () => {
  it("stacks a speaker's messages, at most BUBBLE_STACK, the oldest dropped", () => {
    const board = new SpeechBubbles();
    for (let i = 0; i < BUBBLE_STACK + 2; i++) board.add(7, "say", `m${i}`, [`m${i}`], i);
    const lines = board.of(7).map((b) => b.lines[0]);
    expect(lines).toHaveLength(BUBBLE_STACK);
    expect(lines[lines.length - 1]).toBe(`m${BUBBLE_STACK + 1}`);
    expect(lines[0]).toBe("m2");
  });

  it("drops older messages when the stack has too many lines", () => {
    const board = new SpeechBubbles();
    board.add(1, "say", "a", ["a1", "a2", "a3", "a4"], 0);
    board.add(1, "say", "b", ["b1", "b2", "b3", "b4"], 1);
    expect(board.of(1).map((b) => b.lines[0])).toEqual(["b1"]);
  });

  it("forgets bubbles once their time is up, and their speaker", () => {
    const board = new SpeechBubbles();
    const b = board.add(3, "say", "hola", ["hola"], 0);
    board.add(4, "yell", "hola", ["hola"], 0);
    board.prune(b.end - 1);
    expect(board.of(3)).toHaveLength(1);
    board.prune(b.end);
    expect(board.of(3)).toHaveLength(0);
    expect([...board.speakers()]).toEqual([4]); // a yell lasts longer
  });

  it("keeps speakers apart", () => {
    const board = new SpeechBubbles();
    board.add(1, "say", "a", ["a"], 0);
    board.add(2, "say", "b", ["b"], 0);
    expect(board.of(1)).toHaveLength(1);
    expect(board.of(2)).toHaveLength(1);
    board.clear();
    expect([...board.speakers()]).toEqual([]);
  });
});

describe("channel filtering", () => {
  it("only what is said aloud nearby gets a bubble", () => {
    expect(bubbleStyle(MessageKind.SAY)).toBe("say");
    expect(bubbleStyle(MessageKind.YELL)).toBe("yell");
    expect(bubbleStyle(MessageKind.WHISPER)).toBe("whisper");
    expect(bubbleStyle(MessageKind.NPC)).toBe("npc");
    for (const k of [
      MessageKind.GLOBAL,
      MessageKind.PARTY,
      MessageKind.GUILD,
      MessageKind.BROADCAST,
      MessageKind.SYSTEM,
      MessageKind.UNSPECIFIED,
    ]) {
      expect(bubbleStyle(k)).toBeUndefined();
    }
  });

  it("the option off gives no bubble at all", () => {
    expect(admitSpeech(MessageKind.SAY, true)).toBe("say");
    expect(admitSpeech(MessageKind.SAY, false)).toBeUndefined();
    expect(admitSpeech(MessageKind.YELL, false)).toBeUndefined();
  });
});

describe("stackBubbles", () => {
  const box = (id: number, x: number, y: number, extra: Partial<BubbleBox> = {}): BubbleBox => ({
    id,
    x,
    y,
    width: 60,
    height: 20,
    self: false,
    distance: 1,
    ...extra,
  });

  it("leaves apart stacks where they are", () => {
    const at = stackBubbles([box(1, 100, 200), box(2, 300, 200)]);
    expect(at.get(1)).toBe(200);
    expect(at.get(2)).toBe(200);
  });

  it("lifts the farther of two overlapping stacks right above the other", () => {
    const at = stackBubbles([box(1, 100, 200, { distance: 3 }), box(2, 120, 205)]);
    expect(at.get(2)).toBe(205);
    expect(at.get(1)).toBe(205 - 20 - BUBBLE_GAP);
  });

  it("keeps the own stack over its head first", () => {
    const at = stackBubbles([box(1, 100, 200), box(2, 110, 200, { self: true, distance: 0 })]);
    expect(at.get(2)).toBe(200);
    expect(at.get(1)).toBe(200 - 20 - BUBBLE_GAP);
  });

  it("lifts past several stacks until it is free", () => {
    const at = stackBubbles([
      box(1, 100, 200, { distance: 0 }),
      box(2, 100, 200, { distance: 1 }),
      box(3, 100, 200, { distance: 2 }),
    ]);
    const bottoms = [at.get(1), at.get(2), at.get(3)];
    expect(bottoms).toEqual([200, 178, 156]);
  });

  it("never goes above the top of the canvas", () => {
    const at = stackBubbles([box(1, 100, 10, { distance: 0 }), box(2, 100, 10)], 0);
    expect(at.get(1)).toBe(20);
    expect(at.get(2)).toBe(20);
  });
});

describe("bubbleMetrics", () => {
  it("draws the text 13 CSS px, two more than before, at every pixel density", () => {
    expect(bubbleMetrics(1).fontPx).toBe(13);
    expect(bubbleMetrics(1.25).fontPx).toBe(16);
    expect(bubbleMetrics(1.5).fontPx).toBe(20);
    expect(bubbleMetrics(2).fontPx).toBe(26);
  });
  it("scales the line, padding and wrap width with the font, whole pixels", () => {
    const a = bubbleMetrics(1);
    const b = bubbleMetrics(2);
    expect(b.width).toBe(a.width * 2);
    expect(b.padX).toBe(a.padX * 2);
    for (const v of Object.values(bubbleMetrics(1.25))) expect(Number.isInteger(v)).toBe(true);
    expect(a.lineH).toBeGreaterThan(a.fontPx);
  });
  it("falls back to 1x on a bad density", () => {
    expect(bubbleMetrics(0)).toEqual(bubbleMetrics(1));
    expect(bubbleMetrics(Number.NaN)).toEqual(bubbleMetrics(1));
  });
});
