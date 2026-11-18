import { describe, expect, it } from "vitest";
import type { SoundManifest } from "../content-types.ts";
import {
  ATTACH_MS,
  AudioEngine,
  HEAR_RANGE,
  KEEP_STREAMS,
  MAX_PAN,
  MAX_VOICES,
  directorConfig,
  spatial,
} from "./engine.ts";
import type {
  AudioPorts,
  BufferLike,
  ContextLike,
  GainLike,
  NodeLike,
  PannerLike,
  ParamLike,
  SourceLike,
  StreamLike,
} from "./engine.ts";
import { defaultPrefs, withMuted, withVolume } from "./prefs.ts";

// ---- a fake Web Audio context that records what the engine schedules --------------------

class FakeParam implements ParamLike {
  value = 1;
  readonly events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number): void {
    this.value = v;
    this.events.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.value = v;
    this.events.push(["ramp", v, t]);
  }
  cancelScheduledValues(t: number): void {
    this.events.push(["cancel", 0, t]);
  }
}

class FakeNode implements NodeLike {
  readonly outputs: NodeLike[] = [];
  connect(n: NodeLike): void {
    this.outputs.push(n);
  }
  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeGain extends FakeNode implements GainLike {
  readonly gain = new FakeParam();
}

class FakePanner extends FakeNode implements PannerLike {
  readonly pan = new FakeParam();
}

class FakeSource extends FakeNode implements SourceLike {
  buffer: BufferLike | null = null;
  loop = false;
  started: number | undefined;
  stopped: number | undefined;
  private ended: (() => void)[] = [];
  start(when = 0): void {
    this.started = when;
  }
  stop(when = 0): void {
    this.stopped = when;
  }
  addEventListener(_type: "ended", fn: () => void): void {
    this.ended.push(fn);
  }
  end(): void {
    for (const f of this.ended) f();
  }
}

class FakeContext implements ContextLike {
  state = "suspended";
  currentTime = 0;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly panners: FakePanner[] = [];
  decoded = 0;
  async resume(): Promise<void> {
    await Promise.resolve(); // a real context reports "running" only later, too
    this.state = "running";
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createStereoPanner(): FakePanner {
    const p = new FakePanner();
    this.panners.push(p);
    return p;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(data: ArrayBuffer): Promise<BufferLike> {
    this.decoded++;
    return { duration: data.byteLength }; // 1 byte = 1 s, so tests pick the duration
  }
}

/** A media element: remembers what it was asked to play. */
class FakeStream implements StreamLike {
  readonly output = new FakeNode();
  url: string | undefined;
  at = 0;
  loop = false;
  plays = 0;
  stops = 0;
  private ended: () => void = () => undefined;
  play(url: string, at: number, loop: boolean): void {
    this.url = url;
    this.at = at;
    this.loop = loop;
    this.plays++;
  }
  stop(): void {
    this.url = undefined;
    this.stops++;
  }
  onEnded(fn: () => void): void {
    this.ended = fn;
  }
  end(): void {
    this.ended();
  }
}

const sound = (url: string, channel: "sfx" | "ui" | "music" | "ambient", maxVoices = 3) => ({
  url,
  channel,
  volume: 0.5,
  maxVoices,
});

const track = (url: string, seconds: number, entries: number[]) => ({
  ...sound(url, "music"),
  seconds,
  end: seconds - 5,
  entries,
});

const MANIFEST: SoundManifest = {
  sounds: {
    hit: sound("audio/hit.ogg", "sfx"),
    click: sound("audio/click.ogg", "ui", 1),
    a: sound("audio/a.ogg", "sfx", 8),
    b: sound("audio/b.ogg", "sfx", 8),
    tune: sound("audio/tune.ogg", "music"),
    menu: track("audio/menu.ogg", 100, [10, 30]),
    town1: track("audio/town1.ogg", 120, [12, 40]),
    town2: track("audio/town2.ogg", 110, [15, 50]),
    cave1: track("audio/cave1.ogg", 90, [20, 45]),
    cave2: track("audio/cave2.ogg", 95, [25]),
    cave3: track("audio/cave3.ogg", 95, [25]),
    waves: sound("audio/waves.ogg", "ambient"),
    wind: sound("audio/wind.ogg", "ambient"),
    rain: sound("audio/rain.ogg", "ambient"),
  },
  events: {
    "effect.hit": ["hit"],
    "ui.click": ["click"],
    "effect.gather": ["a"],
    many: ["a", "b"],
    loopy: ["tune"],
  },
  music: {
    pools: {
      title: ["menu"],
      town: ["town1", "town2"],
      cave: ["cave1", "cave2", "cave3"],
      odd: ["tune", "hit"], // a sound of another channel in a pool is left out
    },
    islands: {},
    underground: "cave",
    title: "title",
    bosses: {},
    fades: { zone: 2000, bossIn: 1000, bossOut: 3000, title: 1000, next: 1000 },
    dwellMs: 1000,
    bossHoldMs: 2000,
    resumeMs: 60_000,
    gapMs: [1000, 2000],
  },
  ambient: { fadeMs: 1000, islands: {}, underground: undefined },
};

function setup(prefs = defaultPrefs()) {
  const ctx = new FakeContext();
  const fetched: string[] = [];
  const streamed: string[] = [];
  const released: string[] = [];
  const streams: FakeStream[] = [];
  const pumps: (() => void)[] = [];
  /** Files that only arrive when the test says so. */
  const held = new Map<string, () => void>();
  let hold = false;
  let now = 0;
  let rand = 0;
  const ports: AudioPorts = {
    createContext: () => ctx,
    fetch: async (url) => {
      fetched.push(url);
      return new ArrayBuffer(url.includes("waves") || url.includes("wind") ? 60 : 1);
    },
    now: () => now,
    random: () => rand,
    createStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    loadStream: (url) => {
      streamed.push(url);
      if (!hold) return Promise.resolve(`blob:${url}`);
      return new Promise((resolve) => held.set(url, () => resolve(`blob:${url}`)));
    },
    releaseStream: (url) => released.push(url),
    every: (_ms, fn) => {
      pumps.push(fn);
      return () => undefined;
    },
  };
  const engine = new AudioEngine(MANIFEST, prefs, ports);
  return {
    ctx,
    engine,
    fetched,
    streamed,
    released,
    streams,
    held,
    holdFiles: (on: boolean) => (hold = on),
    setNow: (ms: number) => (now = ms),
    setRandom: (r: number) => (rand = r),
    /** The audio clock moves to `s` seconds and the engine's timer fires. */
    at: async (s: number) => {
      ctx.currentTime = s;
      for (const p of pumps) p();
      await flush();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A gesture: the fake context, like a real one, starts running a microtask later. */
const unlockNow = async (e: AudioEngine): Promise<void> => {
  e.unlock();
  await flush();
};

describe("AudioEngine", () => {
  it("stays silent until the first gesture unlocks it, then resumes the context", async () => {
    const { ctx, engine } = setup();
    expect(engine.play(["effect.hit"])).toBeUndefined();
    expect(ctx.gains).toHaveLength(0);
    engine.unlock();
    expect(engine.unlocked).toBe(true);
    await flush();
    expect(ctx.state).toBe("running");
  });

  it("builds master and channel gains from the preferences", () => {
    const { ctx, engine } = setup(withVolume(withMuted(defaultPrefs(), "ui", true), "music", 0.3));
    engine.unlock();
    const [master, sfx, ui, music] = ctx.gains;
    expect(master?.outputs).toEqual([ctx.destination]);
    expect(sfx?.outputs).toEqual([master]);
    expect(master?.gain.value).toBe(0.8);
    expect(ui?.gain.value).toBe(0); // muted
    expect(music?.gain.value).toBe(0.3);
    engine.setPrefs(withVolume(defaultPrefs(), "master", 0.25));
    expect(master?.gain.value).toBe(0.25);
    expect(ui?.gain.value).toBe(0.7);
  });

  it("hands back the volumes in use, for a panel that mounts later", () => {
    const { engine } = setup();
    const muted = withMuted(defaultPrefs(), "music", true);
    engine.setPrefs(muted);
    expect(engine.currentPrefs()).toBe(muted);
  });

  it("effective level multiplies by master and is 0 when either is muted", () => {
    const { engine } = setup(withVolume(defaultPrefs(), "master", 0.5));
    expect(engine.level("sfx")).toBeCloseTo(0.45);
    engine.setPrefs(withMuted(defaultPrefs(), "master", true));
    expect(engine.level("sfx")).toBe(0);
    expect(engine.level("master")).toBe(0);
  });

  it("loads a sound once, caches the decoded buffer and plays it on its channel", async () => {
    const { ctx, engine, fetched } = setup();
    await unlockNow(engine);
    expect(engine.play(["effect.hit"])).toBe("hit");
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]?.started).toBe(0);
    ctx.currentTime = 5; // the first one ended
    engine.play(["effect.hit"]);
    expect(ctx.sources).toHaveLength(2); // started synchronously: already decoded
    expect(fetched).toEqual(["audio/hit.ogg"]);
    expect(ctx.decoded).toBe(1);
    // source → its gain (sound volume) → the sfx channel gain.
    const voiceGain = ctx.sources[1]?.outputs[0] as FakeGain;
    expect(voiceGain.gain.value).toBe(0.5);
    expect(voiceGain.outputs[0]).toBe(ctx.gains[1]);
    expect(engine.history).toEqual(["hit", "hit"]);
  });

  it("plays the most specific event that is mapped and ignores unknown ones", async () => {
    const { engine } = setup();
    await unlockNow(engine);
    expect(engine.play(["effect.gather.mining", "effect.gather"])).toBe("a");
    expect(engine.play(["nothing.here"])).toBeUndefined();
    expect(engine.play(["loopy"])).toBeUndefined(); // music is not an event sound
  });

  it("picks a random variant", async () => {
    const { engine, setRandom } = setup();
    await unlockNow(engine);
    setRandom(0.1);
    expect(engine.play(["many"])).toBe("a");
    setRandom(0.99);
    expect(engine.play(["many"])).toBe("b");
  });

  it("does not spend a voice on a muted channel", async () => {
    const { ctx, engine } = setup(withMuted(defaultPrefs(), "sfx", true));
    await unlockNow(engine);
    expect(engine.play(["effect.hit"])).toBeUndefined();
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });

  it("caps copies of one sound and voices in total; ended voices free their slot", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    engine.play(["ui.click"]);
    await flush();
    expect(engine.play(["ui.click"])).toBeUndefined(); // max_voices 1
    ctx.sources[0]?.end();
    expect(engine.play(["ui.click"])).toBe("click");

    const { ctx: c2, engine: e2, setRandom } = setup();
    setRandom(0.99); // "many" picks b, "effect.gather" is always a
    await unlockNow(e2);
    e2.play(["effect.gather"]);
    e2.play(["many"]);
    await flush();
    let started = c2.sources.length;
    for (let i = 0; i < 40; i++) if (e2.play([i % 2 ? "effect.gather" : "many"])) started++;
    // a and b allow 8 each, so the per-sound caps (16) meet the global one.
    expect(e2.activeVoices).toBe(MAX_VOICES);
    expect(started).toBe(MAX_VOICES);
  });

  it("keeps max_voices for plays asked while the file was still loading", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    // An area spell: one effect per tile in the same tick, before the file has arrived.
    for (let i = 0; i < 21; i++) engine.play(["ui.click"]);
    await flush();
    expect(ctx.sources).toHaveLength(1); // click: max_voices 1
    for (let i = 0; i < 21; i++) engine.play(["effect.hit"]);
    await flush();
    expect(ctx.sources).toHaveLength(1 + 3); // hit: max_voices 3
  });

  it("drops one-shots while the context is suspended, without using up voices", async () => {
    const { ctx, engine } = setup();
    engine.unlock(); // resume() has not finished: still suspended
    expect(engine.play(["effect.hit"])).toBeUndefined();
    await flush();
    expect(ctx.sources).toHaveLength(0);
    expect(engine.activeVoices).toBe(0);
    ctx.state = "suspended"; // e.g. the browser paused audio in a background tab
    expect(engine.play(["effect.hit"])).toBeUndefined();
    ctx.state = "running";
    expect(engine.play(["effect.hit"])).toBe("hit");
  });

  it("drops a sound whose file arrives too late", async () => {
    const { ctx, engine, setNow } = setup();
    await unlockNow(engine);
    engine.play(["effect.hit"]);
    setNow(1000);
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });

  it("attenuates and pans positional sounds, and skips them out of earshot", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    const me = { x: 100, y: 100, z: 7 };
    engine.play(["effect.hit"], { x: 104, y: 100, z: 7 }, me);
    await flush();
    const g = ctx.sources[0]?.outputs[0] as FakeGain;
    expect(g.gain.value).toBeCloseTo(0.5 * (1 - 4 / (HEAR_RANGE + 1)));
    expect(ctx.panners[0]?.pan.value).toBeCloseTo((4 / 7) * MAX_PAN);
    expect(engine.play(["effect.hit"], { x: 100, y: 100 + HEAR_RANGE + 1, z: 7 }, me)).toBe(
      undefined,
    );
    expect(engine.play(["effect.hit"], { x: 100, y: 100, z: 8 }, me)).toBeUndefined();
  });
});

describe("spatial", () => {
  it("is full volume and centred on the player's tile, quieter and to the side away", async () => {
    const me = { x: 0, y: 0, z: 7 };
    expect(spatial(me, me)).toEqual({ gain: 1, pan: 0 });
    const left = spatial({ x: -20, y: 0, z: 7 }, me);
    expect(left).toBeUndefined();
    const far = spatial({ x: -7, y: 3, z: 7 }, me);
    expect(far?.pan).toBeCloseTo(-MAX_PAN);
    expect(far?.gain).toBeCloseTo(1 - 7 / (HEAR_RANGE + 1));
    const diag = spatial({ x: 3, y: 3, z: 7 }, me);
    expect(diag?.gain).toBeGreaterThan(far?.gain ?? 1);
  });
});

describe("the ambient bed", () => {
  it("remembers the wanted loop while locked and fades it in on unlock", async () => {
    const { ctx, engine } = setup();
    engine.setAmbient("waves");
    expect(ctx.sources).toHaveLength(0);
    await unlockNow(engine);
    await flush();
    expect(engine.playingLoops().ambient).toBe("waves");
    const src = ctx.sources.find((s) => s.loop && (s.buffer?.duration ?? 0) === 60);
    expect(src?.loop).toBe(true);
    const fade = (src?.outputs[0] as FakeGain).gain.events;
    expect(fade).toEqual([
      ["set", 0, 0],
      ["ramp", 0.5, 1],
    ]);
  });

  it("crossfades to a new loop and stops the old one after the fade", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    engine.setAmbient("waves");
    await flush();
    const first = ctx.sources[0];
    ctx.currentTime = 10;
    engine.setAmbient("wind");
    await flush();
    expect(first?.stopped).toBe(11);
    expect((first?.outputs[0] as FakeGain).gain.events.at(-1)).toEqual(["ramp", 0, 11]);
    expect(engine.playingLoops().ambient).toBe("wind");
    engine.setAmbient("wind"); // the same loop again: nothing restarts
    await flush();
    expect(ctx.sources).toHaveLength(2);
    engine.setAmbient(undefined);
    expect(ctx.sources[1]?.stopped).toBe(11);
    expect(engine.playingLoops().ambient).toBeUndefined();
  });

  it("keeps the last two loops decoded and forgets older ones", async () => {
    const { ctx, engine, fetched } = setup();
    await unlockNow(engine);
    engine.setAmbient("waves");
    await flush();
    engine.setAmbient("wind");
    await flush();
    engine.setAmbient("waves"); // back and forth: nothing is fetched or decoded again
    await flush();
    expect(fetched.filter((u) => u.includes("waves"))).toHaveLength(1);
    expect(ctx.decoded).toBe(2);
    engine.setAmbient("rain");
    await flush();
    expect(engine.isCached("wind")).toBe(false);
    expect(engine.isCached("waves")).toBe(true);
  });

  it("does not start a loop that stopped being wanted while it loaded", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    engine.setAmbient("waves");
    engine.setAmbient("wind");
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(engine.playingLoops().ambient).toBe("wind");
  });
});

