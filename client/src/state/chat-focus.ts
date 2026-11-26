// Enter and Escape around the chat line (owner, 2026-11-26): Enter with nothing focused puts
// the cursor in the chat line at once; Enter with text sends it and gives the focus back to
// the game; Enter on an empty line or Escape gives it back too. So a player can talk and
// keep moving without reaching for the mouse. Pure, so the state machine is unit-tested;
// ui/Chat.tsx wires it to the keyboard.

/** What a key press does to the chat line. */
export type ChatFocusAction = "focus" | "send" | "blur" | "none";

/** What the machine needs to know about the key and where the focus is. */
export interface ChatFocusInput {
  /** KeyboardEvent.key. */
  key: string;
  /** The chat line itself has the focus. */
  inChat: boolean;
  /**
   * Something else takes Enter: another text field, a button, a link or a select with the
   * focus, or the key was already used (preventDefault) by the game, a dialog or a window.
   */
  claimed: boolean;
  /** What is typed in the chat line. */
  text: string;
  /** Held down (auto-repeat) or with Ctrl, Alt or Meta: never acts. */
  modified: boolean;
}

export function chatFocusAction(i: ChatFocusInput): ChatFocusAction {
  if (i.modified) return "none";
  if (i.inChat) {
    if (i.key === "Escape") return "blur";
    if (i.key !== "Enter") return "none";
    return i.text.trim() === "" ? "blur" : "send";
  }
  if (i.key === "Enter" && !i.claimed) return "focus";
  return "none";
}

/** Elements that use Enter themselves: with one focused, Enter is not the chat's. */
const OWN_ENTER = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);

/** True when the focused element (or none) leaves Enter free for the chat. */
export function enterIsFree(
  active: { tagName: string; isContentEditable?: boolean } | null,
): boolean {
  if (active === null) return true;
  if (active.isContentEditable === true) return false;
  return !OWN_ENTER.has(active.tagName.toUpperCase());
}
