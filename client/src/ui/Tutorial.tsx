import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Game, GameUi } from "../game.ts";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";

/**
 * The tutorial's hint panel (T4.2), over the map: the current step's text, its progress
 * and a button to skip the tutorial. It never blocks the game (no key, no overlay) and
 * hides while an NPC dialog, shop or station window is open, and on the desktop while the
 * help, the guild or the appearance sits over it. The step's UI element (its
 * `data-tutorial` attribute) gets `data-tutorial-active`, which client.css highlights.
 * T5.6: on a small screen it covers part of the map, so "×" folds it into a small button
 * until the next step (the highlight stays).
 */
export function TutorialPanel(props: {
  t: Translate;
  game: Game | undefined;
  ui: GameUi;
  /**
   * The help, the guild or the appearance is open at its factory place, over the hint's
   * (docs/17 UI-5, ui/windows.ts tutorialCovered): it hides until that window closes or
   * moves.
   */
  covered?: boolean | undefined;
  /** For balance.yaml death.novice_max_level, named by the backpack step's text. */
  content?: Pick<ClientContent, "death"> | undefined;
}): JSX.Element | null {
  const { t } = props;
  const s = props.ui.tutorial;
  const focus = s?.highlight;
  const [hiddenStep, setHiddenStep] = useState<string | undefined>(undefined);
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
  if (
    !s ||
    props.covered ||
    props.ui.dialog ||
    props.ui.shop ||
    props.ui.station ||
    props.ui.market ||
    props.ui.trade
  )
    return null;
  if (hiddenStep === s.stepId) {
    return (
      <button
        type="button"
        class="tutorial-show"
        data-testid="tutorial-show"
        aria-label={t("client.tutorial.show")}
        onClick={() => setHiddenStep(undefined)}
      >
        {t("client.tutorial.title")}
      </button>
    );
  }
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
        <button
          type="button"
          class="close"
          data-testid="tutorial-hide"
          aria-label={t("client.tutorial.hide")}
          title={t("client.tutorial.hide")}
          onClick={() => setHiddenStep(s.stepId)}
        >
          ×
        </button>
      </header>
      <p>{t(s.text, { count: s.count, novice: props.content?.death?.noviceMaxLevel ?? 0 })}</p>
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
