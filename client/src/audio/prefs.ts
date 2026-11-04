// Volume and mute of each audio channel (T3.7), kept in the browser like the language and
// the hotkeys. Unknown or broken saved values fall back to the defaults.
import type { SoundChannel } from "../content-types.ts";

export type VolumeChannel = "master" | SoundChannel;

/** Order of the sliders in the options panel. */
export const ALL_CHANNELS: readonly VolumeChannel[] = ["master", "music", "sfx", "ui", "ambient"];

export interface AudioPrefs {
  /** 0..1 per channel. */
  volume: Record<VolumeChannel, number>;
  muted: Record<VolumeChannel, boolean>;
}

export const AUDIO_STORAGE_KEY = "rpg.audio";

export function defaultPrefs(): AudioPrefs {
  return {
    volume: { master: 0.8, music: 0.5, sfx: 0.9, ui: 0.7, ambient: 0.6 },
    muted: { master: false, music: false, sfx: false, ui: false, ambient: false },
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function loadPrefs(storage: Pick<Storage, "getItem"> | undefined): AudioPrefs {
  const prefs = defaultPrefs();
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(AUDIO_STORAGE_KEY) ?? "null");
  } catch {
    return prefs;
  }
  if (typeof raw !== "object" || raw === null) return prefs;
  const r = raw as { volume?: Record<string, unknown>; muted?: Record<string, unknown> };
  for (const ch of ALL_CHANNELS) {
    const v = r.volume?.[ch];
    if (typeof v === "number" && Number.isFinite(v)) prefs.volume[ch] = clamp01(v);
    const m = r.muted?.[ch];
    if (typeof m === "boolean") prefs.muted[ch] = m;
  }
  return prefs;
}

export function savePrefs(prefs: AudioPrefs, storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the volumes last until the page reloads.
  }
}

/** A copy of prefs with one channel's volume (clamped) or mute changed. */
export function withVolume(prefs: AudioPrefs, ch: VolumeChannel, volume: number): AudioPrefs {
  return { volume: { ...prefs.volume, [ch]: clamp01(volume) }, muted: { ...prefs.muted } };
}

export function withMuted(prefs: AudioPrefs, ch: VolumeChannel, muted: boolean): AudioPrefs {
  return { volume: { ...prefs.volume }, muted: { ...prefs.muted, [ch]: muted } };
}
