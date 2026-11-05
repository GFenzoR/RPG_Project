// soundgen CLI (Node >= 22.18 strips TypeScript types natively).
//   node tools/soundgen/src/cli.ts build [--root DIR] [--only sfx/hit]   render + encode (needs ffmpeg)
//   node tools/soundgen/src/cli.ts check [--root DIR]                    size budget of sounds.yaml
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSounds, checkBudget, manifestFiles } from "./index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string", default: "." }, only: { type: "string" } },
});
const root = resolve(values.root);
const command = positionals[0];
if (command !== "build" && command !== "check") {
  console.error("usage: soundgen build|check [--root DIR] [--only PATH]");
  process.exit(2);
}

if (command === "build") {
  const built = buildSounds(root, values.only);
  for (const b of built)
    console.log(`${String(b.bytes).padStart(7)} B  assets/sounds/${b.path}.ogg`);
  console.log(`soundgen: ${built.length} sounds`);
}
const total = manifestFiles(root).reduce((s, f) => s + Math.max(f.bytes, 0), 0);
const problems = checkBudget(root);
for (const p of problems) console.log(`error ${p}`);
console.log(`soundgen: sounds.yaml total ${(total / 1024).toFixed(1)} KiB`);
if (problems.length > 0) process.exit(1);
