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
 * How long after a back the History entries are checked against the sheets again, ms. A
 * sheet the server closes (a trade, the market, the stash) is still open then: its entry
 * is pushed again, so a second back during the lag asks to close once more instead of
 * leaving the game in the middle of a trade.
 */
export const BACK_RESYNC_MS = 50;

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
  // The sheets open at the last render. The stack follows in an effect, after the paint:
  // a key or a back that arrives in between (Escape right after the key that opened the
  // sheet) reads the top from here, or it would find the stack of before and do nothing.
  const liveRef = useRef<SheetsOpen | undefined>(undefined);
  liveRef.current = active ? open : undefined;
  const top = (): SheetKind | undefined =>
    topSheet(liveRef.current ? syncStack(stack.current, liveRef.current) : []);
  const key = SHEET_KINDS.map((k) => (open[k] ? "1" : "0")).join("");

  // Keep the History entries equal to the stack's depth.
  const sync = (): void => {
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
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(sync, [key, active]);

  // The game view goes away with sheets open (logout, a lost connection): their entries
  // go too, or coming back would need that many dead backs before leaving.
  useEffect(
    () => () => {
      const left = pushed.current;
      pushed.current = 0;
      stack.current = [];
      if (left === 0) return;
      try {
        history.go(-left);
      } catch {
        /* History unavailable. */
      }
    },
    [],
  );

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
      // Closed here, the next render agrees. Still open then (the server closes it): its
      // entry comes back.
      setTimeout(() => syncRef.current(), BACK_RESYNC_MS);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Escape" || e.defaultPrevented) return;
      // After the game's own Escape handling (a menu, an aim, a station): a timeout.
      setTimeout(() => {
        if (e.defaultPrevented) return;
        const k = top();
        if (k) closersRef.current[k]?.();
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
      const k = top();
      if (k) closersRef.current[k]?.();
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
