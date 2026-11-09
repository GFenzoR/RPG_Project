// The house window renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { Game, GameUi } from "../game.ts";
import type { HouseView } from "../state/house.ts";
import { HouseWindow } from "./House.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const byAttr = (tree: unknown, attr: string, value?: string): Node[] =>
  nodes(tree).filter((v) => attr in v.props && (value === undefined || v.props[attr] === value));

function click(n: Node | undefined): void {
  (n?.props["onClick"] as (() => void) | undefined)?.();
}

function submit(form: Node | undefined, fields: Record<string, string>): void {
  const el = {
    elements: { namedItem: (name: string) => (name in fields ? { value: fields[name] } : null) },
    reset: () => {},
  };
  (form?.props["onSubmit"] as ((e: unknown) => void) | undefined)?.({
    preventDefault: () => {},
    currentTarget: el,
  });
}

function recorder(): { game: Game; sent: string[] } {
  const sent: string[] = [];
  const game = {
    houseRent: () => sent.push("rent"),
    houseExtend: () => sent.push("extend"),
    houseLeave: () => sent.push("leave"),
    houseGuest: (n: string, add: boolean) => sent.push(`${add ? "add" : "remove"} ${n}`),
    houseGuildAccess: (on: boolean) => sent.push(`guild ${on}`),
    houseTransfer: (n: string, p: number) => sent.push(`transfer ${n} ${p}`),
    houseTransferCancel: () => sent.push("transfer cancel"),
    houseAccept: (id: string, price: number) => sent.push(`accept ${id} ${price}`),
    houseEnter: () => sent.push("enter"),
    houseExit: () => sent.push("exit"),
    houseClose: () => sent.push("close"),
  } as unknown as Game;
  return { game, sent };
}

const house = (over: Partial<HouseView>): HouseView => ({
  id: "puerto_house_net",
  name: "house.puerto_house_net.name",
  island: "puerto",
  rent: 800,
  periodDays: 7,
  size: 32,
  owner: "",
  isOwner: false,
  paidUntil: 0,
  guests: [],
  guildAccess: false,
  maxGuests: 20,
  items: 0,
  maxItems: 96,
  minLevel: 12,
  maxPeriods: 4,
  transfer: undefined,
  money: 900,
  readOnly: false,
  access: false,
  inside: false,
  ...over,
});

const render = (h: HouseView | undefined, game: Game) =>
  HouseWindow({ t, game, ui: { house: h } as unknown as GameUi, now: 0 });

describe("HouseWindow", () => {
  it("is closed without a house", () => {
    expect(render(undefined, recorder().game)).toBeNull();
  });

  it("a free house offers renting only", () => {
    const { game, sent } = recorder();
    const tree = render(house({}), game);
    expect(byAttr(tree, "data-testid", "house-leave")).toHaveLength(0);
    click(byAttr(tree, "data-testid", "house-rent")[0]);
    click(byAttr(tree, "class", "close")[0]);
    expect(sent).toEqual(["rent", "close"]);
  });

  it("the owner manages guests, the guild, the transfer and leaving", () => {
    const { game, sent } = recorder();
    const tree = render(
      house({ owner: "Ana", isOwner: true, paidUntil: 86_400_000, guests: ["Beto"] }),
      game,
    );
    expect(byAttr(tree, "data-testid", "house-rent")).toHaveLength(0);
    click(byAttr(tree, "data-testid", "house-extend")[0]);
    click(byAttr(tree, "data-guest-remove", "Beto")[0]);
    submit(byAttr(tree, "class", "guest-add")[0], { name: " Cid " });
    (byAttr(tree, "data-testid", "house-guild")[0]?.props["onChange"] as (e: unknown) => void)({
      currentTarget: { checked: true },
    });
    submit(byAttr(tree, "class", "transfer")[0], { name: "Dora", price: "50" });
    click(byAttr(tree, "data-testid", "house-leave")[0]);
    expect(sent).toEqual([
      "extend",
      "remove Beto",
      "add Cid",
      "guild true",
      "transfer Dora 50",
      "leave",
    ]);
  });

  it("the character offered the house accepts it", () => {
    const { game, sent } = recorder();
    const tree = render(
      house({ owner: "Ana", transfer: { to: "Beto", price: 80, forMe: true } }),
      game,
    );
    click(byAttr(tree, "data-testid", "house-accept")[0]);
    expect(sent).toEqual(["accept puerto_house_net 80"]);
  });

  it("enter and exit", () => {
    const { game, sent } = recorder();
    click(
      byAttr(render(house({ owner: "Ana", access: true }), game), "data-testid", "house-enter")[0],
    );
    const inside = render(house({ owner: "Ana", access: true, inside: true }), game);
    expect(byAttr(inside, "data-testid", "house-enter")).toHaveLength(0);
    click(byAttr(inside, "data-testid", "house-exit")[0]);
    expect(sent).toEqual(["enter", "exit"]);
  });

  it("read-only shows the notice and no actions", () => {
    const tree = render(house({ readOnly: true }), recorder().game);
    expect(byAttr(tree, "data-testid", "house-read-only")).toHaveLength(1);
    expect(byAttr(tree, "data-testid", "house-rent")).toHaveLength(0);
  });
});
