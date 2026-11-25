// Footsteps by ground surface (livingworld/README.md "Pasos con sonido"): own recipes for
// the events step.self.<sound> of assets/sounds.yaml, written to
// assets/livingworld/sounds/steps/<sound>_<n>.ogg. One footfall each: filtered noise
// bursts, grains and a few short sines shaped like the material (a swish for grass, a
// knock for wood, a crunch for snow, a squelch for mud...).
//
// Every surface has STEP_TAKES takes: the same recipe with another seed, which also moves
// its pitch and timing a little, so a walk does not repeat one sample. A take is trimmed to
// where it dies away, faded at both ends and then levelled to the same loudness as every
// other one (energy after a rough ear weighting, not peak: a click and a swish of the same
// peak are far from equally loud), so sounds.yaml gives them all one volume.
import { highpass, lowpass, mix, RATE, rng, samples, tone } from "./synth.ts";

type Rand = () => number;

/** Takes of each surface. */
export const STEP_TAKES = 3;
/** A take lasts between these, s. */
export const STEP_MIN_S = 0.08;
export const STEP_MAX_S = 0.25;
/** Loudness of every take (weighted energy, `stepLoudness`) and its peak ceiling. */
export const STEP_LOUDNESS = 0.019;
export const STEP_PEAK = 0.89;

/** White noise of n samples. */
function noise(n: number, rand: Rand): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Band-limited noise: highpass then lowpass (two poles each side). */
function band(sec: number, lo: number, hi: number, rand: Rand): Float32Array {
  const b = noise(samples(sec), rand);
  if (lo > 0) highpass(highpass(b, lo), lo);
  return lowpass(lowpass(b, hi), hi);
}

/** Shapes buf in place: a smooth rise over `attack` s, then an exponential fall. */
function shape(buf: Float32Array, attack: number, decay: number, gain = 1): Float32Array {
  const a = Math.max(1, samples(attack));
  for (let i = 0; i < buf.length; i++) {
    const rise = i < a ? Math.sin((Math.PI / 2) * (i / a)) ** 2 : 1;
    const fall = i < a ? 1 : Math.exp(-(i - a) / (decay * RATE));
    buf[i] = (buf[i] ?? 0) * rise * fall * gain;
  }
  return buf;
}

/** A burst of band noise with that envelope. */
function burst(
  rand: Rand,
  o: { dur: number; lo: number; hi: number; attack: number; decay: number; gain?: number },
): Float32Array {
  return shape(band(o.dur, o.lo, o.hi, rand), o.attack, o.decay, o.gain ?? 1);
}

/**
 * `count` tiny bursts scattered over `dur` s, more of them early (`early` > 1) and fading
 * with time: grit, blades, ice crystals.
 */
function grains(
  rand: Rand,
  o: {
    dur: number;
    count: number;
    lo: number;
    hi: number;
    len: number;
    gain: number;
    early?: number;
  },
): Float32Array {
  const out = new Float32Array(samples(o.dur));
  for (let i = 0; i < o.count; i++) {
    const at = rand() ** (o.early ?? 1.6) * (o.dur - o.len);
    const len = o.len * (0.6 + 0.8 * rand());
    const lo = o.lo * (0.8 + 0.5 * rand());
    const g = o.gain * (0.4 + 0.6 * rand()) * (1 - 0.6 * (at / o.dur));
    mix(
      out,
      burst(rand, { dur: len, lo, hi: o.hi, attack: len * 0.2, decay: len * 0.3, gain: g }),
      at,
    );
  }
  return out;
}

/** A short sine, swept from f0 to f1, dying with `decay`. */
function ping(rand: Rand, f0: number, f1: number, dur: number, decay: number, gain: number) {
  return tone({ wave: "sine", freq: f0, freqEnd: f1, dur, decay, gain, attack: 0.002 }, rand);
}

/** Parts at offsets (seconds) into one buffer of `dur`. */
function layer(dur: number, parts: [number, Float32Array][]): Float32Array {
  const out = new Float32Array(samples(dur));
  for (const [at, buf] of parts) mix(out, buf, at);
  return out;
}

/** A factor around 1, +-`spread`: what makes one take differ from the next. */
const vary = (rand: Rand, spread: number): number => 1 + spread * (rand() * 2 - 1);

