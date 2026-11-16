// Security rules of .github/workflows/ for a public repository (docs/04 "PR de mapas en CI",
// docs/08 "CI (GitHub Actions)"). Pull requests come from forks: whatever runs with a write
// token must come from the default branch and treat the PR as data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlText } from "@rpg/map-format";
import { describe, expect, it } from "vitest";
import { CHECK_WORKFLOW, NO_VERDICT } from "./prcomment.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(repo, ".github/workflows");

type Obj = Record<string, unknown>;
interface Step {
  uses?: string;
  run?: string;
  with?: Obj;
  env?: Obj;
}
interface Job {
  if?: string;
  permissions?: unknown;
  secrets?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  steps?: Step[];
}
interface Workflow {
  file: string;
  text: string;
  name?: string;
  on: unknown;
  permissions?: unknown;
  concurrency?: unknown;
  jobs: Record<string, Job>;
}

const workflows: Workflow[] = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const text = readFileSync(join(dir, file), "utf8");
    const parsed = parseYamlText(text, file, []);
    if (!parsed) throw new Error(`${file}: invalid YAML`);
    return { ...(parsed.data as Omit<Workflow, "file" | "text">), file, text };
  });
const byFile = (f: string): Workflow => {
  const w = workflows.find((x) => x.file === f);
  if (!w) throw new Error(`no ${f}`);
  return w;
};
const triggers = (w: Workflow): string[] =>
  typeof w.on === "string"
    ? [w.on]
    : Array.isArray(w.on)
      ? w.on.map(String)
      : Object.keys(w.on as Obj);
const steps = (w: Workflow): Step[] => Object.values(w.jobs).flatMap((j) => j.steps ?? []);
const checkouts = (w: Workflow): Step[] =>
  steps(w).filter((s) => s.uses?.startsWith("actions/checkout@") === true);
/** Every `${{ ... }}` expression of the file, comments included (a stricter reading). */
const expressions = (w: Workflow): string[] =>
  [...w.text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] ?? "");
/**
 * Every use of the `secrets` context in an expression, as written: `secrets.NAME`, but
 * also `secrets['NAME']`, `secrets[format(...)]` or a bare `secrets` (`toJSON(secrets)`).
 */
const secretRefs = (w: Workflow): string[] =>
  expressions(w).flatMap((e) => e.match(/\bsecrets\b(?:\.[A-Za-z0-9_-]+|\[[^\]]*\])?/g) ?? []);
/** The `${{ ... }}` expressions of a `run` script, trimmed. */
const runExpressions = (run: string): string[] =>
  [...run.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => (m[1] ?? "").trim());

