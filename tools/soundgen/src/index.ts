// soundgen: renders the project's own sounds (sfx.ts, music.ts, ambience.ts, steps.ts) and
// encodes them to Ogg Opus with ffmpeg (libopus): under assets/sounds/, and the living
// world's ambience and footsteps under assets/livingworld/sounds/ (livingworld/README.md). The .ogg files are
// committed, so building or running the game never needs ffmpeg; only `make sounds` does.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { AMBIENCE_PATHS, renderAmbience } from "./ambience.ts";
import { AMBIENT_PATHS, MUSIC_PATHS, renderAmbient, renderMusic } from "./music.ts";
import { renderSfx, SFX } from "./sfx.ts";
import { renderStep, STEP_PATHS } from "./steps.ts";
import { encodeWav } from "./synth.ts";

export type Kind = "sfx" | "music" | "ambient" | "ambience" | "step";

export interface Generated {
  /**
   * Path without extension: under assets/sounds ("sfx/hit"), or the living world's under
   * assets/livingworld/sounds ("livingworld/ambience/waves", "livingworld/steps/grass_1").
   */
  path: string;
  kind: Kind;
}

/** Everything soundgen makes, in a stable order. */
export const GENERATED: Generated[] = [
  ...Object.keys(SFX).map((path) => ({ path, kind: "sfx" as const })),
  ...MUSIC_PATHS.map((path) => ({ path, kind: "music" as const })),
  ...AMBIENT_PATHS.map((path) => ({ path, kind: "ambient" as const })),
  ...AMBIENCE_PATHS.map((path) => ({ path, kind: "ambience" as const })),
  ...STEP_PATHS.map((path) => ({ path, kind: "step" as const })),
];

/** Where a generated sound goes, relative to assets/ (what sounds.yaml `file` says). */
export function assetFile(g: Generated): string {
  const lw = /^livingworld\/(.*)$/.exec(g.path);
  return lw ? `livingworld/sounds/${lw[1] ?? ""}.ogg` : `sounds/${g.path}.ogg`;
}

/** Opus bitrate per kind (mono, 48 kHz). */
export const BITRATE: Record<Kind, string> = {
  sfx: "32k",
  music: "24k",
  ambient: "16k",
  // Crackles, droplets and leaves are bright: 16k smears them.
  ambience: "24k",
  // A footfall is a few hundred bytes either way, and 32k dulls the hiss of sand and grass.
  step: "64k",
};

export function render(g: Generated): Float32Array {
  if (g.kind === "music") return renderMusic(g.path);
  if (g.kind === "ambient") return renderAmbient(g.path);
  if (g.kind === "ambience") return renderAmbience(g.path);
  if (g.kind === "step") return renderStep(g.path);
  return renderSfx(g.path);
}

/** WAV → Ogg Opus through ffmpeg; throws with ffmpeg's message when it fails. */
export function encodeOpus(wav: Buffer, bitrate: string): Buffer {
  const r = spawnSync(
    "ffmpeg",
    [
      ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"],
      ["-c:a", "libopus", "-b:a", bitrate, "-vbr", "on", "-application", "audio"],
      ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"],
      ["-f", "ogg", "pipe:1"],
    ].flat(),
    { input: wav, maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) throw new Error(`ffmpeg: ${r.error.message} (install ffmpeg with libopus)`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  return r.stdout;
}

/** Renders and encodes every generated sound into root/assets/sounds. */
export function buildSounds(root: string, only?: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  for (const g of GENERATED) {
    if (only && g.path !== only) continue;
    const ogg = encodeOpus(encodeWav(render(g)), BITRATE[g.kind]);
    const file = join(root, "assets", assetFile(g));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ogg);
    out.push({ path: assetFile(g), bytes: ogg.length });
  }
  return out;
}

// ---- size budget (docs/07-performance-budget.md, "Audio") ---------------------------

// Since 2026-11-18 the music ships whole takes in stereo, streamed one at a time (the
// owner's request: no one-minute loops; client/src/audio/engine.ts): a take is ~0.8–1.1 MiB
// at 40–48 kbps, nothing of it is in the initial download, and a zone fetches the track it
// plays and the next one. So a music file may be 1.5 MiB, a pool (everything a player who
// stays in one zone ends up fetching) 8 MiB, and all the files together 16 MiB.
export const BUDGET = {
  /** All files referenced by assets/sounds.yaml together. */
  totalBytes: 16 * 1024 * 1024,
  /** One file, by its channel in sounds.yaml. */
  fileBytes: { sfx: 32 * 1024, ui: 16 * 1024, music: 1536 * 1024, ambient: 96 * 1024 },
  /** The files of one pool of sounds.yaml music.pools together. */
  poolBytes: 8 * 1024 * 1024,
} as const;

export type Channel = keyof typeof BUDGET.fileBytes;

/** The pools of sounds.yaml music.pools: pool id → its sound ids. */
export function manifestPools(root: string): Record<string, string[]> {
  const raw = parse(readFileSync(join(root, "assets", "sounds.yaml"), "utf8")) as {
    music?: { pools?: Record<string, string[]> };
  };
  return raw.music?.pools ?? {};
}

/** Files of assets/sounds.yaml with their size and channel (missing files: bytes -1). */
export function manifestFiles(
  root: string,
): { id: string; file: string; channel: Channel; bytes: number }[] {
  const raw = parse(readFileSync(join(root, "assets", "sounds.yaml"), "utf8")) as {
    sounds?: Record<string, { file: string; channel: Channel }>;
  };
  return Object.entries(raw.sounds ?? {}).map(([id, s]) => {
    let bytes = -1;
    try {
      bytes = statSync(join(root, "assets", s.file)).size;
    } catch {
      // reported as missing
    }
    return { id, file: s.file, channel: s.channel, bytes };
  });
}

/** Budget violations, as readable lines (empty = within budget). */
export function checkBudget(root: string): string[] {
  const files = manifestFiles(root);
  const problems: string[] = [];
  let total = 0;
  for (const f of files) {
    if (f.bytes < 0) {
      problems.push(`${f.id}: assets/${f.file} does not exist (run \`make sounds\`)`);
      continue;
    }
    total += f.bytes;
    const max = BUDGET.fileBytes[f.channel];
    if (f.bytes > max) problems.push(`${f.id}: ${f.bytes} B > ${max} B for a ${f.channel} sound`);
  }
  if (total > BUDGET.totalBytes) problems.push(`total ${total} B > ${BUDGET.totalBytes} B`);
  const size = new Map(files.map((f) => [f.id, Math.max(f.bytes, 0)]));
  for (const [pool, ids] of Object.entries(manifestPools(root))) {
    const bytes = ids.reduce((sum, id) => sum + (size.get(id) ?? 0), 0);
    if (bytes > BUDGET.poolBytes) problems.push(`pool ${pool}: ${bytes} B > ${BUDGET.poolBytes} B`);
  }
  return problems;
}
