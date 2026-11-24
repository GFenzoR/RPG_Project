// Runs every workspace package's tests in one Vitest process. Separate parallel
// `vitest run` processes share node_modules/.vitest-cache and can race on it.
import { globSync } from "node:fs";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

// Same packages as pnpm-workspace.yaml (livingworld/client too); Go modules such as tools/bots have no package.json.
const projects = globSync("{client,editor,packages/*,tools/*,livingworld/client}/package.json")
  .map(dirname)
  .sort();

export default defineConfig({
  test: { projects },
});
