// The forge window's body renders as a plain function (no hooks): these tests walk its
// element tree without a DOM (like ui/House.test.ts) for each of its states.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent, ForgeRules, ItemDef } from "../content-types.ts";
import type { Game } from "../game.ts";
import { forgeView } from "../state/forge.ts";
import type { ForgeCandidate, ForgeView, RefineState } from "../state/forge.ts";
import type { StationState } from "../state/recipes.ts";
import { ForgeBody } from "./Forge.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    out.push(v);
    // A function component (SmallIcon, BigIcon) is not expanded: its props are enough.
    nodes(v.props.children, out);
  }
  return out;
}

const byTestId = (tree: unknown, id: string): Node | undefined =>
  nodes(tree).find((v) => v.props["data-testid"] === id);

/** Every string under n, joined. */
function text(n: unknown): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (n && typeof n === "object" && "props" in n) return text((n as Node).props.children);
  return "";
}

const weapon = {
  type: "sword",
  attack: 30,
  defense: 15,
  hands: 1,
  range: 0,
  element: "",
  ammo: "",
};
const base = {
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
};
const content = {
  items: {
    1: {
      ...base,
      id: "embersteel_sabre",
      weapon,
      requires: { level: 30, vocations: [] },
    } as ItemDef,
    307: { ...base, id: "greater_temper_stone", stackable: true } as ItemDef,
    309: { ...base, id: "warding_amber", stackable: true } as ItemDef,
  },
  forge: {
    station: 95,
    safeLevel: 4,
    protection: 309,
    smithingBonus: { skill: "smithing", perLevels: 6, max: 5 },
    jewelryPct: 10,
    levels: [100, 100, 100, 100, 70, 55, 40, 25, 15, 8].map((chance) => ({ chance, stones: 2 })),
    bands: [{ level: 1, stone: 307, gold: 120, attack: 1.4, armor: 0.3, defense: 0.8 }],
  },
} as unknown as ClientContent;

const station = (ambers: number): StationState => ({
  pos: { x: 0, y: 0, z: 7 },
  itemId: 95,
  owned: new Map([
    [307, 6],
    [309, ambers],
  ]),
  tools: new Set(),
  money: 9000,
});

const sabre = (refine: number): ForgeCandidate => ({
  loc: { kind: "slot", slot: 6 },
  itemId: 1,
  mods: { attribute: "attack", value: 3, refine },
});

function render(opts: {
  selected?: ForgeCandidate | undefined;
  view?: ForgeView | undefined;
  protect?: boolean;
  confirming?: boolean;
  result?: RefineState;
}): { tree: unknown; calls: string[] } {
  const calls: string[] = [];
  const tree = ForgeBody({
    t,
    content,
    game: { itemIcon: () => undefined } as unknown as Game,
    candidates: [sabre(opts.selected?.mods?.refine ?? 2)],
    selected: opts.selected,
    view: opts.view,
    protect: opts.protect ?? false,
    confirming: opts.confirming ?? false,
    result: opts.result,
    onPick: () => calls.push("pick"),
    onProtect: (on) => calls.push(`protect ${on}`),
    onAttempt: () => calls.push("attempt"),
    onConfirm: () => calls.push("confirm"),
    onCancel: () => calls.push("cancel"),
  });
  return { tree, calls };
}

const RULES = content.forge as ForgeRules;

const view = (refine: number, ambers: number, protect = false): ForgeView => {
  const v = forgeView(RULES, content, station(ambers), sabre(refine), 0, protect);
  if (!v) throw new Error("no view");
  return v;
};

