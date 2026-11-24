import { describe, expect, it } from "vitest";
import { parseLivingWorldData } from "./data.ts";
import {
  advance,
  arcShadow,
  cycleLength,
  DEFAULT_DAY_NIGHT,
  luminance,
  MIN_NORTH,
  mixColour,
  moonLight,
  newSky,
  parseDayNight,
  phaseAt,
  shadowTransform,
  skyAt,
  withFloor,
} from "./sky.ts";

const d = DEFAULT_DAY_NIGHT;
const MIN = 60_000;
/** The sky at minute m of `day`. */
const at = (m: number, day = 4) => skyAt(d, day, m * MIN);

describe("data/livingworld/daynight.yaml", () => {
  // The repo's file as YAML parses it (client/vite/content.test.ts reads the file itself).
  const raw = {
    cycle: {
      day_minutes: 180,
      night_minutes: 60,
      dawn_minutes: 15,
      dusk_minutes: 15,
      lunar_days: 8,
      sync_seconds: 60,
    },
    sky: {
      dawn: "#ffc9a8",
      day: "#ffffff",
      dusk: "#ffa86e",
      night_new_moon: "#58648c",
      night_full_moon: "#8494c4",
      floor: 0.5,
      sun_shadow: 0.42,
      moon_shadow: 0.16,
      max_shadow: 1.4,
    },
  };

  it("is the owner's 180 + 60 minute cycle, with a floor", () => {
    const data = parseDayNight(raw);
    expect(data.dayMs).toBe(180 * MIN);
    expect(data.nightMs).toBe(60 * MIN);
    expect(cycleLength(data)).toBe(240 * MIN);
    expect(data.dawnMs).toBeGreaterThan(0);
    expect(data.duskMs).toBeGreaterThan(0);
    expect(data.floor).toBeGreaterThanOrEqual(0.4);
    // The file is what the defaults say.
    expect(data).toEqual(DEFAULT_DAY_NIGHT);
  });

  it("rides along in the living world's data, and is absent without the file", () => {
    expect(parseLivingWorldData({}, {}, raw).dayNight?.dayMs).toBe(180 * MIN);
    expect(parseLivingWorldData({}, {}).dayNight).toBeUndefined();
  });

  it("falls back to the defaults for anything malformed", () => {
    expect(parseDayNight("nope")).toEqual(DEFAULT_DAY_NIGHT);
    const bad = parseDayNight({ cycle: { day_minutes: -3 }, sky: { dawn: "red", floor: 0 } });
    expect(bad.dayMs).toBe(d.dayMs);
    expect(bad.dawn).toBe(d.dawn);
    expect(bad.floor).toBe(0.3); // clamped: never a black night
  });
});

describe("the world clock on the client", () => {
  it("runs on at the server's rate and wraps into the next day", () => {
    expect(advance(d, 2, 10 * MIN, 1, 5 * MIN)).toEqual({ day: 2, cycleMs: 15 * MIN });
    expect(advance(d, 2, 239 * MIN, 1, 2 * MIN)).toEqual({ day: 3, cycleMs: 1 * MIN });
    expect(advance(d, 2, 10 * MIN, 0, 99 * MIN)).toEqual({ day: 2, cycleMs: 10 * MIN });
    expect(advance(d, 2, 0, 60, MIN)).toEqual({ day: 2, cycleMs: 60 * MIN });
  });

  it("names the phases like the server", () => {
    expect(phaseAt(d, 0)).toBe("dawn");
    expect(phaseAt(d, 15 * MIN)).toBe("day");
    expect(phaseAt(d, 165 * MIN)).toBe("dusk");
    expect(phaseAt(d, 180 * MIN)).toBe("night");
  });

  it("has moon phases: new at 0, full at lunar_days / 2", () => {
    expect(moonLight(d, 0)).toBe(0);
    expect(moonLight(d, 4)).toBeCloseTo(1);
    expect(moonLight(d, 2)).toBeCloseTo(0.5);
    expect(moonLight(d, 8)).toBe(0);
  });
});

