import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../vite/content.ts";
import {
  TITLE_ART,
  TITLE_FADE_MS,
  TITLE_HOLD_MS,
  TITLE_PRELOAD_LEAD_MS,
  titleNext,
  titlePlan,
  titleReduced,
  titleStart,
  titleUrl,
} from "./title-art.ts";

describe("titleStart", () => {
  it("maps the random number onto the pictures", () => {
    expect(titleStart(3, () => 0)).toBe(0);
    expect(titleStart(3, () => 0.34)).toBe(1);
    expect(titleStart(3, () => 0.99)).toBe(2);
  });
  it("stays inside the list whatever the generator says", () => {
    expect(titleStart(3, () => 1)).toBe(2);
    expect(titleStart(3, () => -4)).toBe(0);
    expect(titleStart(3, () => NaN)).toBe(0);
  });
  it("is 0 with one picture or none, without asking the generator", () => {
    const never = (): number => {
      throw new Error("not needed");
    };
    expect(titleStart(1, never)).toBe(0);
    expect(titleStart(0, never)).toBe(0);
  });
});

describe("titleNext", () => {
  it("walks the pictures in turn and wraps around", () => {
    expect([0, 1, 2, 0].map((i) => titleNext(i, 3))).toEqual([1, 2, 0, 1]);
    expect(titleNext(0, 1)).toBe(0);
    expect(titleNext(0, 0)).toBe(0);
  });
  it("visits every picture before repeating one", () => {
    const seen = new Set<number>();
    let i = 1;
    for (let n = 0; n < TITLE_ART.length; n++) {
      seen.add(i);
      i = titleNext(i, TITLE_ART.length);
    }
    expect(seen.size).toBe(TITLE_ART.length);
  });
});

describe("titlePlan", () => {
  it("rotates from a random picture", () => {
    expect(titlePlan(3, false, () => 0.5)).toEqual({ start: 1, rotates: true });
  });
  it("with reduced motion keeps one random picture, fixed", () => {
    expect(titlePlan(3, true, () => 0.9)).toEqual({ start: 2, rotates: false });
  });
  it("does not rotate a single picture", () => {
    expect(titlePlan(1, false, () => 0.9)).toEqual({ start: 0, rotates: false });
  });
});

describe("titleReduced", () => {
  it("is either the game's option or the system's", () => {
    expect(titleReduced(false, false)).toBe(false);
    expect(titleReduced(true, false)).toBe(true);
    expect(titleReduced(false, true)).toBe(true);
  });
});

describe("the timing", () => {
  it("fades for 12-20 s cycles, and starts loading before the swap", () => {
    const cycle = (TITLE_HOLD_MS + TITLE_FADE_MS) / 1000;
    expect(cycle).toBeGreaterThanOrEqual(12);
    expect(cycle).toBeLessThanOrEqual(20);
    expect(TITLE_PRELOAD_LEAD_MS).toBeLessThan(TITLE_HOLD_MS);
    expect(TITLE_FADE_MS).toBeLessThan(TITLE_HOLD_MS);
  });
  it("matches the fade of title-art.css", () => {
    const css = readFileSync(join(repoRoot(), "client/src/ui/title-art.css"), "utf8");
    expect(css).toContain(`--title-fade: ${TITLE_FADE_MS}ms`);
  });
});

describe("the pictures", () => {
  const dir = join(repoRoot(), "assets", "title");
  it("are the files of assets/title/, each once", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".webp"));
    expect(TITLE_ART.map((a) => a.file).sort()).toEqual(files.sort());
    expect(new Set(TITLE_ART.map((a) => a.id)).size).toBe(TITLE_ART.length);
  });
  it("are light: well under 300 KB each", () => {
    for (const a of TITLE_ART)
      expect(readFileSync(join(dir, a.file)).length).toBeLessThan(300 * 1024);
  });
  it("have a crop position per shape of screen and a URL under /title/", () => {
    for (const a of TITLE_ART) {
      expect(a.wide).toMatch(/^\d+% \d+%$/);
      expect(a.tall).toMatch(/^\d+% \d+%$/);
      expect(titleUrl(a)).toBe(`/title/${a.file}`);
    }
  });
});
