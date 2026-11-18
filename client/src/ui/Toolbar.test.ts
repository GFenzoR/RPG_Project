// The toolbar and a window frame render as plain functions (no hooks): these tests walk
// their element trees without a DOM, like ui/Guild.test.ts.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { GameUi } from "../game.ts";
import { GameWindow } from "./GameWindow.tsx";
import { TOOLBAR, Toolbar, buttonHint } from "./Toolbar.tsx";
import { defaultWindows, openWindow } from "./windows.ts";
import { LOW_HEALTH, lowHealth, orbFill } from "./Vitals.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Props = Record<string, unknown> & { children?: unknown; onClick?: () => void };

function nodes(n: unknown, out: VNode<Props>[] = []): VNode<Props>[] {
  if (Array.isArray(n)) for (const c of n) nodes(c, out);
  else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const noop = (): void => {};

describe("Toolbar", () => {
  it("has a button per window with its key, pressed while the window is open", () => {
    const opened: string[] = [];
    const tree = Toolbar({
      t,
      windows: openWindow(defaultWindows(), "guild"),
      onToggle: (id) => opened.push(id),
      marketOpen: false,
      onCloseMarket: noop,
      guildBadge: false,
      onLogout: noop,
    });
    const buttons = nodes(tree).filter((v) => v.type === "button");
    const windowButtons = buttons.filter((b) => b.props["data-window-button"] !== undefined);
    expect(windowButtons.map((b) => b.props["data-window-button"])).toEqual(
      TOOLBAR.map((b) => b.id),
    );
    const pressed = Object.fromEntries(
      windowButtons.map((b) => [b.props["data-window-button"], b.props["aria-pressed"]]),
    );
    expect(pressed).toMatchObject({ battle: true, inventory: true, guild: true, skills: false });
    const options = buttons.find((b) => b.props["data-window-button"] === "options");
    expect(options?.props["data-testid"]).toBe("options-button");
    expect(options?.props["aria-keyshortcuts"]).toBe("Escape");
    windowButtons.find((b) => b.props["data-window-button"] === "skills")?.props.onClick?.();
    expect(opened).toEqual(["skills"]);
    // Leaving the game keeps its accessible name (the e2e and screen readers use it).
    expect(buttons.find((b) => b.props["data-testid"] === "logout")?.props["aria-label"]).toBe(
      "client.game.logout",
    );
  });

  it("only closes the market, which opens from a market board", () => {
    let closed = 0;
    const props = {
      t,
      windows: defaultWindows(),
      onToggle: noop,
      onCloseMarket: () => closed++,
      guildBadge: true,
      onLogout: noop,
    };
    const market = (open: boolean): VNode<Props> | undefined =>
      nodes(Toolbar({ ...props, marketOpen: open })).find(
        (v) => v.props["data-testid"] === "toolbar-market",
      );
    expect(market(false)?.props["aria-disabled"]).toBe(true);
    expect(market(false)?.props["title"]).toBe("client.toolbar.market_hint");
    market(false)?.props.onClick?.();
    expect(closed).toBe(0);
    market(true)?.props.onClick?.();
    expect(closed).toBe(1);
    // A guild invitation waits: the guild button shows a dot.
    const guild = nodes(Toolbar({ ...props, marketOpen: false })).find(
      (v) => v.props["data-window-button"] === "guild",
    );
    expect(nodes(guild).some((v) => v.props["class"] === "tool-badge")).toBe(true);
  });

  it("names the window and its key in the tooltip", () => {
    expect(buttonHint(t, "inventory")).toBe(
      'client.toolbar.hint{"title":"client.inventory.title","key":"I"}',
    );
    expect(buttonHint(t, "options")).toBe(
      'client.toolbar.hint{"title":"client.options.button","key":"client.toolbar.key_escape"}',
    );
  });
});

describe("GameWindow", () => {
  const frame = (dock: boolean, collapsed: boolean): VNode<Props> =>
    GameWindow({
      t,
      id: "guild",
      icon: "guild",
      title: "Gremio",
      place: { open: true, dock, collapsed, x: 40, y: 50 },
      stack: 2,
      onClose: noop,
      onCollapse: noop,
      onFocus: noop,
      onGrab: noop,
      children: "body",
    }) as VNode<Props>;

  it("is a dialog over the map when it floats and a region in the dock", () => {
    const float = frame(false, false);
    expect(float.props["role"]).toBe("dialog");
    expect(float.props["style"]).toEqual({ zIndex: 22, left: "40px", top: "50px" });
    expect(frame(true, false).props["role"]).toBe("region");
    expect(frame(true, false).props["style"]).toBeUndefined();
  });

  it("names its buttons after the window and hides its body when folded", () => {
    const tree = frame(true, true);
    const labels = nodes(tree)
      .filter((v) => v.type === "button")
      .map((b) => b.props["aria-label"]);
    expect(labels).toEqual([
      'client.window.expand{"title":"Gremio"}',
      'client.window.close{"title":"Gremio"}',
    ]);
    const body = nodes(tree).find((v) => v.props["class"] === "gwin-body");
    expect(body?.props["hidden"]).toBe(true);
    expect(tree.props["data-collapsed"]).toBe("");
  });
});

describe("Vitals", () => {
  it("fills an orb with the share left, full when the maximum is unknown", () => {
    expect(orbFill(30, 120)).toBe(0.25);
    expect(orbFill(200, 120)).toBe(1);
    expect(orbFill(-5, 120)).toBe(0);
    expect(orbFill(10, 0)).toBe(1);
  });

  it("warns under a quarter of the health, never when dead", () => {
    const stats = (health: number): GameUi["stats"] =>
      ({ health, maxHealth: 400, mana: 0, maxMana: 0 }) as GameUi["stats"];
    expect(LOW_HEALTH).toBe(0.25);
    expect(lowHealth(stats(99))).toBe(true);
    expect(lowHealth(stats(100))).toBe(false);
    expect(lowHealth(stats(0))).toBe(false);
    expect(lowHealth(undefined)).toBe(false);
  });
});
