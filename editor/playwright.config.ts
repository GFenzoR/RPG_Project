// E2E for the map editor: starts the editor dev server on a scratch copy of the repo's
// world/, data/, i18n/ and assets/ (so saving never touches the real map) and drives it.
// Screenshots go to e2e/screenshots/actual/ (git-ignored); review them after a run.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repo = resolve(import.meta.dirname, "..");
// Workers inherit the runner's environment, so the copy is made once per run.
if (!process.env["EDITOR_E2E_ROOT"]) {
  const root = mkdtempSync(join(tmpdir(), "rpg-editor-e2e-"));
  for (const dir of ["world", "data", "i18n", "assets"])
    cpSync(join(repo, dir), join(root, dir), {
      recursive: true,
      filter: (src) => !src.includes("/assets/atlas"),
    });
  process.env["EDITOR_E2E_ROOT"] = root;
}
const port = Number(process.env["EDITOR_E2E_PORT"] ?? 5175);

export default defineConfig({
  testDir: "e2e",
  outputDir: "../test-results/editor",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1400, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    cwd: import.meta.dirname,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { EDITOR_ROOT: process.env["EDITOR_E2E_ROOT"] ?? "" },
  },
});
