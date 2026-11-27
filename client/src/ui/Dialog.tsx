// NPC dialog and shop windows (T1.10; redone without scrolling in docs/17 UI-8).
//
// The dialog: the NPC's portrait, name and text, and its options as a grid of buttons
// grouped by topic (quests, trade, travel, services, talk: an icon and a coloured edge
// each, state/dialog.ts), numbered 1–9; "Back" (0) and "Goodbye" (Escape) on their own row.
// With ten options or more a field filters them. The shop opens from a dialog option and
// closes with it: a window of its own with Buy and Sell tabs, category filters, a search,
// a grid of items (pages instead of a scroll bar) and a bar at the bottom with the chosen
// item, the count (−, field, +, Max), the total and the money. The server checks distance,
// money, room and conditions; this UI only sends intents.
//
// DialogView and ShopView are plain functions without hooks (Dialog.test.ts walks their
// trees); DialogBox and ShopWindow hold the little state they need.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent, DialogTopic } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { formatMessage } from "../state/messages.ts";
import type { DialogState, ShopLine, ShopState } from "../state/world.ts";
import {
  FILTER_FROM,
  dialogLayout,
  filterButtons,
  typedLength,
  typedParts,
} from "../state/dialog.ts";
import { typingInField } from "../input/keyboard.ts";
import { motionReduced } from "../state/ui-prefs.ts";
import type { DialogLayout, DialogOption } from "../state/dialog.ts";
import {
  filterShop,
  shopCount,
  shopFilters,
  shopGrid,
  shopLines,
  shopMax,
  shopPage,
} from "../state/shop.ts";
import type { ShopFilter, ShopMode } from "../state/shop.ts";
import { itemCard } from "../state/item-card.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { BigIcon, typeText } from "./ItemCard.tsx";
import type { IconRect } from "./ItemCard.tsx";

/** The NPC's portrait fits this square (ItemCard.tsx bigIconScale). */
export const PORTRAIT_PX = 64;

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** A phone or tablet (layout.ts): the shop's grid takes the screen's width. */
  compact?: boolean | undefined;
  /**
   * Inside a GameWindow (the desktop, docs/17 UI-5): its title bar names the NPC or the
   * shop and closes it, so the window's own header goes.
   */
  framed?: boolean | undefined;
}

/** The icon of each topic (ui/icons.tsx). */
const TOPIC_ICON: Record<DialogTopic, IconName> = {
  quests: "quest",
  trade: "market",
  travel: "travel",
  services: "services",
  talk: "talk",
  back: "talk",
  bye: "talk",
};

const FILTER_ICON: Record<ShopFilter, IconName> = {
  all: "inventory",
  weapons: "battle",
  armor: "guild",
  tools: "options",
  consumables: "services",
  materials: "market",
};

export function DialogWindow(props: Props): JSX.Element | null {
  const d = props.ui.dialog;
  if (!d) return null;
  return (
    <div class="npc-windows" data-shop={props.ui.shop ? "" : undefined}>
      {/* A new node starts with an empty filter. */}
      <DialogBox key={`${d.id}:${d.text}`} {...props} dialog={d} />
      {props.ui.shop && <ShopWindow key={props.ui.shop.dialogId} {...props} shop={props.ui.shop} />}
    </div>
  );
}

/**
 * The dialog with its filter and the NPC's words appearing letter by letter (docs/17 UI-8:
 * 90 a second; a click on them or Space shows them whole, and with reduced motion they are
 * whole from the start). A new node starts both again: key it by the node.
 */
