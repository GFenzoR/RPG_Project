// Hybrid input (owner, 2026-11-24; docs/15 "Entrada híbrida"): which input method the
// player is using is decided per event, never by the layout or the kind of device. A phone
// with a mouse and a keyboard plugged in plays with them, and a laptop with a touch screen
// keeps its gestures. The handlers already branch per event (pointerType on the canvas and
// the items, real key events on the window); this module only remembers the last method
// used, so the on-screen pad and action buttons step back while a keyboard or a mouse is
// in use and come back on the next touch.

export type InputMethod = "touch" | "mouse" | "keyboard";

/** The method of a pointer event: fingers and pens are touch, the rest is a mouse. */
export function pointerMethod(pointerType: string): InputMethod {
  return pointerType === "touch" || pointerType === "pen" ? "touch" : "mouse";
}

/** What of a key event decides whether a real keyboard is in use. */
export interface KeyFacts {
  key: string;
  /** The event's target is a text field (typing there says nothing: a virtual keyboard types too). */
  editable: boolean;
  /** An IME composition, or the 229 key code virtual keyboards send. */
  composing?: boolean | undefined;
}

/** Keys a virtual keyboard or a phone's own buttons also send: they prove no keyboard. */
const NOT_A_KEYBOARD = new Set(["Unidentified", "Process", "GoBack", "BrowserBack", "Dead", ""]);

/** True when a keydown shows a hardware keyboard playing the game. */
export function isKeyboardPlay(k: KeyFacts): boolean {
  if (k.editable || k.composing) return false;
  return !NOT_A_KEYBOARD.has(k.key);
}

/** How the on-screen controls (pad or stick, action buttons) show. */
export type ControlsShow = "full" | "faded";

/**
 * The on-screen controls step back while the last input was a mouse or a keyboard, unless
 * the player pinned them (Options). They never disappear: a faded control still takes a
 * finger, which brings them all back.
 */
export function controlsShow(method: InputMethod, pinned: boolean): ControlsShow {
  return pinned || method === "touch" ? "full" : "faded";
}

/** The last input method used; `note` reports whether it changed. */
export class InputMode {
  private method_: InputMethod;

  constructor(initial: InputMethod) {
    this.method_ = initial;
  }

  get method(): InputMethod {
    return this.method_;
  }

  note(method: InputMethod): boolean {
    if (method === this.method_) return false;
    this.method_ = method;
    return true;
  }

  pointer(pointerType: string): boolean {
    return this.note(pointerMethod(pointerType));
  }

  key(k: KeyFacts): boolean {
    return isKeyboardPlay(k) ? this.note("keyboard") : false;
  }
}

/** The method to assume before any event: fingers where the primary pointer is coarse. */
export function initialMethod(coarsePointer: boolean): InputMethod {
  return coarsePointer ? "touch" : "mouse";
}
