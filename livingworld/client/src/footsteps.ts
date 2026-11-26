// Footstep sounds (livingworld/README.md "Pasos con sonido"): every footfall of the own
// player names the sound events to try, most specific first (step.self.<sound of the
// surface under that foot>, then step.self; the client's audio engine plays the first one
// assets/sounds.yaml maps), and how that foot sounds: the left and the right a little
// apart in pitch and loudness, a small pitch change at every step, and never the same take
// twice in a row. Deterministic (no Math.random): the changes come from the step's number.
import type { LivingWorldData, Surface } from "./data.ts";
import { hash01 } from "./hash.ts";

export const STEP_EVENT = "step.self";

export function footstepEvents(surface: Surface | undefined, data: LivingWorldData): string[] {
  if (!surface) return [STEP_EVENT];
  const sound = data.surfaces[surface]?.sound ?? surface;
  return [`${STEP_EVENT}.${sound}`, STEP_EVENT];
}

/** How one foot sounds, over the sound's own volume. */
export interface FootSound {
  /** Pitch, a share of the take's (−0.03: three percent lower). */
  pitch: number;
  /** Loudness, a factor. */
  gain: number;
}

/** How steps sound (data/livingworld/surfaces.yaml `steps`). */
export interface StepRules {
  /** The one number of how loud steps are: a factor over every step sound's volume. */
  volume: number;
  /** Each step's pitch moves at random up to this share either way. */
  jitter: number;
  left: FootSound;
  right: FootSound;
}

export const DEFAULT_STEP_RULES: StepRules = {
  volume: 1,
  jitter: 0,
  left: { pitch: 0, gain: 1 },
  right: { pitch: 0, gain: 1 },
};

/** How to play one footfall (reused: read it when it is handed over). */
export interface StepVoice {
  /** A factor over the sound's volume. */
  gain: number;
  /** Playback rate: 1 is the take as recorded. */
  rate: number;
  /** Which of `n` takes to play: never the one before when there is another. */
  pick(n: number): number;
}

/** Gives every footfall its voice: the foot's own colour, a jitter and the next take. */
export class StepVoicer {
  private readonly rules: StepRules;
  private count = 0;
  private last = -1;
  private readonly voice: StepVoice;

  constructor(rules: StepRules = DEFAULT_STEP_RULES) {
    this.rules = rules;
    this.voice = { gain: 1, rate: 1, pick: (n) => this.pick(n) };
  }

  /** The voice of the next footfall of the foot on `side` (-1 left, 1 right, 0 either). */
  next(side: number): StepVoice {
    const r = this.rules;
    const foot = side < 0 ? r.left : side > 0 ? r.right : undefined;
    const n = this.count++;
    const jitter = (hash01(n, 3, 9173) * 2 - 1) * r.jitter;
    this.voice.gain = r.volume * (foot?.gain ?? 1);
    this.voice.rate = Math.max(0.5, 1 + (foot?.pitch ?? 0) + jitter);
    return this.voice;
  }

  private pick(n: number): number {
    if (n <= 1) {
      this.last = 0;
      return 0;
    }
    const h = hash01(this.count, 11, 6151);
    // Any take but the last one: one of the n - 1 after it, round the list.
    const take =
      this.last < 0 || this.last >= n
        ? Math.min(n - 1, Math.floor(h * n))
        : (this.last + 1 + Math.min(n - 2, Math.floor(h * (n - 1)))) % n;
    this.last = take;
    return take;
  }
}