describe("the light (tint curve)", () => {
  it("is neutral by day, warm at dawn, orange at dusk, blue at night", () => {
    expect(at(90).ambient).toBe(0xffffff);
    expect(at(90).lamps).toBe(0);
    const dawn = at(7.5);
    expect(dawn.phase).toBe("dawn");
    expect(dawn.ambient).toBe(d.dawn); // mid-dawn: the dawn colour itself
    const dusk = at(172.5);
    expect(dusk.ambient).toBe(d.dusk);
    const night = at(210);
    expect(night.phase).toBe("night");
    expect(night.ambient & 0xff).toBeGreaterThan((night.ambient >> 16) & 0xff); // blue
    expect(night.lamps).toBe(1);
    expect(night.night).toBe(true);
    expect(at(90).night).toBe(false);
  });

  it("changes smoothly: no jump anywhere in the cycle, also when it wraps", () => {
    let prev = skyAt(d, 3, 0).ambient;
    for (let m = 0.25; m <= 240 * 2; m += 0.25) {
      const s = skyAt(d, 3 + Math.floor(m / 240), (m % 240) * MIN);
      const step = Math.abs(luminance(s.ambient) - luminance(prev));
      expect(step, `minute ${m}`).toBeLessThan(0.02);
      prev = s.ambient;
    }
  });

  it("never gets too dark to play: the floor holds at new moon", () => {
    for (let day = 0; day < d.lunarDays; day++)
      for (let m = 0; m < 240; m += 1)
        expect(luminance(skyAt(d, day, m * MIN).ambient)).toBeGreaterThanOrEqual(d.floor - 0.01);
  });

  it("a full moon night is brighter than a new moon one", () => {
    const full = at(210, 4);
    const fresh = at(210, 0);
    expect(luminance(full.ambient)).toBeGreaterThan(luminance(fresh.ambient) + 0.05);
    expect(full.moon).toBeCloseTo(1);
  });

  it("mixes and floors colours", () => {
    expect(mixColour(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(withFloor(0xffffff, 0.5)).toBe(0xffffff);
    expect(luminance(withFloor(0x101020, 0.5))).toBeGreaterThanOrEqual(0.5);
  });

  it("lamps light up through dusk and go out through dawn", () => {
    expect(at(166).lamps).toBeLessThan(at(178).lamps);
    expect(at(1).lamps).toBeGreaterThan(at(14).lamps);
  });
});

describe("the sun's shadow (sun angle mapping)", () => {
  it("morning long to the west, noon short under the feet, afternoon long to the east", () => {
    const morning = at(30).shadow;
    const noon = at(90).shadow;
    const afternoon = at(150).shadow;
    expect(morning.x).toBeLessThan(-0.5);
    expect(afternoon.x).toBeGreaterThan(0.5);
    expect(Math.abs(noon.x)).toBeLessThan(0.01);
    expect(Math.hypot(noon.x, noon.y)).toBeLessThan(0.3);
    expect(Math.hypot(morning.x, morning.y)).toBeGreaterThan(Math.hypot(noon.x, noon.y) * 2);
    // Mirror images.
    expect(morning.x).toBeCloseTo(-afternoon.x);
    // Always on the ground, north of the feet.
    for (const s of [morning, noon, afternoon]) expect(s.y).toBeGreaterThanOrEqual(MIN_NORTH);
  });

  it("is never longer than max_shadow and fades in at sunrise, out at sunset", () => {
    for (let m = 0; m < 180; m += 2) {
      const s = at(m).shadow;
      expect(Math.hypot(s.x, Math.min(s.y, d.maxShadow))).toBeLessThanOrEqual(d.maxShadow + 0.01);
    }
    expect(at(0).shadow.alpha).toBe(0);
    expect(at(90).shadow.alpha).toBeCloseTo(d.sunShadow);
    expect(at(2).shadow.alpha).toBeLessThan(at(20).shadow.alpha);
  });

  it("at night is the moon's: faint, and stronger under a full moon", () => {
    const full = at(210, 4).shadow;
    const half = at(210, 2).shadow;
    const none = at(210, 0).shadow;
    expect(full.alpha).toBeCloseTo(d.moonShadow);
    expect(full.alpha).toBeLessThan(d.sunShadow);
    expect(half.alpha).toBeGreaterThan(0);
    expect(half.alpha).toBeLessThan(full.alpha);
    expect(none.alpha).toBe(0);
    // The moon crosses the night too: rising east, its shadow points west.
    expect(at(190, 4).shadow.x).toBeLessThan(0);
    expect(at(230, 4).shadow.x).toBeGreaterThan(0);
  });

  it("maps to a skew and squash that put the tip where the shadow says", () => {
    for (const m of [20, 60, 90, 120, 160]) {
      const s = at(m).shadow;
      const { skewX, scaleY } = shadowTransform(s);
      // Pixi: a point (0, -h) of a sprite with skew.x and scale.y lands at
      // (-h * scaleY * sin(skewX), -h * scaleY * cos(skewX)).
      const h = 48;
      expect(-h * scaleY * Math.sin(skewX)).toBeCloseTo(h * s.x);
      expect(-h * scaleY * Math.cos(skewX)).toBeCloseTo(-h * s.y);
    }
  });

  it("arcShadow writes into the object it is given", () => {
    const out = { x: 9, y: 9, alpha: 9 };
    expect(arcShadow(0.5, 2, 0.3, out)).toBe(out);
    expect(out.alpha).toBeCloseTo(0.3);
  });

  it("skyAt reuses the Sky it is given", () => {
    const s = newSky();
    expect(skyAt(d, 1, 0, s)).toBe(s);
  });
});
