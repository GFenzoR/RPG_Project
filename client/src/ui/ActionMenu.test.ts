// The touch widgets render as plain functions (no hooks): these tests walk their element
// trees without a DOM and press their buttons with a fake Game.
import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { ActionKind } from "../input/actions.ts";
import { ActionMenu, MENU_WIDTH, PickBanner, menuHeight, menuPlacement } from "./ActionMenu.tsx";
import { TouchPad, TouchPadToggle } from "./TouchPad.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

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

const byAttr = (tree: unknown, attr: string, value?: string): Node[] =>
  nodes(tree).filter((v) => attr in v.props && (value === undefined || v.props[attr] === value));

function click(n: Node | undefined, ev: unknown = {}): void {
  (n?.props["onClick"] as ((e: unknown) => void) | undefined)?.(ev);
}

describe("menuPlacement", () => {
  it("takes the height of a screen too short for the menu", () => {
    const h = menuHeight(4, true); // three actions, cancel, a title
    expect(h).toBe(2 * 8 + 2 + 34 + 4 * 48 + 3 * 6);
    // A phone on its side (412 px): neither side has room, so it spans the screen.
    expect(menuPlacement(400, 220, 860, 412, h)).toEqual({
      left: 400 - MENU_WIDTH / 2,
      top: Math.round((412 - h) / 2),
      maxHeight: 412 - 16,
    });
    // Room on the preferred side: as without a height.
    expect(menuPlacement(400, 100, 800, 900, h)).toEqual(menuPlacement(400, 100, 800, 900));
  });

  it("centres on the finger, below it in the top half and above it in the bottom half", () => {
    expect(menuPlacement(400, 100, 800, 600)).toEqual({ left: 400 - MENU_WIDTH / 2, top: 116 });
    expect(menuPlacement(400, 500, 800, 600)).toEqual({
      left: 400 - MENU_WIDTH / 2,
      bottom: 116,
    });
  });

  it("stays on screen at the edges and on a phone narrower than the menu", () => {
    expect(menuPlacement(5, 100, 800, 600).left).toBe(8);
    expect(menuPlacement(795, 100, 800, 600).left).toBe(800 - MENU_WIDTH - 8);
    expect(menuPlacement(100, 100, 200, 600).left).toBe(8);
  });
});

describe("ActionMenu", () => {
  const menu = {
    x: 100,
    y: 100,
    title: "Lobo",
    actions: ["attack", "look"] as ActionKind[],
  };

  it("one big button per action, labelled by its key, plus cancel", () => {
    const chosen: string[] = [];
    let closed = 0;
    const game = {
      menuChoose: (k: ActionKind) => void chosen.push(k),
      closeMenu: () => void closed++,
    };
    const tree = ActionMenu({ t, menu, game, viewport: { width: 800, height: 600 } });
    const buttons = byAttr(tree, "data-action");
    expect(buttons.map((b) => b.props["data-action"])).toEqual(["attack", "look", "cancel"]);
    expect(buttons[0]?.props.children).toBe("client.touch.action.attack");
    click(buttons[1]);
    expect(chosen).toEqual(["look"]);
    click(buttons[2]);
    const backdrop = nodes(tree).find((n) => n.props["class"] === "touch-menu-backdrop");
    // A click (the long-press finger lifting) keeps the menu; a new press beside it closes it.
    expect(backdrop?.props["onClick"]).toBeUndefined();
    (backdrop?.props["onPointerDown"] as ((e: unknown) => void) | undefined)?.({
      preventDefault: () => undefined,
    });
    expect(closed).toBe(2);
    expect(nodes(tree).some((n) => n.props.children === "Lobo")).toBe(true);
  });

  it("a menu that just opened ignores clicks (the long-press finger lifting)", () => {
    const chosen: string[] = [];
    let closed = 0;
    const game = {
      menuChoose: (k: ActionKind) => void chosen.push(k),
      closeMenu: () => void closed++,
    };
    const tree = ActionMenu({
      t,
      menu: { ...menu, at: performance.now() },
      game,
      viewport: { width: 800, height: 600 },
    });
    for (const b of byAttr(tree, "data-action")) click(b);
    expect(chosen).toEqual([]);
    expect(closed).toBe(0);
  });

  it("a bare tile has no title and the menu is named by its key", () => {
    const tree = ActionMenu({
      t,
      menu: { ...menu, title: "" },
      game: undefined,
      viewport: { width: 800, height: 600 },
    });
    expect(byAttr(tree, "role", "menu")[0]?.props["aria-label"]).toBe("client.touch.actions.label");
  });
});

describe("PickBanner", () => {
  it("names the picked item and drops the pick", () => {
    let cancelled = 0;
    const content = { items: { 66: { id: "backpack" } } } as unknown as ClientContent;
    const tree = PickBanner({
      t,
      content,
      picked: { loc: { kind: "container", id: 1, index: 0 }, itemId: 66, stackIndex: 0, count: 1 },
      game: { cancelPick: () => (cancelled++, true) },
    });
    expect(nodes(tree).some((n) => n.props.children === "item.backpack.name")).toBe(true);
    const text = nodes(tree).find((n) => n.props["class"] === "pick-banner-text");
    expect(text?.props.children).toContain("client.touch.pick_destination");
    click(byAttr(tree, "data-testid", "pick-cancel")[0]);
    expect(cancelled).toBe(1);
  });
});

describe("TouchPad", () => {
  it("eight labelled buttons; a keyboard activation is one step, a pointer click is not", () => {
    const steps: Direction[] = [];
    const game = {
      padPress: () => undefined,
      padRelease: () => undefined,
      padStep: (d: Direction) => void steps.push(d),
    };
    const tree = TouchPad({ t, game });
    const buttons = byAttr(tree, "data-dir");
    expect(buttons).toHaveLength(8);
    const north = buttons.find((b) => b.props["data-dir"] === "north");
    expect(north?.props["aria-label"]).toBe("client.touch.dpad.north");
    click(north, { detail: 1 });
    click(north, { detail: 0 });
    expect(steps).toEqual([Direction.NORTH]);
  });

  it("the Options switch reports the new value", () => {
    const seen: boolean[] = [];
    const tree = TouchPadToggle({ t, on: false, onChange: (on) => void seen.push(on) });
    const input = byAttr(tree, "data-testid", "touch-pad-toggle")[0];
    expect(input?.props["checked"]).toBe(false);
    (input?.props["onChange"] as (e: unknown) => void)({ currentTarget: { checked: true } });
    expect(seen).toEqual([true]);
  });
});
