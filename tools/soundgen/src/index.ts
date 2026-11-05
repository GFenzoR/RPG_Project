// soundgen: renders the project's own sounds (sfx.ts, music.ts) and encodes them to
// Ogg Opus under assets/sounds/ with ffmpeg (libopus). The .ogg files are committed, so
// building or running the game never needs ffmpeg; only `make sounds` does.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { AMBIENT_PATHS, MUSIC_PATHS, renderAmbient, renderMusic } from "./music.ts";
import { renderSfx, SFX } from "./sfx.ts";
import { encodeWav } from "./synth.ts";

export type Kind = "sfx" | "music" | "ambient";

export interface Generated {
  /** Path under assets/sounds without extension ("sfx/hit"). */
  path: string;
  kind: Kind;
}

/** Everything soundgen makes, in a stable order. */
export const GENERATED: Generated[] = [
  ...Object.keys(SFX).map((path) => ({ path, kind: "sfx" as const })),
  ...MUSIC_PATHS.map((path) => ({ path, kind: "music" as const })),
  ...AMBIENT_PATHS.map((path) => ({ path, kind: "ambient" as const })),
];

/** Opus bitrate per kind (mono, 48 kHz). */
export const BITRATE: Record<Kind, string> = { sfx: "32k", music: "24k", ambient: "16k" };

export function render(g: Generated): Float32Array {
  if (g.kind === "music") return renderMusic(g.path);
  if (g.kind === "ambient") return renderAmbient(g.path);
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
    const file = join(root, "assets", "sounds", `${g.path}.ogg`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, ogg);
    out.push({ path: g.path, bytes: ogg.length });
  }
  return out;
}

// ---- size budget (docs/07-performance-budget.md, "Audio") ---------------------------

export const BUDGET = {
  /** All files referenced by assets/sounds.yaml together. */
  totalBytes: 1536 * 1024,
  /** One file, by its channel in sounds.yaml. */
  fileBytes: { sfx: 32 * 1024, ui: 16 * 1024, music: 256 * 1024, ambient: 96 * 1024 },
} as const;

export type Channel = keyof typeof BUDGET.fileBytes;

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
  return problems;
}
