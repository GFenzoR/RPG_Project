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
  postVerdict,
  readEnv,
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
  author_association: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
  changed_files: number;
}

interface Fake {
  pulls: Pull[];
  files: Record<number, { filename: string; previous_filename?: string }[]>;
  comments: Record<number, { id: number; body: string; user: { login: string } }[]>;
  runs: Record<string, string>;
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
    if (/^\/repos\/o\/r\/pulls\?state=open&per_page=100&page=1$/.test(path)) return f.pulls;
    if ((m = path.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments\?per_page=100&page=1$/)))
      return f.comments[Number(m[1])] ?? [];
    if ((m = path.match(/^\/repos\/o\/r\/actions\/runs\/(\d+)$/)))
      return { status: f.runs[m[1] ?? ""] ?? "in_progress" };
    if (/^\/repos\/o\/r\/actions\/runs\/\d+\/artifacts$/.test(path)) return { artifacts: [] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { gh, writes };
}

const pull = (patch: Partial<Pull> = {}): Pull => ({
  number: 5,
  author_association: "CONTRIBUTOR",
  user: { login: "someone" },
  head: { sha: B, repo: { full_name: "someone/r" } },
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
        body: { body: pendingComment(B, "https://github.com/o/r/actions/runs/42") },
      },
    ]);
    const body = String(f.writes[1]?.body.body);
    expect(body.startsWith(MARKER)).toBe(true);
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
    const p = pull({ number: 9, head: { sha: B, repo: { full_name: "o/r" } } });
    const f = fakeGitHub({ pulls: [p], files: {}, comments: {}, runs: {} });
    expect(await markPending(env({ HEAD_REPO: "o/r", PR_HINT: "9" }), f.gh)).toContain("PR #9");
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

  it("leaves the status pending (red job) when the status call fails", async () => {
    const f = fakeGitHub(base({ failOn: "POST /repos/o/r/statuses/" }));
    await expect(postVerdict(withReport(env(), report()), f.gh)).rejects.toThrow("HTTP 502");
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
  const ok = { GITHUB_REPOSITORY: "o/r", RUN_ID: "1", HEAD_SHA: A };
  it("checks every value the event's head fields set", () => {
    expect(readEnv(ok).headRepo).toBe(""); // a deleted fork
    expect(() => readEnv({ ...ok, HEAD_SHA: "abc" })).toThrow();
    expect(() => readEnv({ ...ok, RUN_ID: "1;x" })).toThrow();
    expect(() => readEnv({ ...ok, GITHUB_REPOSITORY: "o/r/x" })).toThrow();
    expect(() => readEnv({ ...ok, HEAD_REPO: "a/b c" })).toThrow();
    expect(() => readEnv({ ...ok, HEAD_REPO: "../x" })).toThrow();
    expect(() => readEnv({ ...ok, PR_HINT: "1/../2" })).toThrow();
    expect(readEnv({ ...ok, HEAD_REPO: "some-one/r.x", PR_HINT: "12" })).toMatchObject({
      headRepo: "some-one/r.x",
      prHint: "12",
    });
  });
});
