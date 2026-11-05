// Recipes of the sound effects (assets/sounds/sfx, assets/sounds/ui). Original sounds made
// from oscillators and noise; each one has its own seed so a change to one recipe does not
// change the others.
import {
  fadeEnds,
  lowpass,
  midi,
  mix,
  normalize,
  note,
  pluck,
  rng,
  silence,
  tone,
} from "./synth.ts";

export type Recipe = (rand: () => number) => Float32Array;

/** Several tones at offsets (seconds) into one buffer of `dur`. */
function layer(dur: number, parts: [number, Float32Array][]): Float32Array {
  const out = silence(dur);
  for (const [at, buf] of parts) mix(out, buf, at);
  return out;
}

/** A short rising arpeggio of sine/triangle bells. */
function chime(notes: string[], gap: number, len: number, rand: () => number): Float32Array {
  return layer(
    gap * notes.length + len,
    notes.map((n, i) => [
      i * gap,
      tone({ wave: "triangle", freq: midi(note(n)), dur: len, decay: len / 3, gain: 0.7 }, rand),
    ]),
  );
}

/** Magic of an element: a sweep with its own colour. */
function spell(kind: string, rand: () => number): Float32Array {
  switch (kind) {
    case "fire": {
      const roar = tone(
        { wave: "noise", freq: 1, dur: 0.6, attack: 0.04, decay: 0.2, lowpass: 900 },
        rand,
      );
      const crack = tone(
        { wave: "noise", freq: 1, dur: 0.12, decay: 0.03, highpass: 2500, gain: 0.5 },
        rand,
      );
      return layer(0.65, [
        [0, roar],
        [0.02, crack],
      ]);
    }
    case "ice":
      return layer(0.6, [
        [
          0,
          tone({ wave: "sine", freq: 2400, freqEnd: 1800, dur: 0.5, decay: 0.15, gain: 0.5 }, rand),
        ],
        [
          0.03,
          tone(
            { wave: "sine", freq: 3200, freqEnd: 2600, dur: 0.4, decay: 0.12, gain: 0.35 },
            rand,
          ),
        ],
        [
          0,
          tone({ wave: "noise", freq: 1, dur: 0.3, decay: 0.08, highpass: 4000, gain: 0.3 }, rand),
        ],
      ]);
    case "energy":
      return layer(0.45, [
        [
          0,
          tone(
            {
              wave: "square",
              freq: 900,
              freqEnd: 120,
              dur: 0.35,
              decay: 0.12,
              duty: 0.3,
              gain: 0.5,
              lowpass: 5000,
            },
            rand,
          ),
        ],
        [
          0,
          tone({ wave: "noise", freq: 1, dur: 0.4, decay: 0.1, highpass: 1500, gain: 0.35 }, rand),
        ],
      ]);
    case "earth":
      return layer(0.6, [
        [0, tone({ wave: "sine", freq: 110, freqEnd: 50, dur: 0.5, decay: 0.18 }, rand)],
        [0, tone({ wave: "noise", freq: 1, dur: 0.5, decay: 0.12, lowpass: 400, gain: 0.8 }, rand)],
      ]);
    case "holy":
      return chime(["E5", "B5", "E6"], 0.05, 0.6, rand);
    case "death":
      return layer(0.8, [
        [
          0,
          tone(
            {
              wave: "saw",
              freq: 220,
              freqEnd: 70,
              dur: 0.75,
              attack: 0.05,
              decay: 0.3,
              lowpass: 700,
              gain: 0.7,
            },
            rand,
          ),
        ],
        [
          0,
          tone(
            {
              wave: "saw",
              freq: 233,
              freqEnd: 74,
              dur: 0.75,
              attack: 0.05,
              decay: 0.3,
              lowpass: 700,
              gain: 0.5,
            },
            rand,
          ),
        ],
      ]);
    default:
      throw new Error(`unknown element ${kind}`);
  }
}

