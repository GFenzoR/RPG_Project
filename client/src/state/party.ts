// The player's party (T3.3), rebuilt from PartyUpdate and PartyInvitation. Pure: callers
// pass `now` in ms. The server decides everything; members out of view arrive without
// health or mana (docs/05, "Grupos"), so there is nothing to hide here.
import { SharedExperience } from "@rpg/protocol";
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
}

export interface PartyView {
  leaderId: number;
  shared: SharedExperience;
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
