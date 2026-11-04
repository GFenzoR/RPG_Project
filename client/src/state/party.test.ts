import { describe, expect, it } from "vitest";
import {
  create,
  PartyInvitationSchema,
  PartyMemberSchema,
  PartyUpdateSchema,
  SharedExperience,
} from "@rpg/protocol";
import { PartyState, sharedKey } from "./party.ts";

const update = (leaderId: number, ids: number[]) =>
  create(PartyUpdateSchema, {
    leaderId,
    shared: SharedExperience.ACTIVE,
    members: ids.map((id) =>
      create(PartyMemberSchema, {
        creatureId: id,
        name: `p${id}`,
        level: 3,
        inView: id === 1,
        healthPercent: id === 1 ? 80 : 0,
      }),
    ),
  });

describe("PartyState", () => {
  it("keeps the party until an empty update", () => {
    const s = new PartyState();
    s.update(update(1, [1, 2]));
    expect(s.party?.members.map((m) => [m.id, m.inView, m.health])).toEqual([
      [1, true, 80],
      [2, false, 0],
    ]);
    expect(s.isLeader(1)).toBe(true);
    expect(s.isMember(2)).toBe(true);
    s.update(create(PartyUpdateSchema, {}));
    expect(s.party).toBeUndefined();
  });

  it("expires, replaces and drops invitations", () => {
    const s = new PartyState();
    s.invited(
      create(PartyInvitationSchema, { inviterId: 5, inviterName: "Ana", expiresMs: 1000 }),
      0,
    );
    s.invited(
      create(PartyInvitationSchema, { inviterId: 5, inviterName: "Ana", expiresMs: 1000 }),
      500,
    );
    s.invited(
      create(PartyInvitationSchema, { inviterId: 6, inviterName: "Bo", expiresMs: 100 }),
      500,
    );
    expect(s.invitations(550).map((i) => i.inviterId)).toEqual([5, 6]);
    expect(s.invitations(1000).map((i) => i.inviterId)).toEqual([5]);
    s.answered(5);
    expect(s.invitations(1000)).toEqual([]);
    s.invited(
      create(PartyInvitationSchema, { inviterId: 7, inviterName: "Cy", expiresMs: 1000 }),
      0,
    );
    s.update(update(1, [1, 7]));
    expect(s.invitations(0)).toEqual([]);
  });

  it("names the indicator", () => {
    expect(sharedKey(SharedExperience.ACTIVE)).toBe("client.party.shared.active");
    expect(sharedKey(SharedExperience.OFF)).toBe("client.party.shared.off");
  });
});