/** Every effect by its output path under assets/sounds (without .ogg), with its seed. */
export const SFX: Record<string, { seed: number; render: Recipe }> = {
  "ui/click": {
    seed: 1,
    render: (r) =>
      tone(
        {
          wave: "square",
          freq: 1400,
          freqEnd: 900,
          dur: 0.04,
          decay: 0.012,
          gain: 0.4,
          lowpass: 6000,
        },
        r,
      ),
  },
  "ui/dialog_open": {
    seed: 2,
    render: (r) => chime(["G5", "C6"], 0.06, 0.25, r),
  },
  "ui/error": {
    seed: 3,
    render: (r) =>
      layer(0.22, [
        [0, tone({ wave: "square", freq: 220, dur: 0.08, gain: 0.35, lowpass: 2000 }, r)],
        [0.1, tone({ wave: "square", freq: 185, dur: 0.1, gain: 0.35, lowpass: 2000 }, r)],
      ]),
  },
  "sfx/hit": {
    seed: 10,
    render: (r) =>
      layer(0.25, [
        [0, tone({ wave: "noise", freq: 1, dur: 0.2, decay: 0.04, lowpass: 2200 }, r)],
        [0, tone({ wave: "sine", freq: 160, freqEnd: 60, dur: 0.15, decay: 0.05 }, r)],
      ]),
  },
  "sfx/miss": {
    seed: 11,
    render: (r) =>
      tone(
        {
          wave: "noise",
          freq: 1,
          dur: 0.22,
          attack: 0.06,
          decay: 0.05,
          highpass: 1200,
          lowpass: 5000,
          gain: 0.6,
        },
        r,
      ),
  },
  "sfx/arrow": {
    seed: 12,
    render: (r) =>
      layer(0.3, [
        [
          0,
          tone(
            {
              wave: "noise",
              freq: 1,
              dur: 0.25,
              attack: 0.08,
              decay: 0.06,
              highpass: 2500,
              gain: 0.5,
            },
            r,
          ),
        ],
        [0, pluck(midi(note("A3")), 0.18, r, { gain: 0.6, damp: 0.99, bright: 0.8 })],
      ]),
  },
  "sfx/spell_fire": { seed: 20, render: (r) => spell("fire", r) },
  "sfx/spell_ice": { seed: 21, render: (r) => spell("ice", r) },
  "sfx/spell_energy": { seed: 22, render: (r) => spell("energy", r) },
  "sfx/spell_earth": { seed: 23, render: (r) => spell("earth", r) },
  "sfx/spell_holy": { seed: 24, render: (r) => spell("holy", r) },
  "sfx/spell_death": { seed: 25, render: (r) => spell("death", r) },
  "sfx/heal": {
    seed: 26,
    render: (r) => chime(["C5", "E5", "G5", "C6"], 0.07, 0.4, r),
  },
  "sfx/buff": {
    seed: 27,
    render: (r) =>
      tone(
        {
          wave: "triangle",
          freq: 300,
          freqEnd: 900,
          dur: 0.4,
          attack: 0.05,
          decay: 0.2,
          vibrato: { depth: 0.03, rate: 18 },
          gain: 0.6,
        },
        r,
      ),
  },
  "sfx/conjure": {
    seed: 28,
    render: (r) =>
      layer(0.6, [
        [
          0,
          tone(
            {
              wave: "sine",
              freq: 500,
              freqEnd: 1500,
              dur: 0.45,
              attack: 0.1,
              decay: 0.2,
              vibrato: { depth: 0.05, rate: 12 },
            },
            r,
          ),
        ],
        [
          0.35,
          tone({ wave: "triangle", freq: midi(note("A5")), dur: 0.25, decay: 0.08, gain: 0.6 }, r),
        ],
      ]),
  },
  "sfx/mining": {
    seed: 30,
    render: (r) =>
      layer(0.45, [
        [0, tone({ wave: "noise", freq: 1, dur: 0.06, decay: 0.012, gain: 0.8 }, r)],
        [0, tone({ wave: "sine", freq: 2100, dur: 0.4, decay: 0.08, gain: 0.35 }, r)],
        [0, tone({ wave: "sine", freq: 3350, dur: 0.3, decay: 0.05, gain: 0.25 }, r)],
      ]),
  },
  "sfx/woodcutting": {
    seed: 31,
    render: (r) =>
      layer(0.3, [
        [0, tone({ wave: "noise", freq: 1, dur: 0.15, decay: 0.03, lowpass: 1200 }, r)],
        [0, tone({ wave: "sine", freq: 230, freqEnd: 150, dur: 0.2, decay: 0.05, gain: 0.8 }, r)],
      ]),
  },
  "sfx/fishing": {
    seed: 32,
    render: (r) =>
      layer(0.5, [
        [
          0,
          tone(
            {
              wave: "noise",
              freq: 1,
              dur: 0.45,
              attack: 0.01,
              decay: 0.1,
              lowpass: 1800,
              gain: 0.8,
            },
            r,
          ),
        ],
        [
          0.02,
          tone({ wave: "sine", freq: 600, freqEnd: 1400, dur: 0.08, decay: 0.03, gain: 0.4 }, r),
        ],
      ]),
  },
  "sfx/gather": {
    seed: 33,
    render: (r) => pluck(midi(note("D4")), 0.25, r, { gain: 0.8, damp: 0.98, bright: 0.4 }),
  },
  "sfx/smithing": {
    seed: 34,
    render: (r) =>
      layer(0.9, [
        [0, tone({ wave: "noise", freq: 1, dur: 0.04, decay: 0.01, gain: 0.7 }, r)],
        [0, tone({ wave: "sine", freq: 1250, dur: 0.85, decay: 0.25, gain: 0.4 }, r)],
        [0, tone({ wave: "sine", freq: 2780, dur: 0.6, decay: 0.15, gain: 0.25 }, r)],
        [0, tone({ wave: "sine", freq: 4110, dur: 0.4, decay: 0.08, gain: 0.15 }, r)],
      ]),
  },
  "sfx/cooking": {
    seed: 35,
    render: (r) => {
      const s = tone(
        { wave: "noise", freq: 1, dur: 0.9, attack: 0.1, highpass: 3000, gain: 0.5 },
        r,
      );
      // Crackle: random amplitude spikes.
      for (let i = 0; i < s.length; i++) s[i] = (s[i] ?? 0) * (r() < 0.02 ? 3 : 0.6);
      return fadeEnds(lowpass(s, 9000), 0.05, 0.25);
    },
  },
  "sfx/craft_fail": {
    seed: 36,
    render: (r) =>
      layer(0.4, [
        [
          0,
          tone({ wave: "triangle", freq: 330, freqEnd: 200, dur: 0.35, decay: 0.12, gain: 0.7 }, r),
        ],
        [0, tone({ wave: "noise", freq: 1, dur: 0.1, decay: 0.03, lowpass: 1500, gain: 0.4 }, r)],
      ]),
  },
  "sfx/coins": {
    seed: 37,
    render: (r) =>
      layer(
        0.45,
        [0, 0.06, 0.11, 0.2].map((at, i) => [
          at,
          tone(
            { wave: "sine", freq: 3000 + 450 * i + 200 * r(), dur: 0.2, decay: 0.05, gain: 0.4 },
            r,
          ),
        ]),
      ),
  },
  "sfx/level_up": {
    seed: 40,
    render: (r) =>
      layer(1.4, [
        [0, chime(["C5", "E5", "G5"], 0.1, 0.4, r)],
        [
          0.32,
          tone(
            {
              wave: "triangle",
              freq: midi(note("C6")),
              dur: 1.0,
              attack: 0.01,
              decay: 0.4,
              vibrato: { depth: 0.006, rate: 5 },
              gain: 0.7,
            },
            r,
          ),
        ],
        [
          0.32,
          tone(
            {
              wave: "triangle",
              freq: midi(note("G5")),
              dur: 1.0,
              attack: 0.01,
              decay: 0.4,
              gain: 0.4,
            },
            r,
          ),
        ],
      ]),
  },
  "sfx/death": {
    seed: 41,
    render: (r) =>
      layer(1.8, [
        [0, tone({ wave: "triangle", freq: midi(note("A4")), dur: 0.5, decay: 0.3, gain: 0.6 }, r)],
        [
          0.4,
          tone({ wave: "triangle", freq: midi(note("F4")), dur: 0.5, decay: 0.3, gain: 0.6 }, r),
        ],
        [
          0.8,
          tone({ wave: "triangle", freq: midi(note("D4")), dur: 1.0, decay: 0.5, gain: 0.6 }, r),
        ],
        [0.8, tone({ wave: "sine", freq: midi(note("D3")), dur: 1.0, decay: 0.5, gain: 0.5 }, r)],
      ]),
  },
  "sfx/step": {
    seed: 42,
    render: (r) =>
      tone({ wave: "noise", freq: 1, dur: 0.07, decay: 0.018, lowpass: 700, gain: 0.7 }, r),
  },
  "sfx/voyage": {
    seed: 43,
    render: (r) =>
      layer(1.6, [
        [0, tone({ wave: "sine", freq: 640, dur: 1.5, decay: 0.5, gain: 0.5 }, r)],
        [0, tone({ wave: "sine", freq: 1536, dur: 1.0, decay: 0.3, gain: 0.25 }, r)],
        [0, tone({ wave: "sine", freq: 2010, dur: 0.6, decay: 0.15, gain: 0.15 }, r)],
        [0.5, tone({ wave: "sine", freq: 640, dur: 1.1, decay: 0.4, gain: 0.35 }, r)],
      ]),
  },
};

/** Renders an effect: recipe, then a short fade at both ends and peak normalization. */
export function renderSfx(path: string): Float32Array {
  const def = SFX[path];
  if (!def) throw new Error(`unknown sound ${path}`);
  return normalize(fadeEnds(def.render(rng(def.seed)), 0.001, 0.01), 0.89);
}
