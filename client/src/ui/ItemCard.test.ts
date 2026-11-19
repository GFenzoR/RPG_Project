// The card renders as a plain function (no hooks): these tests walk its tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ItemCardView } from "../state/item-card.ts";
import {
  BigIcon,
  ItemCard,
  TipCard,
  bigIconScale,
  cardTitle,
  nameClass,
  typeText,
} from "./ItemCard.tsx";

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

describe("TipCard (docs/17 UI-6: the tooltip in the Diablo II style)", () => {
  it("writes one line each, the description last, without an icon", () => {
    const icon = { url: "a.png", x: 0, y: 0, width: 32, height: 32 };
    const tree = ItemCard({ t, card, icon, tip: true });
    const all = texts(tree);
    expect(all[0]).toBe("item.iron_sword.name");
    expect(all.at(-1)).toBe("item.iron_sword.desc");
    expect(all.indexOf("client.card.mark.no_market")).toBeLessThan(
      all.indexOf("item.iron_sword.desc"),
    );
    expect(all).toContain('client.card.stat_line{"stat":"client.card.stat.attack","value":"13"}');
    expect(all).toContain(
      `client.card.stat_line${JSON.stringify({
        stat: "client.card.stat.weight",
        value: 'client.card.oz{"oz":"33.00"}',
      })}`,
    );
    const all2 = nodes(tree);
    expect(all2.some((n) => String(n.props["class"] ?? "").includes("big-icon"))).toBe(false);
    expect(all2[0]?.props["class"]).toBe("item-card tip");
    expect(all2[0]?.props["data-testid"]).toBe("item-card");
    // The unmet requirement is red (client.css), the effect blue.
    const level = all2.find((n) => n.props["data-requirement"] === "level");
    expect(level?.props["class"]).toBe("unmet");
    expect(TipCard({ t, card })).toBeTruthy();
  });

  it("writes the weight of a whole stack after the unit's", () => {
    const stack: ItemCardView = {
      ...card,
      count: 10,
      stats: [{ id: "weight", value: "0.50", total: "5.00" }],
    };
    expect(texts(TipCard({ t, card: stack }))).toContain(
      `client.card.stat_line${JSON.stringify({
        stat: "client.card.stat.weight",
        value: 'client.card.oz{"oz":"0.50"} client.card.weight_total{"oz":"5.00"}',
      })}`,
    );
  });

  it("colours the name: plain, a quest item's, money's", () => {
    expect(nameClass(card)).toBe("card-name");
    expect(nameClass({ ...card, quest: true })).toBe("card-name quest");
    expect(nameClass({ ...card, currency: true })).toBe("card-name coin");
    const coin = nodes(TipCard({ t, card: { ...card, currency: true } })).find(
      (n) => n.props["class"] === "card-name coin",
    );
    expect(coin).toBeDefined();
  });
});

describe("BigIcon", () => {
  const icon = (width: number, height: number) => ({ url: "a.png", x: 0, y: 0, width, height });

  it("draws at 2x, or at the whole scale that fits a square", () => {
    expect(bigIconScale(icon(32, 32))).toBe(2);
    expect(bigIconScale(icon(64, 64))).toBe(2);
    // An NPC portrait fits 64 px: Dungeon Crawl's 32 px at 2x, an LPC character at 1x.
    expect(bigIconScale(icon(32, 32), 64)).toBe(2);
    expect(bigIconScale(icon(64, 64), 64)).toBe(1);
    expect(bigIconScale(icon(16, 16), 64)).toBe(4);
    expect(bigIconScale(icon(32, 64), 64)).toBe(1);
    // Never under 1x, even when the sprite is larger than the box.
    expect(bigIconScale(icon(96, 96), 64)).toBe(1);
  });

  it("sizes its box and scales the sprite to match", () => {
    const fitted = BigIcon({ icon: icon(64, 64), fit: 64 }) as unknown as Node;
    expect(fitted.props["style"]).toEqual({ width: "64px", height: "64px" });
    const inner = nodes(fitted.props.children)[0];
    expect(inner?.props["style"]).toMatchObject({ width: "64px", transform: "scale(1)" });
    const double = BigIcon({ icon: icon(32, 32) }) as unknown as Node;
    expect(double.props["style"]).toEqual({ width: "64px", height: "64px" });
    // 2x is client.css's .big-icon > span, with no inline transform.
    expect(nodes(double.props.children)[0]?.props["style"]).not.toHaveProperty("transform");
  });
});

// docs/02 "Atributos de items": the attribute's line, in its own colour, under the stats.
describe("ItemCard's attribute line", () => {
  const rolled: ItemCardView = { ...card, attribute: { text: "attribute.attack", value: 3 } };
  it("both forms draw it after the stats, with its value", () => {
    for (const tree of [ItemCard({ t, card: rolled }), TipCard({ t, card: rolled })]) {
      const line = nodes(tree).find((n) => n.props["data-testid"] === "card-attribute");
      expect(line?.props["class"]).toBe("card-attribute");
      expect(texts(line)).toEqual(['attribute.attack{"value":3}']);
      const all = nodes(tree);
      const stats = all.findIndex(
        (n) => n.props["class"] === "card-stats" || n.props["class"] === "tip-stats",
      );
      const req = all.findIndex((n) => n.props["class"] === "card-requires");
      expect(stats).toBeGreaterThanOrEqual(0);
      expect(all.indexOf(line as Node)).toBeGreaterThan(stats);
      expect(all.indexOf(line as Node)).toBeLessThan(req);
    }
  });
  it("an equipable that rolls when made says so, dimmer; a card without one has no line", () => {
    const shop: ItemCardView = { ...card, attribute: { random: true } };
    const line = nodes(TipCard({ t, card: shop })).find(
      (n) => n.props["data-testid"] === "card-attribute",
    );
    expect(line?.props["class"]).toBe("card-attribute random");
    expect(texts(line)).toEqual(["client.card.attribute_random"]);
    expect(
      nodes(ItemCard({ t, card })).some((n) => n.props["data-testid"] === "card-attribute"),
    ).toBe(false);
  });
});
