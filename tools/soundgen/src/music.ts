// Music loops and ambient beds (assets/sounds/music, assets/sounds/ambient). Original
// progressions and melodies written for this project; a tiny step sequencer renders them.
// Every note is mixed with wrap-around, so the tail of the last bar rings into the first
// one and the loop has no seam.
import {
  highpass,
  lowpass,
  midi,
  mix,
  normalize,
  note,
  pluck,
  rng,
  samples,
  silence,
  soften,
  tone,
} from "./synth.ts";

/** A note: start beat, note name (or "-" = rest), length in beats. */
type Step = [string, number];

/** Melody written as consecutive [note, beats] steps from beat `start`. */
function line(steps: Step[], start = 0): { beat: number; n: string; len: number }[] {
  let beat = start;
  const out: { beat: number; n: string; len: number }[] = [];
  for (const [n, len] of steps) {
    if (n !== "-") out.push({ beat, n, len });
    beat += len;
  }
  return out;
}

const CHORDS: Record<string, string[]> = {
  Dm: ["D3", "F3", "A3"],
  C: ["C3", "E3", "G3"],
  Bb: ["Bb2", "D3", "F3"],
  F: ["F3", "A3", "C4"],
  G: ["G2", "B2", "D3"],
  Em: ["E3", "G3", "B3"],
  D: ["D3", "F#3", "A3"],
  Am: ["A2", "C3", "E3"],
  Eb: ["Eb3", "G3", "Bb3"],
  Gm: ["G2", "Bb2", "D3"],
};

const chord = (name: string): string[] => {
  const c = CHORDS[name];
  if (!c) throw new Error(`unknown chord ${name}`);
  return c;
};

const up = (n: string, octaves: number): number => note(n) + 12 * octaves;

interface Track {
  bpm: number;
  bars: number;
  seed: number;
  render(out: Float32Array, beat: (b: number) => number, rand: () => number): void;
}

/** Warm pad: three detuned saws through a lowpass. */
function pad(freqs: number[], dur: number, rand: () => number, gain = 0.08): Float32Array {
  const out = silence(dur);
  for (const f of freqs)
    for (const d of [-0.004, 0.004])
      mix(
        out,
        tone(
          { wave: "saw", freq: f * (1 + d), dur, attack: 0.6, release: 0.6, gain, lowpass: 900 },
          rand,
        ),
        0,
      );
  return out;
}

/** Breathy lead: triangle with vibrato and a little noise. */
function flute(freq: number, dur: number, rand: () => number, gain = 0.3): Float32Array {
  const body = tone(
    {
      wave: "triangle",
      freq,
      dur,
      attack: 0.05,
      release: Math.min(0.15, dur / 2),
      vibrato: { depth: 0.006, rate: 5 },
      gain,
    },
    rand,
  );
  const breath = tone(
    {
      wave: "noise",
      freq: 1,
      dur,
      attack: 0.05,
      release: 0.1,
      gain: gain * 0.03,
      highpass: 1500,
      lowpass: 5000,
    },
    rand,
  );
  mix(body, breath, 0);
  return body;
}

