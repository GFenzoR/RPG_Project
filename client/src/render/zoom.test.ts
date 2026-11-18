import { describe, expect, it } from "vitest";
import {
  MIN_VIEW,
  WHEEL_IDLE_MS,
  WheelZoom,
  fillScale,
  loadZoom,
  pinchZoom,
  saveZoom,
  shownTiles,
  stepZoom,
  viewPixels,
  zoomPref,
  zoomRange,
  zoomScale,
} from "./zoom.ts";

const T = 32;
const sizeOf = (v: { width: number; height: number }): [number, number] => [v.width, v.height];

describe("zoomRange", () => {
  it("starts at the scale that fits the whole 15x11 view (a server from before the wide view)", () => {
    // 1280x800 desktop: the map box is about 1000x730 CSS px at 1 device px per CSS px.
    expect(zoomRange(1000, 730, 1, T)).toEqual({ min: 2, fit: 2, max: 4 });
    // Pixel 7 portrait: a 412x302 map box at 2.625 device px per CSS px.
    expect(zoomRange(412, 302, 2.625, T)).toEqual({ min: 2, fit: 2, max: 4 });
  });

  it("never goes below 1, and max is never below fit", () => {
    expect(zoomRange(100, 80, 1, T)).toEqual({ min: 1, fit: 1, max: 1 });
    expect(zoomRange(0, 0, 1, T)).toEqual({ min: 1, fit: 1, max: 1 });
  });

  it("keeps MIN_VIEW tiles in view at the largest scale", () => {
    const r = zoomRange(1700, 1000, 1, T);
    expect(1700 / (r.max * T)).toBeGreaterThanOrEqual(MIN_VIEW.width);
    expect(1000 / (r.max * T)).toBeGreaterThanOrEqual(MIN_VIEW.height);
    expect(1000 / ((r.max + 1) * T)).toBeLessThan(MIN_VIEW.height);
  });
});

describe("zoomScale and zoomPref", () => {
  const range = { min: 2, fit: 2, max: 4 };

  it("fits the view without a choice and clamps a remembered one", () => {
    expect(zoomScale(undefined, range)).toBe(2);
    expect(zoomScale(3, range)).toBe(3);
    expect(zoomScale(9, range)).toBe(4);
    expect(zoomScale(1, range)).toBe(2); // never below the fitted view
    expect(zoomScale(Number.NaN, range)).toBe(2);
  });

  it("forgets the choice at the fitted scale, so it follows the window again", () => {
    expect(zoomPref(2, range)).toBeUndefined();
    expect(zoomPref(1, range)).toBeUndefined();
    expect(zoomPref(3, range)).toBe(3);
    expect(zoomPref(7, range)).toBe(4);
  });
});

describe("stepZoom", () => {
  const range = { min: 2, fit: 2, max: 4 };

  it("moves one whole scale per step and stops at the ends", () => {
    expect(stepZoom(2, 1, range)).toBe(3);
    expect(stepZoom(3, 1, range)).toBe(4);
    expect(stepZoom(4, 1, range)).toBe(4);
    expect(stepZoom(4, -1, range)).toBe(3);
    expect(stepZoom(3, -1, range)).toBeUndefined();
    expect(stepZoom(2, -1, range)).toBeUndefined();
  });
});

describe("pinchZoom", () => {
  const range = { min: 2, fit: 2, max: 5 };

  it("rounds the spread fingers to a whole scale", () => {
    expect(pinchZoom(2, 1, range)).toBe(2);
    expect(pinchZoom(2, 1.2, range)).toBe(2);
    expect(pinchZoom(2, 1.3, range)).toBe(3);
    expect(pinchZoom(2, 2, range)).toBe(4);
    expect(pinchZoom(4, 0.6, range)).toBe(2);
    expect(pinchZoom(3, 0.9, range)).toBe(3);
  });

  it("stays within the range", () => {
    expect(pinchZoom(2, 10, range)).toBe(5);
    expect(pinchZoom(4, 0.1, range)).toBe(2);
    expect(pinchZoom(3, 0, range)).toBe(3);
    expect(pinchZoom(3, Number.POSITIVE_INFINITY, range)).toBe(3);
  });
});

describe("viewPixels", () => {
  it("is the whole view when it fits", () => {
    expect(viewPixels(1000, 730, 2, T)).toEqual({ width: 960, height: 704 });
  });

  it("is cut to the box, in whole sprite pixels, when zoomed in", () => {
    // Pixel 7 portrait at 3x: 1081 x 792 device px.
    const v = viewPixels(1081, 792, 3, T);
    expect(v).toEqual({ width: 1080, height: 792 });
    expect(v.width % 3).toBe(0);
    expect(v.height % 3).toBe(0);
  });

  it("keeps at least one sprite pixel", () => {
    expect(viewPixels(0, 0, 2, T)).toEqual({ width: 2, height: 2 });
  });
});

