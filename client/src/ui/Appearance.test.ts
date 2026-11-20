// The appearance panel renders as a plain function (no hooks): these tests walk its element
// tree without a DOM and press its buttons with a fake Game.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import { AppearancePanel } from "./Appearance.tsx";
import { LookPreview } from "./LookPreview.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

/**
 * Expands function components (they have no hooks) so their output is walked too; the
 * figure (LookPreview, a canvas with state) stays a node.
 */
function nodes(n: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(n)) {
    for (const c of n) nodes(c, out);
  } else if (n && typeof n === "object" && "props" in n) {
    const v = n as Node;
    if (typeof v.type === "function" && v.type !== LookPreview) {
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

describe("AppearancePanel: Personalizar (docs/02 Apariencia)", () => {
  const MIRA = {
    sex: "female",
    body: "slender",
    skin: "olive",
    hair: "ponytail",
    hairColor: "auburn",
    beard: "none",
  };
  const looks = {
    ...content,
    lookOptions: {
      sexes: ["male", "female"],
      builds: ["sturdy", "slender"],
      skins: ["fair", "olive"],
      hairStyles: ["short", "ponytail"],
      hairColors: ["black", "auburn"],
      beards: ["none", "full"],
    },
    looks: { skins: { fair: 0xecc4a2, olive: 0xbc9068 }, hairColors: {}, tints: {} },
    items: {
      60: { id: "iron_sword", worn: { shape: "sword", tint: "iron" }, weapon: { type: "sword" } },
      61: { id: "stag_hood", worn: { shape: "hood", tint: "hide" }, armor: { slot: "head" } },
    },
  } as unknown as ClientContent;
  const lookUi = (extra: Partial<GameUi>): GameUi =>
    ({ cosmetics: undefined, look: MIRA, ...extra }) as unknown as GameUi;
  function lookGame(): { game: Game; sent: string[] } {
    const sent: string[] = [];
    const game = {
      setLookDraft: (l: unknown) => sent.push(`draft ${JSON.stringify(l)}`),
      applyLook: () => sent.push("apply"),
    } as unknown as Game;
    return { game, sent };
  }
  const byTestid = (tree: unknown, id: string): Node | undefined =>
    nodes(tree).find((v) => v.props["data-testid"] === id);

  it("shows nothing without the look choices or a look from the server", () => {
    expect(
      byTestid(
        AppearancePanel({ t, content, game: undefined, ui: lookUi({}) }),
        "appearance-customize",
      ),
    ).toBeUndefined();
    const noLook = lookUi({ look: undefined });
    expect(
      byTestid(
        AppearancePanel({ t, content: looks, game: undefined, ui: noLook }),
        "appearance-customize",
      ),
    ).toBeUndefined();
  });

  it("picks into a draft; saving sends it, undoing drops it", () => {
    const { game, sent } = lookGame();
    let tree = AppearancePanel({ t, content: looks, game, ui: lookUi({}) });
    expect(byTestid(tree, "appearance-customize")).toBeDefined();
    // The figure wears what the character shows (here the sword in its right hand).
    const withSword = AppearancePanel({
      t,
      content: looks,
      game,
      ui: lookUi({
        selfEquipment: { head: 61, torso: 0, legs: 0, feet: 0, leftHand: 0, rightHand: 60 },
      }),
    });
    const figure = nodes(withSword).find((v) => v.type === LookPreview);
    expect((figure?.props["worn"] as { weapon?: unknown }).weapon).toEqual({
      shape: "sword",
      tint: "iron",
    });
    expect(figure?.props["look"]).toEqual(MIRA);
    // Not the hood: it would hide the hair being picked.
    expect((figure?.props["worn"] as { head?: unknown }).head).toBeUndefined();
    // Nothing to save yet.
    expect(byTestid(tree, "look-apply")?.props["disabled"]).toBe(true);
    const red = nodes(tree).find((v) => v.props["data-look"] === "hairColor:black");
    (red?.props["onClick"] as () => void)();
    expect(sent).toEqual([`draft ${JSON.stringify({ ...MIRA, hairColor: "black" })}`]);

    // With a draft: the figure shows it, saving and undoing are on.
    const draft = { ...MIRA, hairColor: "black" };
    tree = AppearancePanel({ t, content: looks, game, ui: lookUi({ lookDraft: draft }) });
    expect(nodes(tree).find((v) => v.type === LookPreview)?.props["look"]).toEqual(draft);
    expect(byTestid(tree, "look-apply")?.props["disabled"]).toBe(false);
    (byTestid(tree, "look-apply")?.props["onClick"] as () => void)();
    (byTestid(tree, "look-revert")?.props["onClick"] as () => void)();
    // Picking back the look it has drops the draft.
    const back = nodes(tree).find((v) => v.props["data-look"] === "hairColor:auburn");
    (back?.props["onClick"] as () => void)();
    expect(sent.slice(1)).toEqual(["apply", "draft undefined", "draft undefined"]);
  });
});
