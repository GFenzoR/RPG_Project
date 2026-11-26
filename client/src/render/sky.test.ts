import { describe, expect, it } from "vitest";
import { WorldClockState } from "../state/world-clock.ts";
import { DEFAULT_DAY_NIGHT, SkyView, dimmed, litSurface } from "./sky.ts";

const MIN = 60_000;
const d = DEFAULT_DAY_NIGHT;

/** A clock the server set to minute `m` of day 4 (full moon) at local time `at`. */
const clockAt = (m: number, at = 0, rate = 1): WorldClockState => {
  const c = new WorldClockState();
  c.set({ day: 4, cycleMs: m * MIN, rate } as never, at);
  return c;
};

describe("SkyView", () => {
  it("is noon before the server's first WorldClock, and nothing without data", () => {
    const v = new SkyView(d, new WorldClockState());
    expect(v.night()).toBe(false);
    const s = v.update(1000);
    expect(s?.phase).toBe("day");
    expect(s?.ambient).toBe(0xffffff);
    expect(litSurface(s)).toBe(false);
    expect(new SkyView(undefined, new WorldClockState()).update(0)).toBeUndefined();
  });

  it("runs the server's clock on smoothly between syncs", () => {
    const v = new SkyView(d, clockAt(170, 1000)); // dusk
    const a = v.update(1000);
    const first = a?.ambient;
    const b = v.update(1000 + 5 * MIN); // 175: deeper into dusk
    expect(b?.phase).toBe("dusk");
    expect(b?.ambient).not.toBe(first);
    expect(v.update(1000 + 20 * MIN)?.phase).toBe("night");
    expect(v.night()).toBe(true);
    // A clock staff stopped stays put.
    const frozen = new SkyView(d, clockAt(90, 0, 0));
    expect(frozen.update(99 * MIN)?.phase).toBe("day");
  });

  it("night activates the surface light map, with lamps lit", () => {
    const v = new SkyView(d, clockAt(210));
    const s = v.update(0);
    expect(litSurface(s)).toBe(true);
    expect(s?.lamps).toBe(1);
    // Day: no light map at all (no extra pass).
    expect(litSurface(new SkyView(d, clockAt(90)).update(0))).toBe(false);
    // Dusk already lights the lamps a little.
    expect(new SkyView(d, clockAt(170)).update(0)?.lamps).toBeGreaterThan(0);
  });

  it("gives the cast shadows' transform per time of day", () => {
    const tip = (m: number): number => {
      const v = new SkyView(d, clockAt(m));
      const p = v.shadowPose(v.update(0));
      if (!p) throw new Error(`no shadow at minute ${m}`);
      return -Math.sin(p.skewX) * p.scaleY; // where the tip goes, east +
    };
    expect(tip(30)).toBeLessThan(-0.5); // morning: long to the west
    expect(Math.abs(tip(90))).toBeLessThan(0.01); // noon: under the feet
    expect(tip(150)).toBeGreaterThan(0.5); // afternoon: long to the east
    const noon = new SkyView(d, clockAt(90));
    const pose = noon.shadowPose(noon.update(0));
    expect(pose?.scaleY).toBeLessThan(0.3);
    expect(pose?.alpha).toBeCloseTo(d.sunShadow);
    // Under a full moon a faint one; at sunrise none.
    const moon = new SkyView(d, clockAt(210));
    expect(moon.shadowPose(moon.update(0))?.alpha).toBeLessThan(d.sunShadow);
    const dawn = new SkyView(d, clockAt(0));
    expect(dawn.shadowPose(dawn.update(0))).toBeUndefined();
  });

  it("is not night underground, whatever the last surface frame was", () => {
    const v = new SkyView(d, clockAt(200));
    v.update(0);
    expect(v.night()).toBe(true);
    expect(v.none()).toBeUndefined();
    expect(v.night()).toBe(false);
    expect(v.current).toBeUndefined();
    v.update(16);
    expect(v.night()).toBe(true);
  });

  it("gives the pose as a transform and as the vector the walls' boxes are swept by", () => {
    for (const m of [20, 90, 160, 200]) {
      const v = new SkyView(d, clockAt(m)); // morning, noon, afternoon, full-moon night
      const s = v.update(0);
      const pose = v.shadowPose(s);
      expect(pose).toBeDefined();
      if (!pose || !s) continue;
      expect(pose.alpha).toBe(s.shadow.alpha);
      expect(pose.x).toBe(s.shadow.x);
      expect(pose.y).toBe(s.shadow.y);
      // The tip of an upright sprite one px high lands on that vector.
      expect(-Math.sin(pose.skewX) * pose.scaleY).toBeCloseTo(pose.x);
      expect(Math.cos(pose.skewX) * pose.scaleY).toBeCloseTo(pose.y);
    }
    // West in the morning, east in the afternoon.
    const at = (m: number): number => {
      const v = new SkyView(d, clockAt(m));
      return v.shadowPose(v.update(0))?.x ?? 0;
    };
    expect(at(20)).toBeLessThan(-0.5);
    expect(at(160)).toBeGreaterThan(0.5);
  });

  it("shows no baked shadow art with a day and night: every object casts its own", () => {
    expect(new SkyView(d, clockAt(90)).staticShadows()).toBe(0);
    expect(new SkyView(undefined, new WorldClockState()).staticShadows()).toBe(1);
  });

  it("reuses its sky and its shadow pose (a frame allocates nothing)", () => {
    const v = new SkyView(d, clockAt(60));
    const a = v.update(0);
    const p = v.shadowPose(a);
    expect(v.update(10)).toBe(a);
    expect(v.shadowPose(a)).toBe(p);
  });
});

describe("dimmed", () => {
  it("scales a lamp's colour toward black", () => {
    expect(dimmed(0xffb060, 1)).toBe(0xffb060);
    expect(dimmed(0xffb060, 0)).toBe(0);
    expect(dimmed(0x804020, 0.5)).toBe(0x402010);
  });
});
