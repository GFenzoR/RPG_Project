import { describe, expect, it } from "vitest";
import {
  CUT_MS,
  MAX_VOICES,
  MusicDirector,
  RESUME_MARGIN_S,
  envelopePoints,
  gainAt,
  positionAt,
  seededRandom,
} from "./director.ts";
import type { DirectorConfig, MusicTrack, Scene, Voice } from "./director.ts";

const track = (seconds: number, entries: number[], end = seconds - 5): MusicTrack => ({
  seconds,
  end,
  entries,
});

const CONFIG: DirectorConfig = {
  pools: {
    town: ["t1", "t2", "t3"],
    cave: ["c1", "c2"],
    forest: ["f1"],
    boss: ["b1"],
    title: ["menu"],
    quest: ["q1"],
    old: ["loop"],
  },
  tracks: {
    t1: track(180, [10, 30, 50, 70]),
    t2: track(170, [12, 40, 90]),
    t3: track(175, [20, 60]),
    c1: track(160, [15, 45]),
    c2: track(150, [25, 55]),
    f1: track(180, [16, 42, 80]),
    b1: track(180, [16, 50]),
    menu: track(176, [12, 27, 48], 161),
    q1: track(120, [10, 40]),
    loop: { seconds: undefined, end: 0, entries: [] },
  },
  titlePool: "title",
  fades: { zone: 5000, bossIn: 1500, bossOut: 6000, title: 3000, next: 4000 },
  dwellMs: 3000,
  bossHoldMs: 5000,
  resumeMs: 180_000,
  gapMs: [6000, 15000],
};

const world = (zone?: string, extra: { quest?: string; boss?: string } = {}): Scene => ({
  kind: "world",
  zone,
  quest: extra.quest,
  boss: extra.boss,
});

const always = (): boolean => true;

/** A director and a clock that steps it every `step` ms, like the engine's pump. */
function run(seed = 7, config = CONFIG) {
  const d = new MusicDirector(config, seededRandom(seed));
  let now = 0;
  let ready: (s: string) => boolean = always;
  const at = (scene: Scene, ms: number, step = 250): void => {
    const end = now + ms;
    for (; now < end; now += step) d.update(now, scene, ready);
    d.update(now, scene, ready);
  };
  return {
    d,
    at,
    now: () => now,
    lead: (): Voice | undefined => d.voices().find((v) => v.env.to > 0),
    setReady: (fn: (s: string) => boolean) => (ready = fn),
  };
}

describe("equal-power envelopes", () => {
  it("fade in along sin and out along cos, so a crossfade keeps the power", () => {
    const fadeIn = { at: 1000, ms: 4000, from: 0, to: 1 };
    const fadeOut = { at: 1000, ms: 4000, from: 1, to: 0 };
    for (let t = 1000; t <= 5000; t += 125) {
      const a = gainAt(fadeIn, t);
      const b = gainAt(fadeOut, t);
      expect(a * a + b * b).toBeCloseTo(1, 9);
    }
    expect(gainAt(fadeIn, 3000)).toBeCloseTo(Math.SQRT1_2, 9); // −3 dB each at the middle
    expect(gainAt(fadeIn, 0)).toBe(0);
    expect(gainAt(fadeIn, 9000)).toBe(1);
    // A fade-out cut in half starts from where the fade-in was, without a jump.
    const half = gainAt(fadeIn, 2000);
    const back = { at: 2000, ms: 1000, from: half, to: 0 };
    expect(gainAt(back, 2000)).toBeCloseTo(half, 9);
    expect(gainAt(back, 3000)).toBe(0);
    expect(gainAt({ at: 10, ms: 0, from: 0, to: 1 }, 10)).toBe(1);
  });

  it("gives the engine points up to the envelope's end, and none after it", () => {
    const env = { at: 0, ms: 1000, from: 0, to: 1 };
    const pts = envelopePoints(env, 0, 50);
    expect(pts).toHaveLength(20);
    expect(pts.at(-1)).toEqual([1000, 1]);
    for (const [t, g] of pts) expect(g).toBeCloseTo(gainAt(env, t), 9);
    for (let i = 1; i < pts.length; i++)
      expect(pts[i]?.[1] ?? 0).toBeGreaterThan(pts[i - 1]?.[1] ?? 0);
    expect(envelopePoints(env, 600, 50)[0]?.[0]).toBe(650);
    expect(envelopePoints(env, 1000, 50)).toEqual([]);
    expect(envelopePoints({ at: 0, ms: 0, from: 0, to: 1 }, 0, 50)).toEqual([]);
  });

  it("the same seed gives the same music", () => {
    const a = seededRandom(3);
    const b = seededRandom(3);
    const xs = Array.from({ length: 5 }, () => a());
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()));
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(seededRandom(4)()).not.toBe(xs[0]);
  });
});

