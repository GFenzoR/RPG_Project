// The card renders as a plain function (no hooks): these tests walk its tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ItemCardView } from "../state/item-card.ts";
import { ItemCard, cardTitle, typeText } from "./ItemCard.tsx";

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

/** Every string in the tree, in order. */
function texts(n: unknown, out: string[] = []): string[] {
  if (typeof n === "string" || typeof n === "number") out.push(String(n));
  else if (Array.isArray(n)) for (const c of n) texts(c, out);
  else if (n && typeof n === "object" && "props" in n) texts((n as Node).props.children, out);
  return out;
}

const card: ItemCardView = {
  itemId: 7,
  id: "iron_sword",
  count: 1,
  type: ["client.card.kind.weapon", "client.card.weapon.sword", "client.card.hands.one"],
  stats: [
    { id: "attack", value: 13 },
    { id: "weight", value: "33.00" },
  ],
  requires: [
    { id: "level", level: 5, met: false },
    { id: "vocations", vocations: ["guardian", "ranger"], met: true },
  ],
  effects: [{ id: "element", element: "ice" }],
  desc: "item.iron_sword.desc",
  marks: ["client.card.mark.no_market"],
};

describe("ItemCard (docs/17 UI-6)", () => {
  it("draws name, type, stats, requirements, effects, description and marks", () => {
    const tree = ItemCard({ t, card });
    const all = texts(tree);
    expect(all).toContain("item.iron_sword.name");
    expect(all).toContain(
      'client.card.type{"kind":"client.card.kind.weapon","detail":"client.card.weapon.sword, client.card.hands.one"}',
    );
    expect(all).toContain("client.card.stat.attack");
    expect(all).toContain("13");
    expect(all).toContain('client.card.oz{"oz":"33.00"}');
    expect(all).toContain('client.card.requires.level{"level":5}');
    expect(all).toContain(
      'client.card.requires.vocations{"vocations":"vocation.guardian.name, vocation.ranger.name"}',
    );
    expect(all).toContain('client.card.effect.element{"element":"client.card.element.ice"}');
    expect(all).toContain("item.iron_sword.desc");
    expect(all).toContain("client.card.mark.no_market");
    // An unmet requirement is marked (red in client.css), a met one too.
    const level = nodes(tree).find((n) => n.props["data-requirement"] === "level");
    expect(level?.props["class"]).toBe("unmet");
    const voc = nodes(tree).find((n) => n.props["data-requirement"] === "vocations");
    expect(voc?.props["class"]).toBe("met");
  });

  it("leaves the name out in the menu, which has it in its header", () => {
    const all = texts(ItemCard({ t, card, name: false }));
    expect(all).not.toContain("item.iron_sword.name");
  });

  it("names a stack with its count and an unknown item by its number", () => {
    expect(cardTitle(t, { ...card, count: 37 })).toBe(
      'client.card.count{"name":"item.iron_sword.name","count":37}',
    );
    expect(cardTitle(t, { ...card, id: "" })).toBe("7");
    expect(typeText(t, { ...card, type: ["client.card.kind.material"] })).toBe(
      "client.card.kind.material",
    );
    expect(typeText(t, { ...card, type: [] })).toBe("");
  });
});
