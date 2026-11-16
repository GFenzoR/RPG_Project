// The map-pr-comment workflow's two jobs (prcomment.ts --pending and the verdict) against an
// in-memory GitHub: which comment and which commit status each one writes, and when it
// writes nothing. The report checks and the Markdown are tested in prcheck.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Env,
  type Gh,
  MARKER,
  STATUS_CONTEXT,
  checkReport,
  commitStatus,
  markPending,
  pendingComment,
  pickPull,
  postVerdict,
  readEnv,
  stampRun,
  trustedFacts,
} from "./prcomment.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const CHUNK = "world/islands/puerto/chunks/z07/c0100_0196.json";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "prcomment-"));
  dirs.push(d);
  return d;
};

/** A report of map-pr for PR 5 at commit B: one chunk changed, nothing wrong. */
const report = (patch: Record<string, unknown> = {}) => ({
  format: 2,
  pr: 5,
  author: "someone",
  maintainer: false,
  base: A,
  head: B,
  ok: true,
  failures: [],
  map_changes: true,
  files: [{ path: CHUNK, status: "modified", base_matches: true, tiles_changed: 2 }],
  conflicts: [],
  invalid_files: [],
  noncanonical_files: [],
  bad_mode_files: [],
  merge_mismatch: [],
  plots: { count: 1, violations: [], violations_total: 0 },
  validation: { errors: 0, new_errors: [], new_errors_total: 0 },
  other_files: [],
  other_files_total: 0,
  areas: [],
  omitted_areas: 0,
  ...patch,
});

interface Pull {
  number: number;
  state: string;
  author_association: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  changed_files: number;
  /** Not in the open PRs listing (past its first 1000): found only by number. */
  unlisted?: boolean;
}

interface Fake {
  pulls: Pull[];
  files: Record<number, { filename: string; previous_filename?: string }[]>;
  comments: Record<number, { id: number; body: string; user: { login: string } }[]>;
  runs: Record<string, string>;
  /** Check runs of the head commit named map-pr/verdict (null: an answer without a count). */
  impostors?: number | null;
  /** Fails the first call whose "METHOD path" starts with this. */
  failOn?: string;
}

/** An in-memory GitHub with the endpoints prcomment.ts uses; records every write. */
function fakeGitHub(f: Fake) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const gh: Gh = async (method, path, body) => {
    if (f.failOn && `${method} ${path}`.startsWith(f.failOn)) throw new Error("HTTP 502");
    let m: RegExpMatchArray | null;
    if (method !== "GET") {
      writes.push({ method, path, body: body as Record<string, unknown> });
      return {};
    }
    if ((m = path.match(/^\/repos\/o\/r\/pulls\/(\d+)\/files\?per_page=100&page=(\d+)$/)))
      return (f.files[Number(m[1])] ?? []).slice((Number(m[2]) - 1) * 100, Number(m[2]) * 100);
    if ((m = path.match(/^\/repos\/o\/r\/pulls\/(\d+)$/))) {
      const p = f.pulls.find((x) => x.number === Number(m?.[1]));
      if (!p) throw new Error("HTTP 404");
      return p;
    }
    if (/^\/repos\/o\/r\/pulls\?state=open&per_page=100&page=1$/.test(path))
      return f.pulls.filter((p) => p.unlisted !== true);
    if ((m = path.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments\?per_page=100&page=1$/)))
      return f.comments[Number(m[1])] ?? [];
    if ((m = path.match(/^\/repos\/o\/r\/actions\/runs\/(\d+)$/)))
      return { status: f.runs[m[1] ?? ""] ?? "in_progress" };
    if (/^\/repos\/o\/r\/actions\/runs\/\d+\/artifacts$/.test(path)) return { artifacts: [] };
    if (
      path ===
      `/repos/o/r/commits/${B}/check-runs?check_name=map-pr%2Fverdict&filter=all&per_page=1`
    )
      return f.impostors === null ? {} : { total_count: f.impostors ?? 0 };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { gh, writes };
}

const pull = (patch: Partial<Pull> = {}): Pull => ({
  number: 5,
  state: "open",
  author_association: "CONTRIBUTOR",
  user: { login: "someone" },
  head: { sha: B, repo: { full_name: "someone/r" } },
  base: { ref: "main" },
  changed_files: 1,
  ...patch,
});

