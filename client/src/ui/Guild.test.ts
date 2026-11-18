// The guild panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { GuildAction, GuildRank } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { GuildView } from "../state/guild.ts";
import { GuildInvitations, GuildPanel } from "./Guild.tsx";
import type { GuildTab } from "./Guild.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

const content = {
  guild: { foundCost: 12000, foundMinLevel: 18, nameMax: 24, motdMax: 160 },
} as unknown as ClientContent;

interface Sent {
  action: GuildAction;
  name: string;
}

function fakeGame(sent: Sent[]): Game {
  return {
    guild: (action: GuildAction, name = "") => sent.push({ action, name }),
    guildWar: (action: GuildAction, name = "", warId = 0n) =>
      sent.push({ action, name: name || String(warId) }),
    guildAnswer: (id: bigint, accept: boolean) =>
      sent.push({ action: accept ? GuildAction.ACCEPT : GuildAction.DECLINE, name: String(id) }),
  } as unknown as Game;
}

function ui(guild: GuildView | undefined, selfName = "Ana"): GameUi {
  return { guild, guildInvitations: [], selfName } as unknown as GameUi;
}

/** Every element of the tree (components are not expanded: the panel has none). */
function nodes(n: unknown, out: VNode[] = []): VNode[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<{ children?: unknown }>;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

function text(n: unknown): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (n && typeof n === "object" && "props" in n) {
    return text((n as VNode<{ children?: unknown }>).props.children);
  }
  return "";
}

function buttons(tree: unknown): VNode<{ onClick?: () => void; children?: unknown }>[] {
  return nodes(tree).filter((v) => v.type === "button") as VNode<{
    onClick?: () => void;
    children?: unknown;
  }>[];
}

function memberButtons(tree: unknown, name: string): string[] {
  const li = nodes(tree).find(
    (v) => v.type === "li" && (v.props as Record<string, unknown>)["data-member"] === name,
  );
  return li ? buttons(li).map((b) => text(b.props.children)) : [];
}

const guild = (rank: GuildRank): GuildView => ({
  id: 4n,
  name: "Salt Lanterns",
  motd: "",
  rank,
  members: [
    { name: "Bruno", rank: GuildRank.LEADER, online: true },
    { name: "Vera", rank: GuildRank.VICE, online: false },
    { name: "Ana", rank, online: true },
    { name: "Milo", rank: GuildRank.MEMBER, online: true },
  ],
  pending: [{ name: "Ciro", until: 7_200_000 }],
  wars: [],
});

describe("GuildPanel", () => {
  it("offers to found a guild, with its cost and level, when the player has none", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: ui(undefined), now: 0 });
    const all = text(tree);
    expect(all).toContain("client.guild.empty");
    expect(all).toContain('client.guild.create_hint{"cost":12000,"level":18}');
    expect(nodes(tree).some((v) => v.type === "form")).toBe(true);
  });

  it("shows a leader every action on the others and none on itself", () => {
    const leaderUi = ui(
      {
        ...guild(GuildRank.LEADER),
        members: [
          { name: "Ana", rank: GuildRank.LEADER, online: true },
          { name: "Vera", rank: GuildRank.VICE, online: false },
          { name: "Milo", rank: GuildRank.MEMBER, online: true },
        ],
      },
      "Ana",
    );
    const sent: Sent[] = [];
    const tree = GuildPanel({ t, content, game: fakeGame(sent), ui: leaderUi, now: 0 });
    expect(memberButtons(tree, "Ana")).toEqual([]);
    expect(memberButtons(tree, "Vera")).toEqual([
      "client.guild.demote",
      "client.guild.transfer",
      "client.guild.kick",
    ]);
    expect(memberButtons(tree, "Milo")).toEqual([
      "client.guild.promote",
      "client.guild.transfer",
      "client.guild.kick",
    ]);
    const all = text(tree);
    expect(all).toContain('client.guild.members{"online":2,"count":3}');
    expect(all).toContain('client.guild.pending_entry{"name":"Ciro","hours":2}');
    expect(all).toContain("client.guild.motd_empty");
    const labels = buttons(tree).map((b) => text(b.props.children));
    expect(labels).toContain("client.guild.disband");
    expect(labels).toContain("client.guild.invite");
    expect(labels).not.toContain("client.guild.leave"); // the leader cannot leave

    buttons(tree)
      .find((b) => text(b.props.children) === "client.guild.promote")
      ?.props.onClick?.();
    buttons(tree)
      .find((b) => text(b.props.children) === "client.guild.revoke")
      ?.props.onClick?.();
    expect(sent).toEqual([
      { action: GuildAction.PROMOTE, name: "Milo" },
      { action: GuildAction.REVOKE, name: "Ciro" },
    ]);
  });

  it("shows a member only how to leave", () => {
    const g = { ...guild(GuildRank.MEMBER), pending: [] };
    const sent: Sent[] = [];
    const tree = GuildPanel({ t, content, game: fakeGame(sent), ui: ui(g), now: 0 });
    for (const name of ["Bruno", "Vera", "Ana", "Milo"])
      expect(memberButtons(tree, name)).toEqual([]);
    const labels = buttons(tree).map((b) => text(b.props.children));
    expect(labels).toEqual(["client.guild.leave"]);
    expect(nodes(tree).filter((v) => v.type === "form")).toEqual([]);
    buttons(tree)[0]?.props.onClick?.();
    expect(sent).toEqual([{ action: GuildAction.LEAVE, name: "" }]);
  });

  it("lets a vice leader kick members only and invite", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: ui(guild(GuildRank.VICE)), now: 0 });
    expect(memberButtons(tree, "Bruno")).toEqual([]);
    expect(memberButtons(tree, "Vera")).toEqual([]);
    expect(memberButtons(tree, "Milo")).toEqual(["client.guild.kick"]);
    const labels = buttons(tree).map((b) => text(b.props.children));
    expect(labels).toContain("client.guild.invite");
    expect(labels).not.toContain("client.guild.disband");
  });
});

