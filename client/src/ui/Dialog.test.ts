// The dialog and shop views render as plain functions (no hooks): these tests walk their
// trees without a DOM and press their buttons (docs/17 UI-8).
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent, ItemDef } from "../content-types.ts";
import type { DialogState, ShopState } from "../state/world.ts";
import { DialogView, SHOP_START, ShopView } from "./Dialog.tsx";
import type { ShopUiState } from "./Dialog.tsx";

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

const byAttr = (tree: unknown, attr: string, value?: unknown): Node[] =>
  nodes(tree).filter((v) => attr in v.props && (value === undefined || v.props[attr] === value));

function texts(n: unknown, out: string[] = []): string[] {
  if (typeof n === "string" || typeof n === "number") out.push(String(n));
  else if (Array.isArray(n)) for (const c of n) texts(c, out);
  else if (n && typeof n === "object" && "props" in n) texts((n as Node).props.children, out);
  return out;
}

const def = (id: string, kind: string): ItemDef => ({
  id,
  kind,
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
});

const content = {
  items: {
    1: def("rope", "tool"),
    2: def("iron_sword", "weapon"),
    3: def("raw_fish", "consumable"),
    4: def("wolf_pelt", "material"),
  },
  dialogTopics: {
    priest: {
      "npc.priest.opt_heal": "services",
      "npc.priest.opt_quest": "quests",
      "dialog.trade": "trade",
    },
  },
  i18n: {},
} as unknown as ClientContent;

const opt = (id: number, text: string): DialogState["options"][number] => ({
  id,
  text,
  params: [],
});

function dialog(options: DialogState["options"]): DialogState {
  return { id: 1, npcId: 9, npcContentId: "priest", text: "npc.priest.greet", options };
}

