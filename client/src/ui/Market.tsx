// Market window (T5.3): opens when the player uses a market board. Search an item, see its
// best sell and buy offers by price and its reference price, buy from or sell to an
// offer, post offers (with the fee), take own offers down, withdraw the mailbox and read
// the own history. The server validates everything and answers each action with a fresh
// MarketUpdate. No hooks: the forms are uncontrolled and read their fields on submit, so
// the tests walk the element tree (Market.test.ts).
import type { JSX } from "preact";
import type { ClientContent, ItemDef, ItemMods } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { refinedName } from "../state/forge.ts";
import { rollsAttribute } from "../state/item-card.ts";
import { createProblem, marketCost, searchItems } from "../state/market.ts";
import { tipMods } from "../state/mods.ts";
import type { MarketView, OfferView } from "../state/market.ts";
import { ItemLabel } from "./Trade.tsx";

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Inside a GameWindow (the desktop): the frame's title bar names and closes it. */
  framed?: boolean | undefined;
}

/** The value of a named field of a submitted form ("" when missing). */
export function field(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  return el && "value" in el ? String(el.value) : "";
}

/** Shows a problem (i18n key, already translated) in the form's <output>, or clears it. */
function report(form: HTMLFormElement, text: string): void {
  const out = form.querySelector("output");
  if (out) out.textContent = text;
}

/**
 * An instance's attribute as a market line writes it ("+3 attack"; docs/02 "Atributos de
 * items"), the "no attribute" text for an instance without one, or the "retired" one for
 * an attribute no longer in the pool (it does nothing).
 */
export function attributeLine(
  t: Translate,
  content: ClientContent,
  mods: ItemMods | undefined,
): string {
  if (!mods || mods.attribute === "") return t("client.market.no_attribute");
  const a = content.attributes?.[mods.attribute];
  return a ? t(a.text, { value: mods.value }) : t("client.card.attribute_retired");
}

/**
 * One instance of item itemId as a picker option or an offer row names it: its attribute
 * (attributeLine) and, refined (the forge, docs/02 "Forja"), its refined name before it
 * ("+7 sword · +3 attack"), so two pieces of one roll at other levels never look alike.
 */
export function instanceLine(
  t: Translate,
  content: ClientContent,
  itemId: number,
  mods: ItemMods | undefined,
): string {
  const attribute = attributeLine(t, content, mods);
  const level = mods?.refine ?? 0;
  if (level <= 0) return attribute;
  const def = content.items[itemId];
  const name = refinedName(t, def ? t(`item.${def.id}.name`) : String(itemId), level);
  return t("client.market.refined_line", { name, attribute });
}

/**
 * The instance picker of an equipable (MarketUpdate.owned_mods, the lowest refine level
 * first): one option per instance the player could sell, by its level and attribute. Its
 * value is the index into ownedMods.
 */
function InstancePicker(props: Props & { itemId: number; owned: ItemMods[] }): JSX.Element {
  const { t } = props;
  return (
    <select name="instance" aria-label={t("client.market.instance")} data-testid="market-instance">
      {props.owned.map((m, i) => (
        <option key={i} value={String(i)}>
          {instanceLine(t, props.content, props.itemId, m)}
        </option>
      ))}
    </select>
  );
}

/**
 * The create form's side changed: its instance picker only counts when selling, so it
 * hides for a buy offer (the form is uncontrolled: the element itself is changed).
 */
function showPicker(side: {
  value: string;
  form: { elements: { namedItem(name: string): unknown } } | null;
}): void {
  const picker = side.form?.elements.namedItem("instance");
  if (picker && typeof picker === "object" && "hidden" in picker)
    picker.hidden = side.value === "buy";
}

/** The instance a form's picker chose (undefined: none to choose from). */
function pickedInstance(form: HTMLFormElement, owned: ItemMods[]): ItemMods | undefined {
  return owned[Math.floor(Number(field(form, "instance")))];
}

function expiresIn(t: Translate, at: number, now: number): string {
  const hours = Math.max(Math.ceil((at - now) / 3_600_000), 0);
  return t("client.market.hours_left", { hours });
}

