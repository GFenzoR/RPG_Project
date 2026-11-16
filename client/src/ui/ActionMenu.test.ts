// The touch widgets render as plain functions (no hooks): these tests walk their element
// trees without a DOM and press their buttons with a fake Game.
import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { ActionKind } from "../input/actions.ts";
import {
  ActionMenu,
  MENU_WIDTH,
  PickBanner,
  menuClickCounts,
  menuHeight,
  menuPlacement,
} from "./ActionMenu.tsx";
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

describe("menuClickCounts", () => {
  it("takes a click only after a press on the menu, or from the keyboard", () => {
    // The long-press finger lifting: a pointer click (detail 1) with no press on the menu.
    expect(menuClickCounts(false, 1)).toBe(false);
    expect(menuClickCounts(true, 1)).toBe(true);
    // Enter or Space on a focused button, or assistive technology.
    expect(menuClickCounts(false, 0)).toBe(true);
  });
});

describe("ActionMenu", () => {
  const menu = {
    x: 100,
    y: 100,
    title: "Lobo",
    actions: ["attack", "look"] as ActionKind[],
  };

  /** A Game that records what the menu asks of it. */
  function fakeGame(): {
    chosen: ActionKind[];
    closed: number;
    menuPressed: boolean;
    menuChoose(k: ActionKind): void;
    closeMenu(): void;
    menuPress(): void;
  } {
    return {
      chosen: [],
      closed: 0,
      menuPressed: false,
      menuChoose(k) {
        this.chosen.push(k);
      },
      closeMenu() {
        this.closed++;
      },
      menuPress() {
        this.menuPressed = true;
      },
    };
  }

  const pressMenu = (tree: unknown): void => {
    const box = byAttr(tree, "data-testid", "action-menu")[0];
    (box?.props["onPointerDown"] as (() => void) | undefined)?.();
  };

  it("one big button per action, labelled by its key, plus cancel", () => {
    const game = fakeGame();
    const tree = ActionMenu({ t, menu, game, viewport: { width: 800, height: 600 } });
    const buttons = byAttr(tree, "data-action");
    expect(buttons.map((b) => b.props["data-action"])).toEqual(["attack", "look", "cancel"]);
    expect(buttons[0]?.props.children).toBe("client.touch.action.attack");
    pressMenu(tree);
    click(buttons[1], { detail: 1 });
    expect(game.chosen).toEqual(["look"]);
    click(buttons[2], { detail: 1 });
    const backdrop = nodes(tree).find((n) => n.props["class"] === "touch-menu-backdrop");
    // A click (the long-press finger lifting) keeps the menu; a new press beside it closes it.
    expect(backdrop?.props["onClick"]).toBeUndefined();
    (backdrop?.props["onPointerDown"] as ((e: unknown) => void) | undefined)?.({
      preventDefault: () => undefined,
    });
    expect(game.closed).toBe(2);
    expect(nodes(tree).some((n) => n.props.children === "Lobo")).toBe(true);
  });

  it("ignores the click of the finger that opened it, however late it lifts", () => {
    // On a phone on its side the menu opens under the finger; a slow device (the CI
    // runner) lifted it more than the old 350 ms after the menu opened, and the browser's
    // click chose the button under it. Nothing pressed the menu: no click counts.
    const game = fakeGame();
    const tree = ActionMenu({ t, menu, game, viewport: { width: 800, height: 600 } });
    for (const b of byAttr(tree, "data-action")) click(b, { detail: 1 });
    expect(game.chosen).toEqual([]);
    expect(game.closed).toBe(0);
    // A tap on a button after that is a choice: its press lands on the menu first. The
    // state is read when the click comes, not when the menu was drawn.
    pressMenu(tree);
    click(byAttr(tree, "data-action", "attack")[0], { detail: 1 });
    expect(game.chosen).toEqual(["attack"]);
  });

  it("takes keyboard clicks without a press (Enter or Space on a focused button)", () => {
    const game = fakeGame();
    const tree = ActionMenu({ t, menu, game, viewport: { width: 800, height: 600 } });
    click(byAttr(tree, "data-action", "look")[0], { detail: 0 });
    click(byAttr(tree, "data-action", "cancel")[0], { detail: 0 });
    expect(game.chosen).toEqual(["look"]);
    expect(game.closed).toBe(1);
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
