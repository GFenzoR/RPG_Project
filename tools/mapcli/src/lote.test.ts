// The batch workflow (.claude/workflows/lote.js, docs/11 "Lotes") run against a fake
// agent: the prompts it hands out must name the repo as it is on disk. A Windows path
// written inside a template literal loses its backslashes ("\P" is "P"), and the
// verify step once told its agent to look for `make play` under C:ProyectosVSCodeRPG_Project.
// Its own tests live here, beside the CI workflows' (workflows.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = "C:\\ProyectosVSCode\\RPG_Project";

interface Call {
  prompt: string;
  label: string;
}

type Script = (args: unknown, agent: unknown, phase: unknown, log: unknown) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...params: string[]
) => Script;

/** Runs lote.js as the workflow runtime does (top-level await and return), with every
 *  agent answering as if its stage went well. Returns each agent's prompt. */
async function runLote(): Promise<Call[]> {
  const text = readFileSync(join(repo, ".claude/workflows/lote.js"), "utf8").replace(
    /^export const meta/m,
    "const meta",
  );
  const script = new AsyncFunction("args", "agent", "phase", "log", text);
  const calls: Call[] = [];
  const agent = async (prompt: string, opts: { label: string }): Promise<unknown> => {
    calls.push({ prompt, label: opts.label });
    if (opts.label.startsWith("impl:"))
      return { ok: true, touches_server: true, summary: "s", e2e_notes: "n" };
    if (opts.label === "final-review" || opts.label.startsWith("review:"))
      return "Nada bloqueante ni importante.";
    return { ok: true, summary: "done" };
  };
  const args = {
    base: "fix/lote6",
    name: "lote7",
    items: [{ slug: "tools", branch: "feat/tools", wt: "tl", risk: "server", brief: "A brief." }],
  };
  await script(
    args,
    agent,
    () => undefined,
    () => undefined,
  );
  return calls;
}

describe("the lote workflow", () => {
  it("names the repo with its backslashes in every prompt", async () => {
    const calls = await runLote();
    expect(calls.map((c) => c.label)).toEqual([
      "impl:tools",
      "review:tools",
      "fix:tools",
      "stack:tools",
      "final-review",
      "verify",
    ]);
    for (const call of calls) {
      expect(call.prompt, call.label).not.toMatch(/C:Proyectos|ProyectosVSCodeRPG/);
      expect(call.prompt, call.label).toContain(REPO);
    }
  });

  it("tells the verify step whose make play it may stop, and what to do after 8 h", async () => {
    const verify = (await runLote()).find((c) => c.label === "verify");
    expect(verify).toBeDefined();
    const prompt = verify?.prompt ?? "";
    expect(prompt).toContain(`started from ${REPO})`);
    expect(prompt).toContain(`under ${REPO}\\.wt\\vf`);
    expect(prompt).toContain("ExecutablePath,CommandLine");
    expect(prompt).toMatch(/still there after 8 h, stop: no Docker/);
  });
});
