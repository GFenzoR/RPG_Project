// The living world's boundary (livingworld/README.md, "Frontera"), checked by make lint:
//   1. nothing under livingworld/ imports from server/ or client/ (Go or TypeScript);
//   2. nothing outside livingworld/ imports it, except the files of the glue list in
//      livingworld/README.md (between <!-- glue:begin --> and <!-- glue:end -->).
// Usage: node --experimental-strip-types livingworld/client/scripts/boundary.ts [--root DIR]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Go module path of the repository (server/go.mod). */
export const GO_REPO = "github.com/GFenzoR/RPG_Project";

const SOURCE = /\.(ts|tsx|mts|js|mjs|go)$/;

/** The import specifiers of a source file (TS/JS: import/export from, import(); Go: import). */
export function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  if (file.endsWith(".go")) {
    // Single imports and import blocks: every quoted path inside them.
    for (const m of text.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1] ?? "");
    for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm))
      for (const m of (block[1] ?? "").matchAll(/"([^"]+)"/g)) out.push(m[1] ?? "");
    return out;
  }
  for (const m of text.matchAll(/(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']/g))
    out.push(m[1] ?? "");
  for (const m of text.matchAll(/(?:^|[^\w.])import\s*["']([^"']+)["']/g)) out.push(m[1] ?? "");
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1] ?? "");
  return out;
}

/** Where an import points: "livingworld", "server", "client" or "other". */
export function targetOf(
  file: string,
  spec: string,
): "livingworld" | "server" | "client" | "other" {
  if (file.endsWith(".go")) {
    if (spec.startsWith(`${GO_REPO}/livingworld/`) || spec === `${GO_REPO}/livingworld`)
      return "livingworld";
    if (spec.startsWith(`${GO_REPO}/server`)) return "server";
    return "other";
  }
  if (spec === "@rpg/living-world" || spec.startsWith("@rpg/living-world/")) return "livingworld";
  if (spec === "@rpg/client" || spec.startsWith("@rpg/client/")) return "client";
  if (spec.startsWith(".")) {
    const to = posix.normalize(posix.join(posix.dirname(file), spec));
    const top = to.split("/")[0];
    if (top === "livingworld" || top === "server" || top === "client") return top;
  }
  return "other";
}

/** The glue list of livingworld/README.md: repo paths in backticks between the markers. */
export function glueList(readme: string): Set<string> {
  const m = /<!-- glue:begin -->([\s\S]*?)<!-- glue:end -->/.exec(readme);
  const out = new Set<string>();
  if (!m) return out;
  for (const line of (m[1] ?? "").split("\n")) {
    const p = /^\s*-\s*`([^`]+)`/.exec(line);
    if (p?.[1]) out.add(p[1]);
  }
  return out;
}

/** Problems of the boundary over repo files (path relative to the root, with "/"). */
export function boundaryProblems(
  files: readonly { path: string; text: string }[],
  glue: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const { path, text } of files) {
    if (!SOURCE.test(path)) continue;
    const inside = path.startsWith("livingworld/");
    for (const spec of importsOf(path, text)) {
      const to = targetOf(path, spec);
      if (inside && (to === "server" || to === "client"))
        problems.push(`${path}: imports ${spec}: livingworld/ never imports from ${to}/`);
      if (!inside && to === "livingworld" && !glue.has(path))
        problems.push(
          `${path}: imports ${spec} but is not in the glue list of livingworld/README.md`,
        );
    }
  }
  return problems;
}

function main(): void {
  const args = process.argv.slice(2);
  const at = args.indexOf("--root");
  const root = resolve(
    at >= 0 ? (args[at + 1] ?? ".") : join(dirname(fileURLToPath(import.meta.url)), "../../.."),
  );
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((p) => SOURCE.test(p) && !p.includes("node_modules/") && !p.startsWith(".wt/"));
  const files = listed.flatMap((path) => {
    try {
      return [{ path, text: readFileSync(join(root, path), "utf8") }];
    } catch {
      return []; // deleted in the work tree
    }
  });
  const glue = glueList(readFileSync(join(root, "livingworld", "README.md"), "utf8"));
  for (const g of glue)
    if (!listed.includes(g)) console.warn(`livingworld boundary: glue file ${g} does not exist`);
  const problems = boundaryProblems(files, glue);
  for (const p of problems) console.error(`livingworld boundary: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`livingworld boundary: ok (${files.length} files, ${glue.size} glue files)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
