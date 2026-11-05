import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGET, checkBudget, GENERATED, manifestFiles, render } from "./index.ts";
import { RATE, encodeWav, note, rng } from "./synth.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const hash = (b: Float32Array): string =>
  createHash("sha256").update(Buffer.from(b.buffer)).digest("hex");

describe("synth", () => {
  it("parses note names", () => {
    expect(note("A4")).toBe(69);
    expect(note("C4")).toBe(60);
    expect(note("Bb2")).toBe(46);
    expect(note("F#3")).toBe(54);
  });

  it("seeded noise is reproducible", () => {
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("writes a mono 16-bit WAV header", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1]));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readInt16LE(46)).toBe(32767);
    expect(wav.length).toBe(44 + 6);
  });
});

describe("generated sounds", () => {
  it("render the same samples every time, within [-1, 1] and not silent", () => {
    for (const g of GENERATED) {
      const a = render(g);
      expect(hash(render(g)), g.path).toBe(hash(a));
      let peak = 0;
      for (const v of a) peak = Math.max(peak, Math.abs(v));
      expect(peak, g.path).toBeGreaterThan(0.5);
      expect(peak, g.path).toBeLessThanOrEqual(1);
      const sec = a.length / RATE;
      if (g.kind === "sfx") expect(sec, g.path).toBeLessThan(2);
      else expect(sec, g.path).toBeGreaterThanOrEqual(15);
    }
  }, 30_000); // renders every sound twice: ~3 s locally, more on a busy runner

  it("music loops last a whole number of bars", () => {
    // puerto: 16 bars of 4 beats at 96 bpm = 40 s.
    expect(render({ path: "music/puerto", kind: "music" }).length).toBe(40 * RATE);
  }, 30_000);

  it("sounds.yaml uses every generated file and every own file exists", () => {
    const files = manifestFiles(root);
    const used = new Set(files.map((f) => f.file));
    for (const g of GENERATED) expect(used, g.path).toContain(`sounds/${g.path}.ogg`);
    for (const f of files) expect(existsSync(join(root, "assets", f.file)), f.file).toBe(true);
  });
});

describe("size budget (docs/07)", () => {
  it("the committed sounds fit", () => {
    expect(checkBudget(root)).toEqual([]);
  });

  it("reports a file over its channel's limit, a missing file and the total", () => {
    const dir = mkdtempSync(join(tmpdir(), "soundgen-"));
    try {
      mkdirSync(join(dir, "assets", "sounds"), { recursive: true });
      writeFileSync(
        join(dir, "assets", "sounds.yaml"),
        "sounds:\n  big: { file: sounds/big.ogg, channel: ui }\n  gone: { file: sounds/gone.ogg, channel: sfx }\n",
      );
      writeFileSync(join(dir, "assets", "sounds", "big.ogg"), Buffer.alloc(BUDGET.totalBytes + 1));
      const problems = checkBudget(dir);
      expect(problems).toHaveLength(3);
      expect(problems[0]).toMatch(/^big: .* for a ui sound$/);
      expect(problems[1]).toMatch(/^gone: .* does not exist/);
      expect(problems[2]).toMatch(/^total /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
