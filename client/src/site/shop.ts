// Cosmetic shop page helpers (T5.7). Pure but for loadIcons (it fetches the atlas): the page
// (site/Shop.tsx) and its tests use them.
import { fetchJSONWithRetry } from "@rpg/renderer/retry";
import type { Fetcher, RetryOptions } from "@rpg/renderer/retry";
import type { ShopHistoryEntry } from "../net/api.ts";

/** How the provider's checkout came back (/shop?checkout=…), or undefined. */
export type CheckoutReturn = "success" | "failure" | "pending";

export function checkoutReturn(search: string): CheckoutReturn | undefined {
  const v = new URLSearchParams(search).get("checkout");
  return v === "success" || v === "failure" || v === "pending" ? v : undefined;
}

/** Where the fake payment provider's checkout lives (server payments.FakeCheckoutPath). */
export const LOCAL_CHECKOUT_PATH = "/api/shop/fake-checkout/";

/**
 * Whether a checkout URL is the fake provider's (this site's own path): the page pays it
 * with a POST instead of going there. A real provider's page is always absolute https.
 */
export function isLocalCheckout(url: string): boolean {
  return url.startsWith(LOCAL_CHECKOUT_PATH) && !url.includes("//");
}

/** i18n key of the notice for a checkout return. */
export const CHECKOUT_NOTICE: Record<CheckoutReturn, string> = {
  success: "site.shop.payment.ok",
  pending: "site.shop.payment.pending",
  failure: "site.shop.payment.failed",
};

/** i18n key of a shop API error code (docs/05 "Tienda"). */
export function shopErrorKey(code: string): string {
  switch (code) {
    case "insufficient_balance":
      return "site.shop.error.insufficient";
    case "already_owned":
      return "site.shop.error.owned";
    case "shop_disabled":
      return "site.shop.error.disabled";
    case "daily_limit":
      return "site.shop.error.limit";
    case "shop_blocked":
      return "site.shop.error.suspended";
    case "unknown_cosmetic":
    case "unknown_pack":
      return "site.shop.error.unknown";
    default:
      return "site.shop.error.generic";
  }
}

/** Digits after the decimal point of a currency (CLP 0, USD 2), from Intl. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * A pack price for people: `price` is in the currency's minor unit (as data/cosmetics.yaml
 * and the API send it), so CLP 1990 is $1.990 and USD 499 is US$4.99.
 */
export function formatPrice(price: number, currency: string, lang: string): string {
  const digits = minorDigits(currency);
  const major = price / 10 ** digits;
  try {
    // Grouping always: Spanish leaves 4-digit numbers ungrouped (1990 next to 19.990).
    return new Intl.NumberFormat(lang, {
      style: "currency",
      currency,
      useGrouping: true, // "always" since ES2023 ("auto" is the default)
    }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

/** i18n key and parameter names of one history line. */
export function historyLine(e: ShopHistoryEntry): {
  key: string;
  /** The amount to show (always positive: the text says whether it was taken or given). */
  amount: number;
} {
  const amount = Math.abs(e.amount);
  switch (e.kind) {
    case "purchase":
      return { key: "site.shop.history.purchase", amount };
    case "pack":
      return { key: "site.shop.history.pack", amount };
    case "refund":
      return { key: "site.shop.history.refund", amount };
    case "chargeback":
      return { key: "site.shop.history.chargeback", amount };
    default:
      // A staff grant can also take currency away: keep its sign.
      return { key: "site.shop.history.grant", amount: e.amount };
  }
}

/** Where one sprite is on an atlas page, for a CSS background (like Atlas.icon). */
export interface SpriteIcon {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Size of the whole page image (background-size when scaled). */
  pageWidth: number;
  pageHeight: number;
}

interface PageData {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
  meta: { image?: string; size?: { w: number; h: number } };
}

/** The icons of `names` from the atlas index and its pages (pageUrl = each page's URL). */
export function iconsFrom(
  pages: { url: string; data: PageData }[],
  names: readonly string[],
): Map<string, SpriteIcon> {
  const out = new Map<string, SpriteIcon>();
  for (const { url, data } of pages) {
    const image = new URL(data.meta.image ?? "", url).href;
    for (const n of names) {
      const f = data.frames[n]?.frame;
      if (!f || out.has(n)) continue;
      out.set(n, {
        url: image,
        x: f.x,
        y: f.y,
        width: f.w,
        height: f.h,
        pageWidth: data.meta.size?.w ?? 0,
        pageHeight: data.meta.size?.h ?? 0,
      });
    }
  }
  return out;
}

/**
 * Fetches the site's sprite atlas (`base`, /atlas/ by default) and returns the icons of
 * `names`. Each request retries like the game's atlas (@rpg/renderer retry.ts); the page
 * images are CSS backgrounds the browser loads itself.
 */
export async function loadIcons(
  names: readonly string[],
  opts: RetryOptions & { base?: string | undefined; fetcher?: Fetcher | undefined } = {},
): Promise<Map<string, SpriteIcon>> {
  const base = opts.base ?? new URL("/atlas/", document.baseURI).href;
  const get = (url: string): Promise<unknown> => fetchJSONWithRetry(url, opts);
  const index = (await get(new URL("atlas.json", base).href)) as { pages?: string[] };
  const pages = await Promise.all(
    (index.pages ?? []).map(async (p) => {
      const url = new URL(p, base).href;
      return { url, data: (await get(url)) as PageData };
    }),
  );
  return iconsFrom(pages, names);
}

/** "#rrggbb" of a 0xrrggbb colour. */
export const cssColor = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
