import type { VNode } from "preact";
import { describe, expect, it } from "vitest";
import { ActionCluster, CONTEXT_ICON, quickSlots } from "./ActionCluster.tsx";
import { ICONS } from "./icons.tsx";

const t = (key: string): string => key;

interface Node {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function walk(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) for (const n of node) walk(n, out);
  else if (node && typeof node === "object" && "props" in node) {
    const n = node as Node;
    out.push(n);
    walk(n.props.children, out);
  }
  return out;
}

function render(ui: Parameters<typeof ActionCluster>[0]["ui"], calls: string[] = []): Node[] {
  const game = {
    targetNext: () => calls.push("targetNext"),
    interact: () => calls.push("interact"),
    setInspect: (on: boolean) => calls.push(`inspect:${on}`),
    setChase: (on: boolean) => calls.push(`chase:${on}`),
    castSpell: (id: string) => calls.push(`cast:${id}`),
    spellCooldown: () => 0,
  };
  return walk(ActionCluster({ t, content: { spells: [] }, game, ui }) as VNode);
}

const byId = (nodes: Node[], id: string): Node | undefined =>
  nodes.find((n) => n.props["data-testid"] === id);
const click = (n: Node | undefined): void =>
  (n?.props["onClick"] as (e: unknown) => void)({ currentTarget: {}, timeStamp: 5 });

const base = {
  target: undefined,
  context: undefined,
  inspect: false,
  chase: false,
  hotkeys: [undefined, "arc_bolt", undefined, "mend", "ember_ring"],
};

describe("quickSlots", () => {
  it("takes the first slots that hold a spell, with their slot", () => {
    expect(quickSlots(base.hotkeys)).toEqual([
      { slot: 1, spellId: "arc_bolt" },
      { slot: 3, spellId: "mend" },
    ]);
    expect(quickSlots([undefined, undefined])).toEqual([]);
    expect(quickSlots(base.hotkeys, 4)).toHaveLength(3);
  });
});

describe("ActionCluster", () => {
  it("every context action has an icon that exists", () => {
    for (const icon of Object.values(CONTEXT_ICON)) expect(ICONS[icon]).toBeDefined();
  });

  it("the attack button targets, and says next once something is targeted", () => {
    const calls: string[] = [];
    const attack = byId(render(base, calls), "touch-attack");
    expect(attack?.props["aria-label"]).toBe("client.touch.cluster.attack");
    click(attack);
    expect(calls).toEqual(["targetNext"]);
    const next = byId(render({ ...base, target: 7 }), "touch-attack");
    expect(next?.props["aria-label"]).toBe("client.touch.cluster.next");
  });

  it("the context button is off with nothing to do and names what it would do", () => {
    const off = byId(render(base), "touch-interact");
    expect(off?.props["disabled"]).toBe(true);
    expect(off?.props["data-context"]).toBe("none");
    const calls: string[] = [];
    const loot = byId(render({ ...base, context: "loot" }, calls), "touch-interact");
    expect(loot?.props["disabled"]).toBe(false);
    expect(loot?.props["aria-label"]).toBe("client.touch.context.loot");
    click(loot);
    expect(calls).toEqual(["interact"]);
  });

  it("inspect and chase are toggles", () => {
    const calls: string[] = [];
    const nodes = render({ ...base, chase: true }, calls);
    expect(byId(nodes, "touch-look")?.props["aria-pressed"]).toBe(false);
    expect(byId(nodes, "touch-chase")?.props["aria-pressed"]).toBe(true);
    click(byId(nodes, "touch-look"));
    click(byId(nodes, "touch-chase"));
    expect(calls).toEqual(["inspect:true", "chase:false"]);
  });

  it("repeats the first hotbar slots and casts them", () => {
    const calls: string[] = [];
    const nodes = render(base, calls);
    expect(byId(nodes, "touch-quick-2")?.props["data-spell"]).toBe("arc_bolt");
    expect(byId(nodes, "touch-quick-4")?.props["data-spell"]).toBe("mend");
    expect(byId(nodes, "touch-quick-5")).toBeUndefined();
    click(byId(nodes, "touch-quick-4"));
    expect(calls).toEqual(["cast:mend"]);
  });
});
