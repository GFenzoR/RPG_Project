import { describe, expect, it } from "vitest";
import { chatFocusAction, enterIsFree } from "./chat-focus.ts";
import type { ChatFocusInput } from "./chat-focus.ts";

const base: ChatFocusInput = {
  key: "Enter",
  inChat: false,
  claimed: false,
  text: "",
  modified: false,
};

describe("chatFocusAction", () => {
  it("Enter with nothing focused focuses the chat line", () => {
    expect(chatFocusAction(base)).toBe("focus");
  });
  it("Enter claimed by a window, a dialog or another field does not", () => {
    expect(chatFocusAction({ ...base, claimed: true })).toBe("none");
  });
  it("Enter with text sends and gives the focus back", () => {
    expect(chatFocusAction({ ...base, inChat: true, text: "hola" })).toBe("send");
  });
  it("Enter on an empty or blank line gives the focus back without sending", () => {
    expect(chatFocusAction({ ...base, inChat: true, text: "" })).toBe("blur");
    expect(chatFocusAction({ ...base, inChat: true, text: "   " })).toBe("blur");
  });
  it("Escape in the chat line gives the focus back, with or without text", () => {
    expect(chatFocusAction({ ...base, key: "Escape", inChat: true, text: "abc" })).toBe("blur");
  });
  it("Escape outside the chat and other keys do nothing", () => {
    expect(chatFocusAction({ ...base, key: "Escape" })).toBe("none");
    expect(chatFocusAction({ ...base, key: "w" })).toBe("none");
    expect(chatFocusAction({ ...base, key: "a", inChat: true, text: "x" })).toBe("none");
  });
  it("a held or modified Enter never acts", () => {
    expect(chatFocusAction({ ...base, modified: true })).toBe("none");
    expect(chatFocusAction({ ...base, inChat: true, text: "x", modified: true })).toBe("none");
  });
});

describe("enterIsFree", () => {
  it("is free on the page or the canvas, not on elements that use Enter", () => {
    expect(enterIsFree(null)).toBe(true);
    expect(enterIsFree({ tagName: "BODY" })).toBe(true);
    expect(enterIsFree({ tagName: "CANVAS" })).toBe(true);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]) {
      expect(enterIsFree({ tagName })).toBe(false);
    }
    expect(enterIsFree({ tagName: "DIV", isContentEditable: true })).toBe(false);
  });
});
