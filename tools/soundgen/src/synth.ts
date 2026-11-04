// Small deterministic synthesizer (sfxr-style): oscillators, noise, envelopes, one-pole
// filters, a plucked string and a step sequencer. Everything renders mono Float32 PCM at
// RATE; the same recipe and seed always give the same samples (no Math.random, no clock).

export const RATE = 48000;

/** Seeded PRNG (mulberry32): uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Wave = "sine" | "square" | "saw" | "triangle" | "noise";

export interface ToneSpec {
  wave: Wave;
  /** Start frequency, Hz. */
  freq: number;
  /** End frequency (exponential sweep), Hz; default = freq. */
  freqEnd?: number;
  /** Seconds. */
  dur: number;
  /** Seconds of linear attack. */
  attack?: number;
  /** Exponential decay time constant after the attack, seconds (default: none). */
  decay?: number;
  /** Seconds of linear fade at the end (default 0.01). */
  release?: number;
  gain?: number;
  /** Square duty cycle (0..1). */
  duty?: number;
  /** Vibrato depth (fraction of freq) and rate (Hz). */
  vibrato?: { depth: number; rate: number };
  /** One-pole lowpass cutoff, Hz. */
  lowpass?: number;
  /** One-pole highpass cutoff, Hz. */
  highpass?: number;
}

/** Midi note number → Hz (A4 = 69 = 440 Hz). */
export const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12);

const NOTE = /^([A-G])([#b]?)(-?\d)$/;
const STEPS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4", "F#3", "Bb2" → midi number. */
export function note(name: string): number {
  const m = NOTE.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + (STEPS[m[1] ?? "C"] ?? 0) + acc;
}

export const samples = (sec: number): number => Math.max(0, Math.round(sec * RATE));

export function lowpass(buf: Float32Array, cutoff: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * ((buf[i] ?? 0) - y);
    buf[i] = y;
  }
  return buf;
}

export function highpass(buf: Float32Array, cutoff: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoff);
  const a = rc / (rc + 1 / RATE);
  let prevX = 0;
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] ?? 0;
    y = a * (y + x - prevX);
    prevX = x;
    buf[i] = y;
  }
  return buf;
}

/** Renders one tone into a new buffer. */
export function tone(spec: ToneSpec, rand: () => number): Float32Array {
  const n = samples(spec.dur);
  const out = new Float32Array(n);
  const f0 = spec.freq;
  const f1 = spec.freqEnd ?? f0;
  const attack = spec.attack ?? 0.002;
  const release = Math.min(spec.release ?? 0.01, spec.dur);
  const gain = spec.gain ?? 1;
  const duty = spec.duty ?? 0.5;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const k = n > 1 ? i / (n - 1) : 0;
    let f = f0 * (f1 / f0) ** k;
    if (spec.vibrato) f *= 1 + spec.vibrato.depth * Math.sin(2 * Math.PI * spec.vibrato.rate * t);
    phase = (phase + f / RATE) % 1;
    let v: number;
    switch (spec.wave) {
      case "sine":
        v = Math.sin(2 * Math.PI * phase);
        break;
      case "square":
        v = phase < duty ? 1 : -1;
        break;
      case "saw":
        v = 2 * phase - 1;
        break;
      case "triangle":
        v = 1 - 4 * Math.abs(phase - 0.5);
        break;
      case "noise":
        v = rand() * 2 - 1;
        break;
    }
    let env = t < attack ? t / attack : 1;
    if (spec.decay !== undefined && t >= attack) env = Math.exp(-(t - attack) / spec.decay);
    const left = spec.dur - t;
    if (left < release) env *= left / release;
    out[i] = v * env * gain;
  }
  if (spec.lowpass !== undefined) lowpass(out, spec.lowpass);
  if (spec.highpass !== undefined) highpass(out, spec.highpass);
  return out;
}

/** Plucked string (Karplus-Strong), for harps, lutes and bass. */
export function pluck(
  freq: number,
  dur: number,
  rand: () => number,
  opts: { gain?: number; damp?: number; bright?: number } = {},
): Float32Array {
  const n = samples(dur);
  const out = new Float32Array(n);
  const period = Math.max(2, Math.round(RATE / freq));
  const ring = new Float32Array(period);
  const bright = opts.bright ?? 0.5;
  let prev = 0;
  for (let i = 0; i < period; i++) {
    // Lowpassed noise burst: brighter = less filtering.
    prev += bright * (rand() * 2 - 1 - prev);
    ring[i] = prev;
  }
  const damp = opts.damp ?? 0.996;
  const gain = opts.gain ?? 1;
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[idx] ?? 0;
    const b = ring[(idx + 1) % period] ?? 0;
    const v = 0.5 * (a + b) * damp;
    ring[idx] = v;
    idx = (idx + 1) % period;
    const left = n - i;
    const fade = left < 480 ? left / 480 : 1;
    out[i] = a * gain * fade;
  }
  return out;
}

/** Mixes src into dst at time `at` (seconds); with wrap, what overflows goes to the start. */
export function mix(dst: Float32Array, src: Float32Array, at: number, wrap = false): void {
  const start = samples(at);
  for (let i = 0; i < src.length; i++) {
    let j = start + i;
    if (j >= dst.length) {
      if (!wrap) break;
      j %= dst.length;
    }
    dst[j] = (dst[j] ?? 0) + (src[i] ?? 0);
  }
}

export function silence(sec: number): Float32Array {
  return new Float32Array(samples(sec));
}

/** Scales buf so its peak is `peak` (no-op on silence). */
export function normalize(buf: Float32Array, peak = 0.9): Float32Array {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) return buf;
  const k = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] ?? 0) * k;
  return buf;
}

/** Soft clipper for dense mixes. */
export function soften(buf: Float32Array): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] ?? 0);
  return buf;
}

/** Linear fade in and out at the ends (seconds), for one-shot sounds. */
export function fadeEnds(buf: Float32Array, inSec: number, outSec: number): Float32Array {
  const a = samples(inSec);
  const b = samples(outSec);
  for (let i = 0; i < a && i < buf.length; i++) buf[i] = (buf[i] ?? 0) * (i / a);
  for (let i = 0; i < b && i < buf.length; i++) {
    const j = buf.length - 1 - i;
    buf[j] = (buf[j] ?? 0) * (i / b);
  }
  return buf;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(buf: Float32Array): Buffer {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i] ?? 0));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
