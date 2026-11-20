// spritegen CLI (Node >= 22.18 strips TypeScript types natively).
//   node tools/spritegen/src/cli.ts build [--root DIR] [--only PREFIX]       write assets/sprites/*.png
//   node tools/spritegen/src/cli.ts preview --out FILE.png [--scale N] [--only PREFIX]
//   node tools/spritegen/src/cli.ts check [--root DIR]     every recipe path is used by data/,
//        and every engine spec is valid, passes the gates and matches its sprites.yaml hints
//   node tools/spritegen/src/cli.ts sheet [--only PREFIX] [--out DIR] [--scale N]
//        contact sheet (every frame at N x, default 4) and 1x lineup of each engine sprite;
//        with item icons among them, also icons.slots.png (each in an inventory slot at 2x
//        and 1x and on grass, a row per line of the catalog) and icons.detail.png (at 4x);
//        with town props among them, also town.floors.png (each on every floor of the towns,
//        beside a person, at 1x shown 2x); with the engine humanoid's layers among
//        them (humans/, worn/), humanoid.<look>.sheet.png (every frame of a composed look)
//        and humanoid.lineup.png (the looks at 1x and 2x on the tile grid beside the boar,
//        the stag and, with --ref FILE.png, a reference person such as the old LPC one)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { decodePng, encodePng, parseYaml, scaleImage } from "@rpg/spritepack";
import { engineProblems } from "./engine/check.ts";
import { contactSheet, floorBoard, iconBoard, reviewLineup } from "./engine/sheet.ts";
import { ENGINE_SPECS } from "./engine/specs/index.ts";
import { BOAR } from "./engine/specs/boar.ts";
import { HUMANOID_LAYERS } from "./engine/specs/humanoid/index.ts";
import { lookTables } from "./engine/specs/humanoid/previews.ts";
import { humanoidLineup, lookSheet, REVIEW_LOOKS } from "./engine/specs/humanoid/review.ts";
import { STAG } from "./engine/specs/stag.ts";
import { ICON_ROWS } from "./engine/specs/items/index.ts";
import { TOWN_FLOORS, TOWN_PROPS } from "./engine/specs/town.ts";
import { buildSprites, checkPaths, previewPng, recipePaths } from "./index.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    only: { type: "string" },
    out: { type: "string" },
    scale: { type: "string", default: "4" },
    ref: { type: "string" },
  },
});
const root = resolve(values.root);
const command = positionals[0];
if (command !== "build" && command !== "preview" && command !== "check" && command !== "sheet") {
  console.error(
    "usage: spritegen build|preview|check|sheet [--root DIR] [--only PREFIX] [--out FILE.png|DIR]",
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
} else if (command === "sheet") {
  const scale = Number(values.scale);
  const out = resolve(values.out ?? join(root, "build", "spritegen"));
  const specs = ENGINE_SPECS.filter((s) => !values.only || s.sprite.startsWith(values.only));
  if (!Number.isInteger(scale) || scale < 1 || specs.length === 0) {
    console.error("sheet needs an integer --scale >= 1 and engine sprites under --only");
    process.exit(2);
  }
  const layers = new Set(HUMANOID_LAYERS.map((l) => l.sprite));
  for (const spec of specs) {
    // The paper doll's layers are judged composed (below), not one by one.
    if (layers.has(spec.sprite)) continue;
    const base = join(out, spec.sprite);
    mkdirSync(dirname(base), { recursive: true });
    writeFileSync(`${base}.sheet.png`, encodePng(contactSheet(spec, scale)));
    writeFileSync(`${base}.lineup.png`, encodePng(scaleImage(reviewLineup(root, spec), 3)));
    console.log(`spritegen: ${base}.sheet.png and .lineup.png`);
  }
  // Item icons: the board of every selected one, by line and band.
  const chosen = new Set(specs.map((s) => s.sprite));
  const rows = ICON_ROWS.map((r) => ({
    ...r,
    specs: r.specs.map((s) => (s && chosen.has(s.sprite) ? s : undefined)),
  })).filter((r) => r.specs.some((s) => s));
  if (rows.length > 0) {
    writeFileSync(join(out, "icons.slots.png"), encodePng(iconBoard(root, rows)));
    writeFileSync(join(out, "icons.detail.png"), encodePng(iconBoard(root, rows, true)));
    console.log(`spritegen: ${join(out, "icons.slots.png")} and icons.detail.png`);
  }
  // The engine humanoid: composed looks, their sheets and the lineup.
  if (specs.some((s) => layers.has(s.sprite))) {
    const tables = lookTables(parseYaml(readFileSync(join(root, "data/looks.yaml"), "utf8")));
    mkdirSync(out, { recursive: true });
    for (const look of REVIEW_LOOKS) {
      const file = join(out, `humanoid.${look.name}.sheet.png`);
      writeFileSync(file, encodePng(lookSheet(look, tables, scale)));
      console.log(`spritegen: ${file}`);
    }
    const ref = values.ref ? decodePng(readFileSync(resolve(values.ref))) : undefined;
    const file = join(out, "humanoid.lineup.png");
    writeFileSync(file, encodePng(humanoidLineup(root, REVIEW_LOOKS, tables, [BOAR, STAG], ref)));
    console.log(`spritegen: ${file}`);
  }
  // Town props: every selected one on each floor of the towns, beside a person.
  const town = TOWN_PROPS.filter((s) => chosen.has(s.sprite));
  if (town.length > 0) {
    const file = join(out, "town.floors.png");
    writeFileSync(file, encodePng(scaleImage(floorBoard(root, town, TOWN_FLOORS), 2)));
    console.log(`spritegen: ${file}`);
  }
}
const problems = [...checkPaths(root), ...engineProblems(root)];
for (const p of problems) console.log(`error ${p}`);
if (problems.length > 0) process.exit(1);
if (command === "check")
  console.log(
    `spritegen: ${recipePaths().length} recipes, all used; ${ENGINE_SPECS.length} engine specs pass their gates`,
  );
