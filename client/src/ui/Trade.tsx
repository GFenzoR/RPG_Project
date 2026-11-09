// Trade window (T5.3): two columns (own offer, the other's), the confirmations of both, and
// the tradeable items of the open containers to add. The server checks distance, items,
// room and every change; any change clears both confirmations. No hooks: the tests walk
// the element tree (Trade.test.ts).
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { TradeItemView, TradeView } from "../state/market.ts";

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}

/** A small item icon from the atlas (a two-letter box until the canvas is up). */
export function ItemLabel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  itemId: number;
  count: number;
}): JSX.Element {
  const { t, game, itemId, count } = props;
  const def = props.content.items[itemId];
  const name = def ? t(`item.${def.id}.name`) : String(itemId);
  const icon = game?.itemIcon(itemId);
  const style: JSX.CSSProperties = icon
    ? {
        backgroundImage: `url(${icon.url})`,
        backgroundPosition: `-${icon.x}px -${icon.y}px`,
        width: `${icon.width}px`,
        height: `${icon.height}px`,
      }
    : {};
  return (
    <span class="item-label" data-item={def?.id ?? itemId}>
      <span class={icon ? "item" : "item missing"} style={style} aria-hidden="true">
        {!icon && name.slice(0, 2)}
      </span>
      <span class="iname">{count > 1 ? t("client.trade.count", { count, name }) : name}</span>
    </span>
  );
}

function OfferList(
  props: Props & { items: TradeItemView[]; own: boolean; testid: string },
): JSX.Element {
  const { t, game, items, own } = props;
  if (items.length === 0) {
    return (
      <p class="empty" data-testid={props.testid}>
        {t("client.trade.nothing")}
      </p>
    );
  }
  return (
    <ul data-testid={props.testid}>
      {items.map((it, i) => (
        <li key={`${i}-${it.itemId}`}>
          <ItemLabel {...props} itemId={it.itemId} count={it.count} />
          {own && (
            <button
              type="button"
              class="remove"
              data-trade-remove={i}
              aria-label={t("client.trade.remove")}
              title={t("client.trade.remove")}
              onClick={() => game?.tradeRemove(i)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The tradeable items of the open containers, with their location for TradeOffer. */
function offerable(ui: GameUi, content: ClientContent) {
  const out: { container: number; index: number; itemId: number; count: number }[] = [];
  for (const c of ui.containers) {
    c.items.forEach((it, index) => {
      if (content.items[it.itemId]?.tradeable) {
        out.push({ container: c.id, index, itemId: it.itemId, count: it.count });
      }
    });
  }
  return out;
}

export function TradeWindow(props: Props): JSX.Element | null {
  const { t, game, ui } = props;
  const tr: TradeView | undefined = ui.trade;
  if (!tr) return null;
  if (tr.invited) {
    return (
      <section class="trade" data-testid="trade" aria-label={t("client.trade.title")}>
        <header>
          <h2>{t("client.trade.title")}</h2>
        </header>
        <p data-testid="trade-invitation">{t("client.trade.invited", { name: tr.partnerName })}</p>
        <OfferList {...props} items={tr.partner} own={false} testid="trade-partner" />
        <div class="actions">
          <button
            type="button"
            data-testid="trade-join"
            onClick={() => game?.tradeRequest(tr.partnerId)}
          >
            {t("client.trade.join")}
          </button>
          <button type="button" data-testid="trade-cancel" onClick={() => game?.tradeCancel()}>
            {t("client.trade.decline")}
          </button>
        </div>
      </section>
    );
  }
  const items = offerable(ui, props.content);
  const full = tr.own.length >= tr.maxItems;
  return (
    <section class="trade" data-testid="trade" aria-label={t("client.trade.title")}>
      <header>
        <h2>{t("client.trade.title")}</h2>
        <button
          type="button"
          class="close"
          aria-label={t("client.trade.cancel")}
          title={t("client.trade.cancel")}
          onClick={() => game?.tradeCancel()}
        >
          ×
        </button>
      </header>
      {!tr.negotiating && (
        <p class="waiting">{t("client.trade.waiting", { name: tr.partnerName })}</p>
      )}
      <div class="columns">
        <div class="column">
          <h3>
            {t("client.trade.yours")}{" "}
            <span class="state" data-testid="trade-own-state">
              {tr.ownAccepted ? t("client.trade.accepted") : t("client.trade.not_accepted")}
            </span>
          </h3>
          <OfferList {...props} items={tr.own} own={true} testid="trade-own" />
        </div>
        <div class="column">
          <h3>
            {tr.partnerName}{" "}
            <span class="state" data-testid="trade-partner-state">
              {tr.partnerAccepted ? t("client.trade.accepted") : t("client.trade.not_accepted")}
            </span>
          </h3>
          <OfferList {...props} items={tr.partner} own={false} testid="trade-partner" />
        </div>
      </div>
      <h3>{t("client.trade.add", { max: tr.maxItems })}</h3>
      {items.length === 0 ? (
        <p class="empty">{t("client.trade.open_backpack")}</p>
      ) : (
        <ul class="offerable" data-testid="trade-offerable">
          {items.map((it) => (
            <li key={`${it.container}-${it.index}`}>
              <ItemLabel {...props} itemId={it.itemId} count={it.count} />
              <button
                type="button"
                disabled={full}
                data-trade-add={props.content.items[it.itemId]?.id ?? it.itemId}
                onClick={() =>
                  game?.tradeOffer({
                    loc: { kind: "container", id: it.container, index: it.index },
                    itemId: it.itemId,
                    stackIndex: it.index,
                    count: it.count,
                  })
                }
              >
                {t("client.trade.offer")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="actions">
        <button
          type="button"
          data-testid="trade-accept"
          disabled={!tr.negotiating || tr.ownAccepted}
          onClick={() => game?.tradeAccept()}
        >
          {t("client.trade.accept")}
        </button>
        <button type="button" data-testid="trade-cancel" onClick={() => game?.tradeCancel()}>
          {t("client.trade.cancel")}
        </button>
      </div>
    </section>
  );
}
