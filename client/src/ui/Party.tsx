// Party panel (T3.3): members with their level and, while in view, health and mana; the
// leader's actions; the shared experience indicator with the bonus % and who shares it;
// a help line on what a party gives; the "Invitar" button (no party or the leader) with
// its prompt for a character name; and the invitations to answer. The server decides
// everything: the buttons only send intents.
import { KNOWN_NAME_MAX_CHARS } from "@rpg/content-schema/npc-role";
import type { JSX } from "preact";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { SharedExperience } from "@rpg/protocol";
import type { ShareBlock } from "@rpg/protocol";
import { blockKey, sharedKey, sharingCount } from "../state/party.ts";

const SHARED_OFF = SharedExperience.OFF;

/**
 * The longest name a character may have: one made before names were bounded to 16 keeps up
 * to 20 letters (server auth.MaxKnownNameLen), and it can still be invited.
 */
const NAME_MAX = KNOWN_NAME_MAX_CHARS;

/**
 * The name field takes the focus when the prompt opens (Preact ignores autoFocus). One
 * function for every render: a new one each time would make Preact call it again on
 * every update and take the focus back from wherever the player put it.
 */
const focusOnMount = (el: HTMLInputElement | null): void => el?.focus();

/**
 * The "Invitar" button, or its prompt while open: a character name, Enter or "Invitar"
 * sends it (PartyCommand INVITE_NAME), Escape or "Cancelar" closes it. A plain function
 * (no hooks): the open state lives in Game (GameUi.partyInviting).
 */
export function PartyInvite(props: {
  t: Translate;
  game: Pick<Game, "partyInvitePrompt" | "partyInviteByName"> | undefined;
  open: boolean;
}): JSX.Element {
  const { t, game } = props;
  if (!props.open) {
    return (
      <button
        type="button"
        data-testid="party-invite"
        onClick={() => game?.partyInvitePrompt(true)}
      >
        {t("client.party.invite")}
      </button>
    );
  }
  return (
    <form
      class="party-invite-prompt"
      role="dialog"
      aria-labelledby="party-invite-title"
      data-testid="party-invite-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        const field = e.currentTarget.elements.namedItem("name") as HTMLInputElement | null;
        const name = field?.value ?? "";
        if (name.trim()) game?.partyInviteByName(name);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        game?.partyInvitePrompt(false);
      }}
    >
      <label>
        <span id="party-invite-title">{t("client.party.invite_title")}</span>
        <input
          ref={focusOnMount}
          name="name"
          type="text"
          maxLength={NAME_MAX}
          required
          autoComplete="off"
          autoCapitalize="words"
          spellcheck={false}
          enterKeyHint="send"
          placeholder={t("client.party.invite_name")}
          aria-label={t("client.party.invite_name")}
          data-testid="party-invite-name"
        />
      </label>
      <div class="buttons">
        <button type="submit" data-testid="party-invite-send">
          {t("client.party.invite_send")}
        </button>
        <button
          type="button"
          data-testid="party-invite-cancel"
          onClick={() => game?.partyInvitePrompt(false)}
        >
          {t("client.party.invite_cancel")}
        </button>
      </div>
    </form>
  );
}

/** The tag that says why a member does not share experience, if it does not. */
function blockTag(t: Translate, block: ShareBlock): JSX.Element | null {
  const key = blockKey(block);
  return key ? (
    <span class="tag blocked" data-testid="party-member-block">
      {t(key)}
    </span>
  ) : null;
}

export function PartyPanel(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t, ui } = props;
  const party = ui.party;
  const leader = party?.leaderId === ui.selfId;
  const self = party?.members.find((m) => m.id === ui.selfId);
  const ownBlock = self && blockKey(self.block, true);
  return (
    <section class="party" data-testid="party-panel" aria-label={t("client.party.title")}>
      <h2>{t("client.party.title")}</h2>
      {!party ? (
        <>
          <p class="empty">{t("client.party.empty")}</p>
          <div class="party-actions">
            <PartyInvite t={t} game={props.game} open={ui.partyInviting === true} />
          </div>
          <p class="party-help" data-testid="party-help">
            {t("client.party.help")}
          </p>
        </>
      ) : (
        <>
          <p class={`shared shared-${party.shared}`} data-testid="party-shared">
            {t(sharedKey(party.shared))}
          </p>
          {ownBlock && (
            <p class="party-block" data-testid="party-block">
              {t(ownBlock)}
            </p>
          )}
          {party.bonusPercent > 0 && (
            <p class="party-bonus" data-testid="party-bonus" data-percent={party.bonusPercent}>
              {t("client.party.bonus", {
                percent: party.bonusPercent,
                count: sharingCount(party),
              })}
            </p>
          )}
          <ul>
            {party.members.map((m) => (
              <li key={m.id} data-member={m.id} class={m.inView ? "" : "away"}>
                <span class="mname">
                  {m.name}
                  {m.id === party.leaderId && <span class="tag">{t("client.party.leader")}</span>}
                  {m.sharing && <span class="tag sharing">{t("client.party.sharing")}</span>}
                  {blockTag(t, m.block)}
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
            {leader && <PartyInvite t={t} game={props.game} open={ui.partyInviting === true} />}
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
          <p class="party-help" data-testid="party-help">
            {t("client.party.help")}
          </p>
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
