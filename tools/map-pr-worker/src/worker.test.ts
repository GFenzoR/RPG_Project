// The worker against the fake GitHub (test/fake-github.ts) and an in-memory queue: the
// pull request it opens, failures of the patch, retries, and that a crash at any step
// never opens a second pull request.
import { afterEach, describe, expect, it } from "vitest";
import { CONTRIBUTORS, branchOf } from "./build.ts";
import { GitHub } from "./github.ts";
import type { Claimed, Queue } from "./queue.ts";
import { CONFIG_WAIT, backoff, checkIdentity, pausedUntil, runOnce } from "./worker.ts";
import { startFakeGitHub } from "../test/fake-github.ts";
import type { FakeGitHub } from "../test/fake-github.ts";
import { PLOT_CHUNK, paint, plotSubmission, readRepo } from "../test/fixtures.ts";
import { readConfig } from "./config.ts";

const TOKEN = "github_pat_test_token";

interface Row extends Claimed {
  status: string;
  nextAt: Date | null;
  failure?: string;
  prUrl?: string;
  prNumber?: number;
}

/** The queue's contract in memory, with an optional crash in `opened`. */
class MemQueue implements Queue {
  rows: Row[] = [];
  crashOnOpened = 0;
  add(s = plotSubmission()): Row {
    const r: Row = { ...s, attempts: 0, status: "approved", nextAt: null };
    this.rows.push(r);
    return r;
  }
  async claim(now: Date, leaseUntil: Date, onlyId?: number): Promise<Claimed | null> {
    const r = this.rows.find(
      (x) =>
        x.status === "approved" &&
        (x.nextAt === null || x.nextAt <= now) &&
        (onlyId === undefined || x.id === onlyId),
    );
    if (!r) return null;
    r.attempts++;
    r.nextAt = leaseUntil;
    return { ...r };
  }
  async opened(id: number, _now: Date, url: string, num: number): Promise<boolean> {
    if (this.crashOnOpened > 0) {
      this.crashOnOpened--;
      throw new Error("connection lost");
    }
    const r = this.rows.find((x) => x.id === id && x.status === "approved");
    if (!r) return false;
    Object.assign(r, { status: "pr_opened", prUrl: url, prNumber: num, nextAt: null });
    return true;
  }
  async failed(id: number, _now: Date, code: string): Promise<boolean> {
    const r = this.rows.find((x) => x.id === id && x.status === "approved");
    if (!r) return false;
    Object.assign(r, { status: "failed", failure: code, nextAt: null });
    return true;
  }
  async retryAt(id: number, at: Date, refund = false): Promise<void> {
    const r = this.rows.find((x) => x.id === id && x.status === "approved");
    if (!r) return;
    r.nextAt = at;
    if (refund) r.attempts = Math.max(0, r.attempts - 1);
  }
}

let fake: FakeGitHub;
let clock = new Date("2026-11-06T10:00:00Z");
const now = (): Date => clock;
afterEach(async () => fake?.close());

async function setup(read = readRepo): Promise<{ gh: GitHub; q: MemQueue }> {
  fake = await startFakeGitHub({ owner: "acme", repo: "rpg", token: TOKEN, readBase: read });
  const gh = new GitHub({ apiUrl: fake.url, token: TOKEN, owner: "acme", repo: "rpg" });
  return { gh, q: new MemQueue() };
}
const opts = { base: "main", now };
const B7 = branchOf(plotSubmission());

