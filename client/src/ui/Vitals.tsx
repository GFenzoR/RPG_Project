// The player's vitals on the desktop game screen (docs/17 UI-4, UI-9), in the gothic bottom
// bar (ui/HudBar.tsx): a life orb at the bottom left and a mana orb at the bottom right,
// each set in an iron socket, Diablo-like but our own; and in the middle, along the bar's
// top, the name plate (name and level) over the experience bar. The orbs fill with
// transform only (windows.css animates it); a lighter "ghost" marks what was just lost and
// drains after it. The own conditions are in the status tray (ui/StatusTray.tsx).
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { GameUi } from "../game.ts";
import type { ExperienceCurve } from "../content-types.ts";
import { toNextLevel } from "../state/experience.ts";
import { fitTextRef } from "./fit-text.ts";

/** Below this share of health the life orb beats and the map's edge turns red. */
export const LOW_HEALTH = 0.25;

/** How full an orb is, 0..1 (an unknown or zero maximum shows it full). */
export function orbFill(value: number, max: number): number {
  if (!(max > 0)) return 1;
  return Math.min(1, Math.max(0, value / max));
}

/** True while the health is low enough to warn (alive, under LOW_HEALTH). */
export function lowHealth(stats: GameUi["stats"]): boolean {
  if (!stats || !(stats.maxHealth > 0) || stats.health <= 0) return false;
  return stats.health / stats.maxHealth < LOW_HEALTH;
}

/** A life or mana orb in its iron socket, with its value written across it. */
export function Orb(props: {
  kind: "life" | "mana";
  fill: number;
  low?: boolean | undefined;
  text: string;
  testid: string;
}): JSX.Element {
  // The liquid sits below the orb and rises with the fill: translateY of the missing part.
  const level = { transform: `translateY(${((1 - props.fill) * 100).toFixed(2)}%)` };
  return (
    <div class={`orb-box orb-${props.kind}`}>
      <div class="orb-socket" aria-hidden="true">
        <div class="orb" data-low={props.low ? "" : undefined}>
          <span class="orb-ghost" style={level} />
          <span class="orb-liquid" style={level}>
            <span class="orb-wave" />
          </span>
          <span class="orb-glass" />
        </div>
      </div>
      {props.text && (
        <span class="orb-text" data-testid={props.testid}>
          {props.text}
        </span>
      )}
    </div>
  );
}

/**
 * The tooltip of the experience bar: the exact experience and what is missing for the next
 * level (state/experience.ts), or the plain experience without a curve.
 */
export function experienceTip(
  t: Translate,
  stats: NonNullable<GameUi["stats"]>,
  curve: ExperienceCurve | undefined,
): string {
  const experience = stats.experience;
  const next = toNextLevel(curve, stats.level, experience);
  if (next)
    return t("client.vitals.experience_next", {
      experience,
      missing: next.missing,
      next: next.next,
    });
  if (curve) return t("client.vitals.experience_max", { experience });
  return t("client.game.experience", { experience });
}

/**
 * The name plate and the experience bar, in the middle of the bottom bar (docs/17 "Placa
 * del nombre", the owner's wish of 2026-11-19): the name and the level centred over a gold
 * bar that carries the percent, and the exact experience to the next level as its tooltip.
 * The bar flashes on a level up; the tutorial's "stats" highlight lands here.
 */
export function ExperienceBar(props: {
  t: Translate;
  name: string;
  stats: GameUi["stats"];
  levelUp: boolean;
  curve?: ExperienceCurve | undefined;
}): JSX.Element {
  const { t, stats } = props;
  const percent = stats ? Math.min(100, Math.max(0, stats.levelPercent)) : 0;
  const tip = stats ? experienceTip(t, stats, props.curve) : undefined;
  return (
    <div class="xp" data-tutorial="stats" role="group" aria-label={t("client.vitals.title")}>
      <div class="nameplate">
        <span class="vname" key={props.name} ref={fitTextRef} title={props.name}>
          {props.name}
        </span>
        {stats && (
          <span class="vlevel" data-testid="level">
            {t("client.vitals.level", { level: stats.level })}
          </span>
        )}
      </div>
      <span
        class={props.levelUp ? "xpbar flash" : "xpbar"}
        role="progressbar"
        data-testid="experience"
        title={tip}
        aria-label={t("client.vitals.experience_bar")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={tip}
      >
        <span class="xpfill" style={{ transform: `scaleX(${(percent / 100).toFixed(3)})` }} />
        {stats && <span class="xppercent">{t("client.vitals.percent", { percent })}</span>}
      </span>
    </div>
  );
}
