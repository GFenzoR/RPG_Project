// Security rules of .github/workflows/ for a public repository (docs/04 "PR de mapas en CI",
// docs/08 "CI (GitHub Actions)"). Pull requests come from forks: whatever runs with a write
// token must come from the default branch and treat the PR as data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYamlText } from "@rpg/map-format";
import { describe, expect, it } from "vitest";
import { CHECK_WORKFLOW, CHECK_WORKFLOW_FILE, NO_VERDICT } from "./prcomment.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dir = join(repo, ".github/workflows");
/** Composite actions of the repo (none yet): their steps run like a workflow's. */
const actionsDir = join(repo, ".github/actions");

type Obj = Record<string, unknown>;
interface Step {
  uses?: string;
  run?: string;
  with?: Obj;
  env?: Obj;
}
/** A composite action (`.github/actions/<name>/action.yml`). */
interface Action {
  file: string;
  runs?: { using?: string; steps?: Step[] };
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
const actions: Action[] = existsSync(actionsDir)
  ? readdirSync(actionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        ["action.yml", "action.yaml"]
          .map((f) => join(actionsDir, d.name, f))
          .filter((f) => existsSync(f)),
      )
      .map((file) => {
        const parsed = parseYamlText(readFileSync(file, "utf8"), file, []);
        if (!parsed) throw new Error(`${file}: invalid YAML`);
        return { ...(parsed.data as Omit<Action, "file">), file };
      })
  : [];
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
/**
 * The scripts of a step: its `run`, or the `script` of actions/github-script (JavaScript
 * that GitHub fills in with the expressions before it runs, like a `run`).
 */
const scripts = (s: Step): string[] => [
  ...(s.run === undefined ? [] : [s.run]),
  ...(s.uses?.startsWith("actions/github-script@") === true && s.with?.script !== undefined
    ? [String(s.with.script)]
    : []),
];
/** Expressions a script may hold: a matrix value (the workflow's own) or a runner value. */
const SAFE_IN_SCRIPT = /^(?:matrix\.[A-Za-z0-9_-]+|runner\.(?:os|arch|temp))$/;

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

  it("put no expression inside a script but a matrix or runner value (script injection)", () => {
    // Event data (a PR title, a branch name), but also step and job outputs or env values
    // derived from it, reach a script only through env. A matrix value is written in the
    // workflow itself; runner.os/arch/temp come from the runner. A script is a `run` or
    // the `script` of actions/github-script, in a workflow or in a composite action of
    // .github/actions/ (whose `inputs` come from whoever calls it).
    const all = [
      ...workflows.flatMap((w) => steps(w).map((s) => ({ file: w.file, s }))),
      ...actions.flatMap((a) => (a.runs?.steps ?? []).map((s) => ({ file: a.file, s }))),
    ];
    for (const { file, s } of all)
      for (const script of scripts(s))
        for (const e of runExpressions(script))
          expect(e, `${file}: ${script}`).toMatch(SAFE_IN_SCRIPT);
  });

  it("read the script of actions/github-script and of composite actions too", () => {
    const gs = {
      uses: "actions/github-script@v7",
      with: { script: "core.info('${{ github.head_ref }}')" },
    };
    expect(scripts(gs).flatMap(runExpressions)).toEqual(["github.head_ref"]);
    expect(scripts({ uses: "actions/checkout@v4", with: { script: "${{ x }}" } })).toEqual([]);
    expect(scripts({ run: "echo ${{ matrix.os }}" }).flatMap(runExpressions)).toEqual([
      "matrix.os",
    ]);
    // Every action found there is a composite one (its steps are the ones checked above).
    for (const a of actions) expect(a.runs?.using, a.file).toBe("composite");
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

/**
 * The commit of each pinned release, checked by hand against GitHub when a pin changes:
 * `git ls-remote https://github.com/<action> refs/tags/<tag> 'refs/tags/<tag>^{}'` (an
 * annotated tag lists its commit as `<tag>^{}`; that is the SHA to pin). A pin whose
 * comment names another release than its SHA fails here.
 */
const PINS: Record<string, string> = {
  "actions/checkout@v4.2.2": "11bd71901bbe5b1630ceea73d27597364c9af683",
  "actions/setup-node@v4.4.0": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/download-artifact@v4.3.0": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
};

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
      // Each pin says which release it is (`@<sha> # vX.Y.Z`), for whoever updates it, and
      // the SHA is that release's commit (PINS).
      for (const line of w.text.split("\n").filter((l) => /^\s*(- )?uses:/.test(l))) {
        const pin = /uses: ([\w-]+\/[\w-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)(;|$)/.exec(line);
        expect(pin, `${w.file}: ${line}`).not.toBeNull();
        const [, action = "", sha = "", tag = ""] = pin ?? [];
        expect(PINS[`${action}@${tag}`], `${w.file}: ${line} (not in PINS)`).toBe(sha);
      }
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
  const check = byFile(CHECK_WORKFLOW_FILE);
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

  it("map-pr-comment runs one job at a time per PR branch, in a group both jobs share", () => {
    // The same group, so a slow "pending" does not land after the verdict of its run. It
    // is weaker than it looks (map-pr-comment.yml): GitHub keeps one job running and one
    // waiting per group, and a newer job cancels the waiting one even with
    // cancel-in-progress false, so two PRs from one branch can lose a verdict. At job
    // level so that a job skipped by its `if` should not take a place in the group (not
    // verified on GitHub).
    expect(comment.concurrency).toBeUndefined();
    const { pending, comment: verdict } = comment.jobs;
    expect(pending?.concurrency).toEqual(verdict?.concurrency);
    expect(pending?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(pending?.concurrency?.group).toContain("github.event.workflow_run.head_branch");
  });
});
