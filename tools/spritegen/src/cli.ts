// spritegen CLI (Node >= 22.18 strips TypeScript types natively).
//   node tools/spritegen/src/cli.ts build [--root DIR] [--only PREFIX]       write assets/sprites/*.png
//   node tools/spritegen/src/cli.ts preview --out FILE.png [--scale N] [--only PREFIX]
//   node tools/spritegen/src/cli.ts check [--root DIR]     every recipe path is used by data/
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSprites, checkPaths, previewPng, recipePaths } from "./index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    only: { type: "string" },
    out: { type: "string" },
    scale: { type: "string", default: "4" },
  },
});
const root = resolve(values.root);
const command = positionals[0];
if (command !== "build" && command !== "preview" && command !== "check") {
  console.error(
    "usage: spritegen build|preview|check [--root DIR] [--only PREFIX] [--out FILE.png]",
  );
  process.exit(2);
}

if (command === "build") {
  const built = buildSprites(root, values.only);
  for (const b of built)
    console.log(`${String(b.bytes).padStart(6)} B  assets/sprites/${b.path}.png`);
  console.log(`spritegen: ${built.length} sprites`);
} else if (command === "preview") {
  const scale = Number(values.scale);
  const paths = recipePaths(values.only);
  if (!values.out || !Number.isInteger(scale) || scale < 1 || paths.length === 0) {
    console.error("preview needs --out FILE.png, an integer --scale >= 1 and matching recipes");
    process.exit(2);
  }
  writeFileSync(resolve(values.out), previewPng(root, paths, scale));
  console.log(`spritegen: preview of ${paths.length} sprites x${scale} -> ${values.out}`);
}
const problems = checkPaths(root);
for (const p of problems) console.log(`error ${p}`);
if (problems.length > 0) process.exit(1);
if (command === "check") console.log(`spritegen: ${recipePaths().length} recipes, all used`);
