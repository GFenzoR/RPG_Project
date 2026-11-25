// The locked "Salir del juego" (docs/02 "Bloqueo de logout en combate"): the views render as
// plain functions (no hooks), walked like ui/Toolbar.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VNode } from "preact";
import { LogoutTextButton, lockSeconds, logoutTitle, scheduleLockRedraw } from "./LogoutButton.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { defaultWindows } from "./windows.ts";
import { logoutLockMs } from "../state/status.ts";
import type { ConditionView } from "../state/world.ts";

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

const c = (id: string, until: number | undefined): ConditionView => ({ id, until, ticks: 0 });

describe("the logout lock", () => {
  it("is the latest end of in_combat and pvp_locked, none when both ran out", () => {
    expect(logoutLockMs([], 0)).toBeUndefined();
    expect(logoutLockMs([c("protection_zone", undefined), c("poison", 9000)], 0)).toBeUndefined();
    expect(logoutLockMs([c("in_combat", 12_000)], 500)).toBe(11_500);
    expect(logoutLockMs([c("in_combat", 12_000), c("pvp_locked", 60_000)], 0)).toBe(60_000);
    expect(logoutLockMs([c("in_combat", 12_000)], 12_000)).toBeUndefined();
    expect(lockSeconds(11_500)).toBe(12);
    expect(lockSeconds(200)).toBe(1);
    expect(lockSeconds(undefined)).toBeUndefined();
  });

  it("greys the toolbar button with the seconds left and says why, and a click still asks", () => {
    let asked = 0;
    const props = {
      t,
      windows: defaultWindows(),
      onToggle: () => {},
      marketOpen: false,
      onCloseMarket: () => {},
      guildBadge: false,
      onLogout: () => asked++,
    };
    const button = (seconds: number | undefined): VNode<Props> | undefined =>
      nodes(Toolbar({ ...props, logoutSeconds: seconds })).find(
        (v) => v.props["data-testid"] === "logout",
      );
    const free = button(undefined);
    expect(free?.props["data-locked"]).toBeUndefined();
    expect(free?.props.title).toBe("client.game.logout");
    expect(nodes(free).some((v) => v.props["data-testid"] === "logout-countdown")).toBe(false);

    const locked = button(8);
    expect(locked?.props["data-locked"]).toBe("");
    // A screen reader hears the lock and its seconds, not only "Leave game"; the digits
    // drawn over the icon are for the eyes.
    expect(free?.props["aria-label"]).toBe("client.game.logout");
    expect(locked?.props["aria-label"]).toBe('client.game.logout_locked_label{"seconds":8}');
    expect(locked?.props.title).toBe('client.game.logout_locked_hint{"seconds":8}');
    const count = nodes(locked).find((v) => v.props["data-testid"] === "logout-countdown");
    expect(count?.props.children).toBe('client.status.badge_seconds{"seconds":8}');
    expect(count?.props["aria-hidden"]).toBe("true");
    locked?.props.onClick?.();
    expect(asked).toBe(1); // the server decides and answers combat.logout_locked
  });

  describe("its countdown", () => {
    afterEach(() => vi.useRealTimers());

    it("draws again when the seconds left change, once, and not when the player may leave", () => {
      vi.useFakeTimers();
      let drawn = 0;
      // 7.4 s left shows 8: at 7 s left it must show 7.
      scheduleLockRedraw(7400, () => drawn++);
      vi.advanceTimersByTime(399);
      expect(drawn).toBe(0);
      vi.advanceTimersByTime(20);
      expect(drawn).toBe(1);
      vi.advanceTimersByTime(5000);
      expect(drawn).toBe(1); // the next render schedules the next one
      // On a whole second, the next one is a second away.
      scheduleLockRedraw(3000, () => drawn++);
      vi.advanceTimersByTime(900);
      expect(drawn).toBe(1);
      vi.advanceTimersByTime(200);
      expect(drawn).toBe(2);
      expect(scheduleLockRedraw(undefined, () => drawn++)).toBeUndefined();
      vi.advanceTimersByTime(5000);
      expect(drawn).toBe(2);
    });

    it("is cancelled when the lock is drawn again or the button goes away", () => {
      vi.useFakeTimers();
      let drawn = 0;
      scheduleLockRedraw(2500, () => drawn++)?.();
      vi.advanceTimersByTime(5000);
      expect(drawn).toBe(0);
    });
  });

  it("writes the countdown on the phone menu's text button", () => {
    let asked = 0;
    const free = LogoutTextButton({
      t,
      seconds: undefined,
      onLogout: () => asked++,
    }) as VNode<Props>;
    expect(free.props.children).toBe("client.game.logout");
    expect(free.props["data-locked"]).toBeUndefined();
    const locked = LogoutTextButton({ t, seconds: 3, onLogout: () => asked++ }) as VNode<Props>;
    expect(locked.props.children).toBe('client.game.logout_locked_label{"seconds":3}');
    expect(locked.props["data-locked"]).toBe("");
    expect(locked.props.title).toBe(logoutTitle(t, 3));
    locked.props.onClick?.();
    expect(asked).toBe(1);
  });
});
