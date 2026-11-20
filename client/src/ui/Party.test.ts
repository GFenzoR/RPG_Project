// The party panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { SharedExperience } from "@rpg/protocol";
import type { Game, GameUi } from "../game.ts";
import type { PartyView } from "../state/party.ts";
import { PartyPanel } from "./Party.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Props = Record<string, unknown> & { children?: unknown; onClick?: () => void };

function nodes(n: unknown, out: VNode<Props>[] = []): VNode<Props>[] {
  if (Array.isArray(n)) for (const c of n) nodes(c, out);
  else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const text = (v: VNode<Props> | undefined): string =>
  nodes(v)
    .flatMap((n) => [n.props.children].flat())
    .filter((c): c is string => typeof c === "string")
    .join("|");

const member = (id: number, sharing: boolean) => ({
  id,
  name: `p${id}`,
  vocation: "guardian",
  level: 10,
  inView: true,
  health: 90,
  mana: 50,
  island: "puerto",
  sharing,
});

function panel(party: PartyView | undefined, sent: boolean[] = []): VNode<Props>[] {
  const game = { partyShare: (on: boolean) => sent.push(on) } as unknown as Game;
  const ui = { party, selfId: 1 } as unknown as GameUi;
  return nodes(PartyPanel({ t, game, ui }));
}

const byTestId = (all: VNode<Props>[], id: string) =>
  all.find((v) => v.props["data-testid"] === id);

describe("PartyPanel", () => {
  it("shows the bonus % and how many share while it is active, and who shares", () => {
    const all = panel({
      leaderId: 1,
      shared: SharedExperience.ACTIVE,
      bonusPercent: 10,
      members: [member(1, true), member(2, true), member(3, true), member(4, false)],
    });
    const bonus = byTestId(all, "party-bonus");
    expect(bonus?.props["data-percent"]).toBe(10);
    expect(text(bonus)).toBe('client.party.bonus{"percent":10,"count":3}');
    const sharing = all.filter((v) => v.props["class"] === "tag sharing");
    expect(sharing).toHaveLength(3);
    expect(byTestId(all, "party-help")).toBeDefined();
  });

  it("shows no bonus while sharing is inactive or off, and the leader can turn it on", () => {
    const sent: boolean[] = [];
    for (const shared of [SharedExperience.INACTIVE, SharedExperience.OFF]) {
      const all = panel(
        { leaderId: 1, shared, bonusPercent: 0, members: [member(1, false), member(2, false)] },
        sent,
      );
      expect(byTestId(all, "party-bonus")).toBeUndefined();
      byTestId(all, "party-share")?.props.onClick?.();
    }
    // On (inactive) the button turns it off; off, it turns it on.
    expect(sent).toEqual([false, true]);
  });

  it("explains what a party gives when the player has none", () => {
    const all = panel(undefined);
    expect(text(byTestId(all, "party-help"))).toBe("client.party.help");
    expect(byTestId(all, "party-bonus")).toBeUndefined();
  });
});