describe("the wide view (31x21, Welcome.view_width/height)", () => {
  const WIDE = { width: 31, height: 21 };

  it("fits the largest view with no empty part, and zooms out to the whole window", () => {
    // 1920x1080 with the dock of before (a 1536x1080 box). 3x is the largest scale that
    // shows 15x11, but only 16x11 of the window; 2x fills the box with 24x16 of it; 1x
    // shows all of it with a dark border.
    expect(zoomRange(1536, 1080, 1, T, WIDE)).toEqual({ min: 1, fit: 2, max: 6 });
    // 2560x1440: a 2176x1440 box. 3x (22x14), not the 4x of 15x11; out to 2x, which
    // already shows the whole window.
    expect(zoomRange(2176, 1440, 1, T, WIDE)).toEqual({ min: 2, fit: 3, max: 9 });
    // A 1440x900 laptop at 2 device px per CSS px: a 1056x900 box, 3x (22x17), not 4x.
    expect(zoomRange(1056, 900, 2, T, WIDE)).toEqual({ min: 2, fit: 3, max: 9 });
    // 1280x800: a 960x800 box. 2x (15x12): at 1x the window (30x21 of it) leaves part of
    // the box empty.
    expect(zoomRange(960, 800, 1, T, WIDE)).toEqual({ min: 1, fit: 2, max: 4 });
    // A server with the classic window: the classic scale, nothing to zoom out to.
    expect(zoomRange(1536, 1080, 1, T)).toEqual({ min: 3, fit: 3, max: 6 });
    expect(zoomRange(1680, 1043, 1, T)).toEqual({ min: 2, fit: 2, max: 6 });
  });

  it("covers the full-screen desktop map above the bar (docs/17 UI-4, cover)", () => {
    // The desktop map is the whole screen above the bottom bar (88 px at 100 %): the
    // box is the screen less 88 px of height. 1920x1080: 1920x992, 2x with 30x15.5 tiles.
    expect(zoomRange(1920, 992, 1, T, WIDE, true)).toEqual({ min: 1, fit: 2, max: 6 });
    expect(shownTiles(...sizeOf(viewPixels(1920, 992, 2, T, WIDE)), 2, T)).toEqual({
      width: 30,
      height: 15.5,
    });
    // 2560x1440: 2560x1352, 3x (26.7x14.1); out to 2x, the whole window.
    expect(zoomRange(2560, 1352, 1, T, WIDE, true)).toEqual({ min: 2, fit: 3, max: 8 });
    // 1280x800: 1280x712, 2x with 20x11.1.
    expect(zoomRange(1280, 712, 1, T, WIDE, true)).toEqual({ min: 1, fit: 2, max: 4 });
    expect(shownTiles(...sizeOf(viewPixels(1280, 712, 2, T, WIDE)), 2, T)).toEqual({
      width: 20,
      height: 11.125,
    });
    // 1280x720: 1280x632. Covering it takes 2x (20x9.9 tiles above the bar); the rule of
    // the phones (never less than 15x11) would give 1x with dark strips at the sides.
    expect(zoomRange(1280, 632, 1, T, WIDE, true)).toEqual({ min: 1, fit: 2, max: 3 });
    expect(zoomRange(1280, 632, 1, T, WIDE)).toEqual({ min: 1, fit: 1, max: 3 });
    // 960x700 (the desktop app): 960x612, 1x with 30x19.1.
    expect(zoomRange(960, 612, 1, T, WIDE, true)).toEqual({ min: 1, fit: 1, max: 3 });
    expect(viewPixels(960, 612, 1, T, WIDE)).toEqual({ width: 960, height: 612 });
    // Ultra-wide screens: covering the width takes a scale that leaves fewer rows than the
    // classic 11 (the owner's choice: no empty strips; zooming out shows the whole window).
    // 2560x1080: 2560x992, 3x with 26.7x10.3; 3440x1440: 3440x1352, 4x with 26.9x10.6.
    expect(zoomRange(2560, 992, 1, T, WIDE, true)).toEqual({ min: 1, fit: 3, max: 6 });
    expect(shownTiles(...sizeOf(viewPixels(2560, 992, 3, T, WIDE)), 3, T)).toEqual({
      width: 26.65625,
      height: 10.3125,
    });
    expect(zoomRange(3440, 1352, 1, T, WIDE, true)).toEqual({ min: 2, fit: 4, max: 8 });
    expect(shownTiles(...sizeOf(viewPixels(3440, 1352, 4, T, WIDE)), 4, T)).toEqual({
      width: 26.875,
      height: 10.5625,
    });
    // A server with the classic window keeps the classic scale.
    expect(zoomRange(1920, 992, 1, T, undefined, true)).toEqual({ min: 2, fit: 2, max: 6 });
  });

  it("never fits a view smaller than 15x11: small windows keep the classic scale", () => {
    // 960x700 (the desktop app's narrow window): a 688x700 box. 1x shows 21x21; 2x would
    // fill it with about 11x11.
    expect(zoomRange(688, 700, 1, T, WIDE)).toEqual({ min: 1, fit: 1, max: 3 });
    // Pixel 7 on its side: a 915x330 box at 2.625 device px per CSS px. 2x shows the whole
    // width of the window (31 tiles) and 13 rows; 3x would fill it with 25x9.
    expect(zoomRange(915, 330, 2.625, T, WIDE)).toEqual({ min: 1, fit: 2, max: 5 });
  });

  it("finds the smallest whole scale at which the window covers the box", () => {
    expect(fillScale(1536, 1080, 1, T, WIDE)).toBe(2);
    expect(fillScale(992, 672, 1, T, WIDE)).toBe(1); // exactly the window
    expect(fillScale(993, 672, 1, T, WIDE)).toBe(2);
    // 1240x840 CSS px at 1.25 device px per CSS px: 1550x1050, a hair over 1.5625.
    expect(fillScale(1240, 840, 1.25, T, WIDE)).toBe(2);
    // 793.6 x 537.6 at 1.25 is the window exactly: no rounding up to 2.
    expect(fillScale(793.6, 537.6, 1.25, T, WIDE)).toBe(1);
    expect(fillScale(0, 0, 1, T, WIDE)).toBe(1);
    expect(fillScale(100, 100, Number.NaN, T, WIDE)).toBe(1);
  });

  it("keeps the scale of before on a phone, and zooms out to 1", () => {
    // iPhone 13 portrait: a 390x480 box at 3 device px per CSS px.
    expect(zoomRange(390, 480, 3, T, WIDE)).toEqual({ min: 1, fit: 2, max: 5 });
  });

  it("remembers a zoom out and forgets the fitted view", () => {
    const r = { min: 1, fit: 2, max: 6 };
    expect(zoomScale(undefined, r)).toBe(2);
    expect(stepZoom(2, -1, r)).toBe(1);
    expect(stepZoom(1, -1, r)).toBe(1);
    expect(stepZoom(1, 1, r)).toBeUndefined();
    expect(stepZoom(2, 1, r)).toBe(3);
    expect(zoomPref(0, r)).toBe(1);
    expect(pinchZoom(2, 0.4, r)).toBe(1);
  });

  it("fills the box with as much of the window as fits", () => {
    // 1920x1080 at 2x, the screen above the bar: 1920x992 of the window.
    expect(viewPixels(1920, 992, 2, T, WIDE)).toEqual({ width: 1920, height: 992 });
    // At 1x the whole window fits.
    expect(viewPixels(1920, 992, 1, T, WIDE)).toEqual({ width: 992, height: 672 });
    expect(shownTiles(992, 672, 1, T)).toEqual({ width: 31, height: 21 });
    // 1280x720 at 1x: all 31 columns and the 19 rows (and a quarter) the box holds.
    expect(viewPixels(1280, 632, 1, T, WIDE)).toEqual({ width: 992, height: 632 });
    // iPhone 13 portrait at 2x: cut to the box.
    expect(viewPixels(1170, 1440, 2, T, WIDE)).toEqual({ width: 1170, height: 1344 });
  });
});

