// The characters screen's parts without hooks (docs/02 "Cuentas" and "Equipo inicial"):
// the list and the vocation's line render as plain functions, walked without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent } from "../content-types.ts";
import { CharacterList, VocationInfo } from "./App.tsx";

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}(${JSON.stringify(params)})` : key;
const content = { vocations: ["guardian", "ranger"] } as unknown as ClientContent;

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

const text = (tree: unknown): string =>
  nodes(tree)
    .flatMap((v) => {
      const c = v.props.children;
      return (Array.isArray(c) ? c : [c]).filter(
        (x) => typeof x === "string" || typeof x === "number",
      );
    })
    .join(" ");

describe("CharacterList", () => {
  const list = [
    { id: 1, name: "Ana", vocation: "guardian", level: 7 },
    { id: 2, name: "Bea", vocation: "ranger", level: 1 },
  ];
  it("shows name, vocation, level and Jugar for each, and marks the new one", () => {
    const played: number[] = [];
    const tree = CharacterList({
      t,
      content,
      list,
      created: 2,
      busy: false,
      clothes: {},
      onPlay: (c) => played.push(c.id),
    });
    const rows = nodes(tree).filter((v) => v.type === "li");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.props["data-created"]).toBe("");
    expect(rows[0]?.props["data-created"]).toBeUndefined();
    const s = text(tree);
    expect(s).toContain("Ana");
    expect(s).toContain("vocation.guardian.name");
    expect(s).toContain('client.characters.level({"level":7})');
    const buttons = nodes(tree).filter((v) => v.type === "button");
    expect(buttons.map((b) => text(b))).toEqual([
      "client.characters.play",
      "client.characters.play",
    ]);
    (buttons[1]?.props["onClick"] as () => void)();
    expect(played).toEqual([2]);
  });

  it("says so when there are none", () => {
    const tree = CharacterList({
      t,
      content,
      list: [],
      created: undefined,
      busy: false,
      clothes: {},
      onPlay: () => {},
    });
    expect(text(tree)).toBe("client.characters.empty");
  });
});

describe("VocationInfo", () => {
  const kits = {
    guardian: [
      { item: "rusty_cutlass", count: 1 },
      { item: "patched_tunic", count: 1 },
    ],
    ranger: [
      { item: "short_bow", count: 1 },
      { item: "arrow", count: 60 },
      { item: "patched_tunic", count: 1 },
    ],
  };
  it("shows the style line and the class's own starting gear", () => {
    const s = text(VocationInfo({ t, vocation: "ranger", kits }));
    expect(s).toContain("vocation.ranger.desc");
    expect(s).toContain(
      'client.characters.kit({"items":"item.short_bow.name, 60 × item.arrow.name"})',
    );
    expect(s).not.toContain("patched_tunic");
  });
  it("has no kit line without kits (fixtures)", () => {
    const tree = VocationInfo({ t, vocation: "guardian", kits: undefined });
    expect(nodes(tree).some((v) => v.props["data-testid"] === "vocation-kit")).toBe(false);
  });
});
