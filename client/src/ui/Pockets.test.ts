// The pockets' row of the inventory (docs/02 "Bolsillos") renders as a plain function (no
// hooks): this test walks its element tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { ItemRef } from "../state/items.ts";
import { NO_POCKETS } from "../state/pockets.ts";
import { PocketsRow } from "./Inventory.tsx";

const t = (key: string): string => key;
const content = {
  items: { 8: { id: "copper_coin", stackable: true }, 60: { id: "iron_sword" } },
} as unknown as ClientContent;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    out.push(v);
    if (typeof v.type === "function") nodes((v.type as (p: unknown) => unknown)(v.props), out);
    nodes(v.props.children, out);
  }
  return out;
}

const byAttr = (tree: unknown, attr: string): Node[] => nodes(tree).filter((v) => attr in v.props);

describe("PocketsRow", () => {
  it("draws one drop target per cell, its item with its card, menu and drag", () => {
    const pressed: ItemRef[] = [];
    const game = {
      itemIcon: () => undefined,
      pressItem: (ref: ItemRef) => pressed.push(ref),
    } as unknown as Game;
    const ui = {
      picked: undefined,
      pockets: {
        capacity: 4,
        items: [
          { itemId: 8, count: 23 },
          { itemId: 60, count: 0 },
        ],
      },
    } as unknown as GameUi;
    const tree = PocketsRow({ t, content, game, ui });
    const cells = byAttr(tree, "data-drop");
    expect(cells.map((c) => [c.props["data-drop"], c.props["data-index"]])).toEqual([
      ["pocket", 0],
      ["pocket", 1],
      ["pocket", 2],
      ["pocket", 3],
    ]);
    // Only the empty cells name themselves.
    expect(cells.map((c) => c.props["title"])).toEqual([
      undefined,
      undefined,
      "client.inventory.pocket",
      "client.inventory.pocket",
    ]);
    const items = byAttr(tree, "data-tip-item");
    expect(items.map((i) => [i.props["data-item"], i.props["data-tip-count"]])).toEqual([
      ["copper_coin", 23],
      ["iron_sword", 0],
    ]);
    (items[1]?.props["onPointerDown"] as (e: unknown) => void)({
      button: 0,
      preventDefault: () => {},
    });
    expect(pressed.map((r) => r.loc)).toEqual([{ kind: "pocket", index: 1 }]);
  });

  it("draws nothing before the server says how many cells there are", () => {
    const ui = { pockets: NO_POCKETS } as unknown as GameUi;
    expect(PocketsRow({ t, content, game: undefined, ui })).toBeNull();
  });
});
