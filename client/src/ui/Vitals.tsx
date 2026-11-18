// The player's vitals on the desktop game screen (docs/17 UI-4, UI-9): a life orb and a mana
// orb, Diablo-like, with the name, the level and the experience bar between them, and the
// own conditions under them. The orbs fill with transform only (client.css animates it);
// a lighter "ghost" marks what was just lost and drains after it.
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

function Orb(props: {
  kind: "life" | "mana";
  fill: number;
  low?: boolean;
  text: string;
  testid: string;
}): JSX.Element {
  // The liquid sits below the orb and rises with the fill: translateY of the missing part.
  const level = { transform: `translateY(${((1 - props.fill) * 100).toFixed(2)}%)` };
  return (
    <div class={`orb-box orb-${props.kind}`}>
      <div class="orb" data-low={props.low ? "" : undefined} aria-hidden="true">
        <span class="orb-ghost" style={level} />
        <span class="orb-liquid" style={level}>
          <span class="orb-wave" />
        </span>
        <span class="orb-glass" />
      </div>
      {props.text && (
        <span class="orb-text" data-testid={props.testid}>
          {props.text}
        </span>
      )}
    </div>
  );
}

export function Vitals(props: {
  t: Translate;
  name: string;
  stats: GameUi["stats"];
  /** A level was just gained: the experience bar flashes. */
  levelUp: boolean;
  /** The conditions bar (App.tsx ConditionBar). */
  children?: ComponentChildren;
}): JSX.Element {
  const { t, stats } = props;
  const percent = stats ? Math.min(100, Math.max(0, stats.levelPercent)) : 0;
  return (
    <section class="vitals" data-tutorial="stats" aria-label={t("client.vitals.title")}>
      <Orb
        kind="life"
        fill={stats ? orbFill(stats.health, stats.maxHealth) : 1}
        low={lowHealth(stats)}
        text={stats ? t("client.game.health", { health: stats.health, max: stats.maxHealth }) : ""}
        testid="health"
      />
      <div class="vitals-mid">
        <span class="vname" title={props.name}>
          {props.name}
        </span>
        {stats && (
          <span class="vlevel" data-testid="level">
            {t("client.game.level", { level: stats.level, percent: stats.levelPercent })}
          </span>
        )}
        <span
          class={props.levelUp ? "xpbar flash" : "xpbar"}
          role="progressbar"
          aria-label={t("client.vitals.experience_bar")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span class="xpfill" style={{ transform: `scaleX(${(percent / 100).toFixed(3)})` }} />
        </span>
        {stats && (
          <span class="vxp" data-testid="experience">
            {t("client.game.experience", { experience: stats.experience })}
          </span>
        )}
      </div>
      <Orb
        kind="mana"
        fill={stats ? orbFill(stats.mana, stats.maxMana) : 1}
        text={stats ? t("client.game.mana", { mana: stats.mana, max: stats.maxMana }) : ""}
        testid="mana"
      />
      {props.children}
    </section>
  );
}
