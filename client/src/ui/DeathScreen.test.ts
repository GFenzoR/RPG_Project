// The death screen says when the novice protection covered the death (docs/02 "Muerte").
// A plain function, walked like ui/LogoutButton.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import { DeathScreen } from "./DeathScreen.tsx";

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

const novice = (noviceUntil: number, onOk = (): void => {}): VNode<Props>[] =>
  nodes(DeathScreen({ t, death: { experience: 12, blessings: 0, noviceUntil, at: 5 }, onOk }));

describe("the death screen", () => {
  it("names the level the novice protection reaches on a protected death", () => {
    const line = novice(8).find((n) => n.props["data-testid"] === "death-novice");
    expect(line?.props.children).toBe('client.death.novice{"level":8}');
  });

  it("says nothing of the protection on an unprotected death", () => {
    const all = novice(0);
    expect(all.some((n) => n.props["data-testid"] === "death-novice")).toBe(false);
    expect(all.some((n) => n.props.children === 'client.death.experience{"experience":12}')).toBe(
      true,
    );
  });

  it("closes with its button", () => {
    const onOk = vi.fn();
    novice(8, onOk)
      .find((n) => n.type === "button")
      ?.props.onClick?.();
    expect(onOk).toHaveBeenCalledOnce();
  });
});
