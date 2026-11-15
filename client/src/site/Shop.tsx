// Cosmetic shop page (T5.7): /shop, signed in only. The balance, the premium currency packs
// (bought on the payment provider's hosted checkout: the browser goes to the URL the server
// gives and comes back to /shop?checkout=…), the catalogue (bought with premium currency)
// and the history. Looks only: nothing here gives an advantage in the game (docs/02).
// The server decides everything; the page only shows and asks.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CosmeticDef, CosmeticKind, SiteContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, shopApi } from "../net/api.ts";
import type { ShopCosmetic, ShopState } from "../net/api.ts";
import {
  COSMETIC_KINDS,
  NAME_EFFECTS,
  cosmeticDescKey,
  cosmeticNameKey,
  packNameKey,
} from "../render/cosmetics.ts";
import { SiteLogin } from "./Maps.tsx";
import {
  CHECKOUT_NOTICE,
  checkoutReturn,
  cssColor,
  formatPrice,
  historyLine,
  isLocalCheckout,
  loadIcons,
  shopErrorKey,
} from "./shop.ts";
import type { SpriteIcon } from "./shop.ts";

interface Props {
  t: Translate;
  lang: string;
  site: SiteContent;
  search: string;
}

const codeOf = (e: unknown): string => (e instanceof ApiError ? e.code : "network");

/** The south-facing standing frame of an outfit (the shop's preview). */
const previewSprite = (site: SiteContent, c: CosmeticDef): string | undefined => {
  const o = site.outfits?.find((x) => x.id === c.outfit);
  return o ? `${o.sprite}/s_0` : undefined;
};

/** Previews scale the 32 px sprites by this (pixel-perfect). */
const PREVIEW_SCALE = 2;

function Preview(props: {
  def: CosmeticDef | undefined;
  icon: SpriteIcon | undefined;
  name: string;
}): JSX.Element | null {
  const { def, icon } = props;
  if (!def) return null;
  if (def.kind === "outfit" && icon) {
    const k = PREVIEW_SCALE;
    return (
      <span
        class="shop-preview sprite"
        aria-hidden="true"
        style={{
          width: `${icon.width * k}px`,
          height: `${icon.height * k}px`,
          backgroundImage: `url("${icon.url}")`,
          backgroundSize: `${icon.pageWidth * k}px ${icon.pageHeight * k}px`,
          backgroundPosition: `-${icon.x * k}px -${icon.y * k}px`,
        }}
      />
    );
  }
  if (def.kind === "outfit_color" && def.tint)
    return <span class="shop-preview swatch" aria-hidden="true" style={{ background: def.tint }} />;
  const fx = def.style ? NAME_EFFECTS[def.style] : undefined;
  if (def.kind === "name_effect" && fx)
    return (
      <span
        class="shop-preview name-sample"
        aria-hidden="true"
        style={{
          color: cssColor(fx.fill),
          textShadow: `0 0 4px ${cssColor(fx.glow)}, 1px 1px 0 ${cssColor(fx.stroke.color)}, -1px -1px 0 ${cssColor(fx.stroke.color)}`,
        }}
      >
        {props.name}
      </span>
    );
  return null;
}

