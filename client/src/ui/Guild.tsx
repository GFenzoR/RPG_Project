// Guild panel (T5.1): the guild's name and message of the day, its members with rank and
// online status, the actions the player's rank allows, the pending invitations it sent
// and, without a guild, the form to found one. Invitations to the player show over the
// map like the party's. The server decides everything: the buttons only send intents.
//
// No hooks: the forms are uncontrolled and read their fields on submit, so the panel
// renders as a plain function (ui/Guild.test.ts walks its tree without a DOM).
//
// In the desktop guild window (docs/17 UI-7) a row of icon buttons picks what shows, one
// part at a time: Summary (the guild, the player's rank, leave or disband), Members (each
// with a "⋯" of what the rank allows on them), Ranks (who holds each and what it can do),
// Invite (the form and the invitations sent), Wars and Message (of the day). The tab lives
// in the caller. Without `tab` (the side panel of small screens) the parts show one under
// the other, but Summary and Ranks (the names carry their ranks there).
import type { JSX } from "preact";
import { GuildAction, GuildRank } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import {
  guildPowers,
  hoursLeft,
  memberActions,
  rankKey,
  warActions,
  warLine,
} from "../state/guild.ts";
import type { GuildMemberView } from "../state/guild.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";

/** The text of the field `name` of the submitted form, trimmed. */
function field(e: JSX.TargetedSubmitEvent<HTMLFormElement>, name: string): string {
  e.preventDefault();
  // No instanceof: the tests run without a DOM.
  const el = e.currentTarget.elements.namedItem(name) as { value?: unknown } | null;
  return typeof el?.value === "string" ? el.value.trim() : "";
}

function clear(e: JSX.TargetedSubmitEvent<HTMLFormElement>): void {
  e.currentTarget.reset();
}

/** The buttons of the guild window, in their order (docs/17 UI-7). */
export const GUILD_TABS = ["summary", "members", "ranks", "invite", "wars", "motd"] as const;
export type GuildTab = (typeof GUILD_TABS)[number];

const GUILD_TAB_TITLE: Record<GuildTab, string> = {
  summary: "client.guild.tab.summary",
  members: "client.guild.tab.members",
  ranks: "client.guild.tab.ranks",
  invite: "client.guild.tab.invite",
  wars: "client.guild.tab.wars",
  motd: "client.guild.tab.motd",
};

const GUILD_TAB_ICON: Record<GuildTab, IconName> = {
  summary: "guild",
  members: "party",
  ranks: "ranks",
  invite: "invite",
  wars: "battle",
  motd: "motd",
};

/** The ranks from the top, with what each may do (client.guild.rank_powers.<rank>). */
const RANKS: readonly { rank: GuildRank; powers: string }[] = [
  { rank: GuildRank.LEADER, powers: "client.guild.rank_powers.leader" },
  { rank: GuildRank.VICE, powers: "client.guild.rank_powers.vice" },
  { rank: GuildRank.MEMBER, powers: "client.guild.rank_powers.member" },
];

