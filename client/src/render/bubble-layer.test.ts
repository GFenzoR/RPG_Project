import type { Container, Text } from "pixi.js";
import { describe, expect, it } from "vitest";
import { BubbleLayer } from "./bubble-layer.ts";
import type { BubbleAnchor } from "./bubble-layer.ts";
import { BUBBLE_MIN_MS } from "./bubbles.ts";

const mono = (s: string): number => [...s].length * 6;

const anchor = (x: number, top: number, extra: Partial<BubbleAnchor> = {}): BubbleAnchor => ({
  x,
  top,
  self: false,
  distance: 1,
  ...extra,
});

const stackOf = (layer: BubbleLayer, id: number): Container | undefined =>
  layer.view.children.find((c) => c.label === `bubbles ${id}`);

const textsOf = (stack: Container | undefined): string[] =>
  (stack?.children ?? []).filter((c): c is Text => "text" in c).map((c) => c.text);

describe("BubbleLayer", () => {
  it("draws a speaker's bubble over its anchor and follows it", () => {
    const layer = new BubbleLayer(mono);
    layer.say(5, "say", "hola a todos", 0);
    layer.draw(new Map([[5, anchor(100, 200)]]), 10);
    const stack = stackOf(layer, 5);
    expect(stack?.visible).toBe(true);
    expect(stack?.position.x).toBe(100);
    expect(stack?.position.y).toBe(200);
    expect(textsOf(stack)).toEqual(["hola a todos"]);
    // The creature walked: the bubble goes with it.
    layer.draw(new Map([[5, anchor(116, 196)]]), 20);
    expect(stack?.position.x).toBe(116);
    expect(stack?.position.y).toBe(196);
  });

  it("keeps the text as plain characters (no markup)", () => {
    const layer = new BubbleLayer(mono);
    layer.say(1, "say", "<b>hi</b> {name}", 0);
    layer.draw(new Map([[1, anchor(50, 50)]]), 1);
    expect(textsOf(stackOf(layer, 1))).toEqual(["<b>hi</b> {name}"]);
  });

  it("hides the bubbles of a speaker not drawn this frame, and drops them when gone", () => {
    const layer = new BubbleLayer(mono);
    layer.say(9, "say", "hola", 0);
    layer.draw(new Map(), 10);
    expect(stackOf(layer, 9)?.visible).toBe(false);
    expect(layer.shown()).toEqual([]);
    layer.draw(new Map([[9, anchor(10, 100)]]), BUBBLE_MIN_MS + 1);
    expect(stackOf(layer, 9)).toBeUndefined();
  });

  it("stacks messages of a speaker and lifts a neighbour's stack off it", () => {
    const layer = new BubbleLayer(mono);
    layer.say(1, "say", "uno", 0);
    layer.say(1, "yell", "dos", 0);
    layer.say(2, "say", "tres", 0);
    layer.draw(
      new Map([
        [1, anchor(100, 200, { self: true, distance: 0 })],
        [2, anchor(110, 200)],
      ]),
      5,
    );
    expect(textsOf(stackOf(layer, 1))).toEqual(["uno", "dos"]);
    expect(stackOf(layer, 1)?.position.y).toBe(200);
    expect(stackOf(layer, 2)?.position.y).toBeLessThan(200 - 30);
    expect(layer.shown().map((b) => b.id)).toEqual([1, 1, 2]);
  });

  it("clear drops everything (the option turned off)", () => {
    const layer = new BubbleLayer(mono);
    layer.say(1, "say", "uno", 0);
    layer.draw(new Map([[1, anchor(10, 100)]]), 1);
    layer.clear();
    layer.draw(new Map([[1, anchor(10, 100)]]), 2);
    expect(layer.view.children).toHaveLength(0);
    expect(layer.shown()).toEqual([]);
  });
});
