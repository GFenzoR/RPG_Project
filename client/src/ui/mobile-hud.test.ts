import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { ICONS } from "./icons.tsx";
import { MOBILE_HUD, PANEL_TABS, layoutFor } from "./layout.ts";
import {
  GLANCE_FADE_MS,
  GLANCE_LINES,
  GLANCE_MS,
  MOBILE_TABS,
  TAB_ICON,
  glanceExpiry,
  glanceLines,
  tabsComplete,
  tabsPlace,
  togglePlace,
} from "./mobile-hud.ts";
import { MobileBar, MobileMenu, PanelTabs, PanelToggle } from "./MobileHud.tsx";

const t = (key: string): string => key;
const css = readFileSync(new URL("./mobile.css", import.meta.url), "utf8");

type Node = VNode<Record<string, unknown> & { children?: unknown }>;
/** Every element of a tree drawn by a component without hooks. */
function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) for (const c of n) nodes(c, out);
  else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    if (typeof v.type === "function") {
      nodes((v.type as (p: unknown) => unknown)(v.props), out);
    } else {
      out.push(v);
      nodes(v.props.children, out);
    }
  }
  return out;
}

const phoneUp = layoutFor(390, 844);
const phoneSide = layoutFor(844, 390);
const tabletUp = layoutFor(768, 1024);

describe("the sections of the mobile HUD", () => {
  it("has a pixel icon and a button for every section, once", () => {
    expect(tabsComplete()).toBe(true);
    expect(new Set(MOBILE_TABS).size).toBe(PANEL_TABS.length);
    for (const tab of PANEL_TABS) expect(ICONS[TAB_ICON[tab]]).toBeDefined();
  });

  it("upright keeps the section buttons in the console, the sheet open or not", () => {
    for (const layout of [phoneUp, tabletUp]) {
      expect(tabsPlace(layout, false)).toBe("console");
      expect(tabsPlace(layout, true)).toBe("console");
      // The sheet closes with its own cross; closed, nothing else is needed.
      expect(togglePlace(layout, false)).toBe("none");
      expect(togglePlace(layout, true)).toBe("sheet");
    }
  });

  it("on its side opens the drawer from the bar and shows the sections along its top", () => {
    expect(tabsPlace(phoneSide, false)).toBe("none");
    expect(tabsPlace(phoneSide, true)).toBe("sheet");
    expect(togglePlace(phoneSide, false)).toBe("bar");
    expect(togglePlace(phoneSide, true)).toBe("bar");
  });

  it("draws a tablist of icon buttons with their names, the chosen one only while open", () => {
    const closed = nodes(PanelTabs({ t, tab: "inventory", open: false, onTab: () => {} }));
    const tabs = closed.filter((n) => n.props["role"] === "tab");
    expect(tabs.map((n) => n.props["data-tab"])).toEqual([...MOBILE_TABS]);
    for (const tab of tabs) {
      expect(tab.props["aria-label"]).toMatch(/^client\.\w+\.title$/);
      expect(tab.props["aria-selected"]).toBe(false);
    }
    const open = nodes(PanelTabs({ t, tab: "inventory", open: true, onTab: () => {} }));
    const chosen = open.filter((n) => n.props["aria-selected"] === true);
    expect(chosen.map((n) => n.props["data-tab"])).toEqual(["inventory"]);
  });

  it("a tap on a section button asks for that section", () => {
    const asked: string[] = [];
    const tree = nodes(PanelTabs({ t, tab: "battle", open: false, onTab: (x) => asked.push(x) }));
    const chat = tree.find((n) => n.props["data-tab"] === "chat");
    (chat?.props["onClick"] as () => void)();
    expect(asked).toEqual(["chat"]);
  });

  it("marks the sections with something new", () => {
    const tree = nodes(
      PanelTabs({ t, tab: "battle", open: false, onTab: () => {}, badges: new Set(["guild"]) }),
    );
    const badge = (tab: string): boolean =>
      nodes(tree.find((n) => n.props["data-tab"] === tab)?.props.children).some(
        (n) => n.props["class"] === "tool-badge",
      );
    expect(badge("guild")).toBe(true);
    expect(badge("chat")).toBe(false);
  });

  it("the panel button says what a tap does", () => {
    const [closed] = nodes(PanelToggle({ t, open: false, place: "bar", onToggle: () => {} }));
    expect(closed?.props["aria-expanded"]).toBe(false);
    expect(closed?.props["aria-label"]).toBe("client.panel.open");
    const [open] = nodes(PanelToggle({ t, open: true, place: "sheet", onToggle: () => {} }));
    expect(open?.props["aria-expanded"]).toBe(true);
    expect(open?.props["aria-label"]).toBe("client.panel.close");
    expect(open?.props["data-testid"]).toBe("panel-toggle");
  });
});