describe("the forge window", () => {
  it("asks to pick an item first, and picks one from the list", () => {
    const { tree, calls } = render({});
    expect(byTestId(tree, "forge-slot")?.props["data-empty"]).toBe("");
    expect(byTestId(tree, "forge-chance")).toBeUndefined();
    const item = nodes(tree).find((n) => n.props["data-forge-item"] === 1);
    (item?.props["onClick"] as () => void)();
    expect(calls).toEqual(["pick"]);
    expect(text(item)).toContain('client.forge.plus{"level":2}');
  });

  it("a safe level: the chance in green, no warning, the attempt goes at once", () => {
    const { tree, calls } = render({ selected: sabre(2), view: view(2, 0) });
    const chance = byTestId(tree, "forge-chance");
    expect(chance?.props["class"]).toBe("forge-chance");
    expect(text(chance)).toContain('client.forge.chance_pct{"pct":100}');
    expect(text(byTestId(tree, "forge-levels"))).toBe('client.forge.levels{"from":2,"to":3}');
    expect(text(byTestId(tree, "forge-gain"))).toContain('"now":2,"next":4');
    expect(byTestId(tree, "forge-risk")).toBeUndefined();
    expect(byTestId(tree, "forge-protect")).toBeUndefined();
    const attempt = byTestId(tree, "forge-attempt");
    expect(attempt?.props["disabled"]).toBe(false);
    (attempt?.props["onClick"] as () => void)();
    expect(calls).toEqual(["attempt"]);
  });

  it("a risky level: the warning in red, the protection toggle when carried, the confirm step", () => {
    const { tree } = render({ selected: sabre(6), view: view(6, 2) });
    expect(byTestId(tree, "forge-chance")?.props["class"]).toBe("forge-chance risky");
    expect(text(byTestId(tree, "forge-chance"))).toContain('"pct":40');
    expect(byTestId(tree, "forge-risk")?.props["class"]).toBe("forge-risk");
    expect(text(byTestId(tree, "forge-risk"))).toBe("client.forge.risk");
    expect(byTestId(tree, "forge-protect")).toBeDefined();
    // Without ambers there is no toggle.
    expect(
      byTestId(render({ selected: sabre(6), view: view(6, 0) }).tree, "forge-protect"),
    ).toBeUndefined();

    const confirm = render({ selected: sabre(6), view: view(6, 2), confirming: true });
    const box = byTestId(confirm.tree, "forge-confirm");
    expect(box?.props["role"]).toBe("alertdialog");
    expect(text(box)).toContain("client.forge.confirm{");
    expect(text(box)).toContain('"chance":40');
    expect(byTestId(confirm.tree, "forge-attempt")).toBeUndefined();
    (byTestId(confirm.tree, "forge-go")?.props["onClick"] as () => void)();
    (byTestId(confirm.tree, "forge-cancel")?.props["onClick"] as () => void)();
    expect(confirm.calls).toEqual(["confirm", "cancel"]);

    const safe = render({
      selected: sabre(6),
      view: view(6, 2, true),
      protect: true,
      confirming: true,
    });
    expect(byTestId(safe.tree, "forge-risk")?.props["class"]).toBe("forge-risk protected");
    expect(text(byTestId(safe.tree, "forge-confirm"))).toContain("client.forge.confirm_protected");
  });

  it("the toggle left on after the last amber was spent: the plain risk, the button free", () => {
    // The amber was marked and the attempt spent the last one: the new StationOpen has none,
    // the toggle hides, its state is still on.
    const { tree, calls } = render({ selected: sabre(6), view: view(6, 0, true), protect: true });
    expect(byTestId(tree, "forge-protect")).toBeUndefined();
    expect(byTestId(tree, "forge-risk")?.props["class"]).toBe("forge-risk");
    expect(text(byTestId(tree, "forge-risk"))).toBe("client.forge.risk");
    const attempt = byTestId(tree, "forge-attempt");
    expect(attempt?.props["disabled"]).toBe(false);
    (attempt?.props["onClick"] as () => void)();
    expect(calls).toEqual(["attempt"]);
    const confirm = render({
      selected: sabre(6),
      view: view(6, 0, true),
      protect: true,
      confirming: true,
    });
    expect(text(byTestId(confirm.tree, "forge-confirm"))).toContain("client.forge.confirm{");
  });

  it("cannot attempt what it lacks, and says +10 is the top", () => {
    const poor = forgeView(RULES, content, { ...station(0), money: 10 }, sabre(6), 0, false);
    const { tree } = render({ selected: sabre(6), view: poor });
    expect(byTestId(tree, "forge-attempt")?.props["disabled"]).toBe(true);
    const gold = nodes(byTestId(tree, "forge-cost")).find((n) => n.props["data-cost"] === "gold");
    expect(gold?.props["class"]).toBe("lacking");
    const top = render({ selected: sabre(10), view: view(10, 2) });
    expect(text(byTestId(top.tree, "forge-levels"))).toBe('client.forge.top{"level":10}');
    expect(byTestId(top.tree, "forge-attempt")).toBeUndefined();
  });

  it("shows the last result: a success, a break, a protected failure", () => {
    for (const [outcome, level] of [
      ["success", 7],
      ["broken", 0],
      ["protected", 5],
    ] as const) {
      const result: RefineState = { outcome, level, itemId: 1, mods: undefined, from: 6, at: 0 };
      const r = byTestId(render({ result }).tree, "forge-result");
      expect(r?.props["data-outcome"]).toBe(outcome);
      expect(text(r)).toContain(`client.forge.result.${outcome}`);
      expect(text(r)).toContain(`"level":${level}`);
      // The item is named as it was: "+6 sabre".
      expect(text(r)).toContain('client.item.refined{\\"level\\":6');
    }
  });
});