/** The gain of a stream's element (stream → its gain → the music channel). */
const deckGain = (s: FakeStream | undefined): FakeParam =>
  (s?.output.outputs[0] as FakeGain | undefined)?.gain ?? new FakeParam();

const world = (zone: string) =>
  ({ kind: "world", zone, quest: undefined, boss: undefined }) as const;

describe("the music", () => {
  it("takes the director's pools, leaving out what is not music", () => {
    const c = directorConfig(MANIFEST);
    expect(c.pools).toEqual({
      title: ["menu"],
      town: ["town1", "town2"],
      cave: ["cave1", "cave2", "cave3"],
      odd: ["tune"],
    });
    expect(c.tracks["tune"]).toEqual({ seconds: undefined, end: 0, entries: [] });
    expect(c.tracks["town1"]).toEqual({ seconds: 120, end: 115, entries: [12, 40] });
  });

  it("remembers the scene while locked, then streams the title's track from an entry, fading in", async () => {
    const { engine, streams, streamed, at } = setup();
    engine.setMusic({ kind: "title" });
    expect(streamed).toEqual([]);
    await unlockNow(engine);
    await at(0);
    expect(streamed[0]).toBe("audio/menu.ogg");
    const s = streams[0];
    expect(s?.url).toBe("blob:audio/menu.ogg");
    expect([10, 30]).toContain(s?.at);
    expect(s?.loop).toBe(false);
    expect(engine.playingLoops().music).toBe("menu");
    const g = deckGain(s).events;
    expect(g[0]).toEqual(["cancel", 0, 0]);
    expect(g[1]).toEqual(["set", 0, 0]);
    expect(g.at(-1)).toEqual(["ramp", 0.5, 1]); // the sound's volume at the end of the fade
    expect(engine.history).toContain("menu");
  });

  it("plays a loop file looping, from its start", async () => {
    const { engine, streams, at } = setup();
    await unlockNow(engine);
    engine.setMusic(world("odd"));
    await at(0);
    expect(streams[0]).toMatchObject({ url: "blob:audio/tune.ogg", at: 0, loop: true });
  });

  it("crossfades a zone change on two elements with equal power", async () => {
    const { engine, streams, at } = setup();
    await unlockNow(engine);
    engine.setMusic(world("town"));
    await at(0);
    await at(10);
    engine.setMusic(world("cave"));
    await at(10.5);
    expect(engine.musicState().pool).toBe("town"); // the dwell
    await at(11.25);
    expect(engine.musicState().pool).toBe("cave");
    const [town, cave] = streams;
    expect(cave?.url).toMatch(/^blob:audio\/cave\d\.ogg$/);
    const out = deckGain(town).events.filter((e) => e[0] === "ramp");
    const into = deckGain(cave).events.filter((e) => e[0] === "ramp");
    expect(out.at(-1)).toEqual(["ramp", 0, 13.25]);
    expect(into.at(-1)?.[1]).toBeCloseTo(0.5, 9);
    // Point for point, (out/vol)² + (in/vol)² = 1: the same power through the crossfade.
    const byTime = new Map(into.map((e) => [e[2].toFixed(3), e[1]]));
    let checked = 0;
    for (const [, g, t] of out) {
      const g2 = byTime.get(t.toFixed(3));
      if (g2 === undefined || t <= 11.25) continue;
      expect((g / 0.5) ** 2 + (g2 / 0.5) ** 2).toBeCloseTo(1, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
    const state = engine.musicState();
    expect(state.voices.map((v) => v.pool)).toEqual(["town", "cave"]);
    expect(state.voices.every((v) => v.playing)).toBe(true);
    await at(14);
    expect(town?.stops).toBe(1); // faded out: its element is let go of
    expect(engine.musicState().voices).toHaveLength(1);
  });

  it("keeps the old music until the new file arrives", async () => {
    const { engine, streams, held, holdFiles, at } = setup();
    await unlockNow(engine);
    engine.setMusic(world("town"));
    await at(0);
    holdFiles(true);
    engine.setMusic(world("cave"));
    await at(1.5);
    await at(4);
    expect(engine.musicState().pool).toBe("town");
    expect(streams).toHaveLength(1);
    const wanted = engine.musicState().wanted[0] ?? "";
    expect(wanted).toMatch(/^cave/);
    held.get(`audio/${wanted}.ogg`)?.();
    await flush();
    await at(4.25);
    expect(engine.musicState().pool).toBe("cave");
    expect(streams[1]?.url).toBe(`blob:audio/${wanted}.ogg`);
  });

  it("fetches nothing while the music is muted, and comes in where the track is when unmuted", async () => {
    const muted = withMuted(defaultPrefs(), "music", true);
    const { engine, streams, streamed, at } = setup(muted);
    await unlockNow(engine);
    engine.setMusic({ kind: "title" });
    await at(0);
    await at(20);
    expect(streamed).toEqual([]);
    expect(streams).toHaveLength(0);
    const [voice] = engine.musicState().voices;
    expect(voice).toMatchObject({ sound: "menu", playing: false });
    engine.setPrefs(defaultPrefs()); // the file is fetched now, and starts when it arrives
    await flush();
    const s = streams[0];
    expect(s?.url).toBe("blob:audio/menu.ogg");
    expect(s?.at).toBeCloseTo(voice?.position ?? 0, 6);
    const g = deckGain(s).events;
    expect(g[1]).toEqual(["set", 0, 20]); // from silence, not a jump
    expect(g[2]?.[2]).toBeCloseTo(20 + ATTACH_MS / 1000, 9);
    // Muted again: the element goes, the track goes on without it.
    engine.setPrefs(muted);
    expect(s?.stops).toBe(1);
    expect(engine.musicState().voices[0]?.playing).toBe(false);
  });

  it("an element that ends is a track that ended: a rest, then the next one", async () => {
    const { engine, streams, at } = setup();
    await unlockNow(engine);
    engine.setMusic(world("town"));
    await at(0);
    const first = streams[0];
    const firstUrl = first?.url;
    first?.end();
    await flush();
    expect(engine.musicState().voices).toHaveLength(0);
    await at(2.5); // gap_ms is 1–2 s
    expect(engine.musicState().voices).toHaveLength(1);
    expect(streams).toHaveLength(1); // the same element, reused
    expect(first?.plays).toBe(2);
    expect(first?.url).not.toBe(firstUrl); // the other track of the pool
  });

  it("keeps a few files and lets go of older ones it does not need", async () => {
    const { engine, released, at } = setup();
    await unlockNow(engine);
    let t = 0;
    for (const zone of ["town", "cave", "odd", "title", "town", "cave", "odd", "title"]) {
      engine.setMusic(world(zone));
      for (let i = 0; i < 16; i++) await at((t += 0.25));
    }
    expect(released.length).toBeGreaterThan(0);
    const kept = Object.keys(MANIFEST.sounds).filter((id) => engine.isStreamed(id));
    expect(kept.length).toBeLessThanOrEqual(KEEP_STREAMS + 2);
  });
});