describe("DialogView (docs/17 UI-8)", () => {
  const view = (
    d: DialogState,
    query = "",
  ): { tree: unknown; chosen: number[]; closed: number[] } => {
    const chosen: number[] = [];
    const closed: number[] = [];
    const tree = DialogView({
      t,
      content,
      dialog: d,
      selfName: "Aldric",
      portrait: undefined,
      query,
      onQuery: () => undefined,
      choose: (id) => void chosen.push(id),
      close: () => void closed.push(1),
    });
    return { tree, chosen, closed };
  };

  it("a grid of buttons by topic, numbered; Back and Goodbye on their own row", () => {
    const { tree, chosen } = view(
      dialog([
        opt(1, "npc.priest.opt_faith"),
        opt(2, "dialog.trade"),
        opt(3, "npc.priest.opt_heal"),
        opt(4, "npc.priest.opt_quest"),
        opt(5, "dialog.back"),
        opt(6, "dialog.bye"),
      ]),
    );
    const grid = byAttr(tree, "class").filter((n) =>
      String(n.props["class"]).startsWith("dialog-option "),
    );
    expect(grid.map((b) => [b.props["data-option"], b.props["data-topic"]])).toEqual([
      [4, "quests"],
      [2, "trade"],
      [3, "services"],
      [1, "talk"],
    ]);
    expect(texts(grid[0])).toContain("1");
    const back = byAttr(tree, "data-topic", "back")[0];
    const bye = byAttr(tree, "data-topic", "bye")[0];
    expect(back?.props["data-option"]).toBe(5);
    expect(bye?.props["data-option"]).toBe(6);
    (bye?.props["onClick"] as () => void)();
    (grid[1]?.props["onClick"] as () => void)();
    expect(chosen).toEqual([6, 2]);
    // No filter with few options.
    expect(byAttr(tree, "data-testid", "dialog-filter")).toHaveLength(0);
  });

  it("the NPC's words appear letter by letter; a click shows them whole", () => {
    let skipped = 0;
    const tree = DialogView({
      t,
      content,
      dialog: dialog([]),
      selfName: "Aldric",
      portrait: undefined,
      query: "",
      onQuery: () => undefined,
      choose: () => undefined,
      close: () => undefined,
      typed: 5,
      onSkip: () => void skipped++,
    });
    const said = 'npc.priest.greet{"name":"Aldric"}';
    const p = byAttr(tree, "class", "npc-text")[0];
    expect(p?.props["data-typing"]).toBe("");
    // Screen readers (and the tests) get the whole text; the rest waits invisible.
    expect(texts(byAttr(tree, "class", "visually-hidden")[0])).toEqual([said]);
    expect(texts(byAttr(tree, "class", "npc-rest")[0])).toEqual([said.slice(5)]);
    (p?.props["onClick"] as () => void)();
    expect(skipped).toBe(1);
    // Whole: one plain paragraph.
    const done = view(dialog([])).tree;
    const q = byAttr(done, "class", "npc-text")[0];
    expect(q?.props["data-typing"]).toBeUndefined();
    expect(texts(q)).toEqual([said]);
  });

  it("framed in a GameWindow, it leaves the header and the test id to the frame", () => {
    const tree = DialogView({
      t,
      content,
      dialog: dialog([]),
      selfName: "Aldric",
      portrait: undefined,
      query: "",
      onQuery: () => undefined,
      choose: () => undefined,
      close: () => undefined,
      framed: true,
    }) as Node;
    expect(tree.props["data-testid"]).toBeUndefined();
    expect(tree.props["role"]).toBeUndefined();
    expect(nodes(tree).some((n) => n.type === "h2")).toBe(false);
    expect((view(dialog([])).tree as Node).props["data-testid"]).toBe("dialog");
  });

  it("Goodbye closes the dialog when the node has no goodbye option", () => {
    const { tree, closed, chosen } = view(dialog([opt(1, "npc.priest.opt_heal")]));
    const bye = byAttr(tree, "data-testid", "dialog-bye")[0];
    expect(bye?.props["data-option"]).toBeUndefined();
    (bye?.props["onClick"] as () => void)();
    expect(closed).toEqual([1]);
    expect(chosen).toEqual([]);
    expect(byAttr(tree, "data-topic", "back")).toHaveLength(0);
  });

  it("ten options or more get a filter that hides the buttons that do not match", () => {
    const many = Array.from({ length: 12 }, (_, i) => opt(i + 1, `npc.priest.opt_${i}`));
    expect(byAttr(view(dialog(many)).tree, "data-testid", "dialog-filter")).toHaveLength(1);
    const filtered = view(dialog(many), "opt_11").tree;
    const ids = byAttr(filtered, "data-option").map((b) => b.props["data-option"]);
    expect(ids.filter((id) => id !== undefined)).toEqual([12]);
    const none = view(dialog(many), "zzz").tree;
    expect(texts(none)).toContain("client.dialog.no_match");
  });
});

