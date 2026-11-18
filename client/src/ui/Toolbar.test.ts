// The toolbar, a window frame and the bottom bar render as plain functions (no hooks):
// these tests walk their element trees without a DOM, like ui/Guild.test.ts.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { GameUi } from "../game.ts";
import { GameWindow } from "./GameWindow.tsx";
import type { GameWindowProps } from "./GameWindow.tsx";
import { TOOLBAR, Toolbar, buttonHint } from "./Toolbar.tsx";
import { defaultWindows, openWindow } from "./windows.ts";
import { LOW_HEALTH, lowHealth, orbFill } from "./Vitals.tsx";
import { HudBar } from "./HudBar.tsx";

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
  const frame = (
    collapsed: boolean,
    more: Partial<GameWindowProps> = {},
    place: { x?: number; y?: number; w?: number; h?: number } = { x: 40, y: 50 },
  ): VNode<Props> =>
    GameWindow({
      t,
      id: "guild",
      icon: "guild",
      title: "Gremio",
      place: { open: true, collapsed, ...place },
      stack: 2,
      onClose: noop,
      onCollapse: noop,
      onFocus: noop,
      onGrab: noop,
      onResize: noop,
      onMoveKey: () => false,
      children: "body",
      ...more,
    }) as VNode<Props>;

  it("is a dialog over the map, at its place, never taller than the room above the bar", () => {
    const placed = frame(false);
    expect(placed.props["role"]).toBe("dialog");
    expect(placed.props["style"]).toEqual({
      zIndex: 22,
      left: "40px",
      top: "50px",
      maxHeight: "calc(100% - 50px)",
    });
    expect(placed.props["data-placed"]).toBe("");
    // Never moved: its default place is windows.css's; only the stacking is set.
    const unplaced = frame(false, {}, {});
    expect(unplaced.props["style"]).toEqual({ zIndex: 22 });
    expect(unplaced.props["data-placed"]).toBeUndefined();
    // The n-th container steps down from the last (windows.css reads --nth).
    expect(frame(false, { nth: 2 }, {}).props["style"]).toEqual({ zIndex: 22, "--nth": "2" });
  });

  it("takes the size the player gave it, in the scale's own pixels (docs/17 UI-3, UI-5)", () => {
    const sized = frame(false, { zoom: 1.25 }, { x: 40, y: 50, w: 300, h: 250 });
    expect(sized.props["style"]).toEqual({
      zIndex: 22,
      left: "32px",
      top: "40px",
      maxHeight: "calc(100% - 40px)",
      width: "240px",
      height: "200px",
    });
    expect(sized.props["data-sized"]).toBe("");
    // Folded, no height.
    expect(frame(true, {}, { h: 250 }).props["style"]).toEqual({ zIndex: 22 });
  });

  it("a window without a close button (the shop closes with its dialog, the chat never)", () => {
    const labels = nodes(frame(false, { closable: false }))
      .filter((v) => v.type === "button")
      .map((b) => b.props["data-testid"]);
    expect(labels).toEqual(["window-move-guild", "window-fold-guild"]);
  });

  it("puts more in its bar and keeps the title for screen readers (the chat's tabs)", () => {
    const tabs = { type: "div", props: { class: "chat-tabs" }, key: null } as unknown as VNode;
    const tree = frame(false, { hideTitle: true, barExtra: tabs });
    const title = nodes(tree).find((v) => v.type === "h2");
    expect(title?.props["class"]).toBe("gwin-title visually-hidden");
    expect(title?.props.children).toBe("Gremio");
    expect(nodes(tree).some((v) => v.props["class"] === "chat-tabs")).toBe(true);
  });

  it("its move handle hands the keys to the window and keeps them from walking", () => {
    let asked = "";
    const tree = frame(false, {
      onMoveKey: (e) => {
        asked = e.key;
        return e.key === "ArrowLeft";
      },
    });
    const move = nodes(tree).find((v) => v.props["class"] === "gwin-btn gwin-move");
    let stopped = 0;
    const key = (k: string): void =>
      (move?.props["onKeyDown"] as (e: unknown) => void)({
        key: k,
        currentTarget: { closest: () => ({}) },
        preventDefault: () => stopped++,
        stopPropagation: () => stopped++,
      });
    key("ArrowLeft");
    expect(asked).toBe("ArrowLeft");
    expect(stopped).toBe(2);
    key("KeyW");
    expect(stopped).toBe(2); // not the window's: it walks as before
    expect(move?.props["title"]).toBe(
      'client.window.move{"title":"Gremio"} · client.window.move_hint',
    );
  });

  it("names its buttons after the window and hides its body when folded", () => {
    const tree = frame(true);
    const labels = nodes(tree)
      .filter((v) => v.type === "button")
      .map((b) => b.props["aria-label"]);
    expect(labels).toEqual([
      'client.window.move{"title":"Gremio"}',
      'client.window.expand{"title":"Gremio"}',
      'client.window.close{"title":"Gremio"}',
    ]);
    const body = nodes(tree).find((v) => v.props["class"] === "gwin-body");
    expect(body?.props["hidden"]).toBe(true);
    expect(tree.props["data-collapsed"]).toBe("");
  });
});

