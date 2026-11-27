// Buttons that answer every finger (lote 21, docs/15 "Multitáctil"): the props of a button
// that acts when a touch pointer lifts on it, whichever finger it is, and on a mouse click
// or a keyboard activation as always. The rule is input/pointers.ts TapGuard.
import type { JSX } from "preact";
import { isTouchPointer } from "../input/gestures.ts";
import { TapGuard } from "../input/pointers.ts";

const guards = new WeakMap<Element, TapGuard>();

function guardOf(el: Element): TapGuard {
  let g = guards.get(el);
  if (!g) {
    g = new TapGuard();
    guards.set(el, g);
  }
  return g;
}

export interface TapProps {
  onPointerUp(e: JSX.TargetedPointerEvent<HTMLElement>): void;
  onClick(e: JSX.TargetedMouseEvent<HTMLElement>): void;
}

export function tapProps(act: () => void): TapProps {
  return {
    onPointerUp: (e) => {
      if (!isTouchPointer(e.pointerType)) return;
      const el = e.currentTarget;
      if ((el as HTMLButtonElement).disabled) return;
      const r = el.getBoundingClientRect();
      // The finger slid off the button before lifting: no tap.
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        return;
      guardOf(el).touchUp(e.timeStamp);
      act();
    },
    onClick: (e) => {
      if (guardOf(e.currentTarget).clickCounts(e.timeStamp)) act();
    },
  };
}
