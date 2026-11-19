// The status tray's view renders as a plain function (no hooks): these tests walk its
// element tree without a DOM, like ui/Toolbar.test.ts.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { StatusTrayView, badgeText, leftText } from "./StatusTray.tsx";
import type { StatusTrayViewProps } from "./StatusTray.tsx";
import { trayEntries } from "../state/status.ts";

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;

type Props = Record<string, unknown> & { children?: unknown; onClick?: () => void };

function nodes(n: unknown, out: VNode<Props>[] = []): VNode<Props>[] {
  if (Array.isArray(n)) for (const c of n) nodes(c, out);
  else if (n && typeof n === "object" && "props" in n) {
    const v = n as VNode<Props>;
    out.push(v);
    nodes(v.props.children, out);
  }
  return out;
}

const text = (v: VNode<Props> | undefined): string =>
  nodes(v)
    .flatMap((n) => [n.props.children].flat())
    .filter((c): c is string => typeof c === "string")
    .join("|");

const entries = trayEntries(
  [
    { id: "hasted", until: 4200, ticks: 0 },
    { id: "poison", until: 130_000, ticks: 3 },
    { id: "protection_zone", until: undefined, ticks: 0 },
  ],
  0,
  false,
);

function view(over: Partial<StatusTrayViewProps> = {}): VNode<Props>[] {
  const props: StatusTrayViewProps = {
    t,
    entries,
    icon: (id) => (id === "poison" ? { "--status-icon": "url(/p.png)" } : undefined),
    open: undefined,
    onToggle: () => {},
    compact: false,
    ...over,
  };
  return nodes(StatusTrayView(props));
}

describe("StatusTrayView", () => {
  it("draws one framed icon per entry in the tray's order, with its kind and seconds", () => {
    const all = view();
    const box = all[0];
    expect(box?.props["data-testid"]).toBe("conditions");
    expect(box?.props["class"]).toBe("status-box");
    const items = all.filter((v) => v.props["data-condition"] !== undefined);
    expect(items.map((v) => [v.props["data-condition"], v.props["data-kind"]])).toEqual([
      ["poison", "harm"],
      ["protection_zone", "buff"],
      ["hasted", "buff"],
    ]);
    // Poison: its sprite, 130 s written as minutes, its hits and the time in the tooltip.
    const poison = items[0];
    expect(poison?.props["class"]).toBe("status status-harm");
    expect(nodes(poison).find((v) => v.props["class"] === "status-icon")?.props["style"]).toEqual({
      "--status-icon": "url(/p.png)",
    });
    expect(nodes(poison).find((v) => v.props["class"] === "status-left")?.props.children).toBe(
      'client.status.badge_minutes{"minutes":3}',
    );
    const tip = nodes(poison).find((v) => v.props["role"] === "tooltip");
    expect(tip?.props["id"]).toBe(poison?.props["aria-describedby"]);
    expect(text(tip)).toBe(
      [
        "condition.poison.name",
        "client.status.harm",
        "condition.poison.desc",
        'client.status.hits_left{"ticks":3}',
        'client.status.left_minutes{"minutes":2,"seconds":10}',
      ].join("|"),
    );
    expect(poison?.props["aria-label"]).toBe(
      'condition.poison.name, client.status.left_minutes{"minutes":2,"seconds":10}',
    );
    // Haste: no sprite in this atlas, so the name's first letter; it flashes (4.2 s left).
    const hasted = items[2];
    expect(nodes(hasted).find((v) => v.props["class"] === "status-letter")?.props.children).toBe(
      "c",
    );
    expect(hasted?.props["data-flash"]).toBe("");
    expect(nodes(hasted).find((v) => v.props["class"] === "status-left")?.props.children).toBe(
      'client.status.badge_seconds{"seconds":5}',
    );
    // The protection zone has no end: no number, no time line, no flash.
    const zone = items[1];
    expect(zone?.props["data-flash"]).toBeUndefined();
    expect(nodes(zone).some((v) => v.props["class"] === "status-left")).toBe(false);
    expect(nodes(zone).some((v) => v.props["class"] === "status-time")).toBe(false);
    expect(zone?.props["aria-label"]).toBe("condition.protection_zone.name");
  });

  it("opens the tooltip a tap chose and asks to toggle on a click; compact in the header", () => {
    const toggled: string[] = [];
    const all = view({ open: "hasted", onToggle: (id) => toggled.push(id), compact: true });
    expect(all[0]?.props["class"]).toBe("status-box compact");
    const items = all.filter((v) => v.props["data-condition"] !== undefined);
    expect(items.map((v) => v.props["data-open"])).toEqual([undefined, undefined, ""]);
    items[0]?.props.onClick?.();
    expect(toggled).toEqual(["poison"]);
  });

  it("is an empty list with nothing to show", () => {
    const all = view({ entries: [] });
    expect(all[0]?.props["data-count"]).toBe(0);
    expect(all.some((v) => v.props["data-condition"] !== undefined)).toBe(false);
  });
});

describe("the tray's numbers", () => {
  it("writes seconds up to 99 and minutes from 100, rounded up", () => {
    expect(badgeText(t, undefined)).toBe("");
    expect(badgeText(t, 99)).toBe('client.status.badge_seconds{"seconds":99}');
    expect(badgeText(t, 100)).toBe('client.status.badge_minutes{"minutes":2}');
    expect(badgeText(t, 1200)).toBe('client.status.badge_minutes{"minutes":20}');
  });

  it("tells the time left in seconds, or minutes and seconds", () => {
    expect(leftText(t, undefined)).toBe("");
    expect(leftText(t, 59)).toBe('client.status.left_seconds{"seconds":59}');
    expect(leftText(t, 61)).toBe('client.status.left_minutes{"minutes":1,"seconds":1}');
  });
});
