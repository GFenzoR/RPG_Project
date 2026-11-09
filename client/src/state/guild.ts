// The player's guild (T5.1), rebuilt from GuildUpdate. Pure: callers pass `now` in ms.
// The server decides every permission; these helpers only choose which buttons to show,
// with the same rules (docs/02, "Gremios"), so a button never offers something the
// server would refuse for the rank.
import { GuildRank } from "@rpg/protocol";
import type { GuildUpdate } from "@rpg/protocol";

export interface GuildMemberView {
  name: string;
  rank: GuildRank;
  online: boolean;
}

export interface PendingInviteView {
  name: string;
  /** When it expires (ms, the caller's clock). */
  until: number;
}

export interface GuildView {
  id: bigint;
  name: string;
  motd: string;
  rank: GuildRank;
  /** Highest rank first, as the server orders them. */
  members: GuildMemberView[];
  /** Only for vice leaders and the leader. */
  pending: PendingInviteView[];
}

export interface GuildInvitationView {
  guildId: bigint;
  guildName: string;
  until: number;
}

export class GuildState {
  guild: GuildView | undefined;
  private invites: GuildInvitationView[] = [];
  private pending: PendingInviteView[] = [];

  update(u: GuildUpdate, now: number): void {
    this.pending = u.pending.map((p) => ({ name: p.name, until: now + p.expiresMs }));
    this.guild =
      u.guildId === 0n
        ? undefined
        : {
            id: u.guildId,
            name: u.name,
            motd: u.motd,
            rank: u.rank,
            members: u.members.map((m) => ({ name: m.name, rank: m.rank, online: m.online })),
            pending: this.pending,
          };
    this.invites = u.invitations.map((i) => ({
      guildId: i.guildId,
      guildName: i.guildName,
      until: now + i.expiresMs,
    }));
  }

  /** Forgets an invitation once answered (the server confirms with an update). */
  answered(guildId: bigint): void {
    this.invites = this.invites.filter((i) => i.guildId !== guildId);
  }

  /** The invitations that have not expired yet. */
  invitations(now: number): GuildInvitationView[] {
    this.invites = this.invites.filter((i) => i.until > now);
    return this.invites;
  }

  /** The guild with its still pending invitations at now. */
  view(now: number): GuildView | undefined {
    const g = this.guild;
    if (!g) return undefined;
    return { ...g, pending: g.pending.filter((p) => p.until > now) };
  }
}

/** i18n key of a rank's name (also the look message's `rank` parameter). */
export function rankKey(r: GuildRank): string {
  switch (r) {
    case GuildRank.LEADER:
      return "client.guild.rank.leader";
    case GuildRank.VICE:
      return "client.guild.rank.vice";
    default:
      return "client.guild.rank.member";
  }
}

/** What the player's rank lets it do to the guild itself. */
export interface GuildPowers {
  invite: boolean;
  motd: boolean;
  disband: boolean;
}

export function guildPowers(rank: GuildRank): GuildPowers {
  const manage = rank === GuildRank.VICE || rank === GuildRank.LEADER;
  return { invite: manage, motd: manage, disband: rank === GuildRank.LEADER };
}

/** What the player's rank lets it do to member `m` (never to itself). */
export interface MemberActions {
  kick: boolean;
  promote: boolean;
  demote: boolean;
  transfer: boolean;
}

export function memberActions(rank: GuildRank, m: GuildMemberView, self: boolean): MemberActions {
  const leader = rank === GuildRank.LEADER;
  if (self || m.rank === GuildRank.LEADER) {
    return { kick: false, promote: false, demote: false, transfer: false };
  }
  return {
    kick: leader || (rank === GuildRank.VICE && m.rank === GuildRank.MEMBER),
    promote: leader && m.rank === GuildRank.MEMBER,
    demote: leader && m.rank === GuildRank.VICE,
    transfer: leader,
  };
}

/** Hours (rounded up, at least 1) until `until`: how invitations show their expiry. */
export function hoursLeft(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 3_600_000));
}