describe("ShopView (docs/17 UI-8)", () => {
  const shop: ShopState = {
    dialogId: 1,
    npcId: 9,
    money: 100,
    lines: [
      { itemId: 1, buyPrice: 45, sellPrice: 0, owned: 1 },
      { itemId: 2, buyPrice: 120, sellPrice: 40, owned: 0 },
      { itemId: 3, buyPrice: 3, sellPrice: 1, owned: 12 },
      { itemId: 4, buyPrice: 0, sellPrice: 15, owned: 2 },
    ],
  };
  const render = (
    state: Partial<ShopUiState>,
    perPage = 24,
  ): {
    tree: unknown;
    sets: Partial<ShopUiState>[];
    bought: [number, number][];
    sold: [number, number][];
  } => {
    const sets: Partial<ShopUiState>[] = [];
    const bought: [number, number][] = [];
    const sold: [number, number][] = [];
    const tree = ShopView({
      t,
      content,
      shop,
      state: { ...SHOP_START, ...state },
      perPage,
      columns: 6,
      icon: () => undefined,
      set: (p) => void sets.push(p),
      buy: (id, n) => void bought.push([id, n]),
      sell: (id, n) => void sold.push([id, n]),
      card: () => undefined,
    });
    return { tree, sets, bought, sold };
  };

  it("buying: a cell per item with its price, category filters, nothing chosen yet", () => {
    const { tree } = render({});
    const cells = byAttr(tree, "data-item").filter((n) => n.type === "li");
    expect(cells.map((c) => c.props["data-item"])).toEqual(["rope", "iron_sword", "raw_fish"]);
    expect(texts(cells[0])).toContain('client.shop.price{"price":45}');
    expect(byAttr(tree, "data-filter").map((b) => b.props["data-filter"])).toEqual([
      "all",
      "weapons",
      "tools",
      "consumables",
    ]);
    expect(texts(tree)).toContain("client.shop.pick");
    expect(texts(byAttr(tree, "data-testid", "shop-money")[0])).toContain(
      'client.shop.money{"money":100}',
    );
  });

  it("the bar buys the chosen item: count within the money, the total, Enter or the button", () => {
    const { tree, bought, sets } = render({ selected: 1, count: 5 });
    // 100 pays 2 ropes of 45: the count shows 2 and Max asks for 2.
    const field = byAttr(tree, "data-testid", "shop-count")[0];
    expect(field?.props["value"]).toBe(2);
    expect(texts(byAttr(tree, "data-testid", "shop-total")[0])).toContain(
      'client.shop.total{"price":90}',
    );
    (byAttr(tree, "data-testid", "shop-max")[0]?.props["onClick"] as () => void)();
    expect(sets).toContainEqual({ count: 2 });
    const form = byAttr(tree, "data-testid", "shop-bar")[0];
    (form?.props["onSubmit"] as (e: unknown) => void)({ preventDefault: () => undefined });
    expect(bought).toEqual([[1, 2]]);
    expect(byAttr(tree, "data-testid", "shop-act")[0]?.props["disabled"]).toBe(false);
  });

  it("what the money does not pay cannot be bought", () => {
    const { tree, bought } = render({ selected: 2 });
    expect(byAttr(tree, "data-testid", "shop-act")[0]?.props["disabled"]).toBe(true);
    const total = byAttr(tree, "data-testid", "shop-total")[0];
    expect(total?.props["class"]).toBe("shop-total short");
    (byAttr(tree, "data-testid", "shop-bar")[0]?.props["onSubmit"] as (e: unknown) => void)({
      preventDefault: () => undefined,
    });
    expect(bought).toEqual([]);
  });

  it("selling: what is carried first, its count, and greyed what is not", () => {
    const { tree, sold } = render({ mode: "sell", selected: 3, count: 4 });
    const cells = byAttr(tree, "data-item").filter((n) => n.type === "li");
    expect(cells.map((c) => c.props["data-item"])).toEqual(["raw_fish", "wolf_pelt", "iron_sword"]);
    expect(texts(cells[0])).toContain("12");
    const sword = byAttr(cells[2], "class", "shop-cell none");
    expect(sword).toHaveLength(1);
    (byAttr(tree, "data-testid", "shop-bar")[0]?.props["onSubmit"] as (e: unknown) => void)({
      preventDefault: () => undefined,
    });
    expect(sold).toEqual([[3, 4]]);
  });

  it("pages instead of scrolling, and a search that finds nothing says so", () => {
    const paged = render({}, 2).tree;
    expect(byAttr(paged, "data-item").filter((n) => n.type === "li")).toHaveLength(2);
    expect(texts(byAttr(paged, "class", "shop-pages")[0])).toContain(
      'client.shop.page{"page":1,"pages":2}',
    );
    const none = render({ query: "zzz" }).tree;
    expect(texts(none)).toContain("client.shop.no_match");
  });

  it("the tabs reset the page and the choice", () => {
    const { tree, sets } = render({ selected: 1, page: 1 });
    const sell = byAttr(tree, "data-shop-tab", "sell")[0];
    (sell?.props["onClick"] as () => void)();
    expect(sets).toEqual([{ mode: "sell", page: 0, selected: undefined, count: 1 }]);
  });
});
