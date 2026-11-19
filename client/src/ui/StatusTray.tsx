// The status tray (docs/17 "Bandeja de estados"): one pixel-art icon per own condition and
// per status the server sends (state/status.ts), each in a green frame if it helps or a
// red one if it harms, with its seconds left written on it, a flash in its last seconds
// and a tooltip with its name, what it does and the time left. On the desktop it stands
// at the bottom left, over the life orb and left of the chat's factory place (HudBar.tsx,
// windows.css); on phones and tablets it is a compact row in the header (client.css).
//
// StatusTrayView draws without hooks (ui/StatusTray.test.ts walks its tree); StatusTray
// keeps the clock that redraws it when a second changes and which tooltip a tap opened.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { Game } from "../game.ts";
import type { ConditionView } from "../state/world.ts";
import { nextTrayChange, statusIconStyle, trayEntries } from "../state/status.ts";
import type { TrayEntry } from "../state/status.ts";
import { motionReduced } from "../state/ui-prefs.ts";

/** Seconds from which the icon writes minutes ("2m"): two digits fit on it. */
const BADGE_MINUTES_FROM = 100;

/** What the icon writes: the seconds left, or the minutes from 100 s; nothing with no end. */
export function badgeText(t: Translate, seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < BADGE_MINUTES_FROM) return t("client.status.badge_seconds", { seconds });
  return t("client.status.badge_minutes", { minutes: Math.ceil(seconds / 60) });
}

/** The tooltip's time left: "12 s" or "3 min 5 s"; nothing with no end. */
export function leftText(t: Translate, seconds: number | undefined): string {
  if (seconds === undefined) return "";
  if (seconds < 60) return t("client.status.left_seconds", { seconds });
  return t("client.status.left_minutes", {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

export interface StatusTrayViewProps {
  t: Translate;
  entries: readonly TrayEntry[];
  /** The CSS variables of an icon (statusIconStyle), undefined without its sprite. */
  icon(id: string): Record<string, string> | undefined;
  /** The id whose tooltip a tap opened, if any. */
  open: string | undefined;
  onToggle(id: string): void;
  /** Phones and tablets: the row in the header (smaller icons, the tooltip under it). */
  compact: boolean;
}

/** The tray as it is now (no hooks). */
export function StatusTrayView(props: StatusTrayViewProps): JSX.Element {
  const { t } = props;
  return (
    <div
      class={props.compact ? "status-box compact" : "status-box"}
      data-testid="conditions"
      data-count={props.entries.length}
    >
      <ul class="status-tray" aria-label={t("client.conditions.title")}>
        {props.entries.map((e) => {
          const name = t(`condition.${e.id}.name`);
          const left = leftText(t, e.seconds);
          const badge = badgeText(t, e.seconds);
          const style = props.icon(e.id);
          const tip = `status-tip-${e.id}`;
          return (
            <li
              key={e.id}
              class={`status status-${e.kind}`}
              data-condition={e.id}
              data-kind={e.kind}
              data-flash={e.flash ? "" : undefined}
              data-open={props.open === e.id ? "" : undefined}
              tabIndex={0}
              aria-label={left ? `${name}, ${left}` : name}
              aria-describedby={tip}
              onClick={() => props.onToggle(e.id)}
            >
              <span class="status-frame" aria-hidden="true">
                {style ? (
                  <span class="status-icon" style={style} />
                ) : (
                  <span class="status-letter">{name.slice(0, 1)}</span>
                )}
                {badge && <span class="status-left">{badge}</span>}
              </span>
              <span class="status-tip" role="tooltip" id={tip}>
                <span class="status-tip-head">
                  <strong class="status-name">{name}</strong>
                  <span class="status-kind">{t(`client.status.${e.kind}`)}</span>
                </span>
                <span class="status-desc">{t(`condition.${e.id}.desc`)}</span>
                {e.ticks > 0 && (
                  <span class="status-hits">
                    {t("client.status.hits_left", { ticks: e.ticks })}
                  </span>
                )}
                {left && <span class="status-time">{left}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The tray of the game screen: redraws itself when a second written on an icon changes
 * (the server only sends the list again when something starts, changes or ends).
 */
export function StatusTray(props: {
  t: Translate;
  conditions: readonly ConditionView[];
  game: Pick<Game, "spriteIcon"> | undefined;
  compact: boolean;
}): JSX.Element {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const now = performance.now();
  const reduced = typeof document === "undefined" || motionReduced(document.documentElement);
  const entries = trayEntries(props.conditions, now, reduced);
  const next = nextTrayChange(props.conditions, now);
  useEffect(() => {
    if (next === undefined) return undefined;
    // A hair after the second turns, so the new one is written.
    const timer = setTimeout(() => setTick((n) => n + 1), next + 15);
    return () => clearTimeout(timer);
  });
  const shown = open !== undefined && entries.some((e) => e.id === open) ? open : undefined;
  return (
    <StatusTrayView
      t={props.t}
      entries={entries}
      icon={(id) => statusIconStyle(props.game?.spriteIcon(`ui/status/${id}`))}
      open={shown}
      onToggle={(id) => setOpen(shown === id ? undefined : id)}
      compact={props.compact}
    />
  );
}