describe("workflows", () => {
  it("are all here", () => {
    expect(workflows.map((w) => w.file).sort()).toEqual([
      "ci.yml",
      "images.yml",
      "map-pr-comment.yml",
      "map-pr.yml",
      "release-desktop.yml",
    ]);
  });

  it("never use pull_request_target (GitHub blocks it by default in public repos)", () => {
    for (const w of workflows) expect(triggers(w), w.file).not.toContain("pull_request_target");
    expect(existsSync(join(dir, "map-pr-pending.yml"))).toBe(false);
  });

  it("put no expression inside `run` but a matrix or runner value (script injection)", () => {
    // Event data (a PR title, a branch name), but also step and job outputs or env values
    // derived from it, reach a script only through env. A matrix value is written in the
    // workflow itself; runner.os/arch/temp come from the runner.
    for (const w of workflows)
      for (const s of steps(w))
        for (const e of runExpressions(s.run ?? ""))
          expect(e, `${w.file}: ${s.run ?? ""}`).toMatch(
            /^(?:matrix\.[A-Za-z0-9_-]+|runner\.(?:os|arch|temp))$/,
          );
  });

  it("see every expression of a script", () => {
    expect(runExpressions('echo "${{ github.event.pull_request.title }}"')).toEqual([
      "github.event.pull_request.title",
    ]);
    expect(runExpressions("x=${{steps.a.outputs.b}}\ny=${{ needs.c.outputs.d }}")).toEqual([
      "steps.a.outputs.b",
      "needs.c.outputs.d",
    ]);
    expect(runExpressions('echo "$HEAD_REF" ${{ matrix.module }}')).toEqual(["matrix.module"]);
  });

  it("give pull_request jobs no secret but the (read-only for forks) GITHUB_TOKEN", () => {
    for (const w of workflows.filter((x) => triggers(x).includes("pull_request"))) {
      for (const ref of secretRefs(w)) expect(ref, w.file).toBe("secrets.GITHUB_TOKEN");
      // A reusable workflow called with `secrets: inherit` (or a list) would get them all.
      for (const [id, j] of Object.entries(w.jobs))
        expect(j.secrets, `${w.file} ${id}`).toBeUndefined();
    }
  });

  it("see every way of reading a secret", () => {
    const fake = (text: string): Workflow => ({ file: "x.yml", text, on: "push", jobs: {} });
    expect(secretRefs(fake("a: ${{ secrets.GITHUB_TOKEN }}"))).toEqual(["secrets.GITHUB_TOKEN"]);
    expect(secretRefs(fake("a: ${{ secrets['NPM'] }}"))).toEqual(["secrets['NPM']"]);
    expect(secretRefs(fake("a: ${{ toJSON(secrets) }}"))).toEqual(["secrets"]);
    expect(secretRefs(fake("a: ${{ secrets[format('{0}', 'X')] }}"))).toEqual([
      "secrets[format('{0}', 'X')]",
    ]);
    expect(secretRefs(fake("a: ${{\n  secrets.X\n}}"))).toEqual(["secrets.X"]);
    expect(secretRefs(fake("a: ${{ github.event.mysecrets }}"))).toEqual([]);
    expect(secretRefs(fake("# no secrets here, ${{ github.token }}"))).toEqual([]);
  });
});

describe("workflow_run workflows (write token, triggered by fork PRs)", () => {
  const runs = workflows.filter((w) => triggers(w).includes("workflow_run"));
  // The only writes a PR's run may cause: its comment and its commit status.
  const allowed: Obj = {
    actions: "read",
    checks: "read",
    contents: "read",
    "pull-requests": "write",
    statuses: "write",
  };

  it("exist only as map-pr-comment", () => {
    expect(runs.map((w) => w.file)).toEqual(["map-pr-comment.yml"]);
  });

  it("start with no permissions and give each job only what it needs", () => {
    for (const w of runs) {
      expect(w.permissions, w.file).toEqual({});
      for (const [id, j] of Object.entries(w.jobs)) {
        expect(typeof j.permissions, `${w.file} ${id}`).toBe("object");
        for (const [k, v] of Object.entries(j.permissions as Obj))
          expect(allowed[k], `${w.file} ${id}: ${k}: ${String(v)}`).toBe(v);
      }
    }
  });

  it("check out only the default branch's own files, without keeping the token", () => {
    for (const w of runs) {
      expect(checkouts(w).length).toBeGreaterThan(0);
      for (const s of checkouts(w)) {
        const opts = s.with ?? {};
        // No ref or repository: workflow_run checks out the default branch.
        expect(Object.keys(opts).sort(), w.file).toEqual([
          "persist-credentials",
          "sparse-checkout",
          "sparse-checkout-cone-mode",
        ]);
        expect(opts["persist-credentials"]).toBe(false);
        expect(opts["sparse-checkout-cone-mode"]).toBe(false);
        const paths = String(opts["sparse-checkout"]).trim().split("\n");
        for (const p of paths)
          expect(["tools/mapcli/src/prcomment.ts", ".github/MAINTAINERS"]).toContain(p.trim());
      }
    }
  });

  it("install and run nothing but the checked-out script, and use no secrets", () => {
    for (const w of runs) {
      expect(secretRefs(w), w.file).toEqual([]);
      for (const [id, j] of Object.entries(w.jobs))
        expect(j.secrets, `${w.file} ${id}`).toBeUndefined();
      for (const s of steps(w)) {
        if (s.run !== undefined)
          expect(s.run).toMatch(
            /^node --experimental-strip-types tools\/mapcli\/src\/prcomment\.ts( --pending)?$/,
          );
        // Pinned by commit SHA: a tag can be moved to other code, a SHA cannot.
        if (s.uses !== undefined)
          expect(s.uses).toMatch(/^actions\/(checkout|setup-node|download-artifact)@[0-9a-f]{40}$/);
      }
      // Each pin says which release it is (`@<sha> # vX.Y.Z`), for whoever updates it.
      for (const line of w.text.split("\n").filter((l) => /^\s*(- )?uses:/.test(l)))
        expect(line, w.file).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+(;|$)/);
    }
  });

  it("unpack the PR's artifacts outside the checkout, so they cannot replace the script", () => {
    for (const w of runs) {
      const downloads = steps(w).filter((s) => s.uses?.startsWith("actions/download-artifact@"));
      expect(downloads.length, w.file).toBeGreaterThan(0);
      for (const s of downloads) {
        // A path in the workspace (".", "tools", "report") would let a zip from the PR's
        // run overwrite tools/mapcli/src/prcomment.ts before it runs with the write token.
        expect(String(s.with?.path), w.file).toMatch(/^\$\{\{ runner\.temp \}\}\/[a-z-]+$/);
        expect(s.with?.name, w.file).toBe("map-pr-report");
        expect(s.with?.pattern, w.file).toBeUndefined();
        expect(s.with?.["merge-multiple"], w.file).toBeUndefined();
      }
    }
  });
});