describe("the mobile bar", () => {
  const stats = {
    health: 60,
    maxHealth: 400,
    mana: 90,
    maxMana: 180,
    level: 15,
    levelPercent: 62,
    experience: 35_280,
  } as Parameters<typeof MobileBar>[0]["stats"];
  const bar = (flow: "row" | "column"): Node[] =>
    nodes(
      MobileBar({ t, flow, name: "Aldric Varn", stats, levelUp: false, hotbar: null, pad: null, tools: null }),
    );

  it.each(["row", "column"] as const)("%s: both orbs, the experience and the name plate", (flow) => {
    const tree = bar(flow);
    const ids = tree.map((n) => n.props["data-testid"]).filter(Boolean);
    expect(ids).toEqual(expect.arrayContaining(["hud-bar", "health", "mana", "experience", "level"]));
    expect(tree.some((n) => n.props["class"] === "nameplate")).toBe(true);
    expect(tree[0]?.props["data-flow"]).toBe(flow);
  });

  it("the life orb beats under a quarter of the health, with its ghost", () => {
    const tree = bar("row");
    const orbs = tree.filter((n) => n.props["class"] === "orb");
    expect(orbs).toHaveLength(2);
    expect(orbs[0]?.props["data-low"]).toBe("");
    expect(orbs[1]?.props["data-low"]).toBeUndefined();
    expect(tree.filter((n) => n.props["class"] === "orb-ghost")).toHaveLength(2);
    const liquid = tree.find((n) => n.props["class"] === "orb-liquid");
    expect(liquid?.props["style"]).toEqual({ transform: "translateY(85.00%)" });
  });

  it("the menu keeps the hamburger's test id and holds what it is given", () => {
    const tree = nodes(MobileMenu({ t, children: [] }));
    expect(tree[0]?.type).toBe("details");
    expect(tree[0]?.props["data-testid"]).toBe("hud-menu");
    expect(tree.some((n) => n.props["data-testid"] === "hud-menu-close")).toBe(true);
  });
});

describe("the compact chat log", () => {
  const line = (at: number): { at: number } => ({ at });

  it("shows the newest lines said in the last seconds, oldest first", () => {
    const chat = [line(0), line(1000), line(2000), line(3000), line(4000)];
    expect(glanceLines(chat, 5000)).toEqual([line(2000), line(3000), line(4000)]);
    expect(GLANCE_LINES).toBe(3);
  });

  it("drops a line when its time is up, and shows none said later than now", () => {
    const chat = [line(0), line(5000)];
    expect(glanceLines(chat, GLANCE_MS - 1)).toEqual(chat);
    expect(glanceLines(chat, GLANCE_MS)).toEqual([line(5000)]);
    expect(glanceLines(chat, 5000 + GLANCE_MS)).toEqual([]);
    expect(glanceLines(chat, 4000)).toEqual([line(0)]);
    expect(glanceLines(chat, 6000, 0)).toEqual([]);
  });

  it("says when to look again", () => {
    expect(glanceExpiry([])).toBeUndefined();
    expect(glanceExpiry([line(700), line(300)])).toBe(300 + GLANCE_MS);
    expect(GLANCE_FADE_MS).toBeLessThan(GLANCE_MS);
  });
});

describe("mobile.css", () => {
  const px = (name: string): number => {
    const m = new RegExp(`--${name}:\\s*(\\d+)px`).exec(css);
    if (!m) throw new Error(`mobile.css has no --${name}`);
    return Number(m[1]);
  };

  it("keeps the sizes layout.ts counts the slots with", () => {
    expect(px("m-slot")).toBe(MOBILE_HUD.slot);
    expect(px("m-gap")).toBe(MOBILE_HUD.slotGap);
    expect(px("m-gap")).toBe(MOBILE_HUD.barGap);
    expect(px("m-gap")).toBe(MOBILE_HUD.toolGap);
    expect(px("m-pad")).toBe(MOBILE_HUD.pad);
    expect(px("m-orb-col")).toBe(MOBILE_HUD.orbCol);
    expect(px("m-tool")).toBe(MOBILE_HUD.tool);
  });

  it("moves only transform and opacity, and never waits for a hover", () => {
    for (const m of css.matchAll(/transition:([^;]+);/g)) {
      const props = (m[1] ?? "")
        .split(",")
        .map((p) => p.trim().split(/\s+/)[0])
        .filter((p) => p !== "none");
      for (const p of props) expect(["transform", "opacity", "visibility"]).toContain(p);
    }
    // No rule shows or hides anything on hover (a finger has none).
    expect(css).not.toMatch(/:hover[^{]*\{[^}]*(display|visibility|opacity)\s*:/);
  });

  it("adds the safe area only where something is fixed to the screen", () => {
    // Without the comments (the one at the top explains this very rule).
    const rules = css
      .split("*/")
      .map((part) => part.split("/*")[0])
      .join("");
    const blocks = rules.split("}\n");
    for (const block of blocks.filter((b) => b.includes("env(safe-area-inset")))
      expect(block).toMatch(/\.mmenu-body\s*\{/);
  });
});
