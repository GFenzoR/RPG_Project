import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";

/**
 * The tutorial's hint panel (T4.2), over the map: the current step's text, its progress
 * and a button to skip the tutorial. It never blocks the game (no key, no overlay) and
 * hides while an NPC dialog, shop or station window is open. The step's UI element (its
 * `data-tutorial` attribute) gets `data-tutorial-active`, which client.css highlights.
 */
export function TutorialPanel(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element | null {
  const { t } = props;
  const s = props.ui.tutorial;
  const focus = s?.highlight;
  // After every render (an element may mount later): mark the step's element.
  useEffect(() => {
    if (!focus) return undefined;
    const marked = [...document.querySelectorAll<HTMLElement>(`[data-tutorial="${focus}"]`)];
    for (const el of marked) el.dataset["tutorialActive"] = "";
    return () => {
      for (const el of marked) delete el.dataset["tutorialActive"];
    };
  });
  // Out of the way of the windows over the map (dialog, shop, station): on a narrow
  // screen they reach the top right corner.
  if (!s || props.ui.dialog || props.ui.shop || props.ui.station) return null;
  return (
    <section
      class="tutorial"
      data-testid="tutorial-panel"
      data-step={s.stepId}
      aria-live="polite"
      aria-label={t("client.tutorial.title")}
    >
      <header>
        <h2>{t("client.tutorial.title")}</h2>
        <span class="step">{t("client.tutorial.step", { step: s.step, total: s.total })}</span>
      </header>
      <p>{t(s.text, { count: s.count })}</p>
      {s.count > 1 && (
        <p class="progress" data-testid="tutorial-progress">
          {t("client.tutorial.progress", { progress: s.progress, count: s.count })}
        </p>
      )}
      <button type="button" data-testid="tutorial-skip" onClick={() => props.game?.skipTutorial()}>
        {t("client.tutorial.skip")}
      </button>
    </section>
  );
}
