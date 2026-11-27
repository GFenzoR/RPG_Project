// Back gesture, Escape and swipe-down for the sheets of a phone (docs/17 "UI movil"). The
// rules are ui/sheets.ts (pure); this keeps one History API entry per open sheet so the
// Android back button (a `popstate`) closes the top sheet instead of leaving the game, and
// lets the sheets' headers close with a swipe down.
import { useEffect, useRef } from "preact/hooks";
import {
  SHEET_KINDS,
  closeTop,
  historyDepth,
  isCloseSwipe,
  syncStack,
  topSheet,
} from "./sheets.ts";
import type { SheetKind, SheetsOpen } from "./sheets.ts";

export type SheetClosers = Readonly<Partial<Record<SheetKind, () => void>>>;

/**
 * Tracks which sheets are open (`open`, `active` false on the desktop: nothing happens) and
 * routes back, Escape and a header swipe to the closer of the top one.
 */
export function useSheets(open: SheetsOpen, closers: SheetClosers, active: boolean): void {
  const stack = useRef<SheetKind[]>([]);
  const pushed = useRef(0);
  const ignore = useRef(0);
  const closersRef = useRef(closers);
  closersRef.current = closers;
  const key = SHEET_KINDS.map((k) => (open[k] ? "1" : "0")).join("");

  // Keep the History entries equal to the stack's depth.
  useEffect(() => {
    const next = active ? syncStack(stack.current, open) : [];
    stack.current = next;
    const want = historyDepth(next);
    try {
      while (pushed.current < want) {
        history.pushState({ rpgSheet: pushed.current + 1 }, "");
        pushed.current++;
      }
      if (pushed.current > want) {
        const back = pushed.current - want;
        pushed.current = want;
        ignore.current += 1; // one popstate for the whole jump
        history.go(-back);
      }
    } catch {
      /* History unavailable (a preview): the sheets still close with their buttons. */
    }
  }, [key, active]);

  useEffect(() => {
    if (!active) return undefined;
    const onPop = (): void => {
      if (ignore.current > 0) {
        ignore.current--;
        return;
      }
      if (pushed.current === 0) return;
      pushed.current--;
      const top = topSheet(stack.current);
      if (!top) return;
      stack.current = closeTop(stack.current);
      closersRef.current[top]?.();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Escape" || e.defaultPrevented) return;
      // After the game's own Escape handling (a menu, an aim, a station): a timeout.
      setTimeout(() => {
        if (e.defaultPrevented) return;
        const top = topSheet(stack.current);
        if (top) closersRef.current[top]?.();
      }, 0);
    };
    let start: { x: number; y: number } | undefined;
    const onDown = (e: PointerEvent): void => {
      const head = (e.target as Element | null)?.closest?.("[data-sheet-head]");
      start = head && e.pointerType !== "mouse" ? { x: e.clientX, y: e.clientY } : undefined;
    };
    const onUp = (e: PointerEvent): void => {
      const s = start;
      start = undefined;
      if (!s || !isCloseSwipe(e.clientX - s.x, e.clientY - s.y)) return;
      const top = topSheet(stack.current);
      if (top) closersRef.current[top]?.();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
    };
  }, [active]);
}
