// The item hotkey bar (ui/ItemHotbar.tsx): which slots it draws, what each one says of the
// units carried, and what a press does. The hooks are stubbed so the function can be walked
// without a DOM.
import { describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import type { ClientContent, ItemDef } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";

vi.mock("preact/hooks", () => ({
  useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
  useEffect: () => {},
}));
const { ItemHotbar, assignable, itemFlashes } = await import("./ItemHotbar.tsx");

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

const base: ItemDef = {
  id: "",
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
    10: { ...base, id: "bread", stackable: true, consumable: { healHp: 0, healMp: 0, foodMs: 9 } },
    11: { ...base, id: "potion", stackable: true, consumable: { healHp: 5, healMp: 0, foodMs: 0 } },
    20: { ...base, id: "sword", weapon: { type: "sword", attack: 1, defense: 1, hands: 1 } },
  },
  i18n: {},
} as unknown as ClientContent;

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
const byAttr = (tree: unknown, attr: string): Node[] =>
  nodes(tree).filter((v) => v.props[attr] !== undefined);

function draw(ui: Partial<GameUi>, game: Partial<Game> = {}): unknown {
  const full = {
    itemKeys: [10, 0, 11, 0, 0, 0],
    itemCounts: new Map([
      [10, 7],
      [11, 0],
    ]),
    ...ui,
  } as GameUi;
  return ItemHotbar({
    t,
    content,
    game: { itemIcon: () => undefined, itemCooldown: () => 0, ...game } as unknown as Game,
    ui: full,
    place: "bar",
  });
}

describe("ItemHotbar", () => {
  it("draws six drop targets with their keys", () => {
    const tree = draw({});
    const slots = byAttr(tree, "data-itemkey");
    expect(slots.map((s) => s.props["data-itemkey"])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(slots.map((s) => s.props["data-drop"])).toEqual(Array(6).fill("itemkey"));
    expect(slots.map((s) => s.props["data-index"])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("shows the units carried, greys out a slot with none and says so to a screen reader", () => {
    const tree = draw({});
    const buttons = nodes(tree).filter((n) => n.type === "button" && "data-item-slot" in n.props);
    expect(buttons.map((b) => b.props["data-item-slot"])).toEqual([
      "bread",
      undefined,
      "potion",
      undefined,
      undefined,
      undefined,
    ]);
    expect(buttons[0]?.props["data-none"]).toBeUndefined();
    expect(buttons[0]?.props["aria-label"]).toBe(
      'client.itemkeys.slot{"key":"1","name":"item.bread.name","count":7}',
    );
    expect(buttons[2]?.props["data-none"]).toBe("");
    expect(
      byAttr(tree, "data-testid").filter((n) => n.props["data-testid"] === "itemkey-count-1"),
    ).toHaveLength(1);
    const counts = nodes(tree).filter((n) =>
      String(n.props["data-testid"]).startsWith("itemkey-count"),
    );
    expect(counts.map((c) => c.props.children)).toEqual([7, 0]);
  });

  it("an empty slot has no card and no count; the card of a full one is its item's", () => {
    const tree = draw({});
    const all = nodes(tree).filter((n) => n.type === "button" && "data-tip-item" in n.props);
    expect(all.map((b) => b.props["data-tip-item"])).toEqual([
      10,
      undefined,
      11,
      undefined,
      undefined,
      undefined,
    ]);
    // Before the first ItemCounts nothing is counted yet.
    const none = draw({ itemCounts: new Map() });
    expect(
      nodes(none).filter((n) => String(n.props["data-testid"]).startsWith("itemkey-count")),
    ).toHaveLength(0);
  });

  it("a press uses the slot, and starts the drag that empties it", () => {
    const used: number[] = [];
    const pressed: number[] = [];
    const tree = draw(
      {},
      {
        useItemKeyTap: (i: number) => void used.push(i),
        pressItemKey: (i: number) => void pressed.push(i),
      },
    );
    const second = nodes(tree).filter((n) => n.type === "button" && "data-item-slot" in n.props)[0];
    (second?.props["onClick"] as (e: unknown) => void)({
      currentTarget: {},
      timeStamp: 1,
    });
    (second?.props["onPointerDown"] as (e: unknown) => void)({});
    expect(used).toEqual([0]);
    expect(pressed).toEqual([0]);
  });

  it("glows the slots while a usable item is dragged and not for a sword", () => {
    const usable = draw({ dragging: { itemId: 10 } as never });
    expect(byAttr(usable, "data-accepts").map((s) => s.props["data-accepts"])).toEqual(
      Array(6).fill("yes"),
    );
    const sword = draw({ dragging: { itemId: 20 } as never });
    expect(byAttr(sword, "data-accepts").map((s) => s.props["data-accepts"])).toEqual(
      Array(6).fill("no"),
    );
    expect(byAttr(draw({}), "data-accepts")).toHaveLength(0);
  });

  it("shades a slot with the cooldown left and lists what the pencil can pick", () => {
    const tree = draw({}, { itemCooldown: (id: number) => (id === 10 ? 0.5 : 0) });
    const cd = nodes(tree).filter((n) => n.props["class"] === "cd");
    expect(cd).toHaveLength(1);
    expect((cd[0]?.props["style"] as { height: string }).height).toBe("50%");
    expect(assignable(content, t).map((c) => c.id)).toEqual([10, 11]);
  });

  it("flashes the slot just used, briefly", () => {
    expect(itemFlashes({ slot: 2, at: 1000 }, 2, 1100)).toBe(true);
    expect(itemFlashes({ slot: 2, at: 1000 }, 1, 1100)).toBe(false);
    expect(itemFlashes({ slot: 2, at: 1000 }, 2, 5000)).toBe(false);
    expect(itemFlashes(undefined, 0, 0)).toBe(false);
  });
});