describe("MusicDirector", () => {
  it("starts a zone's track at one of its entries, never at its beginning", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { d, at } = run(seed);
      at(world("town"), 0);
      const v = d.voices()[0];
      expect(v).toBeDefined();
      const entries = CONFIG.tracks[v?.sound ?? ""]?.entries ?? [];
      expect(entries).toContain(v?.from);
      expect(v?.from).not.toBe(0);
    }
  });

  it("starts a loop file (no entries) at 0, looping", () => {
    const { d, at } = run();
    at(world("old"), 0);
    expect(d.voices()[0]).toMatchObject({ sound: "loop", from: 0, loop: true });
    at(world("old"), 3_600_000, 10_000); // an hour: it never ends
    expect(d.voices()).toHaveLength(1);
  });

  it("never plays the same track twice in a row, and plays the whole pool each round", () => {
    const { d, at } = run(11);
    const played: string[] = [];
    at(world("town"), 0);
    for (let i = 0; i < 90; i++) {
      const lead = d.voices().find((v) => v.env.to > 0);
      if (lead && played.at(-1) !== `${lead.id}:${lead.sound}`)
        played.push(`${lead.id}:${lead.sound}`);
      at(world("town"), 20_000, 1000);
    }
    const sounds = played.map((p) => p.split(":")[1]);
    expect(sounds.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < sounds.length; i++) expect(sounds[i]).not.toBe(sounds[i - 1]);
    for (let i = 0; i + 3 <= sounds.length; i += 3)
      expect(new Set(sounds.slice(i, i + 3)).size).toBe(3);
  });

  it("lets a zone's track play out its ending, rests, then fades the next one in", () => {
    const { d, at, now } = run(5);
    at(world("town"), 0);
    const first = d.voices()[0] as Voice;
    const track = CONFIG.tracks[first.sound] as MusicTrack & { seconds: number };
    const left = (track.seconds - first.from) * 1000;
    at(world("town"), left - 250);
    expect(d.voices()).toHaveLength(1); // its own ending, no crossfade over it
    at(world("town"), 500);
    expect(d.voices()).toHaveLength(0); // the rest: ambience only
    const restFrom = now();
    while (d.voices().length === 0 && now() - restFrom < 20_000) at(world("town"), 250);
    const rest = now() - restFrom;
    expect(rest).toBeGreaterThanOrEqual(CONFIG.gapMs[0] - 250);
    expect(rest).toBeLessThanOrEqual(CONFIG.gapMs[1] + 500);
    const next = d.voices()[0] as Voice;
    expect(next.sound).not.toBe(first.sound);
    expect(next.env).toMatchObject({ from: 0, to: 1, ms: CONFIG.fades.next });
  });

  it("crossfades a boss's track into the next before its ending, never stopping", () => {
    const { d, at } = run(2);
    at(world("forest", { boss: "boss" }), 0);
    const first = d.voices()[0] as Voice;
    const start = (CONFIG.tracks["b1"]?.end ?? 0) - CONFIG.fades.next / 1000;
    at(world("forest", { boss: "boss" }), (start - first.from) * 1000 + 250);
    const [old, next] = d.voices();
    expect(next?.sound).toBe("b1"); // a pool of one: the same track at another entry
    expect(next?.from).not.toBe(first.from);
    expect(old?.env.to).toBe(0);
    expect(old?.env.ms).toBe(CONFIG.fades.next);
    expect(next?.env).toMatchObject({ at: old?.env.at, ms: CONFIG.fades.next });
  });

  it("changes zone only after the dwell: walking along a border never flaps", () => {
    const { d, at } = run();
    at(world("town"), 1000);
    const town = d.voices()[0];
    for (let i = 0; i < 10; i++) {
      at(world("forest"), 2000);
      at(world("town"), 1000);
    }
    expect(d.voices()).toEqual([town]);
    expect(d.playing()?.pool).toBe("town");
    at(world("forest"), CONFIG.dwellMs - 250);
    expect(d.playing()?.pool).toBe("town");
    at(world("forest"), 500);
    expect(d.playing()?.pool).toBe("forest");
  });

  it("crossfades a zone change with equal power: the old fades out as the new fades in", () => {
    const { d, at, now } = run();
    at(world("town"), 10_000);
    at(world("cave"), CONFIG.dwellMs + 250);
    const [old, cave] = d.voices() as [Voice, Voice];
    expect(cave.pool).toBe("cave");
    expect(old.env).toMatchObject({ at: cave.env.at, ms: CONFIG.fades.zone, from: 1, to: 0 });
    for (let t = now(); t <= now() + CONFIG.fades.zone; t += 100) {
      const a = gainAt(old.env, t);
      const b = gainAt(cave.env, t);
      expect(a * a + b * b).toBeCloseTo(1, 9);
    }
    at(world("cave"), CONFIG.fades.zone + 250);
    expect(d.voices()).toEqual([cave]); // the old one is gone once silent
  });

  it("goes on where it was when the player comes back soon, and starts afresh later", () => {
    const { d, at, now } = run(9);
    at(world("town"), 30_000);
    const town = d.voices()[0] as Voice;
    at(world("cave"), CONFIG.dwellMs);
    const left = positionAt(town, now());
    at(world("cave"), 40_000);
    at(world("town"), CONFIG.dwellMs);
    const back = d.voices().at(-1) as Voice;
    expect(back.sound).toBe(town.sound);
    expect(back.from).toBeCloseTo(left, 6); // where it was when the cave took over
    // Away for longer than resumeMs: a fresh track of the pool, at an entry.
    at(world("cave"), CONFIG.dwellMs);
    at(world("cave"), CONFIG.resumeMs + 1000, 5000);
    at(world("town"), CONFIG.dwellMs);
    const fresh = d.voices().at(-1) as Voice;
    expect(CONFIG.tracks[fresh.sound]?.entries).toContain(fresh.from);
  });

  it("does not resume a track that was about to end", () => {
    const { d, at, now } = run(9);
    at(world("town"), 0);
    const town = d.voices()[0] as Voice;
    const end = CONFIG.tracks[town.sound]?.end ?? 0;
    at(world("town"), (end - RESUME_MARGIN_S + 1 - town.from) * 1000);
    at(world("cave"), CONFIG.dwellMs);
    expect(positionAt(town, now())).toBeGreaterThan(end - RESUME_MARGIN_S);
    at(world("cave"), 10_000);
    at(world("town"), CONFIG.dwellMs);
    const back = d.voices().at(-1) as Voice;
    expect(CONFIG.tracks[back.sound]?.entries).toContain(back.from);
  });

  it("an ordinary fight is no input: only a boss changes the music, at once", () => {
    const { d, at } = run(4);
    at(world("forest"), 20_000);
    const forest = d.voices()[0] as Voice;
    at(world("forest", { boss: "boss" }), 0);
    const boss = d.voices().at(-1) as Voice;
    expect(boss).toMatchObject({ pool: "boss", role: "boss" });
    expect(boss.env.ms).toBe(CONFIG.fades.bossIn);
    expect(forest.env).toMatchObject({ to: 0, ms: CONFIG.fades.bossIn });
  });

  it("holds the boss's music after it leaves the view, then goes back to the zone's track at a fresh entry", () => {
    const { d, at, now } = run(4);
    at(world("forest"), 20_000);
    const forest = d.voices()[0] as Voice;
    at(world("forest", { boss: "boss" }), 30_000);
    const left = positionAt(forest, now() - 30_000);
    // The boss steps out of view and back in: no change.
    at(world("forest"), CONFIG.bossHoldMs - 1000);
    at(world("forest", { boss: "boss" }), 500);
    expect(d.playing()?.pool).toBe("boss");
    at(world("forest"), CONFIG.bossHoldMs - 250);
    expect(d.playing()?.pool).toBe("boss");
    at(world("forest"), 500);
    const back = d.voices().at(-1) as Voice;
    expect(back).toMatchObject({ pool: "forest", sound: forest.sound });
    expect(back.env.ms).toBe(CONFIG.fades.bossOut);
    expect(CONFIG.tracks["f1"]?.entries).toContain(back.from);
    expect(back.from).not.toBeCloseTo(left, 1);
  });

  it("a quest area beats the zone and a boss beats the quest area", () => {
    const { d, at } = run();
    at(world("town"), 1000);
    at(world("town", { quest: "quest" }), CONFIG.dwellMs + 250);
    expect(d.playing()).toEqual({ pool: "quest", role: "quest" });
    expect(d.voices().at(-1)?.env.ms).toBe(CONFIG.fades.zone);
    at(world("town", { quest: "quest", boss: "boss" }), 0);
    expect(d.playing()).toEqual({ pool: "boss", role: "boss" });
  });

  it("crossfades between the title screen and the world over the title's fade", () => {
    const { d, at } = run();
    at({ kind: "title" }, 10_000);
    expect(d.playing()).toEqual({ pool: "title", role: "title" });
    expect(d.voices()[0]?.env.ms).toBe(CONFIG.fades.title);
    at(world("town"), 0); // into the world: no dwell
    expect(d.playing()?.pool).toBe("town");
    expect(d.voices().map((v) => v.env.ms)).toEqual([CONFIG.fades.title, CONFIG.fades.title]);
    at(world("town"), 20_000);
    at({ kind: "title" }, 0);
    expect(d.playing()?.pool).toBe("title");
    expect(d.voices().at(-1)?.env.ms).toBe(CONFIG.fades.title);
    // The menus within resumeMs: the title goes on where it was.
    expect(d.voices().at(-1)?.from).toBeGreaterThan(10);
    at({ kind: "silent" }, 0);
    expect(d.playing()).toBeUndefined();
    expect(d.voices().every((v) => v.env.to === 0)).toBe(true);
  });

  it("keeps the old music until the new file is ready, and asks for it", () => {
    const { d, at, setReady } = run();
    at(world("town"), 5000);
    const town = d.voices()[0] as Voice;
    setReady((s) => s.startsWith("t"));
    at(world("cave"), CONFIG.dwellMs + 2000);
    expect(d.voices()).toEqual([town]);
    expect(town.env.to).toBe(1);
    const wanted = d.wanted();
    expect(wanted[0]).toMatch(/^c/);
    setReady(always);
    at(world("cave"), 0);
    expect(d.voices().at(-1)?.sound).toBe(wanted[0]);
    // The next track of the pool is asked for early, to be ready when this one ends.
    expect(d.wanted()).toHaveLength(1);
    expect(d.wanted()[0]).not.toBe(wanted[0]);
  });

  it("never keeps more than a few voices: a burst of changes cuts the oldest fades short", () => {
    const { d, at } = run();
    at({ kind: "title" }, 1000);
    at(world("town"), 250);
    at(world("town", { boss: "boss" }), 250);
    at({ kind: "title" }, 0);
    // The oldest fade is cut to CUT_MS for the new voice; for that moment one more plays.
    expect(d.voices()).toHaveLength(MAX_VOICES + 1);
    expect(d.voices()[0]?.env.ms).toBe(CUT_MS);
    at({ kind: "title" }, CUT_MS);
    expect(d.voices().length).toBeLessThanOrEqual(MAX_VOICES);
  });

  it("an element that ends early is a track that ended", () => {
    const { d, at } = run();
    at(world("town"), 1000);
    const v = d.voices()[0] as Voice;
    d.ended(v.id, 1250);
    expect(d.voices()).toEqual([]);
    expect(d.playing()?.pool).toBe("town"); // resting, then the next one
    at(world("town"), CONFIG.gapMs[1] + 1000);
    expect(d.voices()).toHaveLength(1);
  });
});
