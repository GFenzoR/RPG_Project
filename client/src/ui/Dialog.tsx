// NPC dialog and shop windows (T1.10). The dialog shows the NPC's text and the options
// the server sent; click one or press 1–9 (Escape closes). The shop opens from a dialog
// option and closes with it: buy and sell lines with their prices, the money carried and
// how many of each item the player owns. The server checks distance, money, room and
// conditions; this UI only sends intents.
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { ShopLine, ShopState } from "../state/world.ts";

/** Most units one purchase or sale may move (the server's limit too). */
const MAX_COUNT = 100;

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}

export function DialogWindow({ t, content, game, ui }: Props): JSX.Element | null {
  const d = ui.dialog;
  if (!d) return null;
  const npcName = d.npcContentId ? t(`npc.${d.npcContentId}.name`) : "";
  return (
    <div class="npc-windows">
      <section class="dialog" data-testid="dialog" role="dialog" aria-label={npcName}>
        <header>
          <h2>{npcName}</h2>
          <button
            type="button"
            class="close"
            aria-label={t("client.dialog.close")}
            title={t("client.dialog.close")}
            onClick={() => game?.closeDialog()}
          >
            ×
          </button>
        </header>
        <p class="npc-text">{t(d.text)}</p>
        <ol class="options">
          {d.options.map((o, i) => (
            <li key={o.id}>
              <button type="button" data-option={o.id} onClick={() => game?.chooseOption(o.id)}>
                <kbd>{i + 1}</kbd> {t(o.text)}
              </button>
            </li>
          ))}
        </ol>
      </section>
      {ui.shop && <ShopWindow t={t} content={content} game={game} shop={ui.shop} />}
    </div>
  );
}

function ShopWindow(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  shop: ShopState;
}): JSX.Element {
  const { t, shop } = props;
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const lines = shop.lines.filter((l) => (mode === "buy" ? l.buyPrice > 0 : l.sellPrice > 0));
  return (
    <section class="shop" data-testid="shop" aria-label={t("client.shop.title")}>
      <header>
        <h2>{t("client.shop.title")}</h2>
        <span class="money" data-testid="shop-money">
          {t("client.shop.money", { money: shop.money })}
        </span>
      </header>
      <div class="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "buy"}
          onClick={() => setMode("buy")}
        >
          {t("client.shop.buy")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "sell"}
          onClick={() => setMode("sell")}
        >
          {t("client.shop.sell")}
        </button>
      </div>
      {lines.length === 0 ? (
        <p class="empty">{t("client.shop.empty")}</p>
      ) : (
        <ul>
          {lines.map((l) => (
            <ShopRow key={`${mode}-${l.itemId}`} {...props} line={l} mode={mode} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ShopRow(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  shop: ShopState;
  line: ShopLine;
  mode: "buy" | "sell";
}): JSX.Element {
  const { t, game, line, mode } = props;
  const [count, setCount] = useState(1);
  const def = props.content.items[line.itemId];
  const name = def ? t(`item.${def.id}.name`) : String(line.itemId);
  const price = mode === "buy" ? line.buyPrice : line.sellPrice;
  const max = mode === "buy" ? MAX_COUNT : Math.min(line.owned, MAX_COUNT);
  const icon = game?.itemIcon(line.itemId);
  const style: JSX.CSSProperties = icon
    ? {
        backgroundImage: `url(${icon.url})`,
        backgroundPosition: `-${icon.x}px -${icon.y}px`,
        width: `${icon.width}px`,
        height: `${icon.height}px`,
      }
    : {};
  const disabled = max < 1 || (mode === "buy" && price * count > props.shop.money);
  return (
    <li data-item={def?.id ?? line.itemId}>
      <span class={icon ? "item" : "item missing"} style={style} aria-hidden="true">
        {!icon && name.slice(0, 2)}
      </span>
      <span class="iname">{name}</span>
      <span class="price">{t("client.shop.price", { price })}</span>
      {mode === "sell" && (
        <span class="owned">{t("client.shop.owned", { count: line.owned })}</span>
      )}
      <input
        type="number"
        min={1}
        max={Math.max(max, 1)}
        value={count}
        aria-label={t("client.shop.count", { name })}
        onInput={(e) => {
          const n = Math.floor(Number(e.currentTarget.value));
          setCount(Number.isFinite(n) ? Math.min(Math.max(n, 1), Math.max(max, 1)) : 1);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          mode === "buy" ? game?.shopBuy(line.itemId, count) : game?.shopSell(line.itemId, count)
        }
      >
        {mode === "buy" ? t("client.shop.buy_action") : t("client.shop.sell_action")}
      </button>
    </li>
  );
}
