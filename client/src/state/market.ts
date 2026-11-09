// Trade window and global market (T5.3, docs/02 "Economía"): what the windows show, built
// from TradeUpdate and MarketUpdate. Pure: no DOM, no clock. The server validates every
// action; these helpers only shape the views and the create form.
import { MarketSide, TradeState } from "@rpg/protocol";
import type { MarketOffer, MarketUpdate, TradeUpdate } from "@rpg/protocol";
import type { ItemDef } from "../content-types.ts";

/** One item of a trade offer. */
export interface TradeItemView {
  itemId: number;
  count: number;
}

/** The trade window: an invitation (sent or received) or a negotiation. */
export interface TradeView {
  partnerId: number;
  partnerName: string;
  /** This player received the invitation and may accept or decline it. */
  invited: boolean;
  negotiating: boolean;
  own: TradeItemView[];
  partner: TradeItemView[];
  ownAccepted: boolean;
  partnerAccepted: boolean;
  maxItems: number;
}

/** What a TradeUpdate does to the window: the new view, or closed with the reason key. */
export function tradeFrom(u: TradeUpdate): {
  view: TradeView | undefined;
  closedReason?: string | undefined;
} {
  if (u.state === TradeState.COMPLETED || u.state === TradeState.CANCELLED) {
    return { view: undefined, closedReason: u.reason || undefined };
  }
  const items = (l: { itemId: number; count: number }[]): TradeItemView[] =>
    l.map((s) => ({ itemId: s.itemId, count: s.count }));
  return {
    view: {
      partnerId: u.partnerCreatureId,
      partnerName: u.partnerName,
      invited: u.invited,
      negotiating: u.state === TradeState.NEGOTIATING,
      own: items(u.ownOffer),
      partner: items(u.partnerOffer),
      ownAccepted: u.ownAccepted,
      partnerAccepted: u.partnerAccepted,
      maxItems: u.maxItems,
    },
  };
}

/** One offer line of the market window. */
export interface OfferView {
  id: bigint;
  sell: boolean;
  itemId: number;
  amount: number;
  price: number;
  expiresAt: number;
  owner: string;
  own: boolean;
}

/** The market window. Money values are in the smallest coin. */
export interface MarketView {
  money: number;
  itemId: number;
  sells: OfferView[];
  buys: OfferView[];
  referencePrice: number;
  own: OfferView[];
  mailboxGold: number;
  mailbox: { id: bigint; itemId: number; count: number }[];
  mailboxMore: number;
  history: { sold: boolean; itemId: number; amount: number; price: number; at: number }[];
  rules: MarketRules;
  owned: number;
}

/** The limits of the create form (balance.yaml market, as the server sends them). */
export interface MarketRules {
  feePermille: number;
  feeMin: number;
  feeMax: number;
  maxOffers: number;
  maxAmount: number;
  maxPrice: number;
  durationsHours: number[];
}

function offerFrom(o: MarketOffer): OfferView {
  return {
    id: o.offerId,
    sell: o.side === MarketSide.SELL,
    itemId: o.itemId,
    amount: o.amount,
    price: Number(o.price),
    expiresAt: Number(o.expiresAt),
    owner: o.ownerName,
    own: o.own,
  };
}

/** The market window of a MarketUpdate, or undefined when it closes (open = false). */
export function marketFrom(u: MarketUpdate): MarketView | undefined {
  if (!u.open) return undefined;
  return {
    money: Number(u.money),
    itemId: u.itemId,
    sells: u.sells.map(offerFrom),
    buys: u.buys.map(offerFrom),
    referencePrice: Number(u.referencePrice),
    own: u.own.map(offerFrom),
    mailboxGold: Number(u.mailboxGold),
    mailbox: u.mailboxItems.map((m) => ({
      id: m.id,
      itemId: m.item?.itemId ?? 0,
      count: m.item?.count ?? 0,
    })),
    mailboxMore: u.mailboxMore,
    history: u.history.map((h) => ({
      sold: h.side === MarketSide.SELL,
      itemId: h.itemId,
      amount: h.amount,
      price: Number(h.price),
      at: Number(h.at),
    })),
    rules: {
      feePermille: u.feePermille,
      feeMin: Number(u.feeMin),
      feeMax: Number(u.feeMax),
      maxOffers: u.maxOffers,
      maxAmount: u.maxAmount,
      maxPrice: Number(u.maxPrice),
      durationsHours: [...u.durationsHours],
    },
    owned: u.owned,
  };
}

/** The posting fee of an offer of amount units at price each (the server's formula). */
export function marketFee(rules: MarketRules, amount: number, price: number): number {
  const fee = Math.floor((amount * price * rules.feePermille) / 1000);
  return Math.min(Math.max(fee, rules.feeMin), rules.feeMax);
}

/** What creating the offer takes from the player now: the fee, plus the deposit to buy. */
export function marketCost(
  rules: MarketRules,
  sell: boolean,
  amount: number,
  price: number,
): number {
  return marketFee(rules, amount, price) + (sell ? 0 : amount * price);
}

/** Why the create form cannot be sent (an i18n key), or undefined when it can. */
export function createProblem(
  m: MarketView,
  sell: boolean,
  amount: number,
  price: number,
): string | undefined {
  const r = m.rules;
  if (!Number.isInteger(amount) || amount < 1 || amount > r.maxAmount)
    return "client.market.bad_amount";
  if (!Number.isInteger(price) || price < 1 || price > r.maxPrice) return "client.market.bad_price";
  if (m.own.length >= r.maxOffers) return "client.market.too_many";
  if (sell && amount > m.owned) return "client.market.not_enough_items";
  if (marketCost(r, sell, amount, price) > m.money) return "client.market.not_enough_money";
  return undefined;
}

/**
 * The marketable items whose name contains query (case and accents ignored), sorted by
 * name, at most limit. name translates an item.
 */
export function searchItems(
  items: Record<number, ItemDef>,
  query: string,
  name: (def: ItemDef) => string,
  limit = 12,
): { itemId: number; name: string }[] {
  const fold = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  const q = fold(query.trim());
  if (!q) return [];
  const out: { itemId: number; name: string }[] = [];
  for (const [id, def] of Object.entries(items)) {
    if (!def.marketable) continue;
    const n = name(def);
    if (fold(n).includes(q)) out.push({ itemId: Number(id), name: n });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, limit);
}