describe("guild wars (T5.2)", () => {
  const wars = [
    {
      id: 7n,
      enemy: "Iron",
      active: false,
      declaredByUs: false,
      ours: 0,
      theirs: 0,
      limit: 30,
      until: 3_600_000,
    },
    {
      id: 8n,
      enemy: "Tide",
      active: true,
      declaredByUs: true,
      ours: 4,
      theirs: 2,
      limit: 30,
      until: 7_200_000,
    },
  ];

  it("lets the leader answer, surrender and declare", () => {
    const sent: Sent[] = [];
    const g = { ...guild(GuildRank.LEADER), wars };
    const tree = GuildPanel({ t, content, game: fakeGame(sent), ui: ui(g), now: 0 });
    const all = text(tree);
    expect(all).toContain('client.guild.war_pending_theirs{"guild":"Iron","hours":1}');
    expect(all).toContain(
      'client.guild.war_active{"guild":"Tide","ours":4,"theirs":2,"limit":30,"hours":2}',
    );
    for (const label of ["client.guild.war_accept", "client.guild.war_surrender"]) {
      buttons(tree)
        .find((b) => text(b.props.children) === label)
        ?.props.onClick?.();
    }
    expect(sent).toEqual([
      { action: GuildAction.WAR_ACCEPT, name: "7" },
      { action: GuildAction.WAR_SURRENDER, name: "8" },
    ]);
    expect(
      nodes(tree).some(
        (v) => (v.props as Record<string, unknown>)["data-testid"] === "guild-war-declare",
      ),
    ).toBe(true);
  });

  it("shows a member the score without buttons", () => {
    const g = { ...guild(GuildRank.MEMBER), pending: [], wars };
    const tree = GuildPanel({ t, content, game: undefined, ui: ui(g), now: 0 });
    expect(text(tree)).toContain("client.guild.war_active");
    expect(buttons(tree).map((b) => text(b.props.children))).toEqual(["client.guild.leave"]);
  });
});

describe("GuildInvitations", () => {
  it("answers an invitation", () => {
    const sent: Sent[] = [];
    const u = {
      guildInvitations: [{ guildId: 9n, guildName: "Iron", until: 1 }],
    } as unknown as GameUi;
    const tree = GuildInvitations({ t, game: fakeGame(sent), ui: u });
    expect(text(tree)).toContain('client.guild.invitation{"guild":"Iron"}');
    buttons(tree)[0]?.props.onClick?.();
    expect(sent).toEqual([{ action: GuildAction.ACCEPT, name: "9" }]);
  });
});

