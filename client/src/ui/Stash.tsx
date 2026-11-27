// Account stash window (docs/02 "Baúl de la cuenta"): opens when the player uses a stash
// chest of a town. Two lists: the stash's cells (shared by every character of the account)
// and the tradeable items the player carries in its backpack, pockets and open containers.
// A click on "Store" or "Take", or dragging an item from one list onto the other, moves the
// whole stack (taking plain units heavier than the free capacity takes as many as fit:
// stashTakeCount); the server checks the chest, the item, room and weight and answers with a
// fresh StashUpdate (a refusal goes to the log). It reuses the trade window's frame and
// lists (class "trade"). No hooks: the tests walk the element tree (Stash.test.ts).
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { locKey } from "../state/items.ts";
import { stashFull, stashTakeCount } from "../state/stash.ts";
import type { StashCell } from "../state/stash.ts";
import { ItemLabel, offerable } from "./Trade.tsx";

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Inside a GameWindow (the desktop): the frame's title bar names and closes it. */
  framed?: boolean | undefined;
}

/** The drag payload: which list the item comes from and its key there. */
const DRAG_TYPE = "application/x-rpg-stash";

interface DragEventLike {
  dataTransfer: { setData(type: string, v: string): void; getData(type: string): string } | null;
  preventDefault(): void;
}

export function StashWindow(props: Props): JSX.Element | null {
  const { t, game, ui } = props;
  const st = ui.stash;
  if (!st) return null;
  const carried = offerable(ui, props.content);
  const full = stashFull(st);
  const take = (c: StashCell): void =>
    game?.stashWithdraw(c, stashTakeCount(c, props.content.items[c.itemId], ui.stats?.capacity));
  const onDrop =
    (into: "stash" | "carried") =>
    (e: DragEventLike): void => {
      e.preventDefault();
      const [from, key] = (e.dataTransfer?.getData(DRAG_TYPE) ?? "").split("|");
      if (into === "stash" && from === "carried") {
        const it = carried.find((o) => locKey(o.ref.loc) === key);
        if (it) game?.stashDeposit(it.ref, it.count);
      } else if (into === "carried" && from === "stash") {
        const c = st.cells.find((x) => String(x.index) === key);
        if (c) take(c);
      }
    };
  const allowDrop = (e: DragEventLike): void => e.preventDefault();
  const drag = (from: string, key: string) => (e: DragEventLike) =>
    e.dataTransfer?.setData(DRAG_TYPE, `${from}|${key}`);
  return (
    <section
      class="trade stash"
      data-testid={props.framed ? undefined : "stash"}
      aria-label={t("client.stash.title")}
    >
      {!props.framed && (
        <header data-sheet-head="">
          <h2>{t("client.stash.title")}</h2>
          <button
            type="button"
            class="close"
            aria-label={t("client.stash.close")}
            title={t("client.stash.close")}
            onClick={() => game?.stashClose()}
          >
            ×
          </button>
        </header>
      )}
      <p class="hint">{t("client.stash.hint")}</p>
      <h3>{t("client.stash.cells", { used: st.cells.length, capacity: st.capacity })}</h3>
      {st.cells.length === 0 ? (
        <p
          class="empty drop"
          data-testid="stash-cells"
          onDragOver={allowDrop}
          onDrop={onDrop("stash")}
        >
          {t("client.stash.empty")}
        </p>
      ) : (
        <ul class="drop" data-testid="stash-cells" onDragOver={allowDrop} onDrop={onDrop("stash")}>
          {st.cells.map((c) => (
            <li
              key={`${c.index}-${c.itemId}`}
              draggable
              onDragStart={drag("stash", String(c.index))}
            >
              <ItemLabel {...props} itemId={c.itemId} count={c.count} mods={c.mods} />
              <button type="button" data-stash-take={c.index} onClick={() => take(c)}>
                {t("client.stash.take")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>{t("client.stash.carried")}</h3>
      {carried.length === 0 ? (
        <p
          class="empty drop"
          data-testid="stash-carried"
          onDragOver={allowDrop}
          onDrop={onDrop("carried")}
        >
          {t("client.stash.open_backpack")}
        </p>
      ) : (
        <ul
          class="offerable drop"
          data-testid="stash-carried"
          onDragOver={allowDrop}
          onDrop={onDrop("carried")}
        >
          {carried.map((it) => (
            <li
              key={locKey(it.ref.loc)}
              draggable
              onDragStart={drag("carried", locKey(it.ref.loc))}
            >
              <ItemLabel {...props} itemId={it.itemId} count={it.count} mods={it.mods} />
              <button
                type="button"
                data-stash-store={props.content.items[it.itemId]?.id ?? it.itemId}
                title={full ? t("client.stash.full_hint") : undefined}
                onClick={() => game?.stashDeposit(it.ref, it.count)}
              >
                {t("client.stash.store")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
