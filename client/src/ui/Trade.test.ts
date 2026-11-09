// The trade and market windows render as plain functions (no hooks): these tests walk
// their element trees without a DOM and press their buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { ItemRef } from "../state/items.ts";
import type { MarketView, TradeView } from "../state/market.ts";
import { TradeWindow } from "./Trade.tsx";
import { MarketWindow } from "./Market.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

const content = {
  items: {
    66: { id: "backpack", tradeable: true, marketable: true },
    68: { id: "salve", tradeable: true, marketable: true },
    70: { id: "quest_note", tradeable: false },
  },
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

const byAttr = (tree: unknown, attr: string, value?: string): Node[] =>
  nodes(tree).filter((v) => attr in v.props && (value === undefined || v.props[attr] === value));

function click(n: Node | undefined): void {
  (n?.props["onClick"] as (() => void) | undefined)?.();
}

/** Submits a form element with the given field values. */
function submit(form: Node | undefined, fields: Record<string, string>): void {
  const out = { textContent: "" };
  const el = {
    elements: { namedItem: (name: string) => (name in fields ? { value: fields[name] } : null) },
    querySelector: () => out,
  };
  (form?.props["onSubmit"] as ((e: unknown) => void) | undefined)?.({
    preventDefault: () => {},
    currentTarget: el,
  });
}

function recorder(): { game: Game; sent: string[] } {
  const sent: string[] = [];
  const game = {
    itemIcon: () => undefined,
    tradeRequest: (id: number) => sent.push(`request ${id}`),
    tradeCancel: () => sent.push("cancel"),
    tradeAccept: () => sent.push("accept"),
    tradeRemove: (i: number) => sent.push(`remove ${i}`),
    tradeOffer: (r: ItemRef) => sent.push(`offer ${JSON.stringify(r.loc)} ${r.itemId}`),
    marketBrowse: (id: number) => sent.push(`browse ${id}`),
    marketAccept: (id: bigint, n: number) => sent.push(`accept ${id} ${n}`),
    marketCancel: (id: bigint) => sent.push(`cancel ${id}`),
    marketWithdraw: () => sent.push("withdraw"),
    marketCreate: (sell: boolean, item: number, amount: number, price: number, d: number) =>
      sent.push(`create ${sell ? "sell" : "buy"} ${item} ${amount} ${price} ${d}`),
    marketClose: () => sent.push("close"),
  } as unknown as Game;
  return { game, sent };
}

const trade = (over: Partial<TradeView>): TradeView => ({
  partnerId: 7,
  partnerName: "Beto",
  invited: false,
  negotiating: true,
  own: [],
  partner: [],
  ownAccepted: false,
  partnerAccepted: false,
  maxItems: 2,
  ...over,
});

describe("TradeWindow", () => {
  it("answers an invitation", () => {
    const { game, sent } = recorder();
    const ui = {
      trade: trade({ invited: true, negotiating: false }),
      containers: [],
    } as unknown as GameUi;
    const tree = TradeWindow({ t, content, game, ui });
    click(byAttr(tree, "data-testid", "trade-join")[0]);
    click(byAttr(tree, "data-testid", "trade-cancel")[0]);
    expect(sent).toEqual(["request 7", "cancel"]);
  });

  it("offers tradeable items of the open containers and confirms", () => {
    const { game, sent } = recorder();
    const ui = {
      trade: trade({ own: [{ itemId: 68, count: 2 }] }),
      containers: [
        {
          id: 3,
          itemId: 66,
          capacity: 4,
          hasParent: false,
          items: [
            { itemId: 70, count: 1 },
            { itemId: 68, count: 5 },
          ],
        },
      ],
    } as unknown as GameUi;
    const tree = TradeWindow({ t, content, game, ui });
    const add = byAttr(tree, "data-trade-add");
    expect(add.map((b) => b.props["data-trade-add"])).toEqual(["salve"]); // the quest note is not tradeable
    click(add[0]);
    click(byAttr(tree, "data-testid", "trade-accept")[0]);
    expect(sent).toEqual([`offer {"kind":"container","id":3,"index":1} 68`, "accept"]);

    const accepted = TradeWindow({
      t,
      content,
      game,
      ui: {
        ...ui,
        trade: trade({
          ownAccepted: true,
          own: [
            { itemId: 68, count: 1 },
            { itemId: 66, count: 1 },
          ],
        }),
      } as GameUi,
    });
    expect(byAttr(accepted, "data-testid", "trade-accept")[0]?.props["disabled"]).toBe(true);
    expect(byAttr(accepted, "data-trade-add")[0]?.props["disabled"]).toBe(true); // max_items reached
  });
});

const market = (over: Partial<MarketView>): MarketView => ({
  money: 100,
  itemId: 0,
  sells: [],
  buys: [],
  referencePrice: 0,
  own: [],
  mailboxGold: 0,
  mailbox: [],
  mailboxMore: 0,
  history: [],
  rules: {
    feePermille: 20,
    feeMin: 5,
    feeMax: 4000,
    maxOffers: 2,
    maxAmount: 100,
    maxPrice: 1000,
    durationsHours: [12, 48],
  },
  owned: 4,
  ...over,
});

describe("MarketWindow", () => {
  it("searches by name and withdraws the mailbox", () => {
    const { game, sent } = recorder();
    const empty = MarketWindow({ t, content, game, ui: { market: market({}) } as GameUi });
    expect(byAttr(empty, "data-testid", "market-withdraw")[0]?.props["disabled"]).toBe(true);
    submit(byAttr(empty, "data-testid", "market-search")[0], { item: "item.salve" });
    const full = MarketWindow({
      t,
      content,
      game,
      ui: { market: market({ mailboxGold: 30 }) } as GameUi,
    });
    click(byAttr(full, "data-testid", "market-withdraw")[0]);
    expect(sent).toEqual(["browse 68", "withdraw"]);
  });

  it("lists the browsed item's offers and posts a valid offer only", () => {
    const { game, sent } = recorder();
    const m = market({
      itemId: 68,
      referencePrice: 6,
      sells: [
        {
          id: 9n,
          sell: true,
          itemId: 68,
          amount: 3,
          price: 7,
          expiresAt: 0,
          owner: "Sela",
          own: false,
        },
      ],
      own: [
        {
          id: 4n,
          sell: false,
          itemId: 68,
          amount: 1,
          price: 2,
          expiresAt: 0,
          owner: "Ana",
          own: true,
        },
      ],
    });
    const tree = MarketWindow({ t, content, game, ui: { market: m } as GameUi, now: 0 });
    expect(byAttr(tree, "data-testid", "market-browse")[0]?.props["data-item"]).toBe("salve");
    click(byAttr(tree, "data-market-cancel", "4")[0]);
    const create = byAttr(tree, "data-testid", "market-create")[0];
    submit(create, { side: "sell", amount: "5", price: "6", duration: "1" }); // owns only 4
    submit(create, { side: "sell", amount: "4", price: "6", duration: "1" });
    submit(create, { side: "buy", amount: "10", price: "10", duration: "0" }); // 100 + fee > money
    expect(sent).toEqual(["cancel 4", "create sell 68 4 6 1"]);
  });
});
