// The living world's positional ambience (livingworld/README.md "Ambiente"): own recipes
// for the loops of data/livingworld/ambience.yaml, written to
// assets/livingworld/sounds/ambience/<name>.ogg. Noise shaped by filters and slow envelopes
// (waves, wind, leaves, water, fire), plus a few events (drips, crackles, chirps) mixed
// with wrap-around.
//
// Seamless by construction: every continuous layer is rendered XF_S longer than the loop
// and its tail is folded over its head with an equal-power crossfade (the tail is what
// would have followed the loop's last sample, so the wrap is as smooth as any other
// moment), every envelope is periodic in the loop's length, and events wrap round the end.
// Each loop is then normalised to the same loudness (RMS), so the volumes in
// ambience.yaml are the only mix decisions.
import { highpass, lowpass, mix, RATE, rng as seededRand, samples, tone } from "./synth.ts";

/** Length of every ambience loop, s. */
export const LOOP_S = 16;
/** The crossfade that closes a loop, s. */
export const XF_S = 0.75;
/** Target RMS of a loop and its peak ceiling (the mix happens in ambience.yaml). */
export const TARGET_RMS = 0.16;
export const PEAK = 0.85;

type Rand = () => number;

/** White noise of n samples. */
function noise(n: number, rand: Rand): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Band-limited noise: highpass then lowpass (two poles each side). */
function band(n: number, lo: number, hi: number, rand: Rand): Float32Array {
  const b = noise(n, rand);
  if (lo > 0) highpass(highpass(b, lo), lo);
  return lowpass(lowpass(b, hi), hi);
}

/**
 * A smooth random envelope (0..1) that changes about `rate` times a second: lowpassed
 * noise, squared to make swells, scaled by its own peak.
 */
function flutter(n: number, rate: number, rand: Rand): Float32Array {
  const f = lowpass(lowpass(noise(n, rand), rate), rate);
  let max = 0;
  for (const v of f) max = Math.max(max, Math.abs(v));
  for (let i = 0; i < n; i++) f[i] = Math.abs(f[i] ?? 0) / (max || 1);
  return f;
}

/**
 * Renders a continuous layer seamlessly: `render(n)` makes n + XF samples, and the last XF
 * fold over the first with an equal-power crossfade. `render` must not depend on the loop
 * length's phase except through periodic envelopes.
 */
export function seamless(seconds: number, render: (n: number) => Float32Array): Float32Array {
  const n = samples(seconds);
  const xf = samples(XF_S);
  const long = render(n + xf);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = long[i] ?? 0;
  for (let i = 0; i < xf; i++) {
    const p = i / xf;
    out[i] =
      (long[i] ?? 0) * Math.sin((p * Math.PI) / 2) +
      (long[n + i] ?? 0) * Math.cos((p * Math.PI) / 2);
  }
  return out;
}

/** Scales to TARGET_RMS, then down if the peak would pass PEAK. */
export function level(buf: Float32Array, rms = TARGET_RMS): Float32Array {
  let sum = 0;
  let peak = 0;
  for (const v of buf) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const now = Math.sqrt(sum / Math.max(1, buf.length));
  if (now === 0) return buf;
  const k = Math.min(rms / now, PEAK / peak);
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] ?? 0) * k;
  return buf;
}

/** A periodic envelope over the loop: Σ a·sin(2π·k·t/L + φ), k whole (it closes). */
function periodic(i: number, n: number, parts: readonly [number, number, number][]): number {
  let v = 0;
  for (const [k, a, ph] of parts) v += a * Math.sin((2 * Math.PI * k * i) / n + ph);
  return v;
}

/** A short noise burst (a crackle, a pop, a splash droplet). */
function burst(dur: number, hp: number, lp: number, gain: number, rand: Rand): Float32Array {
  return tone(
    {
      wave: "noise",
      freq: 1,
      dur,
      attack: 0.0005,
      decay: dur / 3,
      highpass: hp,
      lowpass: lp,
      gain,
    },
    rand,
  );
}

