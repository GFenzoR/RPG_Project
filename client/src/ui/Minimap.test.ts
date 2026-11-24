// The minimap's marks render without hooks: walk the tree without a DOM.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { Direction } from "@rpg/protocol";
import { MinimapMarks, facingDegrees } from "./Minimap.tsx";
import type { MinimapUi } from "../game.ts";

type Props = Record<string, unknown> & { children?: unknown };
const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

function nodes(n: unknown, out: VNode<Props>[] = []): VNode<Props>[] {
  if (Array.isArray(n)) for (const c of n) nodes(c, out);
  else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const mm = (over: Partial<MinimapUi> = {}): MinimapUi => ({
  version: 1,
  self: { x: 100, y: 200, z: 7, dir: Direction.EAST },
  party: [{ id: 9, x: 103, y: 201 }],
  hint: undefined,
  tracked: "",
  ...over,
});
const view = { cx: 100.5, cy: 200.5, scale: 2, width: 160, height: 160 };

describe("MinimapMarks", () => {
  it("draws the own marker facing its direction and the party", () => {
    const all = nodes(MinimapMarks({ t, mm: mm(), view }));
    const self = all.find((v) => v.props["data-testid"] === "minimap-self");
    expect(self?.props.transform).toBe("translate(80 80) rotate(90)");
    expect(all.filter((v) => v.props.class === "minimap-party")).toHaveLength(1);
    expect(all.some((v) => v.props["data-testid"] === "minimap-hint")).toBe(false);
  });
  it("draws the estimate as a circle on the map, or an edge arrow with the distance", () => {
    const near = nodes(
      MinimapMarks({
        t,
        mm: mm({ hint: { questId: "q", stepId: "s", x: 110, y: 200, z: 6, radius: 8 } }),
        view,
      }),
    );
    const area = near.find((v) => v.props["data-testid"] === "minimap-hint");
    expect(area?.props["data-kind"]).toBe("area");
    expect(area?.props["data-floor"]).toBe("up");
    const far = nodes(
      MinimapMarks({
        t,
        mm: mm({ hint: { questId: "q", stepId: "s", x: 400, y: 200, z: 7, radius: 8 } }),
        view,
      }),
    );
    expect(far.find((v) => v.props["data-testid"] === "minimap-hint")?.props["data-kind"]).toBe(
      "arrow",
    );
    const label = far.find((v) => v.props["data-testid"] === "minimap-distance");
    expect(label?.props.children).toBe('client.minimap.distance{"tiles":300}');
  });
  it("turns the marker for every facing", () => {
    expect(facingDegrees(Direction.NORTH)).toBe(0);
    expect(facingDegrees(Direction.SOUTH_WEST)).toBe(225);
    expect(facingDegrees(Direction.UNSPECIFIED)).toBe(180);
  });
});
