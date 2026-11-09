import { describe, expect, it } from "vitest";
import {
  create,
  GuildInvitationSchema,
  GuildMemberSchema,
  GuildPendingInviteSchema,
  GuildRank,
  GuildUpdateSchema,
  GuildWarSchema,
  GuildWarState,
} from "@rpg/protocol";
import {
  GuildState,
  guildPowers,
  hoursLeft,
  memberActions,
  rankKey,
  warActions,
  warLine,
} from "./guild.ts";

const L = GuildRank.LEADER;
const V = GuildRank.VICE;
const M = GuildRank.MEMBER;

describe("GuildState", () => {
  it("keeps the guild and its invitations until they expire or are answered", () => {
    const s = new GuildState();
    s.update(
      create(GuildUpdateSchema, {
        guildId: 4n,
        name: "Salt Lanterns",
        motd: "dock",
        rank: L,
        members: [
          create(GuildMemberSchema, { name: "Ana", rank: L, online: true }),
          create(GuildMemberSchema, { name: "Bea", rank: M, online: false }),
        ],
        pending: [create(GuildPendingInviteSchema, { name: "Ciro", expiresMs: 1000 })],
        invitations: [
          create(GuildInvitationSchema, { guildId: 9n, guildName: "Iron", expiresMs: 500 }),
        ],
      }),
      100,
    );
    const g = s.view(200);
    expect(g?.name).toBe("Salt Lanterns");
    expect(g?.members.map((m) => [m.name, m.online])).toEqual([
      ["Ana", true],
      ["Bea", false],
    ]);
    expect(g?.pending.map((p) => p.name)).toEqual(["Ciro"]);
    expect(s.view(1200)?.pending).toEqual([]);
    expect(s.invitations(200).map((i) => i.guildName)).toEqual(["Iron"]);
    expect(s.invitations(700)).toEqual([]);

    s.update(
      create(GuildUpdateSchema, {
        invitations: [
          create(GuildInvitationSchema, { guildId: 9n, guildName: "Iron", expiresMs: 500 }),
        ],
      }),
      1000,
    );
    expect(s.view(1000)).toBeUndefined();
    s.answered(9n);
    expect(s.invitations(1000)).toEqual([]);
  });
});

describe("guild permissions", () => {
  it("matches the server's rules", () => {
    expect(guildPowers(L)).toEqual({ invite: true, motd: true, disband: true });
    expect(guildPowers(V)).toEqual({ invite: true, motd: true, disband: false });
    expect(guildPowers(M)).toEqual({ invite: false, motd: false, disband: false });
    const m = { name: "x", rank: M, online: true };
    const v = { name: "y", rank: V, online: true };
    const l = { name: "z", rank: L, online: true };
    expect(memberActions(L, m, false)).toEqual({
      kick: true,
      promote: true,
      demote: false,
      transfer: true,
    });
    expect(memberActions(L, v, false)).toEqual({
      kick: true,
      promote: false,
      demote: true,
      transfer: true,
    });
    expect(memberActions(V, m, false)).toEqual({
      kick: true,
      promote: false,
      demote: false,
      transfer: false,
    });
    expect(memberActions(V, v, false).kick).toBe(false);
    expect(memberActions(V, l, false).kick).toBe(false);
    expect(memberActions(M, m, false).kick).toBe(false);
    expect(memberActions(L, l, true).transfer).toBe(false);
  });

  it("names ranks and rounds hours up", () => {
    expect(rankKey(V)).toBe("client.guild.rank.vice");
    expect(rankKey(GuildRank.UNSPECIFIED)).toBe("client.guild.rank.member");
    expect(hoursLeft(3_600_001, 0)).toBe(2);
    expect(hoursLeft(10, 0)).toBe(1);
  });
});

describe("guild wars (T5.2)", () => {
  it("keeps the wars of an update with their deadline", () => {
    const s = new GuildState();
    s.update(
      create(GuildUpdateSchema, {
        guildId: 1n,
        name: "Alpha",
        rank: L,
        wars: [
          create(GuildWarSchema, {
            warId: 3n,
            enemyName: "Beta",
            state: GuildWarState.ACTIVE,
            ourKills: 2,
            theirKills: 5,
            killLimit: 30,
            endsMs: 7_200_000,
          }),
          create(GuildWarSchema, {
            warId: 4n,
            enemyName: "Gamma",
            state: GuildWarState.PENDING,
            declaredByUs: true,
            endsMs: 1_000,
          }),
        ],
      }),
      100,
    );
    const wars = s.view(100)?.wars ?? [];
    const active = wars[0];
    const pending = wars[1];
    if (!active || !pending) throw new Error("wars missing");
    expect(active).toMatchObject({
      id: 3n,
      enemy: "Beta",
      active: true,
      ours: 2,
      theirs: 5,
      until: 7_200_100,
    });
    expect(warLine(active, 100)).toEqual({
      key: "client.guild.war_active",
      params: { guild: "Beta", ours: 2, theirs: 5, limit: 30, hours: 2 },
    });
    expect(warLine(pending, 100).key).toBe("client.guild.war_pending_ours");
    expect(warActions(L, pending)).toEqual({ accept: false, decline: false, surrender: false });
    expect(warActions(L, active)).toEqual({ accept: false, decline: false, surrender: true });
    expect(warActions(V, active).surrender).toBe(false);
    const theirs = { ...pending, declaredByUs: false };
    expect(warActions(L, theirs)).toEqual({ accept: true, decline: true, surrender: false });
    expect(warActions(M, theirs).accept).toBe(false);
  });
});