export function DialogBox(props: Props & { dialog: DialogState }): JSX.Element {
  const [query, setQuery] = useState("");
  const d = props.dialog;
  const sprite = d.npcContentId ? props.content.npcSprites?.[d.npcContentId] : undefined;
  const length = [...props.t(d.text, { name: props.ui.selfName })].length;
  const [start] = useState(() => performance.now());
  const [now, setNow] = useState(start);
  const [whole, setWhole] = useState(() => motionReduced(document.documentElement));
  const typed = whole ? length : typedLength(length, now - start);
  const typing = typed < length;
  useEffect(() => {
    if (!typing) return undefined;
    const timer = setInterval(() => setNow(performance.now()), TYPE_TICK_MS);
    // Space shows the words whole (a focused button keeps Space for itself).
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat || typingInField(e)) return;
      if (document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      setWhole(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [typing]);
  return (
    <DialogView
      t={props.t}
      content={props.content}
      dialog={d}
      selfName={props.ui.selfName}
      portrait={sprite ? props.game?.spriteIcon(sprite) : undefined}
      query={query}
      onQuery={setQuery}
      choose={(id) => props.game?.chooseOption(id)}
      close={() => props.game?.closeDialog()}
      framed={props.framed}
      typed={typed}
      onSkip={() => setWhole(true)}
    />
  );
}

/** How often the words that appear are drawn again, ms (90 a second: ~3 a tick). */
const TYPE_TICK_MS = 33;

/** The dialog window as a plain function (no hooks: Dialog.test.ts walks it). */
export function DialogView(props: {
  t: Translate;
  content: ClientContent;
  dialog: DialogState;
  selfName: string;
  portrait: IconRect | undefined;
  query: string;
  onQuery(q: string): void;
  choose(optionId: number): void;
  close(): void;
  /** Inside a GameWindow: no header of its own (the frame's title bar). */
  framed?: boolean | undefined;
  /** How many characters of the NPC's words show yet (undefined: all of them). */
  typed?: number | undefined;
  /** A click on the words while they appear: show them whole. */
  onSkip?: (() => void) | undefined;
}): JSX.Element {
  const { t, content, dialog: d } = props;
  // Greetings say the player's name ({name} in the npcs.yaml catalogs).
  const said = t(d.text, { name: props.selfName });
  const parts = typedParts(said, props.typed ?? Number.POSITIVE_INFINITY);
  const npcName = d.npcContentId ? t(`npc.${d.npcContentId}.name`) : "";
  const layout: DialogLayout = dialogLayout(content, d);
  // An option may carry parameters: a blessing's {price} (content audit M6).
  const text = (o: DialogOption): string =>
    formatMessage({ key: o.text, params: o.params, at: 0 }, content, t);
  const shown = filterButtons(layout.grid, props.query, text);
  return (
    <section
      class="dialog"
      // Framed, the GameWindow carries the test id (and the NPC's name as its heading).
      data-testid={props.framed ? undefined : "dialog"}
      role={props.framed ? undefined : "dialog"}
      aria-label={props.framed ? undefined : npcName}
    >
      {!props.framed && (
        <header data-sheet-head="">
          <h2>{npcName}</h2>
          <button
            type="button"
            class="close"
            aria-label={t("client.dialog.close")}
            title={t("client.dialog.close")}
            onClick={() => props.close()}
          >
            ×
          </button>
        </header>
      )}
      <div class="dialog-body">
        {props.portrait && (
          <span class="npc-portrait">
            <BigIcon icon={props.portrait} fit={PORTRAIT_PX} />
          </span>
        )}
        {parts.rest ? (
          // Appearing: the rest waits invisible (the box keeps its final size) and screen
          // readers get the whole text at once.
          <p
            class="npc-text"
            data-typing=""
            title={t("client.dialog.skip")}
            onClick={() => props.onSkip?.()}
          >
            <span class="visually-hidden">{said}</span>
            <span aria-hidden="true">
              {parts.shown}
              <span class="npc-rest">{parts.rest}</span>
            </span>
          </p>
        ) : (
          <p class="npc-text">{said}</p>
        )}
      </div>
      {layout.grid.length >= FILTER_FROM && (
        <input
          type="search"
          class="dialog-filter"
          data-testid="dialog-filter"
          placeholder={t("client.dialog.filter")}
          aria-label={t("client.dialog.filter")}
          value={props.query}
          onInput={(e) => props.onQuery(e.currentTarget.value)}
        />
      )}
      <ul class="dialog-options" aria-label={t("client.dialog.options")}>
        {shown.map((b) => (
          <li key={b.option.id}>
            <button
              type="button"
              class={`dialog-option topic-${b.topic}`}
              data-option={b.option.id}
              data-topic={b.topic}
              title={`${t(`client.dialog.topic.${b.topic}`)}: ${text(b.option)}`}
              onClick={() => props.choose(b.option.id)}
            >
              {b.key !== undefined ? <kbd>{b.key}</kbd> : <kbd class="none" />}
              <Icon name={TOPIC_ICON[b.topic]} class="topic-icon" />
              <span class="otext">{text(b.option)}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li class="empty">{t("client.dialog.no_match")}</li>}
      </ul>
      <div class="dialog-foot">
        {layout.back && (
          <button
            type="button"
            class="dialog-back"
            data-option={layout.back.id}
            data-topic="back"
            onClick={() => layout.back && props.choose(layout.back.id)}
          >
            <kbd>0</kbd> {text(layout.back)}
          </button>
        )}
        <button
          type="button"
          class="dialog-bye"
          data-option={layout.bye?.id}
          data-topic="bye"
          data-testid="dialog-bye"
          onClick={() => (layout.bye ? props.choose(layout.bye.id) : props.close())}
        >
          <kbd>{t("client.toolbar.key_escape")}</kbd>{" "}
          {layout.bye ? text(layout.bye) : t("client.dialog.bye")}
        </button>
      </div>
    </section>
  );
}

/** What the shop window remembers while it is open. */
export interface ShopUiState {
  mode: ShopMode;
  filter: ShopFilter;
  query: string;
  page: number;
  /** The chosen item (its id) and the count asked for. */
  selected: number | undefined;
  count: number;
}

export const SHOP_START: ShopUiState = {
  mode: "buy",
  filter: "all",
  query: "",
  page: 0,
  selected: undefined,
  count: 1,
};

/** The shop with its tab, filter, search, page, chosen item and count. */
export function ShopWindow(props: Props & { shop: ShopState }): JSX.Element {
  const [s, setS] = useState<ShopUiState>(SHOP_START);
  const grid = shopGrid(window.innerWidth, window.innerHeight, props.compact === true);
  // The grid fills its row with as many cells as the window's width takes (a narrow map
  // beside the dialog takes fewer); a page holds that many columns by the rows that fit.
  const [columns, setColumns] = useState(grid.columns);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => () => observer.current?.disconnect(), []);
  const gridRef = (el: HTMLUListElement | null): void => {
    observer.current?.disconnect();
    if (!el) return;
    const count = (): void => {
      const n = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length;
      if (n > 0) setColumns(Math.min(n, grid.columns));
    };
    observer.current = new ResizeObserver(count);
    observer.current.observe(el);
    count();
  };
  return (
    <ShopView
      t={props.t}
      content={props.content}
      shop={props.shop}
      state={s}
      perPage={Math.min(columns, grid.columns) * grid.rows}
      columns={grid.columns}
      gridRef={gridRef}
      icon={(id) => props.game?.itemIcon(id)}
      level={props.ui.stats?.level}
      vocation={props.ui.vocation}
      set={(patch) => setS((old) => ({ ...old, ...patch }))}
      buy={(id, n) => props.game?.shopBuy(id, n)}
      sell={(id, n) => props.game?.shopSell(id, n)}
      card={(id, x, y) => props.game?.openCardMenu(id, x, y)}
      framed={props.framed}
    />
  );
}

/** The shop window as a plain function (no hooks: Dialog.test.ts walks it). */
export function ShopView(props: {
  t: Translate;
  content: ClientContent;
  shop: ShopState;
  state: ShopUiState;
  perPage: number;
  /** The most columns the grid takes (it shows fewer when the window is narrow). */
  columns: number;
  /** The grid element (ShopWindow counts its columns). */
  gridRef?: ((el: HTMLUListElement | null) => void) | undefined;
  icon(itemId: number): IconRect | undefined;
  level?: number | undefined;
  vocation?: string | undefined;
  set(patch: Partial<ShopUiState>): void;
  buy(itemId: number, count: number): void;
  sell(itemId: number, count: number): void;
  /** Right click on a cell: the item's card. */
  card(itemId: number, x: number, y: number): void;
  /** Inside a GameWindow: the money goes beside the tabs, no header of its own. */
  framed?: boolean | undefined;
}): JSX.Element {
  const { t, content, shop, state: s } = props;
  const nameOf = (id: number): string => {
    const def = content.items[id];
    return def ? t(`item.${def.id}.name`) : String(id);
  };
  const tab = shopLines(shop.lines, s.mode);
  const filters = shopFilters(tab, content.items);
  const filter = filters.includes(s.filter) ? s.filter : "all";
  const list = filterShop(tab, content.items, filter, s.query, nameOf);
  const page = shopPage(list, s.page, props.perPage);
  const line: ShopLine | undefined = tab.find((l) => l.itemId === s.selected);
  const price = line ? (s.mode === "buy" ? line.buyPrice : line.sellPrice) : 0;
  const max = line ? shopMax(s.mode, line, shop.money) : 0;
  const count = Math.min(Math.max(1, s.count), Math.max(1, max));
  const total = price * count;
  const short = s.mode === "buy" && line !== undefined && total > shop.money;
  const can = line !== undefined && max >= 1 && !short;
  const act = (): void => {
    if (!line || !can) return;
    if (s.mode === "buy") props.buy(line.itemId, count);
    else props.sell(line.itemId, count);
  };
  const tabButton = (mode: ShopMode, key: string): JSX.Element => (
    <button
      type="button"
      role="tab"
      data-shop-tab={mode}
      aria-selected={s.mode === mode}
      onClick={() => props.set({ mode, page: 0, selected: undefined, count: 1 })}
    >
      {t(key)}
    </button>
  );
  const money = (
    <span class="money" data-testid="shop-money">
      {t("client.shop.money", { money: shop.money })}
    </span>
  );
  const card = line
    ? itemCard(content.items[line.itemId], line.itemId, 1, {
        level: props.level,
        vocation: props.vocation,
      })
    : undefined;
  return (
    <section
      class="shop"
      data-testid={props.framed ? undefined : "shop"}
      aria-label={t("client.shop.title")}
    >
      {!props.framed && (
        <header data-sheet-head="">
          <h2>{t("client.shop.title")}</h2>
          {money}
        </header>
      )}
      <div class="shop-top">
        <div class="tabs" role="tablist">
          {tabButton("buy", "client.shop.buy")}
          {tabButton("sell", "client.shop.sell")}
        </div>
        <input
          type="search"
          class="shop-search"
          data-testid="shop-search"
          placeholder={t("client.shop.search")}
          aria-label={t("client.shop.search")}
          value={s.query}
          onInput={(e) => props.set({ query: e.currentTarget.value, page: 0 })}
        />
        {props.framed && money}
      </div>
      {filters.length > 2 && (
        <div class="shop-filters" role="group" aria-label={t("client.shop.categories")}>
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              data-filter={f}
              aria-pressed={filter === f}
              title={t(`client.shop.category.${f}`)}
              onClick={() => props.set({ filter: f, page: 0 })}
            >
              <Icon name={FILTER_ICON[f]} />
              <span>{t(`client.shop.category.${f}`)}</span>
            </button>
          ))}
        </div>
      )}
      {page.items.length === 0 ? (
        <p class="empty">{t(s.query ? "client.shop.no_match" : "client.shop.empty")}</p>
      ) : (
        <ul
          class="shop-grid"
          data-testid="shop-grid"
          ref={props.gridRef ?? null}
          style={{ "--shop-columns": String(props.columns) }}
        >
          {page.items.map((l) => {
            const def = content.items[l.itemId];
            const linePrice = s.mode === "buy" ? l.buyPrice : l.sellPrice;
            const none = s.mode === "sell" && l.owned <= 0;
            return (
              <li key={`${s.mode}-${l.itemId}`} data-item={def?.id ?? l.itemId}>
                <button
                  type="button"
                  class={none ? "shop-cell none" : "shop-cell"}
                  aria-pressed={l.itemId === s.selected}
                  aria-label={`${nameOf(l.itemId)}: ${t("client.shop.price", { price: linePrice })}`}
                  data-tip-item={l.itemId}
                  onClick={() => props.set({ selected: l.itemId, count: 1 })}
                  onDblClick={() => {
                    // A double click buys (sells) one at once.
                    props.set({ selected: l.itemId, count: 1 });
                    if (s.mode === "buy" && linePrice <= shop.money) props.buy(l.itemId, 1);
                    if (s.mode === "sell" && l.owned > 0) props.sell(l.itemId, 1);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    props.card(l.itemId, e.clientX, e.clientY);
                  }}
                >
                  <BigIcon icon={props.icon(l.itemId)} />
                  {!props.icon(l.itemId) && (
                    <span class="missing-name">{nameOf(l.itemId).slice(0, 2)}</span>
                  )}
                  {s.mode === "sell" && (
                    <span class="owned" title={t("client.shop.owned", { count: l.owned })}>
                      ×{l.owned}
                    </span>
                  )}
                  <span class="price">{t("client.shop.price", { price: linePrice })}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {page.pages > 1 && (
        <nav class="shop-pages" aria-label={t("client.shop.pages")}>
          <button
            type="button"
            data-testid="shop-prev"
            disabled={page.page === 0}
            aria-label={t("client.shop.prev")}
            onClick={() => props.set({ page: page.page - 1 })}
          >
            ‹
          </button>
          <span>{t("client.shop.page", { page: page.page + 1, pages: page.pages })}</span>
          <button
            type="button"
            data-testid="shop-next"
            disabled={page.page >= page.pages - 1}
            aria-label={t("client.shop.next")}
            onClick={() => props.set({ page: page.page + 1 })}
          >
            ›
          </button>
        </nav>
      )}
      <form
        class="shop-bar"
        data-testid="shop-bar"
        onSubmit={(e) => {
          // Enter in the count confirms.
          e.preventDefault();
          act();
        }}
      >
        {line && card ? (
          <>
            <div class="shop-pick" data-item={card.id}>
              <BigIcon icon={props.icon(line.itemId)} />
              <div>
                <strong class="card-name">{nameOf(line.itemId)}</strong>
                <span class="card-type">{typeText(t, card)}</span>
              </div>
            </div>
            <div class="shop-count">
              <button
                type="button"
                data-testid="shop-minus"
                aria-label={t("client.shop.less")}
                disabled={count <= 1}
                onClick={() => props.set({ count: count - 1 })}
              >
                −
              </button>
              <input
                type="number"
                min={1}
                max={Math.max(1, max)}
                value={count}
                data-testid="shop-count"
                aria-label={t("client.shop.count", { name: nameOf(line.itemId) })}
                onInput={(e) => {
                  const el = e.currentTarget;
                  if (el.value === "") return; // being retyped: the count stays until a number
                  const n = shopCount(el.value, max);
                  props.set({ count: n });
                  // Over the limit: show what a click buys (the state may not change).
                  if (String(n) !== el.value) el.value = String(n);
                }}
              />
              <button
                type="button"
                data-testid="shop-plus"
                aria-label={t("client.shop.more")}
                disabled={count >= max}
                onClick={() => props.set({ count: count + 1 })}
              >
                +
              </button>
              <button
                type="button"
                data-testid="shop-max"
                disabled={max <= 1}
                onClick={() => props.set({ count: Math.max(1, max) })}
              >
                {t("client.shop.max")}
              </button>
            </div>
            <span class={short ? "shop-total short" : "shop-total"} data-testid="shop-total">
              {t("client.shop.total", { price: total })}
            </span>
            <button type="submit" class="shop-act" data-testid="shop-act" disabled={!can}>
              {s.mode === "buy" ? t("client.shop.buy_action") : t("client.shop.sell_action")}
            </button>
          </>
        ) : (
          <p class="hint">{t("client.shop.pick")}</p>
        )}
      </form>
    </section>
  );
}
