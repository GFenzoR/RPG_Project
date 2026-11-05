import { describe, expect, it } from "vitest";
import type { SoundManifest } from "../content-types.ts";
import { AudioEngine, HEAR_RANGE, MAX_PAN, MAX_VOICES, spatial } from "./engine.ts";
import type {
  AudioPorts,
  BufferLike,
  ContextLike,
  GainLike,
  NodeLike,
  PannerLike,
  ParamLike,
  SourceLike,
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

const sound = (url: string, channel: "sfx" | "ui" | "music" | "ambient", maxVoices = 3) => ({
  url,
  channel,
  volume: 0.5,
  maxVoices,
});

const MANIFEST: SoundManifest = {
  sounds: {
    hit: sound("audio/hit.ogg", "sfx"),
    click: sound("audio/click.ogg", "ui", 1),
    a: sound("audio/a.ogg", "sfx", 8),
    b: sound("audio/b.ogg", "sfx", 8),
    tune: sound("audio/tune.ogg", "music"),
    other: sound("audio/other.ogg", "music"),
    waves: sound("audio/waves.ogg", "ambient"),
  },
  events: {
    "effect.hit": ["hit"],
    "ui.click": ["click"],
    "effect.gather": ["a"],
    many: ["a", "b"],
    loopy: ["tune"],
  },
  music: { fadeMs: 2000, islands: {}, underground: undefined },
  ambient: { fadeMs: 1000, islands: {}, underground: undefined },
};

function setup(prefs = defaultPrefs()) {
  const ctx = new FakeContext();
  const fetched: string[] = [];
  let now = 0;
  let rand = 0;
  const ports: AudioPorts = {
    createContext: () => ctx,
    fetch: async (url) => {
      fetched.push(url);
      return new ArrayBuffer(url.includes("tune") || url.includes("other") ? 60 : 1);
    },
    now: () => now,
    random: () => rand,
  };
  const engine = new AudioEngine(MANIFEST, prefs, ports);
  return {
    ctx,
    engine,
    fetched,
    setNow: (ms: number) => (now = ms),
    setRandom: (r: number) => (rand = r),
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

describe("loops", () => {
  it("remembers the wanted loop while locked and fades it in on unlock", async () => {
    const { ctx, engine } = setup();
    engine.setLoops("tune", "waves");
    expect(ctx.sources).toHaveLength(0);
    await unlockNow(engine);
    await flush();
    expect(engine.playingLoops()).toEqual({ music: "tune", ambient: "waves" });
    const src = ctx.sources.find((s) => s.loop && (s.buffer?.duration ?? 0) === 60);
    expect(src?.loop).toBe(true);
    const fade = (src?.outputs[0] as FakeGain).gain.events;
    expect(fade).toEqual([
      ["set", 0, 0],
      ["ramp", 0.5, 2],
    ]);
  });

  it("crossfades to a new loop and stops the old one after the fade", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    engine.setLoops("tune", undefined);
    await flush();
    const first = ctx.sources[0];
    ctx.currentTime = 10;
    engine.setLoops("other", undefined);
    await flush();
    expect(first?.stopped).toBe(12);
    const oldFade = (first?.outputs[0] as FakeGain).gain.events.at(-1);
    expect(oldFade).toEqual(["ramp", 0, 12]);
    expect(engine.playingLoops().music).toBe("other");
    // Same loop again: nothing restarts.
    engine.setLoops("other", undefined);
    await flush();
    expect(ctx.sources).toHaveLength(2);
    // Leaving to silence fades it out too.
    engine.setLoops(undefined, undefined);
    expect(ctx.sources[1]?.stopped).toBe(12);
    expect(engine.playingLoops()).toEqual({ music: undefined, ambient: undefined });
  });

  it("does not start a loop that stopped being wanted while it loaded", async () => {
    const { ctx, engine } = setup();
    await unlockNow(engine);
    engine.setLoops("tune", undefined);
    engine.setLoops("other", undefined);
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(engine.playingLoops().music).toBe("other");
  });
});
