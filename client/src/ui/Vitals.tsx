// The player's vitals on the desktop game screen (docs/17 UI-4, UI-9), in the gothic bottom
// bar (ui/HudBar.tsx): a life orb at the bottom left and a mana orb at the bottom right,
// each set in an iron socket, Diablo-like but our own; the experience bar along the bar;
// and over the life orb a plaque with the name, the level, the experience and the own
// conditions. The orbs fill with transform only (windows.css animates it); a lighter
// "ghost" marks what was just lost and drains after it.
import type { ComponentChildren, JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { GameUi } from "../game.ts";

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

/** The experience to the next level: a gold bar that flashes on a level up. */
export function ExperienceBar(props: {
  t: Translate;
  stats: GameUi["stats"];
  levelUp: boolean;
}): JSX.Element {
  const percent = props.stats ? Math.min(100, Math.max(0, props.stats.levelPercent)) : 0;
  return (
    <span
      class={props.levelUp ? "xpbar flash" : "xpbar"}
      role="progressbar"
      aria-label={props.t("client.vitals.experience_bar")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span class="xpfill" style={{ transform: `scaleX(${(percent / 100).toFixed(3)})` }} />
    </span>
  );
}

/**
 * The plaque over the life orb: name, level, experience and the conditions above them
 * (the tutorial's "stats" highlight lands here).
 */
export function Vitals(props: {
  t: Translate;
  name: string;
  stats: GameUi["stats"];
  /** The conditions bar (GameView ConditionBar). */
  children?: ComponentChildren;
}): JSX.Element {
  const { t, stats } = props;
  return (
    <section class="vitals" data-tutorial="stats" aria-label={t("client.vitals.title")}>
      {props.children}
      <span class="vname" title={props.name}>
        {props.name}
      </span>
      {stats && (
        <span class="vlevel" data-testid="level">
          {t("client.game.level", { level: stats.level, percent: stats.levelPercent })}
        </span>
      )}
      {stats && (
        <span class="vxp" data-testid="experience">
          {t("client.game.experience", { experience: stats.experience })}
        </span>
      )}
    </section>
  );
}
