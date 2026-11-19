// The reading window (docs/02 "Libros y cofres"): which items read, the pages kept inside
// the book, and the body walked without a DOM (like ui/Forge.test.ts).
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { bookOf, turnTo } from "../state/book.ts";
import { BookBody, bookTitle } from "./Book.tsx";

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

const byTestId = (tree: unknown, id: string): Node | undefined =>
  nodes(tree).find((v) => v.props["data-testid"] === id);

function text(n: unknown): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (n && typeof n === "object" && "props" in n) return text((n as Node).props.children);
  return "";
}

const base: ItemDef = {
  id: "",
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
};
const manifest = {
  title: "book.manifest.title",
  pages: ["book.manifest.page_1", "book.manifest.page_2", "book.manifest.page_3"],
};
const content = {
  items: {
    1: { ...base, id: "scroll_manifest", book: manifest, fixed: true },
    2: { ...base, id: "note", book: { title: "book.note.title", pages: ["book.note.page_1"] } },
    3: { ...base, id: "blank", book: { title: "book.blank.title", pages: [] } },
    4: { ...base, id: "iron_sword" },
    5: { ...base, id: "reward_chest", chest: true, fixed: true },
  },
} as unknown as ClientContent;

describe("the books the client reads (state/book.ts)", () => {
  it("knows a readable item by its book block with pages", () => {
    expect(bookOf(content, 1)).toBe(manifest);
    expect(bookOf(content, 2)?.pages).toHaveLength(1);
    expect(bookOf(content, 3)).toBeUndefined(); // no pages: nothing to read
    expect(bookOf(content, 4)).toBeUndefined();
    expect(bookOf(content, 5)).toBeUndefined(); // a chest asks the server
    expect(bookOf(content, 99)).toBeUndefined();
  });

  it("keeps the page inside the book", () => {
    expect(turnTo(manifest, -1)).toBe(0);
    expect(turnTo(manifest, 1)).toBe(1);
    expect(turnTo(manifest, 1.7)).toBe(1);
    expect(turnTo(manifest, 3)).toBe(2);
  });

  it("titles the window with the book's title", () => {
    expect(bookTitle(t, content, 1)).toBe("book.manifest.title");
    expect(bookTitle(t, content, 4)).toBe("");
  });
});

describe("the reading window's body (ui/Book.tsx)", () => {
  const body = (page: number, def = manifest, turned: number[] = []): unknown =>
    BookBody({ t, def, page, onPage: (p) => turned.push(p) });

  it("shows one page, its number and the buttons that turn it", () => {
    const tree = body(0);
    expect(text(byTestId(tree, "book-page"))).toBe("book.manifest.page_1");
    expect(text(byTestId(tree, "book-page-number"))).toBe('client.book.page{"page":1,"pages":3}');
    expect(byTestId(tree, "book-prev")?.props["disabled"]).toBe(true);
    expect(byTestId(tree, "book-next")?.props["disabled"]).toBe(false);
  });

  it("turns forward and back, never past the covers", () => {
    const turned: number[] = [];
    const first = body(0, manifest, turned);
    (byTestId(first, "book-next")?.props["onClick"] as () => void)();
    const middle = body(1, manifest, turned);
    expect(text(byTestId(middle, "book-page"))).toBe("book.manifest.page_2");
    (byTestId(middle, "book-prev")?.props["onClick"] as () => void)();
    (byTestId(middle, "book-next")?.props["onClick"] as () => void)();
    expect(turned).toEqual([1, 0, 2]);
    const last = body(7, manifest, turned);
    expect(text(byTestId(last, "book-page"))).toBe("book.manifest.page_3");
    expect(byTestId(last, "book-next")?.props["disabled"]).toBe(true);
    expect(byTestId(last, "book-prev")?.props["disabled"]).toBe(false);
  });

  it("has no page buttons for a single page", () => {
    const tree = body(0, { title: "book.note.title", pages: ["book.note.page_1"] });
    expect(text(byTestId(tree, "book-page"))).toBe("book.note.page_1");
    expect(byTestId(tree, "book-prev")).toBeUndefined();
    expect(byTestId(tree, "book-page-number")).toBeUndefined();
  });
});
