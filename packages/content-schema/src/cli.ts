// Content tooling CLI (run with Node >= 22.18, which strips TypeScript types natively).
//   node packages/content-schema/src/cli.ts validate [--root DIR] [--base-ref REF]
//   node packages/content-schema/src/cli.ts gen-ids [--root DIR]
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateIdsLock } from "./ids.ts";
import { formatDiagnostic } from "./source.ts";
import { validateContent } from "./validate.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    "base-ref": { type: "string", default: process.env["CONTENT_BASE_REF"] ?? "origin/main" },
  },
});
const root = resolve(values.root);

/** ids.lock.yaml at the base revision, or undefined when git or the ref is not available. */
function baseLock(ref: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:data/ids.lock.yaml`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

switch (positionals[0]) {
  case "validate": {
    const ref = values["base-ref"];
    const base = baseLock(ref);
    if (base === undefined)
      console.log(`note: no data/ids.lock.yaml at ${ref}; skipping the append-only check`);
    const report = validateContent(root, base === undefined ? {} : { baseIdsLock: base });
    for (const d of report.diagnostics) console.log(formatDiagnostic(d));
    console.log(`content: ${report.errors} error(s), ${report.warnings} warning(s)`);
    process.exitCode = report.errors > 0 ? 1 : 0;
    break;
  }
  case "gen-ids": {
    const { added } = generateIdsLock(root);
    console.log(
      added.length === 0 ? "ids.lock.yaml: up to date" : `ids.lock.yaml: added ${added.join(", ")}`,
    );
    break;
  }
  default:
    console.error("usage: cli.ts validate [--root DIR] [--base-ref REF] | gen-ids [--root DIR]");
    process.exitCode = 2;
}
