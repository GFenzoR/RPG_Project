// The look pickers render as a plain function (no hooks): these tests walk their element
// tree without a DOM and press their buttons.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { Look, LookTables } from "@rpg/renderer/look";
import type { LookOptions } from "../content-types.ts";
import { LookPickers } from "./LookPickers.tsx";
import { choosable, randomLook, startingLook } from "../state/look.ts";

const t = (key: string): string => key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

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

const OPTIONS: LookOptions = {
  builds: ["sturdy", "slender"],
  skins: ["pale", "fair", "tan"],
  hairStyles: ["bald", "short", "long"],
  hairColors: ["black", "red"],
  beards: ["none", "full"],
};
const TABLES: LookTables = {
  skins: { pale: 0xf6dcc8, fair: 0xecc4a2, tan: 0xd8a47c },
  hairColors: { black: 0x2e2a30, red: 0xb8502c },
  tints: {},
};
const LOOK: Look = {
  body: "sturdy",
  skin: "fair",
  hair: "short",
  hairColor: "black",
  beard: "none",
};

const choices = (tree: unknown): Node[] => nodes(tree).filter((v) => "data-look" in v.props);
const choice = (tree: unknown, id: string): Node | undefined =>
  choices(tree).find((v) => v.props["data-look"] === id);

describe("LookPickers (docs/02 Apariencia)", () => {
  it("offers every choice of every part, in order, the current one pressed", () => {
    const tree = LookPickers({
      t,
      options: OPTIONS,
      tables: TABLES,
      look: LOOK,
      onChange: () => {},
    });
    expect(choices(tree).map((v) => v.props["data-look"])).toEqual([
      "body:sturdy",
      "body:slender",
      "skin:pale",
      "skin:fair",
      "skin:tan",
      "hair:bald",
      "hair:short",
      "hair:long",
      "hairColor:black",
      "hairColor:red",
      "beard:none",
      "beard:full",
    ]);
    const pressed = choices(tree)
      .filter((v) => v.props["aria-pressed"] === true)
      .map((v) => v.props["data-look"]);
    expect(pressed).toEqual([
      "body:sturdy",
      "skin:fair",
      "hair:short",
      "hairColor:black",
      "beard:none",
    ]);
    // Styles by name, colours as swatches named for screen readers.
    expect(choice(tree, "hair:long")?.props.children).toBe("appearance.hair.long");
    expect(choice(tree, "skin:tan")?.props["aria-label"]).toBe("appearance.skin.tan");
    expect(choice(tree, "skin:tan")?.props["style"]).toEqual({ background: "#d8a47c" });
    expect(choice(tree, "hairColor:red")?.props["aria-label"]).toBe("appearance.hair_color.red");
    // No random button unless asked.
    expect(nodes(tree).some((v) => v.props["data-testid"] === "look-random")).toBe(false);
  });

  it("changes one part per press; the pressed choice sends nothing", () => {
    const sent: Look[] = [];
    const tree = LookPickers({
      t,
      options: OPTIONS,
      tables: TABLES,
      look: LOOK,
      onChange: (l) => sent.push(l),
    });
    (choice(tree, "hairColor:red")?.props["onClick"] as () => void)();
    (choice(tree, "body:slender")?.props["onClick"] as () => void)();
    (choice(tree, "beard:none")?.props["onClick"] as () => void)();
    expect(sent).toEqual([
      { ...LOOK, hairColor: "red" },
      { ...LOOK, body: "slender" },
    ]);
  });

  it("without the colour tables the swatches are names", () => {
    const tree = LookPickers({
      t,
      options: OPTIONS,
      tables: undefined,
      look: LOOK,
      onChange: () => {},
    });
    expect(choice(tree, "skin:tan")?.props.children).toBe("appearance.skin.tan");
  });

  it("a random button on the creation screen", () => {
    let rolled = 0;
    const tree = LookPickers({
      t,
      options: OPTIONS,
      tables: TABLES,
      look: LOOK,
      onChange: () => {},
      onRandom: () => rolled++,
    });
    const random = nodes(tree).find((v) => v.props["data-testid"] === "look-random");
    (random?.props["onClick"] as () => void)();
    expect(rolled).toBe(1);
  });
});

describe("where the pickers start", () => {
  it("from a preferred look part by part, else the first choice", () => {
    expect(startingLook(OPTIONS, LOOK)).toEqual(LOOK);
    expect(startingLook(OPTIONS, { ...LOOK, skin: "drowned", hair: "mohawk" })).toEqual({
      ...LOOK,
      skin: "pale",
      hair: "bald",
    });
    expect(startingLook(OPTIONS, undefined)).toEqual({
      body: "sturdy",
      skin: "pale",
      hair: "bald",
      hairColor: "black",
      beard: "none",
    });
  });

  it("a random look is always a player's choice", () => {
    let n = 0;
    const seq = [0, 0.999, 0.5, 0.25, 0.75, 0.1, 0.9];
    for (let i = 0; i < 20; i++) {
      const l = randomLook(OPTIONS, () => seq[n++ % seq.length] ?? 0);
      expect(choosable(OPTIONS, l)).toBe(true);
    }
    expect(randomLook(OPTIONS, () => 0.999).body).toBe("slender");
  });
});