/** The workflow's environment for a map-pr run of commit B from the fork someone/r. */
function env(patch: Record<string, string> = {}): Env {
  const dir = tmp();
  return readEnv({
    GITHUB_TOKEN: "t",
    GITHUB_REPOSITORY: "o/r",
    RUN_ID: "42",
    HEAD_SHA: B,
    HEAD_REPO: "someone/r",
    PR_HINT: "", // forks: workflow_run lists no pull request
    DEFAULT_BRANCH: "main",
    CONCLUSION: "success",
    REPORT: join(dir, "report.json"),
    MAINTAINERS: join(dir, "MAINTAINERS"),
    ...patch,
  });
}

const withReport = (e: Env, r: unknown): Env => {
  writeFileSync(e.report, JSON.stringify(r));
  return e;
};

const bot = (id: number, body: string) => ({ id, body, user: { login: "github-actions[bot]" } });
const statusOf = (writes: ReturnType<typeof fakeGitHub>["writes"]) =>
  writes.filter((w) => w.path.startsWith("/repos/o/r/statuses/"));

describe("map-pr started (--pending)", () => {
  it("sets a pending status on the run's commit and marks the comment pending", async () => {
    const f = fakeGitHub({
      pulls: [pull()],
      files: {},
      comments: {
        5: [bot(1, "hi"), { ...bot(2, MARKER), user: { login: "u" } }, bot(3, `${MARKER}\n✅ old`)],
      },
      runs: {},
    });
    const out = await markPending(env(), f.gh);
    expect(out).toContain("marked pending");
    expect(f.writes).toEqual([
      {
        method: "POST",
        path: `/repos/o/r/statuses/${B}`,
        body: {
          state: "pending",
          context: STATUS_CONTEXT,
          description: "Revisando el commit bbbbbbbbbbbb",
          target_url: "https://github.com/o/r/actions/runs/42",
        },
      },
      {
        method: "PATCH",
        path: "/repos/o/r/issues/comments/3",
        body: { body: stampRun(pendingComment(B, "https://github.com/o/r/actions/runs/42"), "42") },
      },
    ]);
    const body = String(f.writes[1]?.body.body);
    expect(
      body.startsWith(`${MARKER}
<!-- map-pr-run 42 -->
`),
    ).toBe(true);
    expect(body).toContain("⏳ **Pendiente:** revisando el commit `bbbbbbbbbbbb`");
    expect(body).not.toContain("✅");
  });

  it("only sets the status when there is no comment yet", async () => {
    const f = fakeGitHub({ pulls: [pull()], files: {}, comments: {}, runs: {} });
    await markPending(env(), f.gh);
    expect(f.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /repos/o/r/statuses/${B}`]);
  });

  it("writes nothing for a commit that is no longer the PR's head", async () => {
    // The run is for B; the PR already moved on to C (its own run marks C).
    const f = fakeGitHub({
      pulls: [pull({ head: { sha: C, repo: { full_name: "someone/r" } } })],
      files: {},
      comments: { 5: [bot(3, MARKER)] },
      runs: {},
    });
    expect(await markPending(env(), f.gh)).toContain("nothing to do");
    // A PR from another repo with the same commit is not this run's PR either.
    const g = fakeGitHub({
      pulls: [pull({ head: { sha: B, repo: { full_name: "other/r" } } })],
      files: {},
      comments: {},
      runs: {},
    });
    expect(await markPending(env(), g.gh)).toContain("no open pull request");
    expect([...f.writes, ...g.writes]).toEqual([]);
  });

  it("leaves a run that already finished to the verdict job", async () => {
    const f = fakeGitHub({ pulls: [pull()], files: {}, comments: {}, runs: { 42: "completed" } });
    expect(await markPending(env(), f.gh)).toContain("already completed");
    expect(f.writes).toEqual([]);
  });

  it("fails (red job) when the API fails, instead of passing without marking", async () => {
    const f = fakeGitHub({
      pulls: [pull()],
      files: {},
      comments: { 5: [bot(3, MARKER)] },
      runs: {},
      failOn: "PATCH",
    });
    await expect(markPending(env(), f.gh)).rejects.toThrow("HTTP 502");
  });

  it("uses the PR number GitHub gives for a branch of the repo", async () => {
    // PR 9 is not in the listing (past its first 1000 open PRs): only the hint finds it.
    const p = pull({ number: 9, head: { sha: B, repo: { full_name: "o/r" } }, unlisted: true });
    const f = fakeGitHub({ pulls: [p], files: {}, comments: {}, runs: {} });
    expect(await markPending(env({ HEAD_REPO: "o/r", PR_HINT: "9" }), f.gh)).toContain("PR #9");
    expect(f.writes.map((w) => w.path)).toEqual([`/repos/o/r/statuses/${B}`]);
    const g = fakeGitHub({ pulls: [p], files: {}, comments: {}, runs: {} });
    expect(await markPending(env({ HEAD_REPO: "o/r" }), g.gh)).toContain("no open pull request");
    // A closed PR with that head (into another branch) neither counts nor makes it ambiguous.
    const closed = pull({
      number: 8,
      state: "closed",
      base: { ref: "old" },
      head: { sha: B, repo: { full_name: "o/r" } },
      unlisted: true,
    });
    const k = fakeGitHub({
      pulls: [closed, { ...p, unlisted: false }],
      files: {},
      comments: {},
      runs: {},
    });
    expect(await markPending(env({ HEAD_REPO: "o/r", PR_HINT: "8" }), k.gh)).toContain(
      "PR #9: status pending",
    );
    // A hint for another commit's PR is ignored.
    const h = fakeGitHub({
      pulls: [pull({ number: 9, unlisted: true })],
      files: {},
      comments: {},
      runs: {},
    });
    expect(await markPending(env({ HEAD_REPO: "o/r", PR_HINT: "9" }), h.gh)).toContain(
      "no open pull request",
    );
  });
});

describe("map-pr finished (verdict)", () => {
  const base = (patch: Partial<Fake> = {}): Fake => ({
    pulls: [pull()],
    files: { 5: [{ filename: CHUNK }] },
    comments: {},
    runs: { 42: "completed" },
    ...patch,
  });

  it("posts the comment, then a success status for a pass", async () => {
    const f = fakeGitHub(base());
    await postVerdict(withReport(env(), report()), f.gh);
    expect(f.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /repos/o/r/issues/5/comments",
      `POST /repos/o/r/statuses/${B}`,
    ]);
    expect(String(f.writes[0]?.body.body)).toContain("✅ **Pasa.**");
    expect(f.writes[1]?.body).toMatchObject({ state: "success", context: STATUS_CONTEXT });
  });

  it("fails the status with the failures the trusted side sees", async () => {
    const outside = {
      plots: {
        count: 1,
        violations_total: 1,
        violations: [{ kind: "tiles", path: CHUNK, tiles: 2, at: ["1,1,7"] }],
      },
      maintainer: true, // what the report claims; the API says CONTRIBUTOR
    };
    const f = fakeGitHub(base({ comments: { 5: [bot(7, MARKER)] } }));
    await postVerdict(withReport(env(), report(outside)), f.gh);
    expect(f.writes[0]?.path).toBe("/repos/o/r/issues/comments/7");
    expect(statusOf(f.writes)[0]?.body).toMatchObject({
      state: "failure",
      description: "No pasa: plots",
    });
  });

  it("never gives a success to a community PR that changes the check", async () => {
    const files = [
      { filename: CHUNK },
      { filename: "docs/x.yml", previous_filename: ".github/workflows/map-pr.yml" },
    ];
    const f = fakeGitHub(base({ files: { 5: files }, pulls: [pull({ changed_files: 2 })] }));
    await postVerdict(withReport(env(), report()), f.gh);
    expect(String(f.writes[0]?.body.body)).toContain("El veredicto no es confiable");
    expect(statusOf(f.writes)[0]?.body.state).toBe("failure");
    // The owner's own PR (from a branch of the repo) is trusted with it.
    const owner = pull({
      author_association: "OWNER",
      changed_files: 2,
      head: { sha: B, repo: { full_name: "o/r" } },
    });
    const g = fakeGitHub(base({ files: { 5: files }, pulls: [owner] }));
    await postVerdict(withReport(env({ HEAD_REPO: "o/r" }), report()), g.gh);
    expect(statusOf(g.writes)[0]?.body.state).toBe("success");
  });

  it("fails the status when the run left no usable report", async () => {
    const f = fakeGitHub(base());
    await postVerdict(env({ CONCLUSION: "failure" }), f.gh);
    expect(String(f.writes[0]?.body.body)).toContain("no dejó un reporte utilizable");
    expect(statusOf(f.writes)[0]?.body.state).toBe("failure");
    // A report about another commit is no report.
    const g = fakeGitHub(base());
    await postVerdict(withReport(env(), report({ head: C })), g.gh);
    expect(statusOf(g.writes)[0]?.body.state).toBe("failure");
  });

  it("sets success without a comment for a PR that does not change world/", async () => {
    const f = fakeGitHub(base({ files: { 5: [{ filename: "client/src/main.tsx" }] } }));
    expect(await postVerdict(env(), f.gh)).toContain("no comment");
    expect(f.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /repos/o/r/statuses/${B}`]);
    expect(f.writes[0]?.body).toMatchObject({ state: "success" });
    // With a comment from an earlier commit, it says the old review no longer applies.
    const g = fakeGitHub(
      base({
        files: { 5: [{ filename: "client/src/main.tsx" }] },
        comments: { 5: [bot(7, MARKER)] },
      }),
    );
    await postVerdict(env(), g.gh);
    expect(String(g.writes[0]?.body.body)).toContain("ya no cambia nada en `world/`");
  });

  it("writes nothing for a commit that is no longer the PR's head", async () => {
    // An old pass must never replace "pending", nor be set on the new commit.
    const f = fakeGitHub(
      base({
        pulls: [pull({ head: { sha: C, repo: { full_name: "someone/r" } } })],
        comments: { 5: [bot(7, MARKER)] },
      }),
    );
    expect(await postVerdict(withReport(env(), report()), f.gh)).toContain("nothing to do");
    expect(f.writes).toEqual([]);
  });

  it("writes the comment first, then fails (red job) when the status call fails", async () => {
    const f = fakeGitHub(base({ failOn: "POST /repos/o/r/statuses/" }));
    await expect(postVerdict(withReport(env(), report()), f.gh)).rejects.toThrow("HTTP 502");
    expect(f.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /repos/o/r/issues/5/comments",
    ]);
    expect(String(f.writes[0]?.body.body)).toContain("✅ **Pasa.**");
  });
});

