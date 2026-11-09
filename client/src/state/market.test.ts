import { describe, expect, it } from "vitest";
import {
  create,
  MarketSide,
  MarketUpdateSchema,
  TradeState,
  TradeUpdateSchema,
} from "@rpg/protocol";
import type { ItemDef } from "../content-types.ts";
import {
  createProblem,
  marketCost,
  marketFee,
  marketFrom,
  searchItems,
  tradeFrom,
} from "./market.ts";

const rules = {
  feePermille: 20,
  feeMin: 5,
  feeMax: 4000,
  maxOffers: 2,
  maxAmount: 100,
  maxPrice: 1000,
  durationsHours: [12, 48],
};

describe("tradeFrom", () => {
  it("builds the window while it is open and closes it with the reason", () => {
    const open = tradeFrom(
      create(TradeUpdateSchema, {
        state: TradeState.NEGOTIATING,
        partnerCreatureId: 4,
        partnerName: "Beto",
        ownOffer: [{ itemId: 68, count: 3 }],
        partnerAccepted: true,
        maxItems: 6,
      }),
    );
    expect(open.view).toMatchObject({
      partnerId: 4,
      negotiating: true,
      own: [{ itemId: 68, count: 3 }],
      partnerAccepted: true,
      ownAccepted: false,
    });
    const closed = tradeFrom(
      create(TradeUpdateSchema, { state: TradeState.CANCELLED, reason: "trade.cancel.too_far" }),
    );
    expect(closed).toEqual({ view: undefined, closedReason: "trade.cancel.too_far" });
    expect(
      tradeFrom(create(TradeUpdateSchema, { state: TradeState.COMPLETED })).closedReason,
    ).toBeUndefined();
  });
});

describe("marketFrom", () => {
  it("reads the offers, mailbox and rules, and closes on open = false", () => {
    expect(marketFrom(create(MarketUpdateSchema, { open: false }))).toBeUndefined();
    const m = marketFrom(
      create(MarketUpdateSchema, {
        open: true,
        money: 120n,
        itemId: 68,
        sells: [
          {
            offerId: 9n,
            side: MarketSide.SELL,
            itemId: 68,
            amount: 3,
            price: 7n,
            ownerName: "Sela",
          },
        ],
        mailboxGold: 40n,
        mailboxItems: [{ id: 2n, item: { itemId: 68, count: 5 } }],
        history: [{ side: MarketSide.SELL, itemId: 68, amount: 1, price: 7n, at: 5n }],
        feePermille: 20,
        feeMin: 5n,
        feeMax: 4000n,
        durationsHours: [12],
      }),
    );
    expect(m?.sells[0]).toMatchObject({ id: 9n, sell: true, price: 7, owner: "Sela" });
    expect(m?.mailbox).toEqual([{ id: 2n, itemId: 68, count: 5 }]);
    expect(m?.history[0]).toMatchObject({ sold: true, price: 7 });
    expect(m?.rules.feeMax).toBe(4000);
  });
});

describe("fees and the create form", () => {
  it("clamps the fee and adds the deposit of a buy offer", () => {
    expect(marketFee(rules, 1, 10)).toBe(5); // 2% of 10 is below the minimum
    expect(marketFee(rules, 100, 1000)).toBe(2000);
    expect(marketFee({ ...rules, feeMax: 100 }, 100, 1000)).toBe(100);
    expect(marketCost(rules, false, 10, 30)).toBe(306);
    expect(marketCost(rules, true, 10, 30)).toBe(6);
  });

  it("names the first problem of the form", () => {
    const m = marketFrom(create(MarketUpdateSchema, { open: true, money: 50n, owned: 4 }));
    if (!m) throw new Error("no view");
    m.rules = rules;
    expect(createProblem(m, true, 0, 5)).toBe("client.market.bad_amount");
    expect(createProblem(m, true, 1, 1001)).toBe("client.market.bad_price");
    expect(createProblem(m, true, 5, 5)).toBe("client.market.not_enough_items");
    expect(createProblem(m, false, 10, 5)).toBe("client.market.not_enough_money");
    expect(createProblem(m, true, 4, 5)).toBeUndefined();
  });
});

describe("searchItems", () => {
  it("finds marketable items by name, ignoring case and accents", () => {
    const items: Record<number, ItemDef> = {
      1: { id: "copper_coin", marketable: false } as ItemDef,
      2: { id: "raw_fish", marketable: true } as ItemDef,
      3: { id: "fish_pie", marketable: true } as ItemDef,
      4: { id: "anvil" } as ItemDef,
    };
    const names: Record<string, string> = {
      raw_fish: "pescado crudo",
      fish_pie: "Pastel de PESCADO",
      copper_coin: "pescado",
    };
    const found = searchItems(items, "pescádo", (d) => names[d.id] ?? d.id);
    expect(found.map((f) => f.itemId)).toEqual([3, 2]);
    expect(searchItems(items, "  ", (d) => d.id)).toEqual([]);
  });
});
