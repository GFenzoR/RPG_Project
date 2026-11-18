// The gothic bottom bar of the desktop game screen (docs/17 UI-4, the owner's answer of
// 2026-11-18): the only fixed piece over the full-screen map. The life orb at the bottom
// left and the mana orb at the bottom right, each in an iron socket; between them the
// experience bar along the top and, under it, the spell hotbar (F1–F12) and the toolbar
// (I K B P G O, options, help, market and leaving). Over the life orb, a plaque with the
// name, the level, the experience and the conditions. Carved stone, dark iron and old gold
// (windows.css), our own art in the spirit of the games the owner named, never theirs.
// It is the map's bottom padding (--bar-h in windows.css): the map is the screen above it
// and the windows never go under it. The interface scale zooms it like the windows.
import type { ComponentChildren, JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { GameUi } from "../game.ts";
import { ExperienceBar, Orb, Vitals, lowHealth, orbFill } from "./Vitals.tsx";

export function HudBar(props: {
  t: Translate;
  name: string;
  stats: GameUi["stats"];
  /** A level was just gained: the experience bar flashes. */
  levelUp: boolean;
  /** The conditions bar (GameView ConditionBar), on the plaque. */
  conditions: ComponentChildren;
  /** The spell hotbar (ui/Hotbar.tsx). */
  hotbar: ComponentChildren;
  /** The toolbar (ui/Toolbar.tsx). */
  toolbar: ComponentChildren;
}): JSX.Element {
  const { t, stats } = props;
  return (
    <section class="hud-bar" data-testid="hud-bar" aria-label={t("client.hud.bar")}>
      <Vitals t={t} name={props.name} stats={stats}>
        {props.conditions}
      </Vitals>
      <Orb
        kind="life"
        fill={stats ? orbFill(stats.health, stats.maxHealth) : 1}
        low={lowHealth(stats)}
        text={stats ? t("client.game.health", { health: stats.health, max: stats.maxHealth }) : ""}
        testid="health"
      />
      <div class="bar-centre">
        <ExperienceBar t={t} stats={stats} levelUp={props.levelUp} />
        <div class="bar-row">
          <div class="bar-hotbar">{props.hotbar}</div>
          {props.toolbar}
        </div>
      </div>
      <Orb
        kind="mana"
        fill={stats ? orbFill(stats.mana, stats.maxMana) : 1}
        text={stats ? t("client.game.mana", { mana: stats.mana, max: stats.maxMana }) : ""}
        testid="mana"
      />
    </section>
  );
}
