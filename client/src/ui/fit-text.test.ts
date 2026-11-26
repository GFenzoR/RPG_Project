// A name in the interface never shows cut (docs/17 UI-3 "Nombres"): the fitting, on a fake
// element whose text is as wide as its letters at its font size, and what the style sheets
// and the components have to do for it to work.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { FIT_MIN_PX, fitText, fitTextRef } from "./fit-text.ts";
import type { FitElement } from "./fit-text.ts";
import { ExperienceBar } from "./Vitals.tsx";
import { ActionMenu } from "./ActionMenu.tsx";

const BASE = 13.6; // .vname: 0.85rem

/** An element of `room` px whose text measures `advance` em per letter, like a browser. */
function fake(
  text: string,
  room: number,
  advance = 0.7,
): FitElement & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  const style = { fontSize: "" };
  const px = (): number => (style.fontSize === "" ? BASE : Number.parseFloat(style.fontSize));
  return {
    style,
    attrs,
    get scrollWidth() {
      // A browser never reports less than the box, and rounds.
      return Math.max(room, Math.round(text.length * advance * px()));
    },
    clientWidth: room,
    setAttribute: (k, v) => void attrs.set(k, v),
    removeAttribute: (k) => void attrs.delete(k),
  };
}
const base = (): number => BASE;

describe("fitText", () => {
  it("leaves a name that fits at the style sheet's size", () => {
    const el = fake("Aldric Varn", 300);
    expect(fitText(el, base)).toEqual({ fontPx: BASE, wrapped: false });
    expect(el.style.fontSize).toBe("");
    expect(el.attrs.has("data-fit")).toBe(false);
  });

  it("shrinks a name of 20 letters (the old limit) until it fits, whole", () => {
    const name = "Maximiliano Santiago";
    expect(name).toHaveLength(20);
    const el = fake(name, 150);
    const fit = fitText(el, base);
    expect(fit.wrapped).toBe(false);
    expect(fit.fontPx).toBeLessThan(BASE);
    expect(fit.fontPx).toBeGreaterThanOrEqual(FIT_MIN_PX);
    expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
    expect(el.style.fontSize).toBe(`${fit.fontPx}px`);
    // No more than it has to: a tenth of a pixel bigger would not fit, or nearly.
    expect(name.length * 0.7 * (fit.fontPx + 0.3)).toBeGreaterThan(150);
  });

  it("never goes under the floor: a name too wide even there is marked to wrap", () => {
    const el = fake("Mmmmmmmmmm Wwwwwwwww", 60, 1);
    expect(fitText(el, base)).toEqual({ fontPx: FIT_MIN_PX, wrapped: true });
    expect(el.attrs.get("data-fit")).toBe("wrap");
  });

  it("starts again from the style sheet's size when the room grew", () => {
    const el = fake("Maximiliano Santiago", 150);
    fitText(el, base);
    expect(el.style.fontSize).not.toBe("");
    // The same element in a wider box: its old inline size and mark are dropped first.
    const again = fake("Maximiliano Santiago", 400);
    again.style.fontSize = el.style.fontSize;
    again.attrs.set("data-fit", "wrap");
    expect(fitText(again, base)).toEqual({ fontPx: BASE, wrapped: false });
    expect(again.style.fontSize).toBe("");
    expect(again.attrs.has("data-fit")).toBe(false);
  });

  it("does nothing with an element that is not laid out", () => {
    const el = fake("Aldric", 0);
    expect(fitText(el, () => Number.NaN)).toEqual({ fontPx: 0, wrapped: false });
  });
});

// ---- The places a name shows in the DOM ---------------------------------------------------

const sheet = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** The bodies of every rule whose selector list is exactly `selector`. */
function rules(css: string, selector: string): string[] {
  const out: string[] = [];
  const head = `\n${selector} {`;
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1))
    out.push(css.slice(at + head.length, css.indexOf("}", at)));
  return out;
}

const NAMES: [file: string, selector: string][] = [
  ["windows.css", ".vname"],
  ["client.css", ".hud .name"],
  ["touch.css", ".touch-menu-title"],
  ["touch.css", ".touch-menu-name"],
];

describe("the names of the interface", () => {
  it.each(NAMES)("%s %s never cuts a name with an ellipsis or a hidden overflow", (file, sel) => {
    const bodies = rules(sheet(file), sel);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/text-overflow/);
      expect(body).not.toMatch(/overflow:\s*(hidden|clip)/);
    }
  });

  it.each([
    ["windows.css", '.vname[data-fit="wrap"]'],
    ["client.css", '.hud .name[data-fit="wrap"]'],
    ["touch.css", '.touch-menu-name[data-fit="wrap"]'],
  ])("%s lets %s break onto more lines, at any letter", (file, sel) => {
    const [body] = rules(sheet(file), sel);
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  type Node = VNode<Record<string, unknown> & { children?: unknown }>;
  function nodes(n: unknown, out: Node[] = []): Node[] {
    if (Array.isArray(n)) for (const c of n) nodes(c, out);
    else if (n && typeof n === "object" && "props" in n) {
      out.push(n as Node);
      nodes((n as Node).props.children, out);
    }
    return out;
  }
  const t = (key: string): string => key;
  const old = "Maximiliano Santiago"; // 20 letters: a character from before the limit of 16

  it("fits the name plate's name, keyed by its text", () => {
    const tree = ExperienceBar({ t, name: old, stats: undefined, levelUp: false });
    const name = nodes(tree).find((n) => n.props["class"] === "vname");
    expect(name?.props.children).toBe(old);
    expect(name?.ref).toBe(fitTextRef);
    expect(name?.key).toBe(old);
  });

  it("fits the title of the action menu, keyed by its text", () => {
    const tree = ActionMenu({
      t,
      game: undefined,
      menu: { x: 10, y: 10, title: "lobo gris del monte", actions: ["look"] },
      viewport: { width: 400, height: 800 },
    } as unknown as Parameters<typeof ActionMenu>[0]);
    const name = nodes(tree).find((n) => String(n.props["class"]).startsWith("touch-menu-name"));
    expect(name?.props.children).toBe("lobo gris del monte");
    expect(name?.ref).toBe(fitTextRef);
    expect(name?.key).toBe("lobo gris del monte");
  });

  it("fits the compact header's name, keyed by its text", () => {
    const src = readFileSync(new URL("./GameView.tsx", import.meta.url), "utf8");
    expect(src).toMatch(
      /<span\s+class="name"\s+key=\{props\.characterName\}\s+ref=\{fitTextRef\}\s+title=\{props\.characterName\}\s*>/,
    );
  });
});