describe("map pull request workflows", () => {
  const check = byFile("map-pr.yml");
  const comment = byFile("map-pr-comment.yml");

  it("map-pr runs the base branch's code with a read-only token", () => {
    expect(triggers(check)).toEqual(["pull_request"]);
    expect(check.permissions).toEqual({ contents: "read" });
    for (const j of Object.values(check.jobs)) expect(j.permissions).toBeUndefined();
    const [co] = checkouts(check);
    expect(co?.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.ref }}",
      "persist-credentials": false,
    });
  });

  it("map-pr-comment follows the start and the end of every map-pr run", () => {
    const on = (comment.on as Obj).workflow_run as Obj;
    expect(on.workflows).toEqual([check.name]);
    // prcomment.ts tells map-pr's runs apart from other workflows' by this name.
    expect(check.name).toBe(CHECK_WORKFLOW);
    expect(on.types).toEqual(["requested", "completed"]);
    const { pending, comment: verdict } = comment.jobs;
    expect(pending?.if).toContain("github.event.action == 'requested'");
    expect(verdict?.if).toContain("github.event.action == 'completed'");
    // No verdict for a cancelled run, nor for one waiting for a maintainer's approval.
    for (const c of NO_VERDICT)
      expect(verdict?.if).toContain(`github.event.workflow_run.conclusion != '${c}'`);
    for (const j of [pending, verdict]) {
      expect(j?.if).toContain("github.event.workflow_run.event == 'pull_request'");
      expect(j?.permissions).toMatchObject({ statuses: "write", "pull-requests": "write" });
      // The status is the default branch's: taken from the event's repository (GitHub's),
      // never from the PR (base.ref of a workflow_run is not even in the event).
      expect(j?.steps?.at(-1)?.env?.DEFAULT_BRANCH).toBe(
        "${{ github.event.repository.default_branch }}",
      );
    }
    // The verdict looks for check runs posing as the status.
    expect(verdict?.permissions).toMatchObject({ checks: "read" });
    expect(pending?.steps?.at(-1)?.run).toContain("prcomment.ts --pending");
    expect(verdict?.steps?.at(-1)?.run).not.toContain("--pending");
  });

  it("map-pr-comment handles one event at a time per PR branch, skipped runs aside", () => {
    // Job level, so a run whose job is skipped (a cancelled map-pr) never takes the place
    // of a waiting one; the same group, so "pending" never lands after the verdict.
    expect(comment.concurrency).toBeUndefined();
    const { pending, comment: verdict } = comment.jobs;
    expect(pending?.concurrency).toEqual(verdict?.concurrency);
    expect(pending?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(pending?.concurrency?.group).toContain("github.event.workflow_run.head_branch");
  });
});
