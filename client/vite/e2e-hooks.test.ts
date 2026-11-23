// Lote 16: the read-only E2E hooks (window.__rpgClient, window.__rpgAudio) are a helper for
// scripts, so a production build must not ship them. This builds the game page the way
// `pnpm build` does (without RPG_E2E_HOOKS) and looks for them in every emitted chunk; the
// dev server and an RPG_E2E_HOOKS=1 build keep them (vite.config.ts).
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const dir = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

async function bundledCode(hooks: boolean): Promise<string> {
  const before = process.env["RPG_E2E_HOOKS"];
  if (hooks) process.env["RPG_E2E_HOOKS"] = "1";
  else delete process.env["RPG_E2E_HOOKS"];
  try {
    const out = await build({
      configFile: dir("../vite.config.ts"),
      root: dir(".."),
      mode: "production",
      logLevel: "silent",
      build: { write: false, rollupOptions: { input: { play: dir("../play/index.html") } } },
    });
    const outputs = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
    return outputs
      .flatMap((o) => o.output)
      .map((c) => (c.type === "chunk" ? c.code : ""))
      .join("\n");
  } finally {
    if (before === undefined) delete process.env["RPG_E2E_HOOKS"];
    else process.env["RPG_E2E_HOOKS"] = before;
  }
}

describe("E2E hooks in the production build", () => {
  it("are left out without RPG_E2E_HOOKS and kept with it", { timeout: 180_000 }, async () => {
    const prod = await bundledCode(false);
    expect(prod.length).toBeGreaterThan(10_000);
    expect(prod).not.toContain("__rpgClient");
    expect(prod).not.toContain("__rpgAudio");
    const e2e = await bundledCode(true);
    expect(e2e).toContain("__rpgClient");
    expect(e2e).toContain("__rpgAudio");
  });
});
