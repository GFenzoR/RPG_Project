// LoadStatus renders as a plain function (no hooks): walk the tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { LoadStatus } from "./LoadStatus.tsx";

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

const texts = (tree: unknown): string[] =>
  nodes(tree).flatMap((v) => (typeof v.props.children === "string" ? [v.props.children] : []));

describe("LoadStatus", () => {
  it("says it is connecting while the canvas starts", () => {
    const tree = LoadStatus({ t, failed: false, retry: () => {} });
    expect(texts(tree)).toEqual(["client.game.connecting"]);
    expect(nodes(tree).some((v) => v.props["data-testid"] === "load-retry")).toBe(false);
  });

  it("shows the error and a retry button when the atlas did not load", () => {
    let retried = 0;
    const tree = LoadStatus({ t, failed: true, retry: () => retried++ });
    const box = nodes(tree).find((v) => v.props["data-testid"] === "load-failed");
    expect(box?.props["role"]).toBe("alert");
    expect(texts(tree)).toEqual(["client.game.load_failed", "client.game.load_retry"]);
    const button = nodes(tree).find((v) => v.props["data-testid"] === "load-retry");
    expect(button?.type).toBe("button");
    (button?.props["onClick"] as () => void)();
    expect(retried).toBe(1);
  });
});
