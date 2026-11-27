// House window (T5.4): opens when the player uses a house door. A free house shows its
// rent and can be rented; the owner sees until when it is paid, pays ahead, manages the
// guests and the guild switch, offers the house to another character or leaves it; the
// character offered the house accepts it here. The server validates everything and
// answers each action with a fresh HouseUpdate. No hooks: the forms are uncontrolled and
// read their fields on submit, so the tests walk the element tree (House.test.ts).
import { KNOWN_NAME_MAX_CHARS } from "@rpg/content-schema/npc-role";
import type { JSX } from "preact";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { daysLeft, houseActions } from "../state/house.ts";
import { formatArea } from "../state/units.ts";
import { field } from "./Market.tsx";

interface Props {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
  /** Inside a GameWindow (the desktop): the frame's title bar names and closes it. */
  framed?: boolean | undefined;
}

export function HouseWindow(props: Props & { now?: number }): JSX.Element | null {
  const { t, game } = props;
  const h = props.ui.house;
  if (!h) return null;
  const now = props.now ?? Date.now();
  const can = houseActions(h);
  return (
    <section
      class="house"
      data-testid={props.framed ? undefined : "house"}
      aria-label={t("client.house.title")}
    >
      {/* Framed, the window's title is the house's name (data-testid house-name). */}
      {!props.framed && (
        <header data-sheet-head="">
          <h2 data-testid="house-name">{t(h.name)}</h2>
          <button
            type="button"
            class="close"
            aria-label={t("client.house.close")}
            title={t("client.house.close")}
            onClick={() => game?.houseClose()}
          >
            ×
          </button>
        </header>
      )}
      {h.readOnly && (
        <p class="read-only" data-testid="house-read-only" role="alert">
          {t("client.house.read_only")}
        </p>
      )}
      <p class="facts">
        {t("client.house.facts", {
          island: t(`island.${h.island}.name`),
          area: formatArea(h.size, t),
          items: h.items,
          max: h.maxItems,
        })}
      </p>
      <p class="rent">{t("client.house.rent", { price: h.rent, days: h.periodDays })}</p>
      <p class="owner" data-testid="house-owner">
        {h.owner ? t("client.house.owner", { name: h.owner }) : t("client.house.free")}
      </p>

      {(can.enter || can.exit) && (
        <div class="actions">
          {can.enter && (
            <button type="button" data-testid="house-enter" onClick={() => game?.houseEnter()}>
              {t("client.house.enter")}
            </button>
          )}
          {can.exit && (
            <button type="button" data-testid="house-exit" onClick={() => game?.houseExit()}>
              {t("client.house.exit")}
            </button>
          )}
        </div>
      )}

      {can.rent && (
        <div class="actions">
          <p class="hint">{t("client.house.rent_hint", { level: h.minLevel, money: h.money })}</p>
          <button type="button" data-testid="house-rent" onClick={() => game?.houseRent()}>
            {t("client.house.rent_button", { price: h.rent })}
          </button>
        </div>
      )}

      {can.accept && h.transfer && (
        <div class="actions">
          <p>{t("client.house.offer_for_you", { name: h.owner, price: h.transfer.price })}</p>
          <button
            type="button"
            data-testid="house-accept"
            onClick={() => game?.houseAccept(h.id, h.transfer?.price ?? 0)}
          >
            {t("client.house.accept")}
          </button>
        </div>
      )}

      {can.manage && (
        <div class="manage">
          <p class="paid" data-testid="house-paid">
            {t("client.house.paid_until", {
              date: new Date(h.paidUntil).toISOString().slice(0, 10),
              days: daysLeft(h, now),
            })}
          </p>
          <p class="hint">{t("client.house.renew_hint")}</p>
          <button type="button" data-testid="house-extend" onClick={() => game?.houseExtend()}>
            {t("client.house.extend", { price: h.rent, max: h.maxPeriods })}
          </button>

          <h3>{t("client.house.guests", { count: h.guests.length, max: h.maxGuests })}</h3>
          <ul data-testid="house-guests">
            {h.guests.map((g) => (
              <li key={g}>
                <span class="user-text">{g}</span>
                <button
                  type="button"
                  data-guest-remove={g}
                  aria-label={t("client.house.guest_remove", { name: g })}
                  title={t("client.house.guest_remove", { name: g })}
                  onClick={() => game?.houseGuest(g, false)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form
            class="guest-add"
            onSubmit={(e) => {
              e.preventDefault();
              const name = field(e.currentTarget, "name").trim();
              if (name) game?.houseGuest(name, true);
              e.currentTarget.reset();
            }}
          >
            <input
              name="name"
              maxLength={KNOWN_NAME_MAX_CHARS}
              aria-label={t("client.house.guest_name")}
              placeholder={t("client.house.guest_name")}
              data-testid="house-guest-name"
            />
            <button type="submit" data-testid="house-guest-add">
              {t("client.house.guest_add")}
            </button>
          </form>
          <label class="guild">
            <input
              type="checkbox"
              checked={h.guildAccess}
              data-testid="house-guild"
              onChange={(e) => game?.houseGuildAccess(e.currentTarget.checked)}
            />
            {t("client.house.guild_access")}
          </label>

          <h3>{t("client.house.transfer_title")}</h3>
          {h.transfer ? (
            <p class="pending">
              {t("client.house.transfer_pending", { name: h.transfer.to, price: h.transfer.price })}
              <button type="button" onClick={() => game?.houseTransferCancel()}>
                {t("client.house.transfer_cancel")}
              </button>
            </p>
          ) : (
            <form
              class="transfer"
              onSubmit={(e) => {
                e.preventDefault();
                const name = field(e.currentTarget, "name").trim();
                const price = Math.floor(Number(field(e.currentTarget, "price")));
                if (name && price >= 0) game?.houseTransfer(name, price);
              }}
            >
              <input
                name="name"
                maxLength={KNOWN_NAME_MAX_CHARS}
                aria-label={t("client.house.transfer_to")}
                placeholder={t("client.house.transfer_to")}
              />
              <input
                name="price"
                type="number"
                min={0}
                defaultValue="0"
                aria-label={t("client.house.transfer_price")}
              />
              <button type="submit">{t("client.house.transfer_offer")}</button>
            </form>
          )}

          <h3>{t("client.house.leave_title")}</h3>
          <p class="hint">{t("client.house.leave_hint")}</p>
          {/* Two steps (a native <details>, no state): one click on a window that also
              pays and invites must not give the house up. */}
          <details class="leave" data-testid="house-leave-ask">
            <summary>{t("client.house.leave")}</summary>
            <p class="hint" data-testid="house-leave-confirm">
              {t("client.house.leave_confirm", { days: daysLeft(h, now) })}
            </p>
            <button
              type="button"
              class="danger"
              data-testid="house-leave"
              onClick={() => game?.houseLeave()}
            >
              {t("client.house.leave_yes")}
            </button>
          </details>
        </div>
      )}
    </section>
  );
}
