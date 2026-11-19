// Trade window (T5.3): two columns (own offer, the other's), the confirmations of both, and
// the tradeable items of the open containers and of the pockets to add. The server checks distance, items,
// room and every change; any change clears both confirmations. No hooks: the tests walk
// the element tree (Trade.test.ts).
import type { JSX } from "preact";
import type { ClientContent, ItemMods } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { TradeItemView, TradeView } from "../state/market.ts";
import { refinedName } from "../state/forge.ts";
import { tipMods } from "../state/mods.ts";
import { locKey } from "../state/items.ts";
import { pocketOffers } from "../state/pockets.ts";
import type { Offerable } from "../state/pockets.ts";

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Inside a GameWindow (the desktop): the frame's title bar names and closes it. */
  framed?: boolean | undefined;
}

/** A small item icon from the atlas (a two-letter box until the canvas is up). */
export function ItemLabel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  itemId: number;
  count: number;
  /** The instance's mods (an equipable's attribute): its card shows them. */
  mods?: ItemMods | undefined;
  /**
   * Without mods, it stands for any instance someone else picks (the market: a search, a
   * buy offer, the history): its card says each piece has its own attribute, not that it
   * rolls one.
   */
  anyInstance?: boolean | undefined;
}): JSX.Element {
  const { t, game, itemId, count } = props;
  const def = props.content.items[itemId];
  const base = def ? t(`item.${def.id}.name`) : String(itemId);
  // A refined instance (the forge, docs/02 "Forja") is named with its level: "+7 sword".
  const name = refinedName(t, base, props.mods?.refine);
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
    <span
      class="item-label"
      data-item={def?.id ?? itemId}
      data-tip-item={itemId}
      data-tip-count={count}
      data-tip-mods={tipMods(props.mods)}
      data-tip-any={props.anyInstance && !props.mods ? "" : undefined}
    >
      <span class={icon ? "item" : "item missing"} style={style} aria-hidden="true">
        {!icon && base.slice(0, 2)}
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
          <ItemLabel {...props} itemId={it.itemId} count={it.count} mods={it.mods} />
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

/**
 * The tradeable items the player sees, with their location for TradeOffer: the equipped
 * backpack under the figure first (docs/17 UI-5), then the pockets (docs/02 "Bolsillos"),
 * then the other open containers.
 */
export function offerable(ui: GameUi, content: ClientContent): Offerable[] {
  const out: Offerable[] = [];
  const add = (c: GameUi["containers"][number]): void =>
    c.items.forEach((it, index) => {
      if (content.items[it.itemId]?.tradeable)
        out.push({
          ref: {
            loc: { kind: "container", id: c.id, index },
            itemId: it.itemId,
            stackIndex: index,
            count: it.count,
          },
          itemId: it.itemId,
          count: it.count,
          mods: it.mods,
        });
    });
  if (ui.backpack) add(ui.backpack);
  out.push(...pocketOffers(ui.pockets, content));
  for (const c of ui.containers) add(c);
  return out;
}

export function TradeWindow(props: Props): JSX.Element | null {
  const { t, game, ui } = props;
  const tr: TradeView | undefined = ui.trade;
  if (!tr) return null;
  if (tr.invited) {
    return (
      <section
        class="trade"
        data-testid={props.framed ? undefined : "trade"}
        aria-label={t("client.trade.title")}
      >
        {!props.framed && (
          <header>
            <h2>{t("client.trade.title")}</h2>
          </header>
        )}
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
    <section
      class="trade"
      data-testid={props.framed ? undefined : "trade"}
      aria-label={t("client.trade.title")}
    >
      {!props.framed && (
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
      )}
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
            <li key={locKey(it.ref.loc)}>
              <ItemLabel {...props} itemId={it.itemId} count={it.count} mods={it.mods} />
              <button
                type="button"
                disabled={full}
                data-trade-add={props.content.items[it.itemId]?.id ?? it.itemId}
                onClick={() => game?.tradeOffer(it.ref)}
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