describe("WheelZoom", () => {
  it("turns a mouse notch into one step: up zooms in, down zooms out", () => {
    const w = new WheelZoom();
    expect(w.add(-100, 0, 0)).toBe(1);
    expect(w.add(100, 0, 500)).toBe(-1);
  });

  it("adds up small trackpad events into a single step", () => {
    const w = new WheelZoom();
    const steps = [-8, -8, -8, -8, -8, -8, -8].map((d, i) => w.add(d, 0, i * 16));
    expect(steps).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it("starts over after a pause", () => {
    const w = new WheelZoom();
    expect(w.add(-30, 0, 0)).toBe(0);
    expect(w.add(-30, 0, WHEEL_IDLE_MS + 1)).toBe(0);
    expect(w.add(-30, 0, WHEEL_IDLE_MS + 20)).toBe(1);
  });

  it("reads lines and pages (Firefox)", () => {
    const w = new WheelZoom();
    expect(w.add(3, 1, 0)).toBe(-1);
    expect(w.add(-1, 2, 1000)).toBe(1);
    expect(w.add(Number.NaN, 0, 2000)).toBe(0);
  });
});

describe("loadZoom and saveZoom", () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k) => m.get(k) ?? null,
      key: (i) => [...m.keys()][i] ?? null,
      removeItem: (k) => void m.delete(k),
      setItem: (k, v) => void m.set(k, v),
    };
  };

  it("remembers a scale and forgets the fitted view", () => {
    const s = memory();
    expect(loadZoom(s)).toBeUndefined();
    saveZoom(3, s);
    expect(loadZoom(s)).toBe(3);
    saveZoom(undefined, s);
    expect(loadZoom(s)).toBeUndefined();
    expect(s.length).toBe(0);
  });

  it("ignores junk and blocked storage", () => {
    const s = memory();
    for (const junk of ["0", "-2", "2.5", "abc", "1000"]) {
      s.setItem("rpg.zoom", junk);
      expect(loadZoom(s)).toBeUndefined();
    }
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadZoom(blocked)).toBeUndefined();
    expect(() => saveZoom(3, blocked)).not.toThrow();
    expect(loadZoom(undefined)).toBeUndefined();
  });
});
