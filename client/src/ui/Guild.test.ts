// The guild panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { GuildAction, GuildRank } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { GuildView } from "../state/guild.ts";
import { GuildInvitations, GuildPanel } from "./Guild.tsx";

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
