// The touch widgets render as plain functions (no hooks): these tests walk their element
// trees without a DOM and press their buttons with a fake Game.
import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { itemCard } from "../state/item-card.ts";
import type { ActionKind } from "../input/actions.ts";
import {
  ActionMenu,
  MENU_WIDTH,
  PickBanner,
  NO_INSETS,
  menuClickCounts,
  menuHeight,
  menuPlacement,
  mousePlacement,
  paddingInsets,
} from "./ActionMenu.tsx";
import { TouchPad, TouchPadToggle } from "./TouchPad.tsx";
import { splitCount } from "../state/items.ts";

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

describe("menuPlacement on a notched phone (safe area)", () => {
  // An iPhone on its side: the notch on the left, the home indicator below.
  const side = { top: 0, right: 47, bottom: 21, left: 47 };
  // Upright: the notch above, the home indicator below.
  const upright = { top: 47, right: 0, bottom: 34, left: 0 };

  it("keeps the margin from the safe area's edges, not from the screen's", () => {
    // Pressed by the notch: 8 px right of the inset, not 8 px from the screen edge.
    expect(menuPlacement(20, 100, 844, 390, 0, side).left).toBe(47 + 8);
    expect(menuPlacement(840, 100, 844, 390, 0, side).left).toBe(844 - 47 - MENU_WIDTH - 8);
    // Without insets, as before.
    expect(menuPlacement(20, 100, 844, 390, 0, NO_INSETS).left).toBe(8);
    expect(menuPlacement(20, 100, 844, 390).left).toBe(8);
  });

  it("takes the safe area's height when neither side has room", () => {
    const h = menuHeight(4, true);
    const at = menuPlacement(400, 200, 844, 390, h, side);
    const room = 390 - 21;
    expect(at).toEqual({
      left: 400 - MENU_WIDTH / 2,
      top: Math.round(Math.max(8, (room - h) / 2)),
      maxHeight: room - 16,
    });
    // The whole menu ends above the home indicator, also cut to its largest height.
    expect((at.top ?? 0) + Math.min(h, at.maxHeight ?? 0)).toBeLessThanOrEqual(390 - 21 - 8);
    expect(8 + (at.maxHeight ?? 0)).toBeLessThanOrEqual(390 - 21 - 8);
  });

  it("measures the halves and the room on each side within the safe area", () => {
    const h = menuHeight(3, true);
    // Upright, near the bottom: above the finger, never into the home indicator (a press
    // over the indicator itself would put it 30 px from the screen's edge).
    expect(menuPlacement(200, 700, 390, 844, h, upright).bottom).toBe(844 - 700 + 16);
    expect(menuPlacement(200, 830, 390, 844, h, upright).bottom).toBe(34 + 8);
    // Right under the notch: below the finger, never under the notch.
    expect(menuPlacement(200, 20, 390, 844, h, upright).top).toBe(47 + 8);
    // A menu that would end in the home indicator below the finger (it fitted above the
    // screen's margin) takes the safe area's height instead, clear of the indicator.
    const tall = menuHeight(6, true);
    const y = 844 - 34 - 8 - tall - 16 + 1; // one pixel short of room below
    expect(y).toBeLessThan((47 + 844 - 34) / 2);
    expect(menuPlacement(200, y, 390, 844, tall)).toEqual({
      left: 200 - MENU_WIDTH / 2,
      top: y + 16,
    });
    const at = menuPlacement(200, y, 390, 844, tall, upright);
    expect(at.maxHeight).toBe(844 - 47 - 34 - 16);
    expect((at.top ?? 0) + tall).toBeLessThanOrEqual(844 - 34 - 8);
    expect(at.top ?? 0).toBeGreaterThanOrEqual(47 + 8);
  });
});