describe("HudBar (docs/17 UI-4: the gothic bottom bar)", () => {
  const stats = {
    health: 20,
    maxHealth: 100,
    mana: 45,
    maxMana: 60,
    level: 7,
    levelPercent: 40,
    experience: 4200,
  } as GameUi["stats"];
  const bar = (s: GameUi["stats"], levelUp = false): VNode<Props> =>
    HudBar({
      t,
      name: "Aldric Varn",
      stats: s,
      levelUp,
      conditions: "conditions",
      hotbar: "hotbar",
      toolbar: "toolbar",
    }) as VNode<Props>;
  // HudBar is a plain function: its children are calls of Vitals, Orb and ExperienceBar
  // (also plain), rendered here to walk their trees.
  const rendered = (v: VNode<Props>): VNode<Props>[] =>
    nodes(v).flatMap((n) =>
      typeof n.type === "function"
        ? [n, ...rendered((n.type as (p: Props) => VNode<Props>)(n.props))]
        : [n],
    );

  it("has the orbs at its ends, the plaque over the life orb, and the slots between", () => {
    const tree = bar(stats);
    expect(tree.props["data-testid"]).toBe("hud-bar");
    expect(tree.props["aria-label"]).toBe("client.hud.bar");
    const all = rendered(tree);
    const byTestid = (id: string): VNode<Props> | undefined =>
      all.find((v) => v.props["data-testid"] === id);
    expect(byTestid("health")?.props.children).toBe('client.game.health{"health":20,"max":100}');
    expect(byTestid("mana")?.props.children).toBe('client.game.mana{"mana":45,"max":60}');
    expect(byTestid("level")?.props.children).toBe('client.game.level{"level":7,"percent":40}');
    expect(byTestid("experience")?.props.children).toBe(
      'client.game.experience{"experience":4200}',
    );
    const plaque = all.find((v) => v.props["class"] === "vitals");
    expect(plaque?.props["data-tutorial"]).toBe("stats");
    // The orbs: life low (a fifth), mana three quarters full.
    const orbs = all.filter((v) => v.props["class"] === "orb");
    expect(orbs.map((o) => o.props["data-low"])).toEqual(["", undefined]);
    const levels = all
      .filter((v) => v.props["class"] === "orb-liquid")
      .map((v) => (v.props["style"] as { transform: string }).transform);
    expect(levels).toEqual(["translateY(80.00%)", "translateY(25.00%)"]);
    const xp = all.find((v) => v.props["role"] === "progressbar");
    expect(xp?.props["aria-valuenow"]).toBe(40);
    const centre = all.find((v) => v.props["class"] === "bar-hotbar");
    expect(centre?.props.children).toBe("hotbar");
  });

  it("before the first stats: full orbs without numbers, and a flash on a level up", () => {
    const all = rendered(bar(undefined, true));
    expect(all.some((v) => v.props["data-testid"] === "health")).toBe(false);
    expect(all.find((v) => v.props["role"] === "progressbar")?.props["class"]).toBe("xpbar flash");
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
