import { describe, expect, it } from "vitest";
import {
  checkoutReturn,
  cssColor,
  formatPrice,
  historyLine,
  iconsFrom,
  isLocalCheckout,
  minorDigits,
  shopErrorKey,
} from "./shop.ts";

describe("shop page helpers (T5.7)", () => {
  it("pays only the fake provider's own checkout path locally", () => {
    expect(isLocalCheckout("/api/shop/fake-checkout/1.pack.n.m")).toBe(true);
    expect(isLocalCheckout("https://www.mercadopago.cl/checkout/v1/redirect?pref_id=1")).toBe(
      false,
    );
    expect(isLocalCheckout("/api/shop/fake-checkout//evil.test/x")).toBe(false);
    expect(isLocalCheckout("/shop")).toBe(false);
  });

  it("reads only the known checkout returns", () => {
    expect(checkoutReturn("?checkout=success")).toBe("success");
    expect(checkoutReturn("?checkout=pending&x=1")).toBe("pending");
    expect(checkoutReturn("?checkout=failure")).toBe("failure");
    expect(checkoutReturn("?checkout=<script>")).toBeUndefined();
    expect(checkoutReturn("")).toBeUndefined();
  });

  it("maps every API error code to a shop message", () => {
    expect(shopErrorKey("insufficient_balance")).toBe("site.shop.error.insufficient");
    expect(shopErrorKey("already_owned")).toBe("site.shop.error.owned");
    expect(shopErrorKey("shop_disabled")).toBe("site.shop.error.disabled");
    expect(shopErrorKey("daily_limit")).toBe("site.shop.error.limit");
    expect(shopErrorKey("shop_blocked")).toBe("site.shop.error.suspended");
    expect(shopErrorKey("unknown_pack")).toBe("site.shop.error.unknown");
    expect(shopErrorKey("unknown_cosmetic")).toBe("site.shop.error.unknown");
    expect(shopErrorKey("rate_limited")).toBe("site.shop.error.generic");
    expect(shopErrorKey("provider_error")).toBe("site.shop.error.generic");
  });

  it("formats prices from the currency's minor unit", () => {
    expect(minorDigits("CLP")).toBe(0);
    expect(minorDigits("USD")).toBe(2);
    expect(formatPrice(1990, "CLP", "es-CL")).toMatch(/1\.990/);
    expect(formatPrice(499, "USD", "en")).toBe("$4.99");
    expect(formatPrice(5, "XXX-bad", "en")).toContain("XXX-bad");
  });

  it("shows positive amounts in refund lines and keeps a staff removal's sign", () => {
    expect(historyLine({ at: "", kind: "purchase", amount: -300 })).toEqual({
      key: "site.shop.history.purchase",
      amount: 300,
    });
    expect(historyLine({ at: "", kind: "refund", amount: -100 }).amount).toBe(100);
    expect(historyLine({ at: "", kind: "pack", amount: 550 }).key).toBe("site.shop.history.pack");
    expect(historyLine({ at: "", kind: "grant", amount: -50 }).amount).toBe(-50);
  });

  it("finds sprites on the atlas pages", () => {
    const icons = iconsFrom(
      [
        {
          url: "http://x/atlas/atlas-0.json",
          data: {
            frames: { "outfits/sailor/s_0": { frame: { x: 64, y: 32, w: 32, h: 32 } } },
            meta: { image: "atlas-0.png", size: { w: 2048, h: 160 } },
          },
        },
      ],
      ["outfits/sailor/s_0", "outfits/missing/s_0"],
    );
    expect(icons.get("outfits/sailor/s_0")).toEqual({
      url: "http://x/atlas/atlas-0.png",
      x: 64,
      y: 32,
      width: 32,
      height: 32,
      pageWidth: 2048,
      pageHeight: 160,
    });
    expect(icons.has("outfits/missing/s_0")).toBe(false);
    expect(cssColor(0x0e2a44)).toBe("#0e2a44");
  });
});
