// A measure a ResizeObserver asks for, run on the next animation frame instead of inside the
// observer's delivery. A measure that sets state re-renders (Preact flushes in a microtask,
// still inside the delivery); when that render changes the size of the observed element
// itself (InventoryPanel: the figure sized to the box's width makes the box taller), the
// browser cannot deliver that change in the same pass and reports "ResizeObserver loop
// completed with undelivered notifications" (an error event; WebKit gives it to the page as
// an error). On the next frame the change is made before the observers run: no loop.

/** A callback to run once on the next frame, however many times it is asked for meanwhile. */
export interface Deferred {
  /** Asks for it (the ResizeObserver's callback). */
  run(): void;
  /** Forgets a pending run (the effect's cleanup). */
  cancel(): void;
}

export function deferredMeasure(
  measure: () => void,
  frame: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
): Deferred {
  let pending: number | undefined;
  return {
    run() {
      if (pending !== undefined) return;
      pending = frame(() => {
        pending = undefined;
        measure();
      });
    },
    cancel() {
      if (pending !== undefined) cancelFrame(pending);
      pending = undefined;
    },
  };
}
