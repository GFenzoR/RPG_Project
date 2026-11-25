// Options → Interface renders as a plain function (no hooks): walk the tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { InterfaceOptions } from "./InterfaceOptions.tsx";
import type { NameSize } from "../render/label-style.ts";

const t = (key: string): string => key;

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

const render = (nameSize: NameSize, onNameSize: (v: NameSize) => void = () => {}): unknown =>
  InterfaceOptions({
    t,
    uiScale: 1,
    textScale: 1,
    shake: true,
    chatOpacity: 50,
    bubbles: true,
    nameSize,
    onNameSize,
    onUiScale: () => {},
    onTextScale: () => {},
    onShake: () => {},
    onChatOpacity: () => {},
    onBubbles: () => {},
  });

const select = (tree: unknown): Node => {
  const found = nodes(tree).find((v) => v.props["data-testid"] === "name-size");
  if (!found) throw new Error("no name-size");
  return found;
};

describe("InterfaceOptions: name size (docs/17 UI-3)", () => {
  it("offers normal and large, with their labels, and shows the choice", () => {
    const tree = render("large");
    const s = select(tree);
    expect(s.props["value"]).toBe("large");
    const options = nodes(s.props.children).filter((n) => n.type === "option");
    expect(options.map((o) => o.props["value"])).toEqual(["normal", "large"]);
    expect(options.map((o) => o.props.children)).toEqual([
      "client.options.name_size_normal",
      "client.options.name_size_large",
    ]);
    const texts = nodes(tree).map((n) => n.props.children);
    expect(texts).toContain("client.options.name_size");
  });

  it("reports a known choice and ignores anything else", () => {
    const picked: NameSize[] = [];
    const s = select(render("large", (v) => void picked.push(v)));
    const change = s.props["onChange"] as (e: { currentTarget: { value: string } }) => void;
    change({ currentTarget: { value: "normal" } });
    change({ currentTarget: { value: "huge" } });
    expect(picked).toEqual(["normal"]);
  });
});
