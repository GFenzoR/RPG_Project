import { describe, expect, it } from "vitest";
import { h } from "preact";
import type { ComponentChildren, VNode } from "preact";
import { excerpt, parseInline, parseMarkdown } from "./markdown.ts";
import { Markdown } from "./Markdown.tsx";

describe("news markdown", () => {
  it("parses paragraphs, lists, bold and italics", () => {
    const blocks = parseMarkdown(
      "First line\njoined.\n\nIntro:\n- one **bold**\n- two *it*\n\nLast *word*.\n",
    );
    expect(blocks).toEqual([
      { kind: "p", spans: [{ text: "First line joined." }] },
      { kind: "p", spans: [{ text: "Intro:" }] },
      {
        kind: "ul",
        items: [
          [{ text: "one " }, { text: "bold", bold: true }],
          [{ text: "two " }, { text: "it", italic: true }],
        ],
      },
      { kind: "p", spans: [{ text: "Last " }, { text: "word", italic: true }, { text: "." }] },
    ]);
  });

  it("keeps unmatched markers as text", () => {
    expect(parseInline("2 * 3 = 6 and **open")).toEqual([{ text: "2 * 3 = 6 and **open" }]);
  });

  it("gives the first paragraph as an excerpt", () => {
    expect(excerpt("Hello **you**.\n\nMore.")).toBe("Hello you.");
    expect(excerpt("- only a list")).toBe("");
  });

  it("renders HTML in a post as text, never as markup", () => {
    const html = toHTML(h(Markdown, { source: '<img src=x onerror="alert(1)"> **<b>hi</b>**' }));
    expect(html).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>",
    );
  });
});

/** Tiny server-side render of a Preact tree: only elements without props and escaped text. */
function toHTML(node: ComponentChildren): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number")
    return String(node).replace(
      /[&<>"]/g,
      (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`,
    );
  if (Array.isArray(node)) return node.map(toHTML).join("");
  const v = node as VNode<{ children?: ComponentChildren; dangerouslySetInnerHTML?: unknown }>;
  if (v.props.dangerouslySetInnerHTML !== undefined) throw new Error("innerHTML used");
  if (typeof v.type === "function")
    return toHTML((v.type as (p: unknown) => ComponentChildren)(v.props));
  const inner = toHTML(v.props.children);
  return typeof v.type === "string" ? `<${v.type}>${inner}</${v.type}>` : inner;
}
