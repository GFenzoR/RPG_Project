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
  applyMarket,
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

describe("applyMarket", () => {
  const book = (amount: number, refresh: boolean) =>
    create(MarketUpdateSchema, {
      open: true,
      refresh,
      money: 30n,
      itemId: 68,
      sells: [
        { offerId: 9n, side: MarketSide.SELL, itemId: 68, amount, price: 7n, ownerName: "Sela" },
      ],
    });

  it("refreshes an open window with another player's change", () => {
    const open = applyMarket(undefined, book(10, false));
    expect(open?.sells[0]?.amount).toBe(10);
    const later = applyMarket(open, book(6, true));
    expect(later?.sells[0]?.amount).toBe(6);
    expect(later?.money).toBe(30);
    // A refresh that empties the book still leaves the window open.
    expect(
      applyMarket(later, create(MarketUpdateSchema, { open: true, refresh: true }))?.sells,
    ).toEqual([]);
  });

  it("keeps the create form's default price while the window shows the same item", () => {
    const at = (itemId: number, referencePrice: bigint, refresh: boolean) =>
      create(MarketUpdateSchema, { open: true, refresh, itemId, referencePrice });
    const open = applyMarket(undefined, at(68, 6n, false));
    expect(open?.priceDefault).toBe(6);
    // Another player's sale moves the reference price: the default stays.
    const later = applyMarket(open, at(68, 9n, true));
    expect(later?.referencePrice).toBe(9);
    expect(later?.priceDefault).toBe(6);
    expect(applyMarket(later, at(68, 9n, false))?.priceDefault).toBe(6);
    // Another item, or the window opened again, starts from its reference price.
    expect(applyMarket(later, at(66, 3n, false))?.priceDefault).toBe(3);
    expect(applyMarket(undefined, at(68, 9n, false))?.priceDefault).toBe(9);
    expect(applyMarket(undefined, at(68, 0n, false))?.priceDefault).toBe(1);
  });

  it("never reopens a closed window, but an answer opens it", () => {
    expect(applyMarket(undefined, book(6, true))).toBeUndefined();
    expect(applyMarket(undefined, book(6, false))?.itemId).toBe(68);
    const open = applyMarket(undefined, book(6, false));
    expect(applyMarket(open, create(MarketUpdateSchema, { open: false }))).toBeUndefined();
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
    // docs/02 "Atributos de items": an equipable is sold one instance at a time.
    expect(createProblem(m, true, 2, 5, true)).toBe("client.market.one_instance");
    expect(createProblem(m, true, 1, 5, true)).toBeUndefined();
    expect(createProblem(m, false, 2, 5, true)).toBeUndefined();
  });
});

describe('an equipable in the market (docs/02 "Atributos de items")', () => {
  it("keeps each sell offer's, each mailbox item's and each owned instance's attribute", () => {
    const m = marketFrom(
      create(MarketUpdateSchema, {
        open: true,
        itemId: 60,
        sells: [
          {
            offerId: 1n,
            side: MarketSide.SELL,
            itemId: 60,
            amount: 1,
            mods: { attribute: "attack", value: 2 },
          },
          {
            offerId: 2n,
            side: MarketSide.SELL,
            itemId: 60,
            amount: 1,
            mods: { attribute: "armor", value: 1 },
          },
        ],
        buys: [{ offerId: 3n, side: MarketSide.BUY, itemId: 60, amount: 4 }],
        mailboxItems: [
          { id: 7n, item: { itemId: 60, mods: { attribute: "speed", value: 5, refine: 1 } } },
        ],
        owned: 2,
        ownedMods: [{ attribute: "attack", value: 1 }, {}],
      }),
    );
    if (!m) throw new Error("no view");
    expect(m.sells.map((o) => o.mods)).toEqual([
      { attribute: "attack", value: 2, refine: 0 },
      { attribute: "armor", value: 1, refine: 0 },
    ]);
    expect(m.buys[0]?.mods).toBeUndefined();
    expect(m.mailbox[0]?.mods).toEqual({ attribute: "speed", value: 5, refine: 1 });
    expect(m.ownedMods).toEqual([
      { attribute: "attack", value: 1, refine: 0 },
      { attribute: "", value: 0, refine: 0 },
    ]);
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
    expect(found.map((f) => f.itemId)).toEqual([2, 3]); // the prefix first
    expect(searchItems(items, "  ", (d) => d.id)).toEqual([]);
  });
});

describe("searchItems ranking", () => {
  it("prefers the exact name, then a prefix, over a name that contains it", () => {
    const items: Record<number, ItemDef> = {
      112: { id: "glowcap", marketable: true } as ItemDef,
      116: { id: "glowcap_broth", marketable: true } as ItemDef,
      117: { id: "glowcap_dust", marketable: true } as ItemDef,
    };
    const names: Record<string, string> = {
      glowcap: "hongo lumbre",
      glowcap_broth: "caldo de hongo lumbre",
      glowcap_dust: "hongo lumbre molido",
    };
    const name = (d: ItemDef): string => names[d.id] ?? d.id;
    expect(searchItems(items, "Hongo Lumbre", name, 1)[0]?.itemId).toBe(112);
    expect(searchItems(items, "hongo", name).map((f) => f.itemId)).toEqual([112, 117, 116]);
    expect(searchItems(items, "caldo", name, 1)[0]?.itemId).toBe(116);
  });

  it("reads the read-only flag", () => {
    expect(marketFrom(create(MarketUpdateSchema, { open: true, readOnly: true }))?.readOnly).toBe(
      true,
    );
  });
});

describe("an equipable in the trade window", () => {
  it("keeps each offered instance's attribute", () => {
    const { view } = tradeFrom(
      create(TradeUpdateSchema, {
        state: TradeState.NEGOTIATING,
        ownOffer: [
          { itemId: 60, mods: { attribute: "life_leech", value: 2 } },
          { itemId: 68, count: 3 },
        ],
        partnerOffer: [{ itemId: 63, mods: { attribute: "armor", value: 1 } }],
      }),
    );
    expect(view?.own).toEqual([
      { itemId: 60, count: 0, mods: { attribute: "life_leech", value: 2, refine: 0 } },
      { itemId: 68, count: 3 },
    ]);
    expect(view?.partner[0]?.mods).toEqual({ attribute: "armor", value: 1, refine: 0 });
  });
});