describe("PRs into another branch, late events and impostors", () => {
  const OLD = "content/old";
  const base = (patch: Partial<Fake> = {}): Fake => ({
    pulls: [pull()],
    files: { 5: [{ filename: CHUNK }] },
    comments: {},
    runs: { 42: "completed" },
    ...patch,
  });
  /** A report of PR 5 with tiles outside every plot (fails "plots" for a community PR). */
  const outside = {
    plots: {
      count: 1,
      violations_total: 1,
      violations: [{ kind: "tiles", path: CHUNK, tiles: 2, at: ["1,1,7"] }],
    },
  };
  const calls = (writes: ReturnType<typeof fakeGitHub>["writes"]) =>
    writes.map((w) => `${w.method} ${w.path}`);

  it("writes the commit status only for a PR into the default branch", async () => {
    // Commit B's only PR goes into an old branch: its comment, never main's status.
    const into = pull({ base: { ref: OLD } });
    const f = fakeGitHub(base({ pulls: [into], comments: { 5: [bot(7, MARKER)] }, runs: {} }));
    expect(await markPending(env(), f.gh)).toContain(`no status (PR into ${OLD})`);
    const g = fakeGitHub(base({ pulls: [into] }));
    expect(await postVerdict(withReport(env(), report()), g.gh)).toContain("would be success");
    expect([...calls(f.writes), ...calls(g.writes)]).toEqual([
      "PATCH /repos/o/r/issues/comments/7",
      "POST /repos/o/r/issues/5/comments",
    ]);
  });

  it("never lets the PR into another branch set the status of main's PR with the same commit", async () => {
    // PR 5 (B into main) fails plots. PR 6, newer and so first in the listing, has the same
    // head B into an old branch where those tiles are in a plot: its run passes.
    const pulls = [pull({ number: 6, base: { ref: OLD } }), pull()];
    const files = { 5: [{ filename: CHUNK }], 6: [{ filename: CHUNK }] };
    const f = fakeGitHub(base({ pulls, files }));
    await postVerdict(withReport(env(), report({ pr: 6 })), f.gh);
    expect(calls(f.writes)).toEqual(["POST /repos/o/r/issues/6/comments"]);
    // PR 5's own run: its comment and the status of B.
    const g = fakeGitHub(base({ pulls, files }));
    await postVerdict(withReport(env(), report(outside)), g.gh);
    expect(calls(g.writes)).toEqual([
      "POST /repos/o/r/issues/5/comments",
      `POST /repos/o/r/statuses/${B}`,
    ]);
    expect(statusOf(g.writes)[0]?.body.state).toBe("failure");
    // A run that does not say which of them it is for (the pending job, or no usable
    // report): nothing at all, not even a pending status that no verdict would replace.
    const comments = { 5: [bot(7, MARKER)], 6: [bot(8, MARKER)] };
    const h = fakeGitHub(base({ pulls, files, comments, runs: {} }));
    expect(await markPending(env(), h.gh)).toContain("go into different branches");
    expect(await postVerdict(env({ CONCLUSION: "failure" }), h.gh)).toContain(
      "go into different branches",
    );
    expect(h.writes).toEqual([]);
  });

  it("never lets a late event of an older run replace what a newer run wrote", async () => {
    const newer = bot(7, stampRun(`${MARKER}\n✅ newer`, "50"));
    const f = fakeGitHub(base({ comments: { 5: [newer] }, runs: {} }));
    expect(await markPending(env(), f.gh)).toContain("run 50 of map-pr is newer than 42");
    expect(await postVerdict(withReport(env(), report(outside)), f.gh)).toContain(
      "run 50 of map-pr is newer than 42",
    );
    expect(f.writes).toEqual([]);
    // A re-run of the newest run (same id), or a newer run, writes and stamps its id.
    for (const id of ["50", "51"]) {
      const g = fakeGitHub(base({ comments: { 5: [newer] } }));
      await postVerdict(withReport(env({ RUN_ID: id }), report()), g.gh);
      expect(calls(g.writes)).toEqual([
        "PATCH /repos/o/r/issues/comments/7",
        `POST /repos/o/r/statuses/${B}`,
      ]);
      expect(String(g.writes[0]?.body.body).split("\n").slice(0, 2)).toEqual([
        MARKER,
        `<!-- map-pr-run ${id} -->`,
      ]);
    }
    // A comment without the run line (older format) does not hold anything back.
    const g = fakeGitHub(base({ comments: { 5: [bot(7, `${MARKER}\n✅ old`)] } }));
    expect(await postVerdict(withReport(env(), report()), g.gh)).toContain("status success");
  });

  it("fails the status and warns when a check run poses as map-pr/verdict", async () => {
    const f = fakeGitHub(base({ impostors: 1 }));
    await postVerdict(withReport(env(), report()), f.gh);
    const body = String(f.writes[0]?.body.body);
    expect(body).toContain("🚨 **Otro check de este commit se llama `map-pr/verdict`**");
    expect(body).not.toContain("✅");
    expect(statusOf(f.writes)[0]?.body.state).toBe("failure");
    // Also for the owner, and for a commit that does not change world/.
    const owner = pull({
      author_association: "OWNER",
      head: { sha: B, repo: { full_name: "o/r" } },
    });
    const g = fakeGitHub(
      base({
        impostors: 2,
        pulls: [owner],
        files: { 5: [{ filename: ".github/workflows/x.yml" }] },
      }),
    );
    await postVerdict(env({ HEAD_REPO: "o/r" }), g.gh);
    expect(calls(g.writes)).toEqual([`POST /repos/o/r/statuses/${B}`]);
    expect(g.writes[0]?.body.state).toBe("failure");
    // An answer without the count turns the job red before anything is written.
    const h = fakeGitHub(base({ impostors: null }));
    await expect(postVerdict(withReport(env(), report()), h.gh)).rejects.toThrow("total_count");
    expect(h.writes).toEqual([]);
  });
});

