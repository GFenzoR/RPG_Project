// The zoom buttons render as a plain function (no hooks): walk the tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { ZoomButtons } from "./ZoomButtons.tsx";

const t = (key: string): string => key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const button = (tree: unknown, id: string): Node => {
  const found = nodes(tree).find((v) => v.props["data-testid"] === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};

describe("ZoomButtons", () => {
  it("zooms one whole scale per press", () => {
    const steps: number[] = [];
    const game = { zoom: (s: number) => void steps.push(s) };
    const tree = ZoomButtons({ t, game, zoom: { scale: 3, min: 2, max: 4 } });
    (button(tree, "zoom-in").props["onClick"] as () => void)();
    (button(tree, "zoom-out").props["onClick"] as () => void)();
    expect(steps).toEqual([1, -1]);
    expect(button(tree, "zoom-in").props["aria-label"]).toBe("client.zoom.in");
    expect(button(tree, "zoom-out").props["aria-label"]).toBe("client.zoom.out");
  });

  it("greys out the button at each end of the range", () => {
    const fit = ZoomButtons({ t, game: undefined, zoom: { scale: 2, min: 2, max: 4 } });
    expect(button(fit, "zoom-out").props["disabled"]).toBe(true);
    expect(button(fit, "zoom-in").props["disabled"]).toBe(false);
    const top = ZoomButtons({ t, game: undefined, zoom: { scale: 4, min: 2, max: 4 } });
    expect(button(top, "zoom-in").props["disabled"]).toBe(true);
    expect(button(top, "zoom-out").props["disabled"]).toBe(false);
    const none = ZoomButtons({ t, game: undefined, zoom: undefined });
    expect(button(none, "zoom-in").props["disabled"]).toBe(true);
    expect(button(none, "zoom-out").props["disabled"]).toBe(true);
  });

  it("hides when the screen allows a single scale", () => {
    expect(ZoomButtons({ t, game: undefined, zoom: { scale: 1, min: 1, max: 1 } })).toBeNull();
  });
});