function OfferTable(
  props: Props & { m: MarketView; offers: OfferView[]; sell: boolean; now: number },
): JSX.Element {
  const { t, game, offers, sell } = props;
  // Selling an equipable into a buy offer: one instance, the one the picker names.
  const equipable = rollsAttribute(props.content.items[props.m.itemId]);
  const pick = !sell && equipable;
  if (offers.length === 0) {
    return (
      <p class="empty" data-testid={sell ? "market-sells" : "market-buys"}>
        {t("client.market.no_offers")}
      </p>
    );
  }
  return (
    <ul class="offers" data-testid={sell ? "market-sells" : "market-buys"}>
      {offers.map((o) => (
        <li key={String(o.id)} data-offer={String(o.id)}>
          <span class="owner">{o.own ? t("client.market.own_mark") : o.owner}</span>
          {o.mods && (
            <span
              class="attribute card-attribute"
              data-tip-item={o.itemId}
              data-tip-count={o.amount}
              data-tip-mods={tipMods(o.mods)}
            >
              {instanceLine(t, props.content, o.itemId, o.mods)}
            </span>
          )}
          <span class="amount">{t("client.market.units", { count: o.amount })}</span>
          <span class="price">{t("client.market.each", { price: o.price })}</span>
          <span class="expires">{expiresIn(t, o.expiresAt, props.now)}</span>
          {!o.own && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pick) {
                  const mods = pickedInstance(e.currentTarget, props.m.ownedMods);
                  if (mods) game?.marketAccept(o.id, 1, mods);
                  return;
                }
                const n = Math.floor(Number(field(e.currentTarget, "amount")));
                if (n >= 1 && n <= o.amount) game?.marketAccept(o.id, n);
              }}
            >
              {pick ? (
                <InstancePicker {...props} itemId={props.m.itemId} owned={props.m.ownedMods} />
              ) : (
                <input
                  name="amount"
                  type="number"
                  min={1}
                  max={o.amount}
                  defaultValue="1"
                  aria-label={t("client.market.amount")}
                />
              )}
              <button
                type="submit"
                data-market-accept={String(o.id)}
                disabled={pick && props.m.ownedMods.length === 0}
              >
                {sell ? t("client.market.buy") : t("client.market.sell")}
              </button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

function nameOf(t: Translate, def: ItemDef): string {
  return t(`item.${def.id}.name`);
}

export function MarketWindow(props: Props & { now?: number }): JSX.Element | null {
  const { t, game, content } = props;
  const m = props.ui.market;
  if (!m) return null;
  const now = props.now ?? Date.now();
  const def = m.itemId ? content.items[m.itemId] : undefined;
  const equipable = rollsAttribute(def);
  const r = m.rules;
  const marketable = Object.entries(content.items).filter(([, d]) => d.marketable);
  return (
    <section
      class="market"
      data-testid={props.framed ? undefined : "market"}
      aria-label={t("client.market.title")}
    >
      {props.framed ? (
        <p class="market-money">
          <span class="money" data-testid="market-money">
            {t("client.shop.money", { money: m.money })}
          </span>
        </p>
      ) : (
        <header>
          <h2>{t("client.market.title")}</h2>
          <span class="money" data-testid="market-money">
            {t("client.shop.money", { money: m.money })}
          </span>
          <button
            type="button"
            class="close"
            aria-label={t("client.market.close")}
            title={t("client.market.close")}
            onClick={() => game?.marketClose()}
          >
            ×
          </button>
        </header>
      )}

      {m.readOnly && (
        <p class="read-only" data-testid="market-read-only" role="alert">
          {t("client.market.read_only")}
        </p>
      )}
      <form
        class="search"
        data-testid="market-search"
        onSubmit={(e) => {
          e.preventDefault();
          const q = field(e.currentTarget, "item");
          const found = searchItems(content.items, q, (d) => nameOf(t, d), 1)[0];
          report(e.currentTarget, found ? "" : t("client.market.not_found"));
          if (found) game?.marketBrowse(found.itemId);
        }}
      >
        <input
          name="item"
          list="market-items"
          placeholder={t("client.market.search")}
          aria-label={t("client.market.search")}
        />
        <datalist id="market-items">
          {marketable.map(([id, d]) => (
            <option key={id} value={nameOf(t, d)} />
          ))}
        </datalist>
        <button type="submit">{t("client.market.search_action")}</button>
        <output />
      </form>

      {def && (
        <div class="browse" data-testid="market-browse" data-item={def.id}>
          <h3>
            <ItemLabel
              t={t}
              content={content}
              game={game}
              itemId={m.itemId}
              count={1}
              anyInstance={true}
            />
          </h3>
          <p class="reference" data-testid="market-reference">
            {m.referencePrice > 0
              ? t("client.market.reference", { price: m.referencePrice })
              : t("client.market.no_reference")}
          </p>
          <h4>{t("client.market.sells")}</h4>
          <OfferTable {...props} m={m} offers={m.sells} sell={true} now={now} />
          <h4>{t("client.market.buys")}</h4>
          <OfferTable {...props} m={m} offers={m.buys} sell={false} now={now} />
          {/* Keyed by item: browsing another item starts a fresh form. Within one item the
              default price stays fixed (MarketView.priceDefault), so a refresh never rewrites
              a field the player left alone; what the player typed is kept either way. */}
          <form
            key={m.itemId}
            class="create"
            data-testid="market-create"
            onSubmit={(e) => {
              e.preventDefault();
              const f = e.currentTarget;
              const sell = field(f, "side") !== "buy";
              const amount = Math.floor(Number(field(f, "amount")));
              const price = Math.floor(Number(field(f, "price")));
              const problem = createProblem(m, sell, amount, price, equipable);
              if (problem) {
                report(f, t(problem, { cost: marketCost(r, sell, amount, price) }));
                return;
              }
              // An equipable is sold one instance at a time: the one the picker names.
              const mods = sell && equipable ? pickedInstance(f, m.ownedMods) : undefined;
              report(f, "");
              game?.marketCreate(sell, m.itemId, amount, price, Number(field(f, "duration")), mods);
            }}
          >
            <h4>{t("client.market.create")}</h4>
            <select
              name="side"
              aria-label={t("client.market.side")}
              onChange={(e) => showPicker(e.currentTarget)}
            >
              <option value="sell">{t("client.market.side_sell", { owned: m.owned })}</option>
              <option value="buy">{t("client.market.side_buy")}</option>
            </select>
            {equipable && m.ownedMods.length > 0 && (
              <InstancePicker {...props} itemId={m.itemId} owned={m.ownedMods} />
            )}
            <input
              name="amount"
              type="number"
              min={1}
              max={r.maxAmount}
              defaultValue="1"
              aria-label={t("client.market.amount")}
            />
            <input
              name="price"
              type="number"
              min={1}
              max={r.maxPrice}
              defaultValue={String(m.priceDefault)}
              aria-label={t("client.market.price")}
            />
            <select name="duration" aria-label={t("client.market.duration")}>
              {r.durationsHours.map((h, i) => (
                <option key={h} value={String(i)}>
                  {t("client.market.hours", { hours: h })}
                </option>
              ))}
            </select>
            <button type="submit">{t("client.market.post")}</button>
            <p class="fee">
              {t("client.market.fee_rule", {
                pct: r.feePermille / 10,
                min: r.feeMin,
                max: r.feeMax,
              })}
            </p>
            <output />
          </form>
        </div>
      )}

      <h3>{t("client.market.mine", { count: m.own.length, max: r.maxOffers })}</h3>
      {m.own.length === 0 ? (
        <p class="empty">{t("client.market.no_own")}</p>
      ) : (
        <ul class="own" data-testid="market-own">
          {m.own.map((o) => (
            <li key={String(o.id)} data-offer={String(o.id)}>
              <span class="mside">
                {o.sell ? t("client.market.selling") : t("client.market.buying")}
              </span>
              <ItemLabel
                t={t}
                content={content}
                game={game}
                itemId={o.itemId}
                count={o.amount}
                mods={o.mods}
                anyInstance={true}
              />
              {o.mods && (
                <span class="attribute card-attribute">{attributeLine(t, content, o.mods)}</span>
              )}
              <span class="price">{t("client.market.each", { price: o.price })}</span>
              <span class="expires">{expiresIn(t, o.expiresAt, now)}</span>
              <button
                type="button"
                data-market-cancel={String(o.id)}
                onClick={() => game?.marketCancel(o.id)}
              >
                {t("client.market.cancel")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>{t("client.market.mailbox")}</h3>
      <div class="mailbox" data-testid="market-mailbox">
        <p data-testid="market-mailbox-gold">
          {t("client.market.mailbox_gold", { gold: m.mailboxGold })}
        </p>
        {m.mailbox.length > 0 && (
          <ul>
            {m.mailbox.map((x) => (
              <li key={String(x.id)}>
                <ItemLabel
                  t={t}
                  content={content}
                  game={game}
                  itemId={x.itemId}
                  count={x.count}
                  mods={x.mods}
                />
                {x.mods && (
                  <span class="attribute card-attribute">{attributeLine(t, content, x.mods)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {m.mailboxMore > 0 && <p>{t("client.market.mailbox_more", { count: m.mailboxMore })}</p>}
        <button
          type="button"
          data-testid="market-withdraw"
          disabled={m.mailboxGold === 0 && m.mailbox.length === 0}
          onClick={() => game?.marketWithdraw()}
        >
          {t("client.market.withdraw")}
        </button>
      </div>

      <h3>{t("client.market.history")}</h3>
      {m.history.length === 0 ? (
        <p class="empty">{t("client.market.no_history")}</p>
      ) : (
        <ul class="history" data-testid="market-history">
          {m.history.map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <span class="mside">
                {h.sold ? t("client.market.sold") : t("client.market.bought")}
              </span>
              <ItemLabel
                t={t}
                content={content}
                game={game}
                itemId={h.itemId}
                count={h.amount}
                anyInstance={true}
              />
              <span class="price">{t("client.market.each", { price: h.price })}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