describe("paddingInsets", () => {
  it("reads the insets from the computed padding of .game", () => {
    expect(
      paddingInsets({
        paddingTop: "47px",
        paddingRight: "0px",
        paddingBottom: "34px",
        paddingLeft: "0px",
      }),
    ).toEqual({ top: 47, right: 0, bottom: 34, left: 0 });
    expect(
      paddingInsets({
        paddingTop: "",
        paddingRight: "auto",
        paddingBottom: "-3px",
        paddingLeft: "2.5px",
      }),
    ).toEqual({ top: 0, right: 0, bottom: 0, left: 2.5 });
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

describe("ActionMenu on the remains of a death", () => {
  const rect = (x: number) => ({ url: "atlas.png", x, y: 0, width: 64, height: 64 });
  const fur: ItemDef = {
    id: "remains_fur",
    sprite: "decor/remains_fur",
    ground: false,
    walkable: true,
    blocks: false,
    speed: 100,
    stackable: false,
    slots: 10,
    useWith: false,
    fixed: true,
  };
  const card = itemCard(fur, 91, 1, {}, { attribute: "", value: 0, refine: 0, remainsOf: "wolf" });
  const menu = { x: 100, y: 100, title: "restos de lobo", actions: ["open", "look"], card };
  const iconBox = (tree: unknown): Node | undefined =>
    nodes(nodes(tree).find((n) => n.props["class"] === "touch-menu-title")).find(
      (n) => n.props["class"] === "touch-menu-icon",
    );

  it("shows the monster's own corpse beside the title, fitted to the icon box", () => {
    const asked: string[] = [];
    const game = {
      menuPressed: false,
      menuChoose: () => undefined,
      closeMenu: () => undefined,
      menuPress: () => undefined,
      itemIcon: () => rect(0),
      spriteIcon: (path: string) => (asked.push(path), rect(128)),
    };
    const tree = ActionMenu({
      t,
      menu: menu as Parameters<typeof ActionMenu>[0]["menu"],
      game: game as unknown as Parameters<typeof ActionMenu>[0]["game"],
      viewport: { width: 800, height: 600 },
    });
    expect(asked).toEqual(["corpses/wolf"]);
    const icon = iconBox(tree);
    expect(icon?.props["icon"]).toEqual(rect(128));
    expect(icon?.props["fit"]).toBe(64);
    // A boss's 96 px corpse is scaled down into the box, not drawn over the title.
    expect(icon?.props["shrink"]).toBe(true);
    expect(nodes(tree).some((n) => n.props.children === "restos de lobo")).toBe(true);
  });

  it("falls back to the item's icon when the atlas has no corpse for the monster", () => {
    const game = {
      menuPressed: false,
      menuChoose: () => undefined,
      closeMenu: () => undefined,
      menuPress: () => undefined,
      itemIcon: () => rect(0),
      spriteIcon: () => undefined,
    };
    const tree = ActionMenu({
      t,
      menu: menu as Parameters<typeof ActionMenu>[0]["menu"],
      game: game as unknown as Parameters<typeof ActionMenu>[0]["game"],
      viewport: { width: 800, height: 600 },
    });
    const icon = iconBox(tree);
    expect(icon?.props["icon"]).toEqual(rect(0));
    expect(icon?.props["fit"]).toBeUndefined();
  });
});

describe("PickBanner", () => {
  it("names picked remains after whose they are", () => {
    const content = { items: { 91: { id: "remains_fur" } } } as unknown as ClientContent;
    // The monster has a name here (one without falls back to the family's: item-name.ts).
    const named: typeof t = (key, params) =>
      key === "monster.wolf.name" ? "wolf" : t(key, params);
    const tree = PickBanner({
      t: named,
      content,
      picked: {
        loc: { kind: "pos", pos: { x: 1, y: 1, z: 7 } },
        itemId: 91,
        stackIndex: 1,
        count: 1,
        mods: { attribute: "", value: 0, refine: 0, remainsOf: "wolf" },
      },
      game: { cancelPick: () => true },
    });
    const name = 'client.item.remains_of{"monster":"wolf"}';
    expect(nodes(tree).some((n) => n.props.children === name)).toBe(true);
  });

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

describe("the right-click menu (docs/17 UI-6)", () => {
  const card = {
    itemId: 7,
    id: "raw_fish",
    count: 12,
    type: ["client.card.kind.consumable", "client.card.food"],
    stats: [{ id: "weight" as const, value: 500, total: 6000 }],
    requires: [],
    effects: [{ id: "food" as const, seconds: 60 }],
    desc: "item.raw_fish.desc",
    marks: [],
  };
  const menu = {
    x: 300,
    y: 200,
    title: "pescado crudo",
    actions: ["eat", "look", "move", "split"] as ActionKind[],
    card,
    mouse: true,
    stack: 12,
  };

  it("opens at the mouse, right of and below it, and flips at the edges", () => {
    expect(mousePlacement(300, 200, 1280, 800, 288, 300)).toEqual({ left: 304, top: 204 });
    // Near the right edge: left of the pointer; near the bottom: above it.
    expect(mousePlacement(1200, 700, 1280, 800, 288, 300)).toEqual({ left: 908, top: 396 });
    // Too tall for either side: as low as it fits; taller than the screen: it scrolls.
    expect(mousePlacement(300, 400, 1280, 800, 288, 700)).toEqual({ left: 304, top: 92 });
    expect(mousePlacement(300, 400, 1280, 600, 288, 700)).toEqual({
      left: 304,
      top: 8,
      maxHeight: 584,
    });
  });

  it("the mouse's buttons are compact and the card adds its lines", () => {
    expect(menuHeight(3, true, true)).toBe(2 * 8 + 2 + 34 + 3 * 30 + 2 * 2);
    // The card's lines, and the title grows to hold the item's icon at 2x.
    expect(menuHeight(3, true, true, 4)).toBe(menuHeight(3, true, true) + 34 + 2 + 12 + 4 * 19);
  });

  it("the default action first and bold, the card under the buttons, Move part as a form", () => {
    const chosen: ActionKind[] = [];
    const split: number[] = [];
    const game = {
      menuPressed: true,
      menuChoose: (k: ActionKind) => void chosen.push(k),
      closeMenu: () => undefined,
      menuPress: () => undefined,
      menuSplit: (n: number) => void split.push(n),
      itemIcon: () => undefined,
    };
    const tree = ActionMenu({ t, menu, game, viewport: { width: 1280, height: 800 } });
    const box = byAttr(tree, "data-testid", "action-menu")[0];
    expect(box?.props["class"]).toBe("touch-menu with-card");
    expect(box?.props["data-pointer"]).toBe("mouse");
    const buttons = byAttr(tree, "data-action");
    expect(buttons.map((b) => b.props["data-action"])).toEqual([
      "eat",
      "look",
      "move",
      "split",
      "cancel",
    ]);
    expect(buttons[0]?.props["class"]).toBe("touch-menu-action default");
    expect(buttons[1]?.props["class"]).toBe("touch-menu-action");
    click(buttons[0], { detail: 1 });
    expect(chosen).toEqual(["eat"]);
    // The card is there, without its name (the header has it).
    const cardNode = nodes(tree).filter((n) => n.props["card"] === card);
    expect(cardNode).toHaveLength(1);
    expect(cardNode[0]?.props["name"]).toBe(false);
    // Move part: the field is read on submit, kept within 1..stack-1.
    const field = byAttr(tree, "data-testid", "split-count")[0];
    expect(field?.props["defaultValue"]).toBe("6");
    expect(field?.props["max"]).toBe(11);
    const form = nodes(tree).find((n) => n.props["class"] === "touch-menu-split-form");
    const input = { value: "40" };
    (form?.props["onSubmit"] as (e: unknown) => void)({
      preventDefault: () => undefined,
      currentTarget: { elements: { namedItem: () => input } },
    });
    expect(split).toEqual([11]);
  });

  it("splitCount keeps a whole number from 1 to the stack less one", () => {
    expect(splitCount(5, 12)).toBe(5);
    expect(splitCount(40, 12)).toBe(11);
    expect(splitCount(0, 12)).toBe(1);
    expect(splitCount(Number.NaN, 12)).toBe(1);
    expect(splitCount(2.7, 12)).toBe(2);
  });
});

describe('the menu\'s quick key (docs/02 "Teclas rapidas de items")', () => {
  it("lists the six slots under one entry and assigns the one that is pressed", () => {
    const slots: number[] = [];
    const game = {
      menuPressed: true,
      menuChoose: () => undefined,
      closeMenu: () => undefined,
      menuPress: () => undefined,
      menuHotkey: (n: number) => void slots.push(n),
    };
    const tree = ActionMenu({
      t,
      menu: { x: 10, y: 10, title: "pocion", actions: ["use", "look", "hotkey"], mouse: true },
      game,
      viewport: { width: 800, height: 600 },
    });
    expect(byAttr(tree, "data-action").map((b) => b.props["data-action"])).toEqual([
      "use",
      "look",
      "hotkey",
      "cancel",
    ]);
    const buttons = byAttr(tree, "data-hotkey-slot");
    expect(buttons.map((b) => b.props["data-hotkey-slot"])).toEqual([1, 2, 3, 4, 5, 6]);
    click(buttons[3], { detail: 1 });
    click(buttons[0], { detail: 1 });
    expect(slots).toEqual([3, 0]);
  });
});