/** One footfall on each surface sound (data/livingworld/surfaces.yaml `sound`). */
const RECIPES: Record<string, (r: Rand) => Float32Array> = {
  // Blades bending under the sole: a soft swish with a few rustles and hardly any body.
  grass: (r) => {
    const p = vary(r, 0.12);
    return layer(0.2, [
      [0, burst(r, { dur: 0.16, lo: 800 * p, hi: 3200 * p, attack: 0.016, decay: 0.03 })],
      [0, burst(r, { dur: 0.08, lo: 140, hi: 520, attack: 0.004, decay: 0.02, gain: 0.7 })],
      [0.008, grains(r, { dur: 0.15, count: 9, lo: 1600, hi: 5000, len: 0.01, gain: 0.6 })],
    ]);
  },
  // Wading through stems: a longer, brighter swish, and the stems springing back.
  tall_grass: (r) => {
    const p = vary(r, 0.1);
    const back = 0.07 * vary(r, 0.2);
    return layer(0.25, [
      [0, burst(r, { dur: 0.2, lo: 1100 * p, hi: 4200 * p, attack: 0.035, decay: 0.05 })],
      [
        back,
        burst(r, { dur: 0.14, lo: 1500 * p, hi: 5000, attack: 0.03, decay: 0.035, gain: 0.5 }),
      ],
      [
        0.005,
        grains(r, { dur: 0.2, count: 14, lo: 2000, hi: 6000, len: 0.009, gain: 0.6, early: 1.1 }),
      ],
    ]);
  },
  // Packed earth: a dull thud with grit under it.
  dirt: (r) => {
    const p = vary(r, 0.12);
    return layer(0.16, [
      [0, burst(r, { dur: 0.1, lo: 90, hi: 450 * p, attack: 0.003, decay: 0.022 })],
      [
        0.002,
        burst(r, { dur: 0.07, lo: 600, hi: 2200 * p, attack: 0.004, decay: 0.016, gain: 0.35 }),
      ],
      [0.004, grains(r, { dur: 0.09, count: 9, lo: 800, hi: 2800, len: 0.006, gain: 0.4 })],
    ]);
  },
  // Dry sand giving way: a hiss that swells and goes, no impact.
  sand: (r) => {
    const p = vary(r, 0.1);
    return layer(0.2, [
      [0, burst(r, { dur: 0.17, lo: 2400 * p, hi: 7500 * p, attack: 0.024, decay: 0.038 })],
      [0, burst(r, { dur: 0.06, lo: 120, hi: 400, attack: 0.006, decay: 0.018, gain: 0.3 })],
      [
        0.01,
        grains(r, { dur: 0.15, count: 14, lo: 3200, hi: 8000, len: 0.005, gain: 0.25, early: 1.2 }),
      ],
    ]);
  },
  // Wet sand at the water's edge: firmer and darker, with a small wet tick.
  wet_sand: (r) => {
    const p = vary(r, 0.12);
    return layer(0.18, [
      [0, burst(r, { dur: 0.14, lo: 500, hi: 2300 * p, attack: 0.008, decay: 0.028 })],
      [0, burst(r, { dur: 0.09, lo: 100, hi: 360, attack: 0.004, decay: 0.024, gain: 0.8 })],
      [0.012, ping(r, 520 * p, 250 * p, 0.045, 0.012, 0.12)],
      [0.02, grains(r, { dur: 0.1, count: 5, lo: 1500, hi: 4500, len: 0.006, gain: 0.2 })],
    ]);
  },
  // Ash: a muffled puff, the softest of all.
  ash: (r) => {
    const p = vary(r, 0.12);
    return layer(0.22, [
      [0, burst(r, { dur: 0.19, lo: 260, hi: 1300 * p, attack: 0.028, decay: 0.045 })],
      [0, burst(r, { dur: 0.08, lo: 90, hi: 300, attack: 0.008, decay: 0.022, gain: 0.5 })],
      [0.02, grains(r, { dur: 0.12, count: 4, lo: 1500, hi: 3600, len: 0.008, gain: 0.12 })],
    ]);
  },
  // Flagstones: a short, dry tap of the heel, then the faintest scuff of the sole.
  stone: (r) => {
    const p = vary(r, 0.1);
    return layer(0.1, [
      [0, burst(r, { dur: 0.03, lo: 1800, hi: 7000, attack: 0.0006, decay: 0.004, gain: 0.8 })],
      [0, ping(r, 950 * p, 900 * p, 0.04, 0.007, 0.3)],
      [0, ping(r, 1730 * p, 1700 * p, 0.03, 0.004, 0.14)],
      [0, burst(r, { dur: 0.06, lo: 120, hi: 520, attack: 0.002, decay: 0.014, gain: 1 })],
      [
        0.03 * vary(r, 0.2),
        burst(r, { dur: 0.05, lo: 2000, hi: 5200, attack: 0.012, decay: 0.012, gain: 0.1 }),
      ],
    ]);
  },
  // Planks: a hollow knock, the board ringing low for a moment.
  wood: (r) => {
    const p = vary(r, 0.14);
    return layer(0.16, [
      [0, ping(r, 182 * p, 170 * p, 0.14, 0.032, 0.8)],
      [0, ping(r, 296 * p, 285 * p, 0.1, 0.022, 0.6)],
      [0, ping(r, 471 * p, 460 * p, 0.07, 0.014, 0.4)],
      [0, ping(r, 765 * p, 750 * p, 0.05, 0.008, 0.18)],
      [0, burst(r, { dur: 0.03, lo: 900, hi: 3600, attack: 0.0008, decay: 0.005, gain: 0.7 })],
      [0, burst(r, { dur: 0.06, lo: 200, hi: 900, attack: 0.002, decay: 0.014, gain: 0.5 })],
    ]);
  },
  // Snow packing down: a crunch made of many crystals, thinning out.
  snow: (r) => {
    const p = vary(r, 0.1);
    return layer(0.25, [
      [
        0,
        grains(r, {
          dur: 0.21,
          count: 42,
          lo: 1500 * p,
          hi: 6500,
          len: 0.007,
          gain: 0.8,
          early: 1.5,
        }),
      ],
      [0, burst(r, { dur: 0.2, lo: 700, hi: 3200 * p, attack: 0.012, decay: 0.055, gain: 0.3 })],
      [0, burst(r, { dur: 0.07, lo: 120, hi: 420, attack: 0.006, decay: 0.02, gain: 0.35 })],
    ]);
  },
  // Mud: the foot sinking in with a squelch, and the suck of it coming out.
  mud: (r) => {
    const p = vary(r, 0.12);
    const out = 0.095 * vary(r, 0.15);
    return layer(0.25, [
      [0, burst(r, { dur: 0.13, lo: 150, hi: 950 * p, attack: 0.014, decay: 0.035 })],
      [0.004, ping(r, 240 * p, 110 * p, 0.09, 0.028, 0.3)],
      [out, burst(r, { dur: 0.1, lo: 420, hi: 1700 * p, attack: 0.02, decay: 0.022, gain: 0.5 })],
      [out + 0.012, ping(r, 310 * p, 540 * p, 0.035, 0.012, 0.14)],
      [
        0.02,
        grains(r, { dur: 0.14, count: 6, lo: 900, hi: 3000, len: 0.007, gain: 0.18, early: 1 }),
      ],
    ]);
  },
  // Shallow water: a small splash and two or three drops falling back.
  water: (r) => {
    const p = vary(r, 0.1);
    const parts: [number, Float32Array][] = [
      [0, burst(r, { dur: 0.22, lo: 600, hi: 4500 * p, attack: 0.006, decay: 0.048 })],
      [0, burst(r, { dur: 0.09, lo: 110, hi: 480, attack: 0.004, decay: 0.028, gain: 0.6 })],
      [
        0.01,
        grains(r, { dur: 0.18, count: 10, lo: 2200, hi: 7000, len: 0.006, gain: 0.3, early: 1.2 }),
      ],
    ];
    const drops = 2 + Math.floor(r() * 2);
    for (let i = 0; i < drops; i++) {
      const f = (900 + 1300 * r()) * p;
      parts.push([0.05 + 0.13 * r(), ping(r, f, f * 1.5, 0.028, 0.009, 0.1 + 0.06 * r())]);
    }
    return layer(0.25, parts);
  },
};