describe("GuildPanel in its own window (docs/17 UI-7)", () => {
  const memberUi = ui(guild(GuildRank.MEMBER), "Ana");
  const prop = (v: VNode, name: string): unknown => (v.props as Record<string, unknown>)[name];

  it("shows only the chosen tab, under the guild's name and its tab buttons", () => {
    const ids = (tab: GuildTab): unknown[] =>
      nodes(GuildPanel({ t, content, game: undefined, ui: memberUi, now: 0, tab }))
        .map((v) => prop(v, "data-testid"))
        .filter((id) => id !== undefined);
    expect(ids("summary")).toEqual(["guild-panel", "guild-motd", "guild-summary", "guild-leave"]);
    expect(ids("members")).toEqual(["guild-panel", "guild-motd"]);
    expect(ids("ranks")).toEqual(["guild-panel", "guild-motd", "guild-ranks"]);
    expect(ids("invite")).toEqual(["guild-panel", "guild-motd"]);
    expect(ids("wars")).toEqual(["guild-panel", "guild-motd"]);
    expect(ids("motd")).toEqual(["guild-panel", "guild-motd"]);
    // A member is told who invites and who writes the message.
    const inviteTab = GuildPanel({
      t,
      content,
      game: undefined,
      ui: memberUi,
      now: 0,
      tab: "invite",
    });
    expect(text(inviteTab)).toContain("client.guild.invite_rank");
    const motdTab = GuildPanel({ t, content, game: undefined, ui: memberUi, now: 0, tab: "motd" });
    expect(text(motdTab)).toContain("client.guild.motd_rank");
    const members = GuildPanel({
      t,
      content,
      game: undefined,
      ui: memberUi,
      now: 0,
      tab: "members",
    });
    expect(nodes(members).filter((v) => prop(v, "data-member") !== undefined)).toHaveLength(4);
    const wars = GuildPanel({ t, content, game: undefined, ui: memberUi, now: 0, tab: "wars" });
    expect(text(wars)).toContain("client.guild.no_wars");
  });

  it("switches tabs with its buttons and marks the chosen one", () => {
    const chosen: GuildTab[] = [];
    const tree = GuildPanel({
      t,
      content,
      game: undefined,
      ui: memberUi,
      now: 0,
      tab: "summary",
      onTab: (tab) => chosen.push(tab),
    });
    const tabs = buttons(tree).filter((b) => prop(b, "role") === "tab");
    expect(tabs.map((b) => text(b.props.children))).toEqual([
      "client.guild.tab.summary",
      "client.guild.tab.members",
      "client.guild.tab.ranks",
      "client.guild.tab.invite",
      "client.guild.tab.wars",
      "client.guild.tab.motd",
    ]);
    expect(tabs.map((b) => prop(b, "aria-selected"))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    tabs[1]?.props.onClick?.();
    expect(chosen).toEqual(["members"]);
  });

  it("keeps every section, without tab buttons, in the side panel of small screens", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: memberUi, now: 0 });
    expect(buttons(tree).some((b) => prop(b, "role") === "tab")).toBe(false);
    expect(text(tree)).not.toContain("client.guild.no_wars");
    expect(nodes(tree).map((v) => prop(v, "data-testid"))).toContain("guild-leave");
  });
});

describe("the guild window's buttons (docs/17 UI-7)", () => {
  const leaderUi = ui(guild(GuildRank.LEADER), "Ana");
  const prop = (v: VNode, name: string): unknown => (v.props as Record<string, unknown>)[name];

  it("Summary: the player's rank, members online and wars, and the way out", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: leaderUi, now: 0, tab: "summary" });
    const all = text(tree);
    expect(all).toContain("client.guild.your_rank");
    expect(all).toContain('client.guild.members_count{"online":3,"count":4}');
    expect(all).toContain('client.guild.wars_count{"active":0,"count":0}');
    expect(buttons(tree).map((b) => text(b.props.children))).toContain("client.guild.disband");
  });

  it("Ranks: who holds each rank and what it may do", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: leaderUi, now: 0, tab: "ranks" });
    const ranks = nodes(tree).filter((v) => prop(v, "data-rank") !== undefined);
    expect(ranks.map((v) => prop(v, "data-rank"))).toEqual([
      GuildRank.LEADER,
      GuildRank.VICE,
      GuildRank.MEMBER,
    ]);
    expect(text(ranks[0])).toContain("client.guild.rank_powers.leader");
    expect(text(ranks[0])).toContain("Ana");
    expect(text(ranks[1])).toContain("Vera");
    expect(text(ranks[2])).toContain("Milo");
  });

  it("Invite: the form and the invitations sent, for a leader", () => {
    const sent: Sent[] = [];
    const tree = GuildPanel({
      t,
      content,
      game: fakeGame(sent),
      ui: leaderUi,
      now: 0,
      tab: "invite",
    });
    expect(nodes(tree).some((v) => prop(v, "data-testid") === "guild-invite")).toBe(true);
    expect(text(tree)).toContain('client.guild.pending_entry{"name":"Ciro","hours":2}');
    // The members tab no longer holds the form.
    const members = GuildPanel({
      t,
      content,
      game: undefined,
      ui: leaderUi,
      now: 0,
      tab: "members",
    });
    expect(nodes(members).some((v) => prop(v, "data-testid") === "guild-invite")).toBe(false);
  });

  it("Message: the form for a leader", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: leaderUi, now: 0, tab: "motd" });
    expect(nodes(tree).some((v) => prop(v, "data-testid") === "guild-motd-form")).toBe(true);
  });

  it("a member's actions fold under its ⋯", () => {
    const tree = GuildPanel({ t, content, game: undefined, ui: leaderUi, now: 0, tab: "members" });
    const milo = nodes(tree).find((v) => prop(v, "data-member") === "Milo");
    const menu = nodes(milo).find((v) => v.type === "details");
    expect(menu).toBeDefined();
    expect(buttons(menu).map((b) => text(b.props.children))).toEqual([
      "client.guild.promote",
      "client.guild.transfer",
      "client.guild.kick",
    ]);
  });
});
