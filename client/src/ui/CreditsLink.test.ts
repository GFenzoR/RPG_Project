// The credits window of the desktop app (docs/17 A1) renders as a plain function: these
// tests walk its element tree, expanding the components (none of them has hooks).
import { describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import type { Credits } from "../content-types.ts";
import { CreditsLink, CreditsWindow } from "./CreditsLink.tsx";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Node = VNode<Record<string, unknown> & { children?: unknown }>;

/** Every element of a tree, function components expanded (they are hook-free here). */
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

const text = (n: unknown): string =>
  Array.isArray(n)
    ? n.map(text).join("")
    : typeof n === "string" || typeof n === "number"
      ? String(n)
      : n && typeof n === "object" && "props" in n
        ? text((n as Node).props.children)
        : "";

const credits: Credits = {
  packs: [
    {
      pack: "lpc",
      licences: ["CC-BY-SA 3.0"],
      url: "https://github.com/LiberatedPixelCup/example",
      perFile: true,
    },
  ],
  files: [
    {
      pack: "lpc",
      works: ["body/male.png"],
      authors: ["Someone"],
      licence: "OGA-BY 3.0",
      urls: ["https://opengameart.org/content/example"],
    },
  ],
  derived: [],
  fonts: [
    {
      family: "Cinzel",
      copyright: "Copyright 2020 The Cinzel Project Authors",
      licence: "OFL 1.1",
      url: "https://github.com/google/fonts/tree/main/ofl/cinzel",
    },
  ],
};

describe("CreditsWindow (desktop app)", () => {
  it("shows the whole credits page with every address as text, never a link", () => {
    const tree = CreditsWindow({
      t,
      load: { state: "ready", credits },
      site: "https://realm.example",
      onClose: () => {},
    });
    const all = nodes(tree);
    expect(all.some((n) => n.props["data-testid"] === "credits")).toBe(true);
    expect(all.filter((n) => n.type === "a")).toEqual([]);
    const shown = text(all.filter((n) => n.type === "span" || n.type === "code"));
    expect(shown).toContain("https://github.com/LiberatedPixelCup/example");
    expect(shown).toContain("https://creativecommons.org/licenses/by-sa/3.0/");
    expect(shown).toContain("https://openfontlicense.org/open-font-license-official-text/");
    const site = all.find((n) => n.props["data-testid"] === "credits-desktop");
    expect(text(site)).toContain("https://realm.example/credits");
  });

  it("says when it is loading or failed, and closes from its button or its backdrop", () => {
    const onClose = vi.fn();
    const loading = nodes(CreditsWindow({ t, load: { state: "loading" }, site: "", onClose }));
    expect(loading.some((n) => text(n) === "client.credits.loading")).toBe(true);
    expect(loading.some((n) => n.props["data-testid"] === "credits-desktop")).toBe(false);
    const failed = nodes(CreditsWindow({ t, load: { state: "failed" }, site: "", onClose }));
    expect(failed.some((n) => text(n) === "client.credits.failed")).toBe(true);
    const close = failed.find((n) => n.props["data-testid"] === "credits-close");
    (close?.props["onClick"] as () => void)();
    const backdrop = failed.find((n) => n.props["data-testid"] === "credits-window");
    const down = backdrop?.props["onPointerDown"] as (e: unknown) => void;
    down({ target: "inside", currentTarget: "backdrop" });
    expect(onClose).toHaveBeenCalledTimes(1);
    down({ target: "backdrop", currentTarget: "backdrop" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("CreditsLink", () => {
  it("links to the website's page in the browser", () => {
    const link = CreditsLink({ t, desktop: false });
    expect(link.type).toBe("a");
    expect(link.props).toMatchObject({ href: "/credits", target: "_blank" });
  });
});
