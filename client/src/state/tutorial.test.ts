import { describe, expect, it } from "vitest";
import { create, TutorialState, TutorialStepSchema } from "@rpg/protocol";
import { tutorialFrom } from "./tutorial.ts";

interface Over {
  state?: TutorialState;
  stepId?: string;
  index?: number;
  total?: number;
  highlight?: string;
  progress?: number;
  count?: number;
}

const step = (over: Over = {}) =>
  create(TutorialStepSchema, {
    state: TutorialState.ACTIVE,
    stepId: "first_steps",
    index: 0,
    total: 7,
    text: { key: "tutorial.step.first_steps", params: [] },
    highlight: "",
    progress: 2,
    count: 5,
    ...over,
  });

describe("tutorialFrom (T4.2)", () => {
  it("shows the active step, 1-based, with its progress", () => {
    expect(tutorialFrom(step())).toEqual({
      stepId: "first_steps",
      step: 1,
      total: 7,
      text: "tutorial.step.first_steps",
      highlight: undefined,
      progress: 2,
      count: 5,
    });
  });
  it("highlights only known UI elements", () => {
    expect(tutorialFrom(step({ highlight: "inventory" }))?.highlight).toBe("inventory");
    expect(tutorialFrom(step({ highlight: "body" }))?.highlight).toBeUndefined();
  });
  it("closes the panel when the tutorial ends, whichever way", () => {
    expect(tutorialFrom(step({ state: TutorialState.DONE, stepId: "" }))).toBeUndefined();
    expect(tutorialFrom(step({ state: TutorialState.SKIPPED, stepId: "" }))).toBeUndefined();
    expect(tutorialFrom(step({ state: TutorialState.UNSPECIFIED }))).toBeUndefined();
  });
  it("keeps numbers sane with odd input", () => {
    const v = tutorialFrom(step({ index: 9, total: 3, progress: 8, count: 0 }));
    expect(v && [v.step, v.total, v.progress, v.count]).toEqual([10, 10, 1, 1]);
  });
});
