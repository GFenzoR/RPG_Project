// The guided tutorial (T4.2): what the server says the current step is. Pure (tested in
// tutorial.test.ts). The client never completes a step: it shows the hint, highlights
// the element and can ask to skip; the server advances it with its own events.
import { TutorialState } from "@rpg/protocol";
import type { TutorialStep } from "@rpg/protocol";

/** UI elements a step may highlight: the value of their data-tutorial attribute. */
export const TUTORIAL_TARGETS = ["inventory", "hotbar", "battle", "chat", "skills", "stats"];

/** The step on screen. */
export interface TutorialView {
  stepId: string;
  /** 1-based position and number of steps, for "2 / 7". */
  step: number;
  total: number;
  /** i18n key of the hint, translated with {count}. */
  text: string;
  /** data-tutorial value to highlight, or undefined. */
  highlight: string | undefined;
  progress: number;
  count: number;
}

/**
 * The tutorial after a TutorialStep: the step while ACTIVE, undefined once it ended
 * (DONE or SKIPPED) or for an unknown state.
 */
export function tutorialFrom(msg: TutorialStep): TutorialView | undefined {
  if (msg.state !== TutorialState.ACTIVE || msg.stepId === "") return undefined;
  const highlight = TUTORIAL_TARGETS.includes(msg.highlight) ? msg.highlight : undefined;
  return {
    stepId: msg.stepId,
    step: msg.index + 1,
    total: Math.max(msg.total, msg.index + 1),
    text: msg.text?.key ?? "",
    highlight,
    progress: Math.min(msg.progress, Math.max(msg.count, 1)),
    count: Math.max(msg.count, 1),
  };
}
