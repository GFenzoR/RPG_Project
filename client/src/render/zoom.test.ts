import { describe, expect, it } from "vitest";
import {
  MIN_VIEW,
  WHEEL_IDLE_MS,
  WheelZoom,
  loadZoom,
  pinchZoom,
  saveZoom,
  stepZoom,
  viewPixels,
  zoomPref,
  zoomRange,
  zoomScale,
} from "./zoom.ts";

const T = 32;

describe("zoomRange", () => {
  it("starts at the scale that fits the whole 15x11 view", () => {
    // 1280x800 desktop: the map box is about 1000x730 CSS px at 1 device px per CSS px.
    expect(zoomRange(1000, 730, 1, T)).toEqual({ min: 2, max: 4 });
    // Pixel 7 portrait: a 412x302 map box at 2.625 device px per CSS px.
    expect(zoomRange(412, 302, 2.625, T)).toEqual({ min: 2, max: 4 });
  });

  it("never goes below 1, and max is never below min", () => {
    expect(zoomRange(100, 80, 1, T)).toEqual({ min: 1, max: 1 });
    expect(zoomRange(0, 0, 1, T)).toEqual({ min: 1, max: 1 });
  });

  it("keeps MIN_VIEW tiles in view at the largest scale", () => {
    const r = zoomRange(1700, 1000, 1, T);
    expect(1700 / (r.max * T)).toBeGreaterThanOrEqual(MIN_VIEW.width);
    expect(1000 / (r.max * T)).toBeGreaterThanOrEqual(MIN_VIEW.height);
    expect(1000 / ((r.max + 1) * T)).toBeLessThan(MIN_VIEW.height);
  });
});

describe("zoomScale and zoomPref", () => {
  const range = { min: 2, max: 4 };

  it("fits the view without a choice and clamps a remembered one", () => {
    expect(zoomScale(undefined, range)).toBe(2);
    expect(zoomScale(3, range)).toBe(3);
    expect(zoomScale(9, range)).toBe(4);
    expect(zoomScale(1, range)).toBe(2); // never below what fits the 15x11 view
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
  const range = { min: 2, max: 4 };

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
  const range = { min: 2, max: 5 };

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