const TRACKS: Record<string, Track> = {
  // Velmara: D dorian, a lute and a flute over a walking bass, 96 bpm.
  "music/puerto": {
    bpm: 96,
    bars: 16,
    seed: 100,
    render(out, beat, rand) {
      const prog = ["Dm", "C", "Bb", "C", "Dm", "F", "G", "Dm"];
      const melody = line([
        ["A4", 1],
        ["F4", 0.5],
        ["G4", 0.5],
        ["A4", 1],
        ["D5", 1],
        ["C5", 1.5],
        ["Bb4", 0.5],
        ["A4", 1],
        ["G4", 1],
        ["F4", 1],
        ["G4", 0.5],
        ["A4", 0.5],
        ["Bb4", 1],
        ["A4", 1],
        ["G4", 2],
        ["E4", 1],
        ["-", 1],
        ["A4", 1],
        ["A4", 0.5],
        ["Bb4", 0.5],
        ["C5", 1],
        ["D5", 1],
        ["C5", 1],
        ["A4", 1],
        ["F4", 1],
        ["A4", 1],
        ["B4", 1.5],
        ["A4", 0.5],
        ["G4", 1],
        ["B4", 1],
        ["A4", 3],
        ["-", 1],
      ]);
      for (let pass = 0; pass < 2; pass++) {
        const off = pass * 32;
        prog.forEach((name, bar) => {
          const tones = chord(name);
          const root = tones[0] ?? "D3";
          for (const b of [0, 2])
            mix(
              out,
              pluck(midi(up(root, -1)), beat(1.8), rand, { gain: 0.5, damp: 0.995, bright: 0.3 }),
              beat(off + bar * 4 + b),
              true,
            );
          // Lute: eighth-note arpeggio up and down the chord.
          const arp = [0, 1, 2, 1, 0, 1, 2, 1];
          arp.forEach((k, i) => {
            const n = tones[k] ?? root;
            mix(
              out,
              pluck(midi(up(n, 1)), beat(1), rand, { gain: 0.22, damp: 0.994, bright: 0.6 }),
              beat(off + bar * 4 + i * 0.5),
              true,
            );
          });
          if (pass === 1)
            for (let i = 0; i < 8; i++)
              mix(
                out,
                tone(
                  {
                    wave: "noise",
                    freq: 1,
                    dur: 0.05,
                    decay: 0.012,
                    highpass: 6000,
                    gain: i % 2 ? 0.06 : 0.1,
                  },
                  rand,
                ),
                beat(off + bar * 4 + i * 0.5),
                true,
              );
        });
        for (const m of melody) {
          const f = midi(note(m.n));
          const voice =
            pass === 0
              ? flute(f, beat(m.len), rand, 0.28)
              : pluck(f, beat(m.len) + 0.3, rand, { gain: 0.45, damp: 0.997, bright: 0.7 });
          mix(out, voice, beat(off + m.beat), true);
        }
      }
    },
  },
  // Selvaine: E minor pentatonic flute over pads and a harp, 72 bpm.
  "music/bosque": {
    bpm: 72,
    bars: 8,
    seed: 200,
    render(out, beat, rand) {
      const prog = ["Em", "C", "G", "D", "Em", "C", "D", "Em"];
      const melody = line([
        ["-", 1],
        ["E5", 1],
        ["G5", 1],
        ["A5", 1],
        ["B5", 2],
        ["A5", 1],
        ["G5", 1],
        ["D5", 1.5],
        ["E5", 0.5],
        ["G5", 2],
        ["A5", 3],
        ["-", 1],
        ["B5", 1],
        ["D6", 1],
        ["B5", 1],
        ["A5", 1],
        ["G5", 2],
        ["E5", 2],
        ["D5", 1],
        ["E5", 1],
        ["G5", 1],
        ["A5", 1],
        ["E5", 3],
        ["-", 1],
      ]);
      prog.forEach((name, bar) => {
        const tones = chord(name);
        mix(
          out,
          pad(
            tones.map((n) => midi(note(n))),
            beat(4) + 0.6,
            rand,
          ),
          beat(bar * 4),
          true,
        );
        [0, 1, 2, 1].forEach((k, i) => {
          const n = tones[k] ?? "E3";
          mix(
            out,
            pluck(midi(up(n, 1)), beat(2), rand, { gain: 0.25, damp: 0.997, bright: 0.45 }),
            beat(bar * 4 + i),
            true,
          );
        });
      });
      for (const m of melody)
        mix(out, flute(midi(note(m.n)), beat(m.len), rand, 0.22), beat(m.beat), true);
    },
  },
  // Caves: a low drone in A, sparse plucks and water drops, 60 bpm.
  "music/cueva": {
    bpm: 60,
    bars: 8,
    seed: 300,
    render(out, beat, rand) {
      const total = beat(32);
      const drone = silence(total);
      for (const n of ["A1", "E2"])
        mix(
          drone,
          tone(
            {
              wave: "saw",
              freq: midi(note(n)),
              dur: total,
              attack: 0.01,
              release: 0.01,
              gain: 0.12,
              lowpass: 260,
            },
            rand,
          ),
          0,
        );
      // Slow swell, two per loop, so the loop point stays smooth.
      for (let i = 0; i < drone.length; i++)
        drone[i] = (drone[i] ?? 0) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * i) / drone.length));
      mix(out, drone, 0);
      const plucks: [number, string][] = [
        [0, "A2"],
        [6, "C3"],
        [8, "E3"],
        [14, "D3"],
        [16, "A2"],
        [22, "G2"],
        [24, "E3"],
        [29, "C3"],
      ];
      for (const [b, n] of plucks)
        mix(
          out,
          pluck(midi(note(n)), beat(3), rand, { gain: 0.4, damp: 0.998, bright: 0.25 }),
          beat(b),
          true,
        );
      for (let i = 0; i < 9; i++) {
        const at = rand() * beat(32);
        const f = 900 + rand() * 900;
        mix(
          out,
          tone(
            { wave: "sine", freq: f, freqEnd: f * 2.2, dur: 0.09, decay: 0.03, gain: 0.18 },
            rand,
          ),
          at,
          true,
        );
      }
    },
  },
  // Karvask (T5.5): D phrygian dominant over a low drone, slow drums like the
  // mountain's pulse and a far anvil from the smithies of Cinderstead, 66 bpm.
  "music/volcan": {
    bpm: 66,
    bars: 8,
    seed: 600,
    render(out, beat, rand) {
      const total = beat(32);
      const drone = silence(total);
      for (const n of ["D1", "A1"])
        mix(
          drone,
          tone(
            {
              wave: "saw",
              freq: midi(note(n)),
              dur: total,
              attack: 0.01,
              release: 0.01,
              gain: 0.1,
              lowpass: 200,
            },
            rand,
          ),
          0,
        );
      // A slow swell, twice per loop, so the loop point stays smooth.
      for (let i = 0; i < drone.length; i++)
        drone[i] = (drone[i] ?? 0) * (0.65 + 0.35 * Math.cos((2 * Math.PI * 2 * i) / drone.length));
      mix(out, drone, 0);
      // D phrygian dominant (D Eb F# G A Bb C): the bII–I of Eb to D closes every half.
      const prog = ["D", "Eb", "D", "C", "D", "Eb", "Gm", "Eb"];
      prog.forEach((name, bar) => {
        const tones = chord(name);
        mix(
          out,
          pad(
            tones.map((n) => midi(note(n))),
            beat(4) + 0.6,
            rand,
            0.06,
          ),
          beat(bar * 4),
          true,
        );
        // Drums: a deep hit on 1, a softer one on 3 and a ghost before the next bar.
        for (const [b, g] of [
          [0, 0.75],
          [2, 0.45],
          [3.5, 0.2],
        ] as const) {
          mix(
            out,
            tone(
              {
                wave: "sine",
                freq: 110,
                freqEnd: 42,
                dur: 0.6,
                attack: 0.003,
                decay: 0.2,
                gain: g,
              },
              rand,
            ),
            beat(bar * 4 + b),
            true,
          );
          mix(
            out,
            tone(
              { wave: "noise", freq: 1, dur: 0.08, decay: 0.02, lowpass: 500, gain: g * 0.5 },
              rand,
            ),
            beat(bar * 4 + b),
            true,
          );
        }
        // The anvil: two inharmonic partials, far away, every other bar.
        if (bar % 2 === 1)
          for (const [f, g] of [
            [1568, 0.05],
            [2321, 0.03],
          ] as const)
            mix(
              out,
              tone({ wave: "sine", freq: f, dur: 1.2, attack: 0.002, decay: 0.35, gain: g }, rand),
              beat(bar * 4 + 3),
              true,
            );
      });
      const melody = line([
        ["-", 2],
        ["D4", 1],
        ["Eb4", 1],
        ["F#4", 2],
        ["G4", 1],
        ["F#4", 1],
        ["Eb4", 3],
        ["D4", 1],
        ["C4", 2],
        ["D4", 2],
        ["-", 1],
        ["A4", 1],
        ["Bb4", 1],
        ["A4", 1],
        ["G4", 1.5],
        ["F#4", 0.5],
        ["Eb4", 2],
        ["D4", 1],
        ["Eb4", 1],
        ["F#4", 1],
        ["G4", 1],
        ["Bb4", 1],
        ["G4", 2],
        ["-", 1],
      ]);
      for (const m of melody)
        mix(out, flute(midi(note(m.n)), beat(m.len), rand, 0.26), beat(m.beat), true);
    },
  },
};

