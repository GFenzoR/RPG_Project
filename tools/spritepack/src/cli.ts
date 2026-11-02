// spritepack CLI (Node >= 22.18 strips TypeScript types natively).
//   node tools/spritepack/src/cli.ts build   [--root DIR] [--out DIR] [--strict]
//   node tools/spritepack/src/cli.ts check   [--root DIR] [--strict]
//   node tools/spritepack/src/cli.ts preview [--root DIR] [--page N] [--scale N] --out FILE.png
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildAtlas, DEFAULT_OUT_DIR, writeAtlas } from "./build.ts";
import { encodePng, scaleImage } from "./image.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    out: { type: "string" },
    strict: { type: "boolean", default: false },
    page: { type: "string", default: "0" },
    scale: { type: "string", default: "4" },
  },
});
const root = resolve(values.root);
const command = positionals[0];
if (command !== "build" && command !== "check" && command !== "preview") {
  console.error("usage: spritepack build|check|preview [--root DIR] [--out PATH] [--strict]");
  process.exit(2);
}

const result = buildAtlas(root, { strict: values.strict });
for (const d of result.diagnostics) console.log(`${d.severity} ${d.where} ${d.message}`);
const counts: Record<string, number> = {};
for (const s of result.sprites.values()) counts[s.origin] = (counts[s.origin] ?? 0) + 1;
console.log(
  `spritepack: ${result.sprites.size} sprites (` +
    ["file", "vendor", "placeholder", "auto"].map((o) => `${o} ${counts[o] ?? 0}`).join(", ") +
    ")",
);
if (!result.atlas) {
  console.log("spritepack: failed");
  process.exit(1);
}

if (command === "build") {
  const outDir = resolve(root, values.out ?? DEFAULT_OUT_DIR);
  const files = writeAtlas(result.atlas, outDir);
  console.log(
    `spritepack: wrote ${files.map((f) => join(values.out ?? DEFAULT_OUT_DIR, f)).join(", ")}`,
  );
} else if (command === "preview") {
  const page = result.atlas.pages[Number(values.page)];
  const scale = Number(values.scale);
  if (!page || !values.out || !Number.isInteger(scale) || scale < 1) {
    console.error("preview needs --out FILE.png, an existing --page and an integer --scale >= 1");
    process.exit(2);
  }
  writeFileSync(resolve(values.out), encodePng(scaleImage(page.image, scale)));
  console.log(`spritepack: preview of ${page.pngFile} x${scale} -> ${values.out}`);
}
