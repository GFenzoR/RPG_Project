import { describe, expect, it } from "vitest";
import { deferredMeasure } from "./next-frame.ts";

/** A fake animation frame: the callbacks wait until `tick`. */
function frames(): {
  frame: (cb: () => void) => number;
  cancel: (id: number) => void;
  tick: () => void;
  waiting: () => number;
} {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    frame: (cb) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancel: (id) => queue.delete(id),
    tick: () => {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb();
    },
    waiting: () => queue.size,
  };
}

describe("deferredMeasure (a ResizeObserver's measure on the next frame)", () => {
  it("measures on the next frame, not inside the observer's delivery", () => {
    const f = frames();
    let measured = 0;
    const later = deferredMeasure(() => measured++, f.frame, f.cancel);
    later.run();
    expect(measured).toBe(0);
    f.tick();
    expect(measured).toBe(1);
  });

  it("measures once per frame however many times it is asked", () => {
    const f = frames();
    let measured = 0;
    const later = deferredMeasure(() => measured++, f.frame, f.cancel);
    later.run();
    later.run();
    later.run();
    expect(f.waiting()).toBe(1);
    f.tick();
    expect(measured).toBe(1);
    // Asked again afterwards (the next change): another frame.
    later.run();
    f.tick();
    expect(measured).toBe(2);
  });

  it("forgets a pending measure when cancelled (the element is gone)", () => {
    const f = frames();
    let measured = 0;
    const later = deferredMeasure(() => measured++, f.frame, f.cancel);
    later.run();
    later.cancel();
    f.tick();
    expect(measured).toBe(0);
    // And can be asked again.
    later.run();
    f.tick();
    expect(measured).toBe(1);
  });
});
