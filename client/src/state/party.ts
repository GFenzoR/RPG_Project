// The player's party (T3.3), rebuilt from PartyUpdate and PartyInvitation. Pure: callers
// pass `now` in ms. The server decides everything; members out of view arrive without
// health or mana (docs/05, "Grupos"), so there is nothing to hide here.
import { ShareBlock, SharedExperience } from "@rpg/protocol";
import type { PartyInvitation, PartyUpdate } from "@rpg/protocol";

export interface PartyMemberView {
  id: number;
  name: string;
  vocation: string;
  level: number;
  inView: boolean;
  /** Percent; 0 when out of view. */
  health: number;
  mana: number;
  /** Island id ("" at sea). */
  island: string;
  sharing: boolean;
  /** Why it does not share (UNSPECIFIED while it shares or sharing is off). */
  block: ShareBlock;
}

export interface PartyView {
  leaderId: number;
  shared: SharedExperience;
  /** The shared experience bonus % right now (0 unless shared is ACTIVE). */
  bonusPercent: number;
  members: PartyMemberView[];
}

export interface InvitationView {
  inviterId: number;
  inviterName: string;
  /** When it expires (ms, the caller's clock). */
  until: number;
}

export class PartyState {
  party: PartyView | undefined;
  private invites: InvitationView[] = [];

  update(u: PartyUpdate): void {
    if (u.members.length === 0) {
      this.party = undefined;
      return;
    }
    this.party = {
      leaderId: u.leaderId,
      shared: u.shared,
      bonusPercent: u.shared === SharedExperience.ACTIVE ? u.bonusPercent : 0,
      members: u.members.map((m) => ({
        id: m.creatureId,
        name: m.name,
        vocation: m.vocation,
        level: m.level,
        inView: m.inView,
        health: m.healthPercent,
        mana: m.manaPercent,
        island: m.island,
        sharing: m.sharing,
        block: m.shareBlock,
      })),
    };
    // In a party now: any other invitation needs leaving first.
    this.invites = [];
  }

  invited(i: PartyInvitation, now: number): void {
    this.invites = this.invites.filter((x) => x.inviterId !== i.inviterId);
    this.invites.push({
      inviterId: i.inviterId,
      inviterName: i.inviterName,
      until: now + i.expiresMs,
    });
  }

  /** Forgets an invitation once answered. */
  answered(inviterId: number): void {
    this.invites = this.invites.filter((x) => x.inviterId !== inviterId);
  }

  /** The invitations that have not expired yet, oldest first. */
  invitations(now: number): InvitationView[] {
    this.invites = this.invites.filter((x) => x.until > now);
    return this.invites;
  }

  isLeader(selfId: number): boolean {
    return this.party?.leaderId === selfId;
  }

  isMember(id: number): boolean {
    return this.party?.members.some((m) => m.id === id) ?? false;
  }
}

/** The party bonus % the player gets now: 0 out of a party or without sharing. */
export function partyBonus(p: PartyView | undefined): number {
  return p?.bonusPercent ?? 0;
}

/** How many members share right now (the ones the player sees qualify). */
export function sharingCount(p: PartyView | undefined): number {
  return p?.members.filter((m) => m.sharing).length ?? 0;
}

/** i18n key of the shared experience indicator. */
export function sharedKey(s: SharedExperience): string {
  switch (s) {
    case SharedExperience.ACTIVE:
      return "client.party.shared.active";
    case SharedExperience.INACTIVE:
      return "client.party.shared.inactive";
    default:
      return "client.party.shared.off";
  }
}

const BLOCKS: Partial<Record<ShareBlock, string>> = {
  [ShareBlock.FAR]: "far",
  [ShareBlock.DEAD]: "dead",
  [ShareBlock.IDLE]: "idle",
  [ShareBlock.LEVEL]: "level",
  [ShareBlock.ACCOUNT]: "account",
  [ShareBlock.ALONE]: "alone",
};

/**
 * i18n key of why a member does not share experience, or undefined when it shares or
 * there is nothing to tell: `client.party.block.<reason>` is the short tag next to a
 * member and, with `own`, `client.party.block_you.<reason>` the sentence for the player.
 */
export function blockKey(b: ShareBlock, own = false): string | undefined {
  const reason = BLOCKS[b];
  return reason && `client.party.${own ? "block_you" : "block"}.${reason}`;
}
