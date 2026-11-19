import { describe, expect, it } from "vitest";
import {
  CANVAS_FONT,
  CANVAS_FONT_FAMILY,
  CANVAS_FONT_SIZE,
  loadCanvasFont,
} from "./canvas-font.ts";

/** A FontFaceSet whose load resolves (or rejects) when the test says so. */
function fakeFonts() {
  const asked: string[] = [];
  let finish: (faces: unknown[]) => void = () => {};
  let fail: () => void = () => {};
  const fonts = {
    load(font: string) {
      asked.push(font);
      return new Promise<unknown[]>((ok, ko) => {
        finish = ok;
        fail = () => ko(new Error("network"));
      });
    },
  };
  return { fonts, asked, finish: (f: unknown[]) => finish(f), fail: () => fail() };
}

/** A timer the test fires by hand. */
function fakeTimer() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => pending.push(fn),
    fire: () => pending.splice(0).forEach((fn) => fn()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("canvas font", () => {
  it("names the pixel font first, with the system sans as fallback", () => {
    expect(CANVAS_FONT.split(",").map((s) => s.trim())).toEqual([CANVAS_FONT_FAMILY, "sans-serif"]);
    expect(CANVAS_FONT_SIZE).toBe(11);
  });

  it("asks for the font at the canvas size and waits for it", async () => {
    const f = fakeFonts();
    const timer = fakeTimer();
    let late = 0;
    const ready = loadCanvasFont(f.fonts, { setTimer: timer.setTimer, onLate: () => late++ });
    expect(f.asked).toEqual([`11px "Pixelify Sans"`]);
    f.finish([{}]);
    expect(await ready).toBe(true);
    timer.fire(); // the wait running out afterwards changes nothing
    await flush();
    expect(late).toBe(0);
  });

  it("gives up after the wait and asks for a redraw when the font arrives late", async () => {
    const f = fakeFonts();
    const timer = fakeTimer();
    let late = 0;
    const ready = loadCanvasFont(f.fonts, { setTimer: timer.setTimer, onLate: () => late++ });
    timer.fire();
    expect(await ready).toBe(false);
    expect(late).toBe(0);
    f.finish([{}]);
    await flush();
    expect(late).toBe(1);
  });

  it("does not wait without a FontFaceSet, a matching face or a working load", async () => {
    expect(await loadCanvasFont(undefined)).toBe(false);
    const empty = fakeFonts();
    const t1 = fakeTimer();
    const none = loadCanvasFont(empty.fonts, { setTimer: t1.setTimer });
    empty.finish([]);
    expect(await none).toBe(false);
    const broken = fakeFonts();
    const t2 = fakeTimer();
    let late = 0;
    const failed = loadCanvasFont(broken.fonts, { setTimer: t2.setTimer, onLate: () => late++ });
    broken.fail();
    expect(await failed).toBe(false);
    const throwing = {
      load: () => {
        throw new Error("bad font string");
      },
    };
    expect(await loadCanvasFont(throwing, { setTimer: fakeTimer().setTimer })).toBe(false);
    expect(late).toBe(0);
  });
});
