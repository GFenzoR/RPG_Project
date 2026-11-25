import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AMBIENCE_PATHS, LOOP_S, PEAK, TARGET_RMS, XF_S, seamless } from "./ambience.ts";
import { assetFile, BUDGET, checkBudget, GENERATED, manifestFiles, render } from "./index.ts";
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
    // volcan (T5.5): 8 bars of 4 beats at 66 bpm.
    expect(render({ path: "music/volcan", kind: "music" }).length).toBe(
      Math.round(((8 * 4 * 60) / 66) * RATE),
    );
  }, 30_000);

  it("Karvask plays its own loops, not the cave's and the shore's (T5.5)", () => {
    const raw = parse(readFileSync(join(root, "assets", "sounds.yaml"), "utf8")) as {
      music: { islands: Record<string, string>; pools: Record<string, string[]> };
    };
    expect(raw.music.islands["volcan"]).toBe("volcan");
    expect(raw.music.pools["volcan"]).toContain("music_volcan");
    const files = new Map(manifestFiles(root).map((f) => [f.id, f.file]));
    // Its own theme: soundgen's, or the Gemini take the owner picked for it.
    expect(files.get("music_volcan")).toMatch(/^sounds\/music\/(volcan|gemini\/volcan_\d)\.ogg$/);
    expect(files.get("amb_volcan")).toBe("sounds/ambient/volcan.ogg");
  });

  it("the volcanic ambience loops without a click", () => {
    const a = render({ path: "ambient/volcan", kind: "ambient" });
    expect(Math.abs((a[0] ?? 0) - (a[a.length - 1] ?? 0))).toBeLessThan(0.05);
  }, 30_000);

  it("the living world's ambience loops are seamless, as loud as each other, and capped", () => {
    expect(AMBIENCE_PATHS.length).toBeGreaterThanOrEqual(9);
    for (const path of AMBIENCE_PATHS) {
      const g = { path, kind: "ambience" as const };
      expect(assetFile(g), path).toMatch(/^livingworld\/sounds\/ambience\/[a-z_]+\.ogg$/);
      const a = render(g);
      expect(a.length, path).toBe(LOOP_S * RATE);
      let sum = 0;
      let peak = 0;
      for (const v of a) {
        sum += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      const rms = Math.sqrt(sum / a.length);
      expect(peak, path).toBeLessThanOrEqual(PEAK + 1e-6);
      // At the target, or under it where the peak ceiling held it (crackles, drips).
      expect(rms, path).toBeLessThanOrEqual(TARGET_RMS + 1e-6);
      expect(rms, path).toBeGreaterThan(TARGET_RMS / 4);
      // The wrap is no bigger a step than the ordinary ones of the loop.
      const steps = [];
      for (let i = 1; i < a.length; i += 97) steps.push(Math.abs((a[i] ?? 0) - (a[i - 1] ?? 0)));
      steps.sort((x, y) => x - y);
      const p99 = steps[Math.floor(steps.length * 0.99)] ?? 0;
      expect(Math.abs((a[0] ?? 0) - (a[a.length - 1] ?? 0)), path).toBeLessThanOrEqual(p99);
    }
  }, 60_000);

  it("seamless folds the tail over the head with equal power", () => {
    // A ramp rendered past the loop: the head starts as the tail's continuation.
    const a = seamless(1, (n) => Float32Array.from({ length: n }, (_, i) => i / RATE));
    const xf = Math.round(XF_S * RATE);
    expect(a.length).toBe(RATE);
    expect(a[0]).toBeCloseTo(1, 3); // the sample after the loop's last one
    expect(a[xf]).toBeCloseTo(xf / RATE, 3); // past the fold: the ramp itself
    expect(a[a.length - 1]).toBeCloseTo((RATE - 1) / RATE, 3);
  });

  it("sounds.yaml uses every generated file and every own file exists", () => {
    const files = manifestFiles(root);
    const used = new Set(files.map((f) => f.file));
    // A theme a Gemini pick replaced stays, with its recipe, to play again with "none".
    for (const slot of Object.values(gemini().slots)) if (slot.fallback) used.add(slot.fallback);
    for (const g of GENERATED) expect(used, g.path).toContain(assetFile(g));
    for (const f of files) expect(existsSync(join(root, "assets", f.file)), f.file).toBe(true);
  });
});

interface GeminiTrack {
  take: string;
  sound: string;
  file: string;
  volume: number;
  /** Not picked by the owner yet (a cave version until he lists his). */
  provisional: boolean;
  source: string;
  prompt: string;
  seconds: number;
  end: number;
  entries: number[];
  bytes: number;
}

interface GeminiSlot {
  sound: string;
  /** A take, a pool of takes, or "none". */
  pick: string | string[];
  provisional: boolean;
  /** What the slot's own sound plays (a pool's first track, or the fallback with none). */
  file?: string;
  volume?: number;
  fallback?: string;
  /** The sounds of its pool in sounds.yaml music.pools. */
  pool?: string[];
  tracks?: GeminiTrack[];
}

