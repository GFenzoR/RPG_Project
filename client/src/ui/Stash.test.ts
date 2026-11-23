// The stash window renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons, and drop items on its lists, with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { StashResult } from "@rpg/protocol";
import type { StashUpdate } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { ItemRef } from "../state/items.ts";
import { NO_POCKETS } from "../state/pockets.ts";
import { stashFrom, stashResultKey } from "../state/stash.ts";
import type { StashCell, StashView } from "../state/stash.ts";
import { StashWindow } from "./Stash.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

const content = {
  items: {
    60: { id: "iron_sword", tradeable: true, stackable: false },
    66: { id: "backpack", tradeable: true },
    68: { id: "salve", tradeable: true, stackable: true },
    70: { id: "quest_note", tradeable: false },
  },
  attributes: {},
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

const byAttr = (tree: unknown, attr: string, value?: unknown): Node[] =>
  nodes(tree).filter((v) => attr in v.props && (value === undefined || v.props[attr] === value));

function recorder(): { game: Game; sent: string[] } {
  const sent: string[] = [];
  const game = {
    itemIcon: () => undefined,
    stashDeposit: (r: ItemRef, n: number) =>
      sent.push(`store ${JSON.stringify(r.loc)} ${r.itemId} ${n}`),
    stashWithdraw: (c: StashCell, n: number) =>
      sent.push(`take ${c.index} ${c.itemId} ${n}${c.mods ? ` ${c.mods.attribute}` : ""}`),
    stashClose: () => sent.push("close"),
  } as unknown as Game;
  return { game, sent };
}

const stash: StashView = {
  capacity: 30,
  cells: [
    { index: 0, itemId: 68, count: 12 },
    { index: 1, itemId: 60, count: 0, mods: { attribute: "attack", value: 2, refine: 1 } },
  ],
  chest: { x: 1, y: 2, z: 7 },
};

function ui(over: Partial<GameUi>): GameUi {
  return {
    containers: [],
    pockets: NO_POCKETS,
    backpack: {
      id: 3,
      itemId: 66,
      capacity: 4,
      items: [
        { itemId: 68, count: 5 },
        { itemId: 70, count: 0 },
      ],
      hasParent: false,
    },
    stash,
    ...over,
  } as unknown as GameUi;
}

function drop(target: Node | undefined, payload: string): void {
  (target?.props["onDrop"] as ((e: unknown) => void) | undefined)?.({
    preventDefault: () => {},
    dataTransfer: { getData: () => payload, setData: () => {} },
  });
}

function dragPayload(n: Node | undefined): string {
  let out = "";
  (n?.props["onDragStart"] as ((e: unknown) => void) | undefined)?.({
    preventDefault: () => {},
    dataTransfer: { setData: (_: string, v: string) => (out = v), getData: () => "" },
  });
  return out;
}

describe("StashWindow", () => {
  it("draws nothing without a stash", () => {
    expect(StashWindow({ t, content, game: undefined, ui: ui({ stash: undefined }) })).toBeNull();
  });

  it("lists the cells and the tradeable carried items, and moves them on click", () => {
    const { game, sent } = recorder();
    const tree = StashWindow({ t, content, game, ui: ui({}) });
    expect(
      nodes(tree).some((n) => n.props.children === `client.stash.cells{"used":2,"capacity":30}`),
    ).toBe(true);
    const take = byAttr(tree, "data-stash-take");
    expect(take).toHaveLength(2);
    (take[1]?.props["onClick"] as () => void)();
    // Only the salve is tradeable: the quest note never shows.
    const store = byAttr(tree, "data-stash-store");
    expect(store.map((n) => n.props["data-stash-store"])).toEqual(["salve"]);
    (store[0]?.props["onClick"] as () => void)();
    expect(sent).toEqual([
      "take 1 60 0 attack",
      `store {"kind":"container","id":3,"index":0} 68 5`,
    ]);
  });

  it("moves by dragging from one list onto the other", () => {
    const { game, sent } = recorder();
    const tree = StashWindow({ t, content, game, ui: ui({}) });
    const cells = byAttr(tree, "data-testid", "stash-cells")[0];
    const carried = byAttr(tree, "data-testid", "stash-carried")[0];
    const items = nodes(tree).filter((n) => n.props["draggable"] === true);
    const fromStash = dragPayload(items[0]);
    const fromPack = dragPayload(items[2]);
    drop(carried, fromStash);
    drop(cells, fromPack);
    drop(cells, fromStash); // onto its own list: nothing
    expect(sent).toEqual(["take 0 68 12", `store {"kind":"container","id":3,"index":0} 68 5`]);
  });

  it("closes", () => {
    const { game, sent } = recorder();
    const tree = StashWindow({ t, content, game, ui: ui({}) });
    (nodes(tree).find((n) => n.props["class"] === "close")?.props["onClick"] as () => void)();
    expect(sent).toEqual(["close"]);
  });
});

describe("stashFrom", () => {
  const update = (u: Partial<StashUpdate>): StashUpdate =>
    ({ open: true, capacity: 30, items: [], result: StashResult.OK, ...u }) as StashUpdate;

  it("builds the cells with their index and mods", () => {
    const r = stashFrom(
      update({
        items: [
          { itemId: 68, count: 3 } as never,
          { itemId: 60, count: 0, mods: { attribute: "armor", value: 2, refine: 0 } } as never,
        ],
        chest: { x: 5, y: 6, z: 7 } as never,
      }),
    );
    expect(r.refused).toBeUndefined();
    expect(r.view?.cells).toEqual([
      { index: 0, itemId: 68, count: 3 },
      { index: 1, itemId: 60, count: 0, mods: { attribute: "armor", value: 2, refine: 0 } },
    ]);
    expect(r.view?.chest).toEqual({ x: 5, y: 6, z: 7 });
  });

  it("closes, and names a refusal for the log", () => {
    expect(stashFrom(update({ open: false, result: StashResult.TOO_FAR }))).toEqual({
      view: undefined,
      refused: "client.stash.result.too_far",
    });
    expect(stashFrom(update({ result: StashResult.CHANGED })).refused).toBe(
      "client.stash.result.changed",
    );
    for (const r of Object.values(StashResult).filter(
      (v): v is StashResult => typeof v === "number",
    ))
      if (r !== StashResult.OK && r !== StashResult.UNSPECIFIED)
        expect(stashResultKey(r)).toMatch(/^client\.stash\.result\./);
  });
});