describe("map PR worker", () => {
  it("opens one pull request that only touches world/ and credits the author", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    const out = await runOnce(gh, q, opts);
    expect(out).toMatchObject([
      {
        kind: "opened",
        pr: { number: 1, url: "https://github.com/acme/rpg/pull/1", state: "open" },
      },
    ]);
    expect(row).toMatchObject({
      status: "pr_opened",
      prNumber: 1,
      prUrl: "https://github.com/acme/rpg/pull/1",
    });
    const pr = fake.pulls[0];
    expect(pr).toMatchObject({ head: B7, base: "main" });
    expect(pr?.title).toBe("map: Pasto en la playa norte (envío n.º 7)");
    expect(pr?.body).toContain("Cartographer Aria");
    // The branch's commit: the merged chunk and the credits row, nothing else.
    expect(fake.fileOn(B7, PLOT_CHUNK)).toBe(
      paint(readRepo(PLOT_CHUNK) ?? "", 3202, 6298, "grass"),
    );
    expect(fake.fileOn(B7, CONTRIBUTORS)).toContain("| Cartographer Aria | puerto | envío n.º 7 |");
    const head = fake.commits.get(fake.refs.get(B7) ?? "");
    expect(head?.parents).toEqual([fake.refs.get("main")]);
    expect(head?.message).toContain("Map-Submission: 7");
    expect(fake.requests.filter((r) => r === "POST /pulls")).toHaveLength(1);
  });

  it("merges onto the current base, not the one the patch was made on", async () => {
    const moved = paint(readRepo(PLOT_CHUNK) ?? "", 3210, 6300, "dirt");
    const { gh, q } = await setup((p) => (p === PLOT_CHUNK ? moved : readRepo(p)));
    q.add();
    await runOnce(gh, q, opts);
    expect(fake.fileOn(B7, PLOT_CHUNK)).toBe(paint(moved, 3202, 6298, "grass"));
  });

  it("marks a conflict as failed and creates nothing", async () => {
    const changed = paint(readRepo(PLOT_CHUNK) ?? "", 3202, 6298, "dirt");
    const { gh, q } = await setup((p) => (p === PLOT_CHUNK ? changed : readRepo(p)));
    const row = q.add();
    expect(await runOnce(gh, q, opts)).toEqual([{ kind: "failed", code: "conflict" }]);
    expect(row).toMatchObject({ status: "failed", failure: "conflict" });
    expect(fake.refs.has(B7)).toBe(false);
    expect(fake.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });

  it("refuses a patch outside world/ even if it reached the queue", async () => {
    const { gh, q } = await setup();
    const row = q.add({
      ...plotSubmission(),
      patch: JSON.stringify({
        format: 2,
        kind: "rpg-map-patch",
        base_ref: "HEAD",
        files: [{ path: ".github/workflows/x.yml", base: null, content: "on: push\n" }],
      }),
    });
    await runOnce(gh, q, opts);
    expect(row).toMatchObject({ status: "failed", failure: "invalid_patch" });
    expect(fake.requests.some((r) => r.startsWith("POST"))).toBe(false);
  });

  it("retries a GitHub failure later, then gives up", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    fake.fail({ route: "POST /git/trees", status: 502, times: 100 });
    const first = await runOnce(gh, q, opts);
    expect(first).toEqual([{ kind: "retry", at: new Date(clock.getTime() + backoff(1)) }]);
    expect(row.status).toBe("approved");
    // Not due yet: nothing happens.
    expect(await runOnce(gh, q, opts)).toEqual([]);
    for (let i = 2; i <= 10; i++) {
      clock = new Date((row.nextAt ?? clock).getTime());
      await runOnce(gh, q, opts);
    }
    expect(row).toMatchObject({ status: "failed", failure: "github", attempts: 10 });
    expect(backoff(1)).toBe(60_000);
    expect(backoff(30)).toBe(6 * 3600_000);
  });

  it("never opens a second pull request, whatever step it stopped at", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    // 1. The branch is created, then opening the pull request fails.
    fake.fail({ route: "POST /pulls", status: 502 });
    expect((await runOnce(gh, q, opts))[0]?.kind).toBe("retry");
    expect(fake.refs.has(B7)).toBe(true);
    expect(fake.pulls).toHaveLength(0);
    // 2. Next try: reuses the branch (no new commit) and opens it; then the database
    //    update fails (as if the worker died right after GitHub answered).
    const commits = fake.commits.size;
    q.crashOnOpened = 1;
    clock = new Date((row.nextAt ?? clock).getTime());
    // The queue error goes up (the CLI logs it and waits); the lease keeps the row.
    await expect(runOnce(gh, q, opts)).rejects.toThrow("connection lost");
    expect(fake.commits.size).toBe(commits);
    expect(fake.pulls).toHaveLength(1);
    // 3. Next try: finds that pull request and records it.
    clock = new Date((row.nextAt ?? clock).getTime());
    await runOnce(gh, q, opts);
    expect(row).toMatchObject({ status: "pr_opened", prNumber: 1 });
    expect(fake.pulls).toHaveLength(1);
    expect(fake.requests.filter((r) => r === "POST /git/refs")).toHaveLength(1);
  });

  it("handles a branch race: another attempt created it first", async () => {
    const { gh, q } = await setup();
    q.add();
    // The ref creation answers 422 (already exists) and the PR is opened anyway.
    const orig = gh.createBranch.bind(gh);
    gh.createBranch = async (b, sha) => {
      await orig(b, sha);
      return orig(b, sha);
    };
    await runOnce(gh, q, opts);
    expect(fake.pulls).toHaveLength(1);
  });

  it("only handles the given id with onlyId", async () => {
    const { gh, q } = await setup();
    const a = q.add(plotSubmission(1));
    const b = q.add(plotSubmission(2, 3204, 6299));
    await runOnce(gh, q, { ...opts, onlyId: 2 });
    expect(a.status).toBe("approved");
    expect(b.status).toBe("pr_opened");
  });

  it("a refused token blocks the worker without spending anyone's attempts", async () => {
    const { q } = await setup();
    const a = q.add(plotSubmission(1));
    const b = q.add(plotSubmission(2, 3204, 6299));
    const bad = new GitHub({ apiUrl: fake.url, token: "expired", owner: "acme", repo: "rpg" });
    for (let i = 0; i < 20; i++) {
      const out = await runOnce(bad, q, opts);
      expect(out.map((o) => o.kind)).toEqual(["paused"]); // stops at the first one
      clock = new Date((a.nextAt ?? clock).getTime());
    }
    expect(a).toMatchObject({ status: "approved", attempts: 0 });
    expect(b).toMatchObject({ status: "approved", attempts: 0 });
    // Fixed token: both go through.
    const { gh } = {
      gh: new GitHub({ apiUrl: fake.url, token: TOKEN, owner: "acme", repo: "rpg" }),
    };
    expect((await runOnce(gh, q, opts)).map((o) => o.kind)).toEqual(["opened", "opened"]);
  });

  it("a missing permission (403 without rate limit) pauses the worker for 15 minutes", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    const other = q.add(plotSubmission(8, 3204, 6299));
    fake.fail({ route: "POST /git/trees", status: 403 });
    const out = await runOnce(gh, q, opts);
    expect(out).toEqual([
      { kind: "paused", until: new Date(clock.getTime() + CONFIG_WAIT), reason: "config" },
    ]);
    expect(pausedUntil(out)).toEqual(new Date(clock.getTime() + CONFIG_WAIT));
    expect(row.attempts).toBe(0);
    expect(other.attempts).toBe(0); // not claimed in the same round
  });

  it("a rate limit pauses the whole worker for as long as GitHub asks", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    const other = q.add(plotSubmission(8, 3204, 6299));
    fake.fail({ route: "POST /git/trees", status: 429, headers: { "retry-after": "120" } });
    const out = await runOnce(gh, q, opts);
    expect(out).toEqual([
      { kind: "paused", until: new Date(clock.getTime() + 120_000), reason: "rate_limit" },
    ]);
    expect(row).toMatchObject({ status: "approved", attempts: 0 });
    expect(other.attempts).toBe(0);
    // A 403 with no requests left is a rate limit too; without a hint, at least a minute.
    clock = new Date(clock.getTime() + 120_000);
    fake.fail({ route: "POST /git/trees", status: 403, headers: { "x-ratelimit-remaining": "0" } });
    const again = await runOnce(gh, q, opts);
    expect(again[0]).toMatchObject({ kind: "paused", reason: "rate_limit" });
    expect(pausedUntil(again)?.getTime()).toBeGreaterThanOrEqual(clock.getTime() + 60_000);
    // When the limit is over, both go through.
    clock = new Date((pausedUntil(again) ?? clock).getTime());
    expect((await runOnce(gh, q, opts)).map((o) => o.kind)).toEqual(["opened", "opened"]);
  });

  it("a body cut short, a stalled body or an empty 200 is retried, never invalid_patch", async () => {
    const { q } = await setup();
    const gh = new GitHub({
      apiUrl: fake.url,
      token: TOKEN,
      owner: "acme",
      repo: "rpg",
      timeoutMs: 300,
    });
    const row = q.add();
    for (const [route, mode] of [
      ["GET /pulls", "truncate"],
      ["GET /git/ref", "stall"],
      ["GET /git/ref", "empty"],
    ] as const) {
      fake.fail({ route, status: 200, mode });
      expect((await runOnce(gh, q, opts))[0]?.kind).toBe("retry");
      expect(row.status).toBe("approved");
      clock = new Date((row.nextAt ?? clock).getTime());
    }
    expect(row.attempts).toBe(3);
    await runOnce(gh, q, opts);
    expect(row.status).toBe("pr_opened");
  });

  it("never takes a pull request or a branch of another submission as its own", async () => {
    const { gh, q } = await setup();
    // Another database's submission 7 with another patch: other branch (sha in the name).
    const other = { ...plotSubmission(), sha256: "b".repeat(64) };
    q.add(other);
    await runOnce(gh, q, opts);
    expect(fake.pulls[0]?.head).toBe(branchOf(other));
    // Same id and same sha prefix, but the PR's marker is not this submission's.
    const twin = { ...plotSubmission(), sha256: `${"b".repeat(12)}${"c".repeat(52)}` };
    const row = q.add(twin);
    expect(await runOnce(gh, q, opts)).toEqual([{ kind: "failed", code: "github" }]);
    expect(row.status).toBe("failed");
    expect(fake.pulls).toHaveLength(1);
  });

  it("a database failure after the PR opened never marks it failed", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    row.attempts = 9; // the next one is the last attempt (default maxAttempts 10)
    q.crashOnOpened = 1;
    await expect(runOnce(gh, q, opts)).rejects.toThrow("connection lost");
    expect(row.status).toBe("approved");
    clock = new Date((row.nextAt ?? clock).getTime());
    // Out of attempts: before failing it, the worker finds the pull request and records it.
    await runOnce(gh, q, opts);
    expect(row).toMatchObject({ status: "pr_opened", prNumber: 1 });
    expect(fake.pulls).toHaveLength(1);
  });

  it("stops claiming a submission whose worker keeps dying on it", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    row.attempts = 10; // ten claims, no outcome
    expect(await runOnce(gh, q, opts)).toEqual([{ kind: "failed", code: "github" }]);
    expect(row).toMatchObject({ status: "failed", failure: "github" });
    expect(fake.requests).toEqual(["GET /pulls"]); // only the check for a pull request
  });

  it("the last attempt failing on POST /pulls fails it only if no PR exists", async () => {
    const { gh, q } = await setup();
    const row = q.add();
    row.attempts = 9;
    fake.fail({ route: "POST /pulls", status: 502 });
    expect(await runOnce(gh, q, opts)).toEqual([{ kind: "failed", code: "github" }]);
    expect(fake.refs.has(B7)).toBe(true);
    expect(row.status).toBe("failed");
  });
});