/** The surface sounds that have steps of their own. */
export const STEP_SOUNDS = Object.keys(RECIPES);

/** Everything this file renders: "livingworld/steps/<sound>_<take>". */
export const STEP_PATHS = STEP_SOUNDS.flatMap((sound) =>
  Array.from({ length: STEP_TAKES }, (_, i) => `livingworld/steps/${sound}_${i + 1}`),
);

/**
 * How loud a short sound is: the root of its energy (not of its mean power: a footfall is
 * heard whole) after a rough ear weighting, two highpass poles at 350 Hz and a lowpass at
 * 9 kHz, close to an A curve where a step has its energy. Without it a low thud would
 * count as much as a hiss that is heard far louder.
 */
export function stepLoudness(buf: Float32Array): number {
  const w = lowpass(highpass(highpass(Float32Array.from(buf), 350), 350), 9000);
  let sum = 0;
  for (const v of w) sum += v * v;
  return Math.sqrt(sum / RATE);
}

/** Cuts buf where it has died away (40 dB under its peak), never shorter than STEP_MIN_S. */
function trim(buf: Float32Array): Float32Array {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last] ?? 0) < peak * 0.01) last--;
  const n = Math.min(buf.length, Math.max(samples(STEP_MIN_S), last + samples(0.012)));
  return buf.slice(0, n);
}

/** Renders one take: recipe, trim, fades at both ends (no click) and the common loudness. */
export function renderStep(path: string): Float32Array {
  const m = /^livingworld\/steps\/([a-z_]+)_(\d+)$/.exec(path);
  const recipe = m ? RECIPES[m[1] ?? ""] : undefined;
  const take = Number(m?.[2] ?? 0);
  if (!recipe || take < 1 || take > STEP_TAKES) throw new Error(`unknown step sound ${path}`);
  const index = STEP_SOUNDS.indexOf(m?.[1] ?? "");
  const buf = trim(recipe(rng(7000 + index * 16 + take)));
  const a = samples(0.0015);
  const b = samples(0.012);
  for (let i = 0; i < a; i++) buf[i] = (buf[i] ?? 0) * (i / a);
  for (let i = 0; i < b; i++) {
    const j = buf.length - 1 - i;
    buf[j] = (buf[j] ?? 0) * Math.sin((Math.PI / 2) * (i / b)) ** 2;
  }
  const k = STEP_LOUDNESS / (stepLoudness(buf) || 1);
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] ?? 0) * k;
  return buf;
}