const AMBIENT: Record<
  string,
  { seconds: number; seed: number; render(out: Float32Array, rand: () => number): void }
> = {
  // Waves on a beach: lowpassed noise that swells twice per loop.
  "ambient/olas": {
    seconds: 16,
    seed: 400,
    render(out, rand) {
      const n = out.length;
      const rumble = lowpass(
        tone({ wave: "noise", freq: 1, dur: n / 48000, attack: 0.001, release: 0.001 }, rand),
        420,
      );
      const hiss = highpass(
        lowpass(
          tone({ wave: "noise", freq: 1, dur: n / 48000, attack: 0.001, release: 0.001 }, rand),
          3500,
        ),
        900,
      );
      for (let i = 0; i < n; i++) {
        const ph = (2 * Math.PI * 2 * i) / n;
        const swell = 0.35 + 0.65 * Math.sin(ph / 2) ** 2;
        const wash = Math.max(0, Math.sin(ph / 2 - 0.6)) ** 3;
        out[i] = 1.6 * (rumble[i] ?? 0) * swell + 0.5 * (hiss[i] ?? 0) * wash;
      }
    },
  },
  // Forest: soft wind and a few bird calls.
  "ambient/bosque": {
    seconds: 16,
    seed: 500,
    render(out, rand) {
      const n = out.length;
      const wind = lowpass(
        lowpass(
          tone({ wave: "noise", freq: 1, dur: n / 48000, attack: 0.001, release: 0.001 }, rand),
          350,
        ),
        500,
      );
      for (let i = 0; i < n; i++)
        out[i] = 1.5 * (wind[i] ?? 0) * (0.6 + 0.4 * Math.sin((2 * Math.PI * i) / n));
      for (let call = 0; call < 6; call++) {
        const at = rand() * 16;
        const base = 2600 + rand() * 1400;
        const chirps = 2 + Math.floor(rand() * 3);
        for (let c = 0; c < chirps; c++)
          mix(
            out,
            tone(
              {
                wave: "sine",
                freq: base,
                freqEnd: base * 1.35,
                dur: 0.07,
                attack: 0.01,
                decay: 0.03,
                gain: 0.12,
              },
              rand,
            ),
            at + c * 0.11,
            true,
          );
      }
    },
  },
  // Karvask (T5.5): the mountain's deep rumble, lava bubbling, crackling rock and
  // a vent letting off steam now and then.
  "ambient/volcan": {
    seconds: 16,
    seed: 700,
    render(out, rand) {
      const n = out.length;
      // The bed is rendered half a second longer and its tail crossfaded into its start,
      // so the filtered noise has no click at the loop point.
      const xf = 24000;
      const noise = (): Float32Array =>
        tone(
          { wave: "noise", freq: 1, dur: (n + xf) / 48000, attack: 0.001, release: 0.001 },
          rand,
        );
      const rumble = lowpass(lowpass(noise(), 140), 180);
      const roar = highpass(lowpass(noise(), 900), 250);
      const bed = (i: number): number => {
        const ph = (2 * Math.PI * i) / n;
        const swell = 0.6 + 0.4 * Math.sin(ph) ** 2;
        return (
          2.4 * (rumble[i] ?? 0) * (0.75 + 0.25 * Math.cos(2 * ph)) + 0.2 * (roar[i] ?? 0) * swell
        );
      };
      for (let i = 0; i < n; i++) {
        const w = i < xf ? i / xf : 1;
        out[i] = w * bed(i) + (1 - w) * bed(n + i);
      }
      // Lava bubbles: low blips that rise as they pop.
      for (let b = 0; b < 14; b++) {
        const f = 70 + rand() * 60;
        mix(
          out,
          tone(
            {
              wave: "sine",
              freq: f,
              freqEnd: f * 2.4,
              dur: 0.12 + rand() * 0.1,
              attack: 0.005,
              decay: 0.05,
              gain: 0.3,
            },
            rand,
          ),
          rand() * 16,
          true,
        );
      }
      // Crackles: short ticks in small clusters.
      for (let c = 0; c < 10; c++) {
        const at = rand() * 16;
        const ticks = 2 + Math.floor(rand() * 4);
        for (let k = 0; k < ticks; k++)
          mix(
            out,
            tone(
              {
                wave: "noise",
                freq: 1,
                dur: 0.02,
                decay: 0.004,
                highpass: 2000,
                gain: 0.12 + rand() * 0.15,
              },
              rand,
            ),
            at + k * (0.03 + rand() * 0.06),
            true,
          );
      }
      // Steam from a vent, twice per loop.
      for (const at of [3.5, 11]) {
        mix(
          out,
          tone(
            {
              wave: "noise",
              freq: 1,
              dur: 1.8,
              attack: 0.4,
              release: 1,
              highpass: 3000,
              lowpass: 9000,
              gain: 0.1,
            },
            rand,
          ),
          at,
          true,
        );
      }
    },
  },
};

export const MUSIC_PATHS = Object.keys(TRACKS);
export const AMBIENT_PATHS = Object.keys(AMBIENT);

/** Renders a music loop (exactly `bars` bars long). */
export function renderMusic(path: string): Float32Array {
  const t = TRACKS[path];
  if (!t) throw new Error(`unknown track ${path}`);
  const secPerBeat = 60 / t.bpm;
  const out = new Float32Array(samples(t.bars * 4 * secPerBeat));
  t.render(out, (b) => b * secPerBeat, rng(t.seed));
  return normalize(soften(normalize(out, 1.2)), 0.85);
}

export function renderAmbient(path: string): Float32Array {
  const a = AMBIENT[path];
  if (!a) throw new Error(`unknown ambient ${path}`);
  const out = new Float32Array(samples(a.seconds));
  a.render(out, rng(a.seed));
  return normalize(out, 0.8);
}