describe("identity", () => {
  it("refuses the repository owner and the map maintainers, accepts a bot", async () => {
    for (const [login, maintainers, ok] of [
      ["rpg-map-bot", "# maintainers\nsomeone\n", true],
      ["ACME", null, false],
      ["Someone", "# maintainers\nsomeone # map lead\n", false],
    ] as const) {
      fake = await startFakeGitHub({
        owner: "acme",
        repo: "rpg",
        token: TOKEN,
        login,
        readBase: (p) => (p === ".github/MAINTAINERS" ? maintainers : null),
      });
      const gh = new GitHub({ apiUrl: fake.url, token: TOKEN, owner: "acme", repo: "rpg" });
      expect((await checkIdentity(gh, "main")).ok).toBe(ok);
      await fake.close();
    }
  });
});

describe("config", () => {
  const env = {
    DATABASE_URL: "postgres://x",
    GITHUB_REPOSITORY: "acme/rpg",
    GITHUB_MAP_PR_TOKEN: TOKEN,
  };
  it("is disabled without a token", () => {
    expect(readConfig({ ...env, GITHUB_MAP_PR_TOKEN: "" })).toBe("disabled");
  });
  it("reads the defaults", () => {
    expect(readConfig(env)).toMatchObject({
      owner: "acme",
      repo: "rpg",
      base: "main",
      apiUrl: "https://api.github.com",
      pollMs: 30_000,
    });
  });
  it("refuses what would leak the token or misdirect the PRs", () => {
    for (const bad of [
      { GITHUB_API_URL: "http://evil.example" },
      { GITHUB_REPOSITORY: "acme" },
      { GITHUB_REPOSITORY: "acme/rpg/x" },
      { MAP_PR_BASE: "--force" },
      { MAP_PR_BASE: "a..b" },
      { MAP_PR_POLL_SECONDS: "0" },
      { DATABASE_URL: "" },
    ])
      expect(readConfig({ ...env, ...bad })).toHaveProperty("error");
    expect(readConfig({ ...env, GITHUB_API_URL: "http://127.0.0.1:9999" })).toMatchObject({
      apiUrl: "http://127.0.0.1:9999",
    });
  });
});
