// The appearance panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import { AppearancePanel } from "./Appearance.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

/** Expands function components (they have no hooks) so their output is walked too. */
function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    if (typeof v.type === "function") {
      nodes((v.type as (p: unknown) => unknown)(v.props), out);
      return out;
    }
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const content = {
  outfits: [
    { id: "citizen", sprite: "outfits/citizen", frames: 3 },
    { id: "sailor", sprite: "outfits/sailor", frames: 3 },
  ],
  cosmetics: [
    { id: "outfit_sailor", kind: "outfit", price: 300, outfit: "sailor" },
    { id: "color_tide", kind: "outfit_color", price: 120, tint: "#7fa8d8" },
    { id: "name_frost", kind: "name_effect", price: 250, style: "frost" },
  ],
} as unknown as ClientContent;

function recorder(): { game: Game; sent: string[] } {
  const sent: string[] = [];
  const game = {
    equipCosmetic: (id: string) => sent.push(`equip ${id}`),
    unequipCosmetic: (kind: string) => sent.push(`unequip ${kind}`),
  } as unknown as Game;
  return { game, sent };
}

const ui = (cosmetics: GameUi["cosmetics"]): GameUi => ({ cosmetics }) as unknown as GameUi;

const choices = (tree: unknown): Node[] => nodes(tree).filter((v) => "data-cosmetic" in v.props);
const choice = (tree: unknown, id: string): Node | undefined =>
  choices(tree).find((v) => v.props["data-cosmetic"] === id);

describe("AppearancePanel (T5.7)", () => {
  it("says there is nothing to wear without owned cosmetics", () => {
    const tree = AppearancePanel({ t, content, game: undefined, ui: ui(undefined) });
    const texts = nodes(tree).flatMap((v) =>
      typeof v.props.children === "string" ? [v.props.children] : [],
    );
    expect(texts).toContain("client.appearance.empty");
    expect(choices(tree)).toHaveLength(0);
  });

  it("lists the owned cosmetics by kind and equips or unequips", () => {
    const { game, sent } = recorder();
    const tree = AppearancePanel({
      t,
      content,
      game,
      ui: ui({
        owned: ["outfit_sailor", "name_frost", "gone_from_catalogue"],
        balance: 30,
        equipped: { outfit: "outfit_sailor", color: "", nameEffect: "" },
      }),
    });
    // Kinds with something owned only: outfit and name effect (no colour).
    expect(choices(tree).map((v) => v.props["data-cosmetic"])).toEqual([
      "default-outfit",
      "outfit_sailor",
      "default-name_effect",
      "name_frost",
    ]);
    expect(choice(tree, "outfit_sailor")?.props["aria-pressed"]).toBe(true);
    expect(choice(tree, "default-outfit")?.props["aria-pressed"]).toBe(false);
    expect(choice(tree, "default-name_effect")?.props["aria-pressed"]).toBe(true);
    (choice(tree, "name_frost")?.props["onClick"] as () => void)();
    (choice(tree, "default-outfit")?.props["onClick"] as () => void)();
    // Pressing what is already worn sends nothing.
    (choice(tree, "outfit_sailor")?.props["onClick"] as () => void)();
    expect(sent).toEqual(["equip name_frost", "unequip outfit"]);
  });
});
