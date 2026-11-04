// Party panel (T3.3): members with their level and, while in view, health and mana; the
// leader's actions; the shared experience indicator; and the invitations to answer. The
// server decides everything: the buttons only send intents.
import type { JSX } from "preact";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { SharedExperience } from "@rpg/protocol";
import { sharedKey } from "../state/party.ts";

const SHARED_OFF = SharedExperience.OFF;

export function PartyPanel(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t, ui } = props;
  const party = ui.party;
  const leader = party?.leaderId === ui.selfId;
  return (
    <section class="party" data-testid="party-panel" aria-label={t("client.party.title")}>
      <h2>{t("client.party.title")}</h2>
      {!party ? (
        <p class="empty">{t("client.party.empty")}</p>
      ) : (
        <>
          <p class={`shared shared-${party.shared}`} data-testid="party-shared">
            {t(sharedKey(party.shared))}
          </p>
          <ul>
            {party.members.map((m) => (
              <li key={m.id} data-member={m.id} class={m.inView ? "" : "away"}>
                <span class="mname">
                  {m.name}
                  {m.id === party.leaderId && <span class="tag">{t("client.party.leader")}</span>}
                  {m.sharing && <span class="tag sharing">{t("client.party.sharing")}</span>}
                </span>
                <span class="mlevel">
                  {t(`vocation.${m.vocation}.name`)} · {t("client.party.level", { level: m.level })}
                </span>
                {m.inView ? (
                  <span class="bars">
                    <span class="hp" aria-label={t("client.party.health", { health: m.health })}>
                      <span style={{ width: `${m.health}%` }} />
                    </span>
                    <span class="mp" aria-label={t("client.party.mana", { mana: m.mana })}>
                      <span style={{ width: `${m.mana}%` }} />
                    </span>
                  </span>
                ) : (
                  <span class="where">
                    {m.island
                      ? t("client.party.away", { island: t(`island.${m.island}.name`) })
                      : t("client.party.away_sea")}
                  </span>
                )}
                {leader && m.id !== ui.selfId && (
                  <span class="actions">
                    <button type="button" onClick={() => props.game?.partyPassLeader(m.id)}>
                      {t("client.party.pass_leader")}
                    </button>
                    <button type="button" onClick={() => props.game?.partyKick(m.id)}>
                      {t("client.party.kick")}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div class="party-actions">
            {leader && (
              <button
                type="button"
                data-testid="party-share"
                onClick={() => props.game?.partyShare(party.shared === SHARED_OFF)}
              >
                {party.shared === SHARED_OFF
                  ? t("client.party.share_on")
                  : t("client.party.share_off")}
              </button>
            )}
            <button
              type="button"
              data-testid="party-leave"
              onClick={() => props.game?.partyLeave()}
            >
              {t("client.party.leave")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Invitations waiting for an answer, over the map. */
export function PartyInvitations(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t } = props;
  return (
    <div class="invitations">
      {props.ui.invitations.map((i) => (
        <div key={i.inviterId} class="invitation" role="alertdialog" data-testid="party-invitation">
          <p>{t("client.party.invitation", { name: i.inviterName })}</p>
          <button
            type="button"
            data-testid="party-accept"
            onClick={() => props.game?.partyAnswer(i.inviterId, true)}
          >
            {t("client.party.accept")}
          </button>
          <button type="button" onClick={() => props.game?.partyAnswer(i.inviterId, false)}>
            {t("client.party.decline")}
          </button>
        </div>
      ))}
    </div>
  );
}
