// Security rules of .github/workflows/ for a public repository (docs/04 "PR de mapas en CI",
// docs/08 "CI (GitHub Actions)"). Pull requests come from forks: whatever runs with a write
// token must come from the default branch and treat the PR as data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlText } from "@rpg/map-format";
import { describe, expect, it } from "vitest";

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

  it("pass event data to scripts through env, never inside `run` (script injection)", () => {
    for (const w of workflows)
      for (const s of steps(w))
        expect(s.run ?? "", w.file).not.toMatch(/\$\{\{[^}]*github\.(event|head_ref)/);
  });

  it("give pull_request jobs no secret but the (read-only for forks) GITHUB_TOKEN", () => {
    for (const w of workflows.filter((x) => triggers(x).includes("pull_request")))
      for (const m of w.text.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
        expect(m[1], w.file).toBe("GITHUB_TOKEN");
  });
});

describe("workflow_run workflows (write token, triggered by fork PRs)", () => {
  const runs = workflows.filter((w) => triggers(w).includes("workflow_run"));
  // The only writes a PR's run may cause: its comment and its commit status.
  const allowed: Obj = {
    actions: "read",
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
      expect(w.text).not.toMatch(/secrets\./);
      for (const s of steps(w)) {
        if (s.run !== undefined)
          expect(s.run).toMatch(
            /^node --experimental-strip-types tools\/mapcli\/src\/prcomment\.ts( --pending)?$/,
          );
        if (s.uses !== undefined)
          expect(s.uses).toMatch(
            /^actions\/(checkout|setup-node|download-artifact)@v\d+\.\d+\.\d+$/,
          );
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
    expect(on.types).toEqual(["requested", "completed"]);
    const { pending, comment: verdict } = comment.jobs;
    expect(pending?.if).toContain("github.event.action == 'requested'");
    expect(verdict?.if).toContain("github.event.action == 'completed'");
    for (const j of [pending, verdict]) {
      expect(j?.if).toContain("github.event.workflow_run.event == 'pull_request'");
      expect(j?.permissions).toMatchObject({ statuses: "write", "pull-requests": "write" });
    }
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