describe("pickPull", () => {
  const p = (number: number, ref: string) => ({ number, base: { ref } });
  it("follows the report's PR among those of the commit, else only an unambiguous one", () => {
    expect(pickPull([], 5)).toBeUndefined();
    expect(pickPull([p(5, "main")])?.number).toBe(5);
    expect(pickPull([p(5, "main")], 9)?.number).toBe(5); // matchReport rejects it later
    expect(pickPull([p(6, "old"), p(5, "main")], 5)?.number).toBe(5);
    expect(pickPull([p(6, "old"), p(5, "main")], 6)?.number).toBe(6);
    expect(pickPull([p(6, "old"), p(5, "main")])).toBeUndefined();
    expect(pickPull([p(6, "old"), p(5, "main")], 7)).toBeUndefined();
    expect(pickPull([p(6, "main"), p(5, "main")])?.number).toBe(6);
  });
});

describe("commitStatus", () => {
  const r = checkReport(report());
  it("is a success only for the comment's pass, a maintainer's pass or no map", () => {
    const mapOnly = trustedFacts([CHUNK], false);
    expect(commitStatus(r, mapOnly, true).state).toBe("success");
    expect(commitStatus(null, mapOnly, true).state).toBe("failure");
    const code = trustedFacts([CHUNK, "server/main.go"], false);
    expect(commitStatus(r, code, true).state).toBe("failure");
    expect(commitStatus(r, trustedFacts([CHUNK, "server/main.go"], true), true).state).toBe(
      "success",
    );
    // A maintainer's report with failures still fails.
    const bad = checkReport(report({ ok: false, failures: ["validation"] }));
    expect(commitStatus(bad, trustedFacts([CHUNK], true), true)).toEqual({
      state: "failure",
      description: "No pasa: validation",
    });
  });

  it("does not trust 'no map' when the API did not list every file", () => {
    const cut = trustedFacts(["client/a.ts"], false, 5000);
    expect(cut.truncated).toBe(true);
    expect(commitStatus(null, cut, false).state).toBe("failure");
    expect(commitStatus(null, trustedFacts(["client/a.ts"], true, 5000), false).state).toBe(
      "success",
    );
    expect(commitStatus(null, trustedFacts(["client/a.ts"], false), false).state).toBe("success");
  });

  it("keeps every description within GitHub's 140 characters", () => {
    const all = checkReport(
      report({
        ok: false,
        failures: ["conflicts", "validation", "invalid", "rebase", "merge_mismatch", "limits"],
      }),
    );
    const t = trustedFacts([CHUNK], false);
    expect(commitStatus(all, t, true).description.length).toBeLessThanOrEqual(140);
  });
});

