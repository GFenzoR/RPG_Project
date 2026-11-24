// The logout lock on the "Salir del juego" buttons (docs/02 "Bloqueo de logout en combate"):
// while the server says the player is in a fight (the in_combat or pvp_locked status,
// state/status.ts logoutLockMs) the buttons look locked, with the seconds left on them and
// a tooltip that says why, instead of only failing after a click. A click still sends the
// Logout: the server decides, and its refusal (combat.logout_locked with the seconds) floats
// over the map.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { ConditionView } from "../state/world.ts";
import { logoutLockMs } from "../state/status.ts";

/** The whole seconds left of a lock, rounded up; undefined when the player may leave. */
export function lockSeconds(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/** The tooltip of a logout button: its name, or why it is locked and for how long. */
export function logoutTitle(t: Translate, seconds: number | undefined): string {
  return seconds === undefined
    ? t("client.game.logout")
    : t("client.game.logout_locked_hint", { seconds });
}

/** The text button of the phone menu (no hooks: LogoutLock gives it the seconds). */
export function LogoutTextButton(props: {
  t: Translate;
  seconds: number | undefined;
  onLogout(): void;
}): JSX.Element {
  const { t, seconds } = props;
  return (
    <button
      type="button"
      class="logout-text"
      data-testid="logout-menu"
      data-locked={seconds === undefined ? undefined : ""}
      title={logoutTitle(t, seconds)}
      onClick={() => props.onLogout()}
    >
      {seconds === undefined
        ? t("client.game.logout")
        : t("client.game.logout_locked_label", { seconds })}
    </button>
  );
}

/**
 * Gives its child the seconds left of the logout lock and draws it again each second
 * while the lock lasts (the server sends the status only when it starts, moves or ends).
 */
export function LogoutLock(props: {
  conditions: readonly ConditionView[];
  children: (seconds: number | undefined) => JSX.Element;
}): JSX.Element {
  const [, setTick] = useState(0);
  const left = logoutLockMs(props.conditions, performance.now());
  useEffect(() => {
    if (left === undefined) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), (left % 1000 || 1000) + 15);
    return () => clearTimeout(timer);
  });
  return props.children(lockSeconds(left));
}
