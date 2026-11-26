// The party panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { CREATURE_NAME_MAX_CHARS } from "@rpg/content-schema/npc-role";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { SharedExperience } from "@rpg/protocol";
import type { Game, GameUi } from "../game.ts";
import type { PartyView } from "../state/party.ts";
import { PartyInvite, PartyPanel } from "./Party.tsx";

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

function panel(
  party: PartyView | undefined,
  sent: boolean[] = [],
  partyInviting = false,
): VNode<Props>[] {
  const game = { partyShare: (on: boolean) => sent.push(on) } as unknown as Game;
  const ui = { party, selfId: 1, partyInviting } as unknown as GameUi;
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

  it("offers Invitar without a party and to the leader only", () => {
    const invite = (all: VNode<Props>[]) => all.filter((v) => v.type === PartyInvite);
    expect(invite(panel(undefined))).toHaveLength(1);
    const party = (leaderId: number): PartyView => ({
      leaderId,
      shared: SharedExperience.OFF,
      bonusPercent: 0,
      members: [member(1, false), member(2, false)],
    });
    expect(invite(panel(party(1)))).toHaveLength(1);
    expect(invite(panel(party(2)))).toHaveLength(0);
    // The open state comes from Game.
    expect(invite(panel(undefined, [], true))[0]?.props["open"]).toBe(true);
  });
});

describe("PartyInvite", () => {
  function recorder(): {
    game: Pick<Game, "partyInvitePrompt" | "partyInviteByName">;
    sent: string[];
  } {
    const sent: string[] = [];
    return {
      sent,
      game: {
        partyInvitePrompt: (open: boolean) => sent.push(open ? "open" : "close"),
        partyInviteByName: (name: string) => sent.push(`invite ${name}`),
      },
    };
  }

  function submit(form: VNode<Props> | undefined, value: string | undefined): boolean {
    let prevented = false;
    const field = value === undefined ? null : { value };
    (form?.props["onSubmit"] as ((e: unknown) => void) | undefined)?.({
      preventDefault: () => (prevented = true),
      currentTarget: { elements: { namedItem: (n: string) => (n === "name" ? field : null) } },
    });
    return prevented;
  }

  function key(
    form: VNode<Props> | undefined,
    k: string,
  ): { prevented: boolean; stopped: boolean } {
    const r = { prevented: false, stopped: false };
    (form?.props["onKeyDown"] as ((e: unknown) => void) | undefined)?.({
      key: k,
      preventDefault: () => (r.prevented = true),
      stopPropagation: () => (r.stopped = true),
    });
    return r;
  }

  it("closed, is a button that opens the prompt", () => {
    const { game, sent } = recorder();
    const all = nodes(PartyInvite({ t, game, open: false }));
    expect(byTestId(all, "party-invite-prompt")).toBeUndefined();
    const button = byTestId(all, "party-invite");
    expect(text(button)).toBe("client.party.invite");
    button?.props.onClick?.();
    expect(sent).toEqual(["open"]);
  });

  it("open, asks for a character name: a text field that fits a name, focused", () => {
    const { game } = recorder();
    const all = nodes(PartyInvite({ t, game, open: true }));
    expect(byTestId(all, "party-invite")).toBeUndefined();
    const input = byTestId(all, "party-invite-name");
    expect(input?.props["name"]).toBe("name");
    expect(input?.props["type"]).toBe("text");
    expect(input?.props["maxLength"]).toBe(CREATURE_NAME_MAX_CHARS);
    expect(input?.props["aria-label"]).toBe("client.party.invite_name");
    expect(input?.props["enterKeyHint"]).toBe("send");
    // A stable ref: it focuses the field once, not on every update.
    const again = byTestId(nodes(PartyInvite({ t, game, open: true })), "party-invite-name");
    // Preact keeps a ref on the vnode, not in its props.
    const ref = (input as { ref?: unknown } | undefined)?.ref;
    expect(typeof ref).toBe("function");
    expect((again as { ref?: unknown } | undefined)?.ref).toBe(ref);
    let focused = 0;
    (ref as (el: unknown) => void)({ focus: () => focused++ });
    expect(focused).toBe(1);
  });

  it("sends the typed name on submit (Enter or Invitar), never an empty one", () => {
    const { game, sent } = recorder();
    const form = byTestId(nodes(PartyInvite({ t, game, open: true })), "party-invite-prompt");
    expect(form?.type).toBe("form");
    expect(submit(form, "Bruno Holt")).toBe(true); // no page reload
    submit(form, "   ");
    submit(form, undefined);
    expect(sent).toEqual(["invite Bruno Holt"]);
    const send = byTestId(nodes(PartyInvite({ t, game, open: true })), "party-invite-send");
    expect(send?.props["type"]).toBe("submit");
  });

  it("closes on Escape or Cancelar without sending", () => {
    const { game, sent } = recorder();
    const all = nodes(PartyInvite({ t, game, open: true }));
    const form = byTestId(all, "party-invite-prompt");
    expect(key(form, "a")).toEqual({ prevented: false, stopped: false });
    // Escape stays in the prompt: it does not also close the window around it.
    expect(key(form, "Escape")).toEqual({ prevented: true, stopped: true });
    byTestId(all, "party-invite-cancel")?.props.onClick?.();
    expect(sent).toEqual(["close", "close"]);
  });
});