describe("readEnv", () => {
  const ok = { GITHUB_REPOSITORY: "o/r", RUN_ID: "1", HEAD_SHA: A, DEFAULT_BRANCH: "main" };
  it("checks every value the event's head fields set", () => {
    expect(readEnv(ok).headRepo).toBe(""); // a deleted fork
    expect(() => readEnv({ ...ok, HEAD_SHA: "abc" })).toThrow();
    expect(() => readEnv({ ...ok, RUN_ID: "1;x" })).toThrow();
    expect(() => readEnv({ ...ok, GITHUB_REPOSITORY: "o/r/x" })).toThrow();
    expect(() => readEnv({ ...ok, HEAD_REPO: "a/b c" })).toThrow();
    expect(() => readEnv({ ...ok, HEAD_REPO: "../x" })).toThrow();
    expect(() => readEnv({ ...ok, PR_HINT: "1/../2" })).toThrow();
    // The default branch comes from the event's repository; still checked.
    for (const bad of [undefined, "", "a..b", "-x", "/x", "x/", "a//b", "a b", "a\nb"])
      expect(() => readEnv({ ...ok, DEFAULT_BRANCH: bad }), String(bad)).toThrow();
    expect(readEnv({ ...ok, DEFAULT_BRANCH: "release/v1.2_x" }).defaultBranch).toBe(
      "release/v1.2_x",
    );
    expect(readEnv({ ...ok, HEAD_REPO: "some-one/r.x", PR_HINT: "12" })).toMatchObject({
      headRepo: "some-one/r.x",
      prHint: "12",
    });
  });
});