export function GuildPanel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** ms clock for the invitations' expiry (performance.now()). */
  now: number;
  /** The part shown (desktop window); undefined shows every part. */
  tab?: GuildTab | undefined;
  onTab?(tab: GuildTab): void;
}): JSX.Element {
  const { t, ui } = props;
  const g = ui.guild;
  const rules = props.content.guild;
  const send = (a: GuildAction, name = "", text = ""): void => props.game?.guild(a, name, text);
  if (!g) {
    return (
      <section class="guild" data-testid="guild-panel" aria-label={t("client.guild.title")}>
        <h2>{t("client.guild.title")}</h2>
        <p class="empty">{t("client.guild.empty")}</p>
        <form
          class="guild-create"
          data-testid="guild-create"
          onSubmit={(e) => {
            const name = field(e, "name");
            if (name) send(GuildAction.CREATE, name);
          }}
        >
          <label>
            {t("client.guild.create_name")}
            <input name="name" maxLength={rules?.nameMax ?? 32} autoComplete="off" />
          </label>
          <button type="submit">{t("client.guild.create")}</button>
          {rules && (
            <p class="hint">
              {t("client.guild.create_hint", { cost: rules.foundCost, level: rules.foundMinLevel })}
            </p>
          )}
        </form>
      </section>
    );
  }
  const powers = guildPowers(g.rank);
  const online = g.members.filter((m) => m.online).length;
  const tab = props.tab;
  const shows = (part: GuildTab): boolean => tab === undefined || tab === part;
  const activeWars = g.wars.filter((w) => w.active).length;

  const summary = (
    <dl class="guild-facts" data-testid="guild-summary">
      <div>
        <dt>{t("client.guild.your_rank")}</dt>
        <dd>{t(rankKey(g.rank))}</dd>
      </div>
      <div>
        <dt>{t("client.guild.tab.members")}</dt>
        <dd>{t("client.guild.members_count", { online, count: g.members.length })}</dd>
      </div>
      <div>
        <dt>{t("client.guild.tab.wars")}</dt>
        <dd>{t("client.guild.wars_count", { active: activeWars, count: g.wars.length })}</dd>
      </div>
    </dl>
  );

  const memberRow = (m: GuildMemberView): JSX.Element => {
    const self = m.name === ui.selfName;
    const a = memberActions(g.rank, m, self);
    const any = a.kick || a.promote || a.demote || a.transfer;
    return (
      <li key={m.name} data-member={m.name} class={m.online ? "online" : "offline"}>
        <span class="mname">
          <span
            class="dot"
            aria-label={t(m.online ? "client.guild.online" : "client.guild.offline")}
          />
          {m.name}
          <span class={`tag rank-${m.rank}`}>{t(rankKey(m.rank))}</span>
        </span>
        {any && (
          // What the rank allows on this member, folded under "⋯" (no hooks: <details>).
          <details class="member-menu">
            <summary aria-label={t("client.guild.member_actions", { name: m.name })}>⋯</summary>
            <span class="actions">
              {a.promote && (
                <button type="button" onClick={() => send(GuildAction.PROMOTE, m.name)}>
                  {t("client.guild.promote")}
                </button>
              )}
              {a.demote && (
                <button type="button" onClick={() => send(GuildAction.DEMOTE, m.name)}>
                  {t("client.guild.demote")}
                </button>
              )}
              {a.transfer && (
                <button type="button" onClick={() => send(GuildAction.TRANSFER, m.name)}>
                  {t("client.guild.transfer")}
                </button>
              )}
              {a.kick && (
                <button type="button" class="danger" onClick={() => send(GuildAction.KICK, m.name)}>
                  {t("client.guild.kick")}
                </button>
              )}
            </span>
          </details>
        )}
      </li>
    );
  };
  const members = (
    <>
      <h3>{t("client.guild.members", { online, count: g.members.length })}</h3>
      <ul class="guild-members">{g.members.map(memberRow)}</ul>
    </>
  );

  const ranks = (
    <ul class="guild-ranks" data-testid="guild-ranks">
      {RANKS.map(({ rank, powers: what }) => {
        const holders = g.members.filter((m) => m.rank === rank);
        return (
          <li key={rank} data-rank={rank}>
            <h3>
              <span class={`tag rank-${rank}`}>{t(rankKey(rank))}</span>{" "}
              <span class="count">{holders.length}</span>
            </h3>
            <p class="hint">{t(what)}</p>
            <p class="holders">{holders.map((m) => m.name).join(", ") || "—"}</p>
          </li>
        );
      })}
    </ul>
  );

  const invite = powers.invite ? (
    <form
      class="guild-row"
      data-testid="guild-invite"
      onSubmit={(e) => {
        const name = field(e, "name");
        if (name) send(GuildAction.INVITE, name);
        clear(e);
      }}
    >
      <input
        name="name"
        maxLength={20}
        placeholder={t("client.guild.invite_placeholder")}
        aria-label={t("client.guild.invite_placeholder")}
        autoComplete="off"
      />
      <button type="submit">{t("client.guild.invite")}</button>
    </form>
  ) : (
    <p class="hint">{t("client.guild.invite_rank")}</p>
  );
  const pending = g.pending.length > 0 && (
    <>
      <h3>{t("client.guild.pending")}</h3>
      <ul class="guild-pending">
        {g.pending.map((p) => (
          <li key={p.name}>
            {t("client.guild.pending_entry", {
              name: p.name,
              hours: hoursLeft(p.until, props.now),
            })}
            <button type="button" onClick={() => send(GuildAction.REVOKE, p.name)}>
              {t("client.guild.revoke")}
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  const wars = (g.wars.length > 0 || g.rank === GuildRank.LEADER) && (
    <>
      <h3>{t("client.guild.wars")}</h3>
      <ul class="guild-wars" data-testid="guild-wars">
        {g.wars.map((w) => {
          const line = warLine(w, props.now);
          const a = warActions(g.rank, w);
          const war = (action: GuildAction): void => props.game?.guildWar(action, "", w.id);
          return (
            <li key={String(w.id)} data-war={w.enemy} class={w.active ? "active" : "pending"}>
              <span>{t(line.key, line.params)}</span>
              {(a.accept || a.decline || a.surrender) && (
                <span class="actions">
                  {a.accept && (
                    <button type="button" onClick={() => war(GuildAction.WAR_ACCEPT)}>
                      {t("client.guild.war_accept")}
                    </button>
                  )}
                  {a.decline && (
                    <button type="button" onClick={() => war(GuildAction.WAR_DECLINE)}>
                      {t("client.guild.war_decline")}
                    </button>
                  )}
                  {a.surrender && (
                    <button
                      type="button"
                      class="danger"
                      onClick={() => war(GuildAction.WAR_SURRENDER)}
                    >
                      {t("client.guild.war_surrender")}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {g.rank === GuildRank.LEADER && (
        <form
          class="guild-row"
          data-testid="guild-war-declare"
          onSubmit={(e) => {
            const name = field(e, "enemy");
            if (name) props.game?.guildWar(GuildAction.WAR_DECLARE, name);
            clear(e);
          }}
        >
          <input
            name="enemy"
            maxLength={rules?.nameMax ?? 32}
            placeholder={t("client.guild.war_declare_placeholder")}
            aria-label={t("client.guild.war_declare_placeholder")}
            autoComplete="off"
          />
          <button type="submit">{t("client.guild.war_declare")}</button>
        </form>
      )}
    </>
  );

  const motd = powers.motd ? (
    <form
      class="guild-row"
      data-testid="guild-motd-form"
      onSubmit={(e) => {
        send(GuildAction.MOTD, "", field(e, "motd"));
        clear(e);
      }}
    >
      <input
        name="motd"
        maxLength={rules?.motdMax ?? 255}
        placeholder={t("client.guild.motd_placeholder")}
        aria-label={t("client.guild.motd_placeholder")}
        autoComplete="off"
      />
      <button type="submit">{t("client.guild.motd_save")}</button>
    </form>
  ) : (
    tab !== undefined && <p class="hint">{t("client.guild.motd_rank")}</p>
  );

  const actions = (
    <div class="guild-actions">
      {g.rank !== GuildRank.LEADER && (
        <button type="button" data-testid="guild-leave" onClick={() => send(GuildAction.LEAVE)}>
          {t("client.guild.leave")}
        </button>
      )}
      {powers.disband && (
        <form
          class="guild-row"
          onSubmit={(e) => {
            send(GuildAction.DISBAND, field(e, "confirm"));
            clear(e);
          }}
        >
          <input
            name="confirm"
            placeholder={t("client.guild.disband_placeholder")}
            aria-label={t("client.guild.disband_placeholder")}
            autoComplete="off"
          />
          <button type="submit" class="danger">
            {t("client.guild.disband")}
          </button>
        </form>
      )}
    </div>
  );
  return (
    <section
      class="guild"
      data-testid="guild-panel"
      data-guild-part={tab}
      aria-label={t("client.guild.title")}
    >
      <h2>
        {g.name} <span class="tag">{t(rankKey(g.rank))}</span>
      </h2>
      <p class="motd" data-testid="guild-motd">
        {g.motd || t("client.guild.motd_empty")}
      </p>
      {tab !== undefined && (
        <div class="guild-tabs" role="tablist" aria-label={t("client.guild.title")}>
          {GUILD_TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-guild-tab={id}
              aria-selected={tab === id}
              title={t(GUILD_TAB_TITLE[id])}
              onClick={() => props.onTab?.(id)}
            >
              <Icon name={GUILD_TAB_ICON[id]} />
              <span>{t(GUILD_TAB_TITLE[id])}</span>
            </button>
          ))}
        </div>
      )}
      <div class="guild-part" key={tab}>
        {tab === "summary" && summary}
        {shows("members") && members}
        {tab === "ranks" && ranks}
        {shows("invite") && tab !== undefined && invite}
        {tab === undefined && powers.invite && invite}
        {shows("invite") && pending}
        {tab === "wars"
          ? wars || <p class="empty">{t("client.guild.no_wars")}</p>
          : shows("wars") && wars}
        {shows("motd") && motd}
        {shows("summary") && actions}
      </div>
    </section>
  );
}

/** Invitations to a guild waiting for an answer, over the map. */
export function GuildInvitations(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t } = props;
  return (
    <div class="invitations guild-invitations">
      {props.ui.guildInvitations.map((i) => (
        <div
          key={String(i.guildId)}
          class="invitation"
          role="alertdialog"
          data-testid="guild-invitation"
        >
          <p>{t("client.guild.invitation", { guild: i.guildName })}</p>
          <button
            type="button"
            data-testid="guild-accept"
            onClick={() => props.game?.guildAnswer(i.guildId, true)}
          >
            {t("client.guild.accept")}
          </button>
          <button type="button" onClick={() => props.game?.guildAnswer(i.guildId, false)}>
            {t("client.guild.decline")}
          </button>
        </div>
      ))}
    </div>
  );
}