/** assets/sounds/music/gemini.yaml: what `make music-gemini` put in each slot. */
function gemini(): { slots: Record<string, GeminiSlot> } {
  return parse(readFileSync(join(root, "assets", "sounds", "music", "gemini.yaml"), "utf8")) as {
    slots: Record<string, GeminiSlot>;
  };
}

describe("Gemini music (make music-gemini)", () => {
  const slots = Object.entries(gemini().slots);
  const tracks = slots.flatMap(([id, slot]) =>
    (slot.tracks ?? []).map((track) => ({ id, slot, track })),
  );
  const files = new Map(manifestFiles(root).map((f) => [f.id, f]));
  const raw = parse(readFileSync(join(root, "assets", "sounds.yaml"), "utf8")) as {
    sounds: Record<string, { volume?: number; seconds?: number; end?: number; entries?: number[] }>;
    music: { pools: Record<string, string[]> };
  };

  it("sounds.yaml plays what the manifest says, at its volume", () => {
    expect(slots.length).toBeGreaterThan(0);
    for (const [id, slot] of slots) {
      const played = files.get(slot.sound);
      if (!slot.file) {
        expect(played, `${id}: no music of its own`).toBeUndefined();
        continue;
      }
      expect(played?.file, id).toBe(slot.file);
      expect(played?.channel, id).toBe("music");
      expect(raw.sounds[slot.sound]?.volume, id).toBe(slot.volume);
      if (slot.pick === "none") expect(slot.file, id).toBe(slot.fallback);
      else expect(slot.tracks?.[0]?.file, `${id}: a pool's first track`).toBe(slot.file);
      // Its pool is the director's: every track, in order.
      expect(raw.music.pools[id], `${id}: its pool`).toEqual(slot.pool);
    }
    // Every track ships as a sound of its own (a pool's others for the music director).
    for (const { id, track } of tracks) {
      const played = files.get(track.sound);
      expect(played?.file, `${id} ${track.take}`).toBe(track.file);
      expect(played?.channel, `${id} ${track.take}`).toBe("music");
      expect(played?.bytes, `${id} ${track.take}`).toBe(track.bytes);
      expect(raw.sounds[track.sound]?.volume, `${id} ${track.take}`).toBe(track.volume);
      // Whole takes, with where the director may start them.
      const def = raw.sounds[track.sound];
      expect(def?.seconds, `${id} ${track.take}`).toBe(track.seconds);
      expect(def?.end, `${id} ${track.take}`).toBe(track.end);
      expect(def?.entries, `${id} ${track.take}`).toEqual(track.entries);
      expect(track.seconds, `${id} ${track.take}: a whole take`).toBeGreaterThan(120);
    }
  });

  it("every Gemini track is credited with its committed prompt, and nothing else is in its folder", () => {
    const credits = readFileSync(join(root, "assets", "CREDITS.md"), "utf8");
    const ai = credits.slice(credits.indexOf("## Generado con IA"));
    for (const { id, track } of tracks) {
      const row = ai.split("\n").find((l) => l.startsWith(`| \`assets/${track.file}\``));
      expect(row, `${id} ${track.take}: CREDITS.md row`).toBeDefined();
      expect(row, id).toContain(`\`assets/${track.prompt}\``);
      expect(row?.includes("Provisional"), `${id} ${track.take}: provisional in its row`).toBe(
        track.provisional,
      );
      expect(existsSync(join(root, "assets", track.prompt)), `${id}: prompt file`).toBe(true);
    }
    const folder = join(root, "assets", "sounds", "music", "gemini");
    const there = existsSync(folder)
      ? readdirSync(folder).map((f) => `sounds/music/gemini/${f}`)
      : [];
    expect(there.sort()).toEqual(tracks.map(({ track }) => track.file).sort());
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
        [
          "sounds:",
          "  big: { file: sounds/big.ogg, channel: ui }",
          "  gone: { file: sounds/gone.ogg, channel: sfx }",
          "  a: { file: sounds/a.ogg, channel: music }",
          "  b: { file: sounds/b.ogg, channel: music }",
          "music:",
          "  pools: { zone: [a, b] }",
        ].join("\n") + "\n",
      );
      writeFileSync(join(dir, "assets", "sounds", "big.ogg"), Buffer.alloc(BUDGET.totalBytes + 1));
      // Two tracks of one pool, together over its budget.
      const track = Buffer.alloc(BUDGET.poolBytes / 2 + 1);
      writeFileSync(join(dir, "assets", "sounds", "a.ogg"), track);
      writeFileSync(join(dir, "assets", "sounds", "b.ogg"), track);
      const problems = checkBudget(dir);
      expect(problems.filter((p) => p.startsWith("big: "))).toHaveLength(1);
      expect(problems.some((p) => /^gone: .* does not exist/.test(p))).toBe(true);
      expect(problems.some((p) => p.startsWith("total "))).toBe(true);
      expect(problems.some((p) => p.startsWith("pool zone: "))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