interface Recipe {
  seed: number;
  render(rand: Rand): Float32Array;
}

const L = LOOP_S;

export const AMBIENCE: Record<string, Recipe> = {
  // Sea waves on a shore: a low swell that rises into each breaker, the wash of foam that
  // spreads and draws back, over a soft distant surf. Four waves of unequal length.
  "livingworld/ambience/waves": {
    seed: 1101,
    render(rand) {
      const breaks = [0, 3.7, 8.1, 11.9]; // s; the loop is 16 s, so they wrap
      const out = seamless(L, (n) => {
        const surf = band(n, 60, 380, rand);
        const rush = band(n, 200, 1200, rand);
        const foam = band(n, 1200, 5000, rand);
        const o = new Float32Array(n);
        const nl = samples(L);
        for (let i = 0; i < n; i++) {
          const t = (i % nl) / RATE;
          let swell = 0;
          let wash = 0;
          for (const b of breaks) {
            // Signed time from this breaker, wrapped into [-L/2, L/2): it rises before,
            // breaks at 0 and ebbs after, with no step anywhere.
            const d = ((((t - b + L / 2) % L) + L) % L) - L / 2;
            if (d < 0 && d > -1.6) swell += (1 + d / 1.6) ** 2;
            if (d >= 0) {
              swell += Math.exp(-d / 0.5);
              // The foam spreads over a third of a second and draws back slowly.
              wash += Math.exp(-d / 1.1) * Math.sin(Math.min(1, d / 0.35) * (Math.PI / 2)) ** 2;
            }
          }
          o[i] =
            0.9 * (surf[i] ?? 0) * (0.55 + 0.25 * swell) +
            0.6 * (rush[i] ?? 0) * (0.15 + 0.85 * Math.min(1, swell + 0.6 * wash)) +
            0.3 * (foam[i] ?? 0) * Math.min(1, wash);
        }
        return o;
      });
      return out;
    },
  },
  // Desert wind: a hollow low roar and a higher whistle of moving air, rising in long
  // gusts, with fine sand hissing at the top of each gust.
  "livingworld/ambience/desert_wind": {
    seed: 1201,
    render(rand) {
      return seamless(L, (n) => {
        const roar = band(n, 40, 260, rand);
        const air = band(n, 250, 1000, rand);
        const sand = band(n, 3000, 7000, rand);
        const o = new Float32Array(n);
        const nl = samples(L);
        for (let i = 0; i < n; i++) {
          const j = i % nl;
          const gust =
            0.55 +
            0.3 *
              periodic(j, nl, [
                [1, 1, 0.3],
                [2, 0.45, 1.9],
                [3, 0.25, 4.1],
              ]);
          const g = Math.max(0.15, Math.min(1, gust));
          o[i] =
            1.1 * (roar[i] ?? 0) * (0.5 + 0.5 * g) +
            0.7 * (air[i] ?? 0) * g * g +
            0.12 * (sand[i] ?? 0) * Math.max(0, g - 0.55) * 2;
        }
        return o;
      });
    },
  },
  // Wind in forest trees: leaves rustling in quick flutters that swell with each gust,
  // a soft low wind through the trunks, and now and then a small bird far off.
  "livingworld/ambience/forest": {
    seed: 1301,
    render(rand) {
      const out = seamless(L, (n) => {
        const leaves = band(n, 1800, 7500, rand);
        const low = band(n, 50, 400, rand);
        const flick = flutter(n, 9, rand);
        const o = new Float32Array(n);
        const nl = samples(L);
        for (let i = 0; i < n; i++) {
          const j = i % nl;
          const gust = Math.max(
            0.1,
            0.5 +
              0.35 *
                periodic(j, nl, [
                  [1, 1, 2.2],
                  [2, 0.6, 0.4],
                  [5, 0.2, 3],
                ]),
          );
          o[i] =
            0.75 * (leaves[i] ?? 0) * gust * (0.35 + 0.65 * (flick[i] ?? 0)) +
            0.8 * (low[i] ?? 0) * (0.4 + 0.4 * gust);
        }
        return o;
      });
      for (const at of [2.6, 9.4, 13.1]) {
        const base = 3000 + rand() * 1200;
        for (let c = 0; c < 2 + Math.floor(rand() * 2); c++)
          mix(
            out,
            tone(
              {
                wave: "sine",
                freq: base,
                freqEnd: base * 1.25,
                dur: 0.06,
                attack: 0.008,
                decay: 0.025,
                gain: 0.04,
              },
              rand,
            ),
            at + c * 0.13,
            true,
          );
      }
      return out;
    },
  },
  // A cave: a dark, almost still room tone and water drops falling into pools, each with
  // two faint echoes off the rock.
  "livingworld/ambience/cave": {
    seed: 1401,
    render(rand) {
      const out = seamless(L, (n) => {
        const room = band(n, 30, 160, rand);
        const hiss = band(n, 500, 2500, rand);
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = 0.9 * (room[i] ?? 0) + 0.05 * (hiss[i] ?? 0);
        return o;
      });
      const drops = [0.8, 2.9, 4.1, 6.7, 8.8, 10.2, 12.6, 14.9];
      for (const at of drops) {
        const f = 900 + rand() * 900;
        const gain = 0.35 + rand() * 0.3;
        const drop = (g: number): Float32Array =>
          tone(
            {
              wave: "sine",
              freq: f,
              freqEnd: f * 1.6,
              dur: 0.07,
              attack: 0.002,
              decay: 0.018,
              gain: g,
            },
            rand,
          );
        mix(out, drop(gain), at, true);
        mix(out, lowpass(drop(gain * 0.3), 2500), at + 0.13, true);
        mix(out, lowpass(drop(gain * 0.12), 1800), at + 0.29, true);
      }
      return out;
    },
  },
  // A light town murmur: several voices far off, each a band of breath shaped into
  // syllables and phrases, too soft and blurred for words; now and then a laugh-like
  // brighter phrase.
  "livingworld/ambience/town": {
    seed: 1501,
    render(rand) {
      return seamless(L, (n) => {
        const o = new Float32Array(n);
        const nl = samples(L);
        for (let v = 0; v < 7; v++) {
          const centre = 350 + rand() * 900;
          const voice = band(n, centre * 0.6, centre * 1.8, rand);
          const syll = flutter(n, 5 + rand() * 3, rand);
          // Phrases: a voice talks for a while, then is quiet (periodic, so it closes).
          const k = 1 + Math.floor(rand() * 3);
          const ph = rand() * 6.28;
          for (let i = 0; i < n; i++) {
            const phrase = Math.max(0, Math.sin((2 * Math.PI * k * (i % nl)) / nl + ph));
            o[i] = (o[i] ?? 0) + (voice[i] ?? 0) * (syll[i] ?? 0) * phrase;
          }
        }
        const far = band(n, 60, 300, rand);
        lowpass(lowpass(o, 1800), 2400); // far off: the words blur
        for (let i = 0; i < n; i++) o[i] = (o[i] ?? 0) + 0.25 * (far[i] ?? 0);
        return o;
      });
    },
  },
  // A small stone fountain: water falling into a basin, a steady bright splash with a
  // bubbling flutter, droplets plinking on the surface.
  "livingworld/ambience/fountain": {
    seed: 1601,
    render(rand) {
      const out = seamless(L, (n) => {
        const splash = band(n, 500, 4000, rand);
        const body = band(n, 120, 700, rand);
        const bub = flutter(n, 30, rand);
        const slow = flutter(n, 3, rand);
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const b = bub[i] ?? 0;
          o[i] =
            0.8 * (splash[i] ?? 0) * (0.2 + 0.8 * b * b) * (0.7 + 0.3 * (slow[i] ?? 0)) +
            0.45 * (body[i] ?? 0);
        }
        return o;
      });
      for (let d = 0; d < 160; d++) {
        const f = 900 + rand() * 2200;
        mix(
          out,
          tone(
            {
              wave: "sine",
              freq: f,
              freqEnd: f * 1.4,
              dur: 0.03,
              attack: 0.001,
              decay: 0.008,
              gain: 0.05 + rand() * 0.06,
            },
            rand,
          ),
          rand() * L,
          true,
        );
      }
      return out;
    },
  },
  // A crackling campfire: the soft low breath of the flames and sharp crackles in small
  // clusters, with a deeper pop now and then.
  "livingworld/ambience/campfire": {
    seed: 1701,
    render(rand) {
      const out = seamless(L, (n) => {
        const flame = band(n, 60, 500, rand);
        const lick = flutter(n, 4, rand);
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = 0.8 * (flame[i] ?? 0) * (0.5 + 0.5 * (lick[i] ?? 0));
        return o;
      });
      for (let c = 0; c < 70; c++) {
        const at = rand() * L;
        const ticks = 1 + Math.floor(rand() * 4);
        for (let k = 0; k < ticks; k++)
          mix(
            out,
            burst(0.004 + rand() * 0.006, 1800, 9000, 0.25 + rand() * 0.45, rand),
            at + k * (0.015 + rand() * 0.05),
            true,
          );
      }
      for (let p = 0; p < 9; p++)
        mix(
          out,
          burst(0.025 + rand() * 0.02, 250, 1600, 0.5 + rand() * 0.3, rand),
          rand() * L,
          true,
        );
      return out;
    },
  },
  // A torch: a lighter, quicker flame fluttering in a draught, with few crackles.
  "livingworld/ambience/torch": {
    seed: 1801,
    render(rand) {
      const out = seamless(L, (n) => {
        const flame = band(n, 120, 900, rand);
        const lick = flutter(n, 7, rand);
        const o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = (flame[i] ?? 0) * (0.35 + 0.65 * (lick[i] ?? 0));
        return o;
      });
      for (let c = 0; c < 22; c++)
        mix(
          out,
          burst(0.003 + rand() * 0.004, 2500, 9000, 0.12 + rand() * 0.2, rand),
          rand() * L,
          true,
        );
      return out;
    },
  },
  // A forge: the deep steady roar of a coal bed, breathed up by the bellows every four
  // seconds, with sparks crackling at each breath.
  "livingworld/ambience/forge": {
    seed: 1901,
    render(rand) {
      const out = seamless(L, (n) => {
        const roar = band(n, 40, 220, rand);
        const draft = band(n, 300, 1500, rand);
        const o = new Float32Array(n);
        const nl = samples(L);
        for (let i = 0; i < n; i++) {
          const j = i % nl;
          // Four breaths per loop: a quick rise, a slow release.
          const ph = ((j / nl) * 4) % 1;
          // sin² up, exp down, then a short ease into the next breath: no edge anywhere.
          const breath =
            ph < 0.35
              ? Math.sin((ph / 0.35) * (Math.PI / 2)) ** 2
              : Math.exp(-(ph - 0.35) / 0.2) * Math.min(1, (1 - ph) / 0.1);
          o[i] = 1.2 * (roar[i] ?? 0) * (0.6 + 0.4 * breath) + 0.5 * (draft[i] ?? 0) * breath;
        }
        return o;
      });
      for (let b = 0; b < 4; b++)
        for (let s = 0; s < 6; s++)
          mix(
            out,
            burst(0.004, 2500, 9000, 0.15 + rand() * 0.2, rand),
            b * 4 + 0.4 + rand() * 1.2,
            true,
          );
      return out;
    },
  },
};

export const AMBIENCE_PATHS = Object.keys(AMBIENCE);

/** Renders an ambience loop, seamless and normalised. */
export function renderAmbience(path: string): Float32Array {
  const r = AMBIENCE[path];
  if (!r) throw new Error(`unknown ambience ${path}`);
  return level(r.render(seededRand(r.seed)));
}