export function ShopPage(props: Props): JSX.Element {
  const { t, lang } = props;
  const [state, setState] = useState<ShopState | "login" | string | undefined>(undefined);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const [icons, setIcons] = useState<Map<string, SpriteIcon>>(new Map());
  const [returned] = useState(() => checkoutReturn(props.search));
  const reload = (): void => setRound((r) => r + 1);
  useEffect(() => {
    shopApi.state().then(setState, (e: unknown) => {
      const code = codeOf(e);
      setState(code === "unauthorized" ? "login" : code);
    });
  }, [round]);
  // The checkout's way back (/shop?checkout=…): show its notice once, drop the query.
  useEffect(() => {
    if (returned) history.replaceState(history.state, "", location.pathname);
  }, [returned]);
  useEffect(() => {
    let live = true;
    const names = (props.site.cosmetics ?? []).flatMap((c) => {
      const s = c.kind === "outfit" ? previewSprite(props.site, c) : undefined;
      return s ? [s] : [];
    });
    if (names.length > 0)
      loadIcons(names).then(
        (m) => live && setIcons(m),
        () => {}, // no previews: the names still say what each one is
      );
    return () => {
      live = false;
    };
  }, [props.site]);

  if (state === undefined) return <p class="muted">{t("site.shop.loading")}</p>;
  if (state === "login")
    return <SiteLogin t={t} onDone={reload} hint={t("site.shop.login_required")} />;
  if (typeof state === "string")
    return (
      <p class="error" role="alert">
        {t(shopErrorKey(state))}
      </p>
    );

  const amount = (n: number): string => t("premium.amount", { count: n });
  const defOf = (id: string): CosmeticDef | undefined =>
    props.site.cosmetics?.find((c) => c.id === id);
  const fail = (e: unknown): void => {
    setError(t(shopErrorKey(codeOf(e))));
    setBusy(undefined);
  };
  const checkout = (packId: string): void => {
    setBusy(packId);
    setError(undefined);
    setDone(undefined);
    shopApi
      .checkout(packId, lang)
      .then(async (r) => {
        if (!isLocalCheckout(r.url)) {
          location.assign(r.url);
          return;
        }
        // The fake provider (development and tests): pay it here, then come back the
        // way a real provider would.
        await shopApi.payLocal(r.url);
        location.assign("/shop?checkout=success");
      })
      .catch(fail);
  };
  const buy = (c: ShopCosmetic): void => {
    const name = t(cosmeticNameKey(c.id));
    if (!window.confirm(t("site.shop.buy_confirm", { name, amount: amount(c.price) }))) return;
    setBusy(c.id);
    setError(undefined);
    setDone(undefined);
    shopApi.buy(c.id).then(() => {
      setBusy(undefined);
      setDone(t("site.shop.bought", { name }));
      reload();
    }, fail);
  };
  const byKind = (k: CosmeticKind): ShopCosmetic[] => state.cosmetics.filter((c) => c.kind === k);
  const when = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section class="shop-page" data-testid="shop-page">
      <header class="card shop-head">
        <div>
          <h1>{t("site.shop.title")}</h1>
          <p class="muted">{t("site.shop.intro")}</p>
        </div>
        <p class="shop-balance">
          <span class="muted">{t("site.shop.balance")}</span>
          <strong data-testid="shop-balance" data-balance={state.balance}>
            {amount(state.balance)}
          </strong>
        </p>
      </header>
      {returned && (
        <p
          class={returned === "failure" ? "error" : "notice"}
          role="status"
          data-testid="shop-return"
          data-checkout={returned}
        >
          {t(CHECKOUT_NOTICE[returned])}
        </p>
      )}
      {!state.enabled && (
        <p class="notice" data-testid="shop-disabled">
          {t("site.shop.disabled")}
        </p>
      )}
      {state.blocked && (
        <p class="error" role="alert" data-testid="shop-blocked">
          {t("site.shop.error.suspended")}
        </p>
      )}
      {error && (
        <p class="error" role="alert" data-testid="shop-error">
          {error}
        </p>
      )}
      {done && (
        <p class="notice" role="status" data-testid="shop-done">
          {done}
        </p>
      )}
      {state.enabled && state.packs.length > 0 && (
        <section class="card" aria-labelledby="shop-packs-title">
          <h2 id="shop-packs-title">{t("site.shop.packs.title")}</h2>
          <ul class="shop-packs">
            {state.packs.map((p) => (
              <li key={p.id} data-pack={p.id}>
                <span class="shop-pack-name">{t(packNameKey(p.id))}</span>
                <strong class="shop-pack-amount">{amount(p.amount)}</strong>
                <span class="shop-pack-price">{formatPrice(p.price, p.currency, lang)}</span>
                <button
                  type="button"
                  disabled={busy !== undefined || state.blocked}
                  data-testid={`buy-pack-${p.id}`}
                  onClick={() => checkout(p.id)}
                >
                  {busy === p.id ? t("site.shop.packs.redirecting") : t("site.shop.packs.buy")}
                </button>
              </li>
            ))}
          </ul>
          <p class="muted small">{t("site.shop.packs.note")}</p>
        </section>
      )}
      <section class="card" aria-labelledby="shop-catalog-title">
        <h2 id="shop-catalog-title">{t("site.shop.catalog.title")}</h2>
        <p class="muted small">{t("site.shop.equip_hint")}</p>
        {COSMETIC_KINDS.map((k) => {
          const list = byKind(k);
          if (list.length === 0) return null;
          return (
            <div class="shop-kind" key={k} data-kind={k}>
              <h3>{t(`site.shop.kind.${k}`)}</h3>
              <ul class="shop-catalog">
                {list.map((c) => {
                  const name = t(cosmeticNameKey(c.id));
                  const def = defOf(c.id);
                  const sprite = def && previewSprite(props.site, def);
                  return (
                    <li key={c.id} data-cosmetic={c.id} data-owned={c.owned ? "" : undefined}>
                      <Preview
                        def={def}
                        icon={sprite ? icons.get(sprite) : undefined}
                        name={name}
                      />
                      <div class="shop-item-text">
                        <h4>{name}</h4>
                        <p class="muted">{t(cosmeticDescKey(c.id))}</p>
                        <p class="shop-price">
                          {t("site.shop.price", { amount: amount(c.price) })}
                        </p>
                      </div>
                      {c.owned ? (
                        <span class="badge status-approved shop-owned">{t("site.shop.owned")}</span>
                      ) : (
                        state.enabled && (
                          <button
                            type="button"
                            disabled={busy !== undefined || state.blocked}
                            data-testid={`buy-${c.id}`}
                            onClick={() => buy(c)}
                          >
                            {t("site.shop.buy")}
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>
      <section class="card" aria-labelledby="shop-history-title">
        <h2 id="shop-history-title">{t("site.shop.history.title")}</h2>
        {state.history.length === 0 ? (
          <p class="muted">{t("site.shop.history.empty")}</p>
        ) : (
          <ul class="shop-history" data-testid="shop-history">
            {state.history.map((h, i) => {
              const line = historyLine(h);
              const text = t(line.key, {
                amount: amount(line.amount),
                name: h.cosmetic_id ? t(cosmeticNameKey(h.cosmetic_id)) : "",
                pack: h.pack_id ? t(packNameKey(h.pack_id)) : "",
              });
              return (
                <li key={`${h.at}-${i}`} data-kind={h.kind}>
                  <time dateTime={h.at}>{when.format(new Date(h.at))}</time>
                  <span>{text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
