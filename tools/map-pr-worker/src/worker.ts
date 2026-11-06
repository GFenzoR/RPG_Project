// The map PR worker (T4.5 2/2): takes approved map submissions from the queue and opens a
// pull request for each one in this repository, on a branch map-submission/<id>-<sha12>
// that only touches world/. Every step is safe to repeat after a crash:
//   1. a pull request from the branch (any state) carrying the submission's marker is the
//      answer;
//   2. else the branch, if its commit carries the submission's trailers, is reused as it is
//      (it is only ever created complete);
//   3. else the patch is merged onto the current base and tree, commit and branch are
//      written;
//   4. the pull request is opened (or found, if a racing retry opened it first);
//   5. only then the submission moves to pr_opened, guarded by status = 'approved'.
// A failure of the patch (conflict, outside the plots...) moves it to failed with a fixed
// code. A failure on the way to GitHub leaves it approved and tries again later; only after
// its last attempt, and after checking that no pull request was opened meanwhile, it fails
// as `github`. GitHub refusing the worker itself (token, permissions) or rate limiting it
// pauses the whole worker, without spending anyone's attempts.
import {
  branchOf,
  buildChange,
  commitMessage,
  markerOf,
  prBody,
  prTitle,
  trailersOf,
} from "./build.ts";
import type { FailureCode, Submission } from "./build.ts";
import { GitHubError } from "./github.ts";
import type { GitHub, PullRequest, TreeEntry } from "./github.ts";
import type { Claimed, Queue } from "./queue.ts";

export interface WorkerOptions {
  /** Base branch of the pull requests (main). */
  base: string;
  /** How long a claim keeps other workers away (default 10 min). */
  lease?: number;
  /** After this many attempts a submission that keeps failing on GitHub fails (default 10). */
  maxAttempts?: number;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

export type Outcome =
  | { kind: "opened"; pr: PullRequest }
  | { kind: "failed"; code: FailureCode }
  | { kind: "retry"; at: Date }
  /**
   * The whole worker waits until `until`: GitHub refused it (config: token, permissions,
   * repository) or rate limited it. Nobody's attempt is spent; the round stops.
   */
  | { kind: "paused"; until: Date; reason: "config" | "rate_limit" };

const MINUTE = 60_000;
/** How long the worker waits after GitHub refused it (configuration). */
export const CONFIG_WAIT = 15 * MINUTE;

/** Wait before attempt n + 1: 1, 2, 4… minutes, at most 6 hours. */
export function backoff(attempts: number): number {
  return Math.min(MINUTE * 2 ** Math.max(0, attempts - 1), 6 * 60 * MINUTE);
}

/** The submission's own pull request, if one was opened (any state), or null. */
async function ownPull(gh: GitHub, s: Submission): Promise<PullRequest | null> {
  const pr = await gh.findPull(branchOf(s));
  return pr && pr.body.includes(markerOf(s)) ? pr : null;
}

/** Steps 1–4 for one submission: the pull request, or why there cannot be one. */
export async function openPullRequest(
  gh: GitHub,
  s: Submission,
  base: string,
): Promise<{ pr: PullRequest } | { failed: FailureCode }> {
  const branch = branchOf(s);
  const existing = await gh.findPull(branch);
  if (existing) {
    // Reused only if it is this submission's own pull request.
    if (!existing.body.includes(markerOf(s))) return { failed: "github" };
    return { pr: existing };
  }

  const head = await gh.branchSha(branch);
  if (head !== null) {
    // A branch from an earlier attempt (or opened by hand following the moderation page):
    // reused only if its commit is this submission's.
    if (!(await gh.commitMessage(head)).includes(trailersOf(s))) return { failed: "github" };
  } else {
    const baseSha = await gh.branchSha(base);
    if (baseSha === null) throw new GitHubError(`base branch ${base} not found`, 404, false, true);
    const built = await buildChange(s, (path) => gh.fileAt(path, baseSha));
    if (!built.ok) return { failed: built.code };
    const entries: TreeEntry[] = [...built.writes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, content }));
    const tree = await gh.createTree(await gh.commitTree(baseSha), entries);
    const commit = await gh.createCommit(commitMessage(s), tree, [baseSha]);
    await gh.createBranch(branch, commit);
  }
  const pr = await gh.openPull({ title: prTitle(s), head: branch, base, body: prBody(s) });
  return { pr };
}

/** A pause of the whole worker for a GitHub error, or undefined if it is not one. */
function pauseFor(
  e: unknown,
  now: Date,
): { until: Date; reason: "config" | "rate_limit" } | undefined {
  if (!(e instanceof GitHubError)) return undefined;
  if (e.config) return { until: new Date(now.getTime() + CONFIG_WAIT), reason: "config" };
  if (e.waitMs !== undefined)
    return { until: new Date(now.getTime() + e.waitMs), reason: "rate_limit" };
  return undefined;
}

/**
 * The last word on a submission that ran out of attempts: its pull request if one was
 * opened after all (the last attempt may have died right after GitHub created it), else a
 * final `github` failure. If GitHub cannot even be asked, it stays approved for later.
 */
async function giveUp(
  gh: GitHub,
  queue: Queue,
  s: Claimed,
  now: Date,
  log: NonNullable<WorkerOptions["log"]>,
  err: string,
): Promise<Outcome> {
  let pr: PullRequest | null;
  try {
    pr = await ownPull(gh, s);
  } catch (e) {
    const pause = pauseFor(e, now);
    const at = pause?.until ?? new Date(now.getTime() + backoff(s.attempts));
    await queue.retryAt(s.id, at, pause !== undefined);
    log("warn", "map submission out of attempts, GitHub unreachable: will check again", {
      id: s.id,
      at: at.toISOString(),
    });
    return pause ? { kind: "paused", ...pause } : { kind: "retry", at };
  }
  if (pr) {
    await queue.opened(s.id, now, pr.url, pr.number);
    log("info", "map submission pull request (found after its last attempt)", {
      id: s.id,
      pr: pr.number,
    });
    return { kind: "opened", pr };
  }
  await queue.failed(s.id, now, "github");
  log("error", "map submission failed", { id: s.id, attempts: s.attempts, failure: "github", err });
  return { kind: "failed", code: "github" };
}

/**
 * One claimed submission, start to end. The GitHub part decides the outcome; the queue
 * update after it is not caught: if Postgres fails there, the error goes up, the lease
 * runs out and the next attempt finds the pull request already open.
 */
export async function handle(
  gh: GitHub,
  queue: Queue,
  s: Claimed,
  opts: WorkerOptions,
): Promise<Outcome> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const maxAttempts = opts.maxAttempts ?? 10;
  let r: { pr: PullRequest } | { failed: FailureCode };
  try {
    r = await openPullRequest(gh, s, opts.base);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const pause = pauseFor(e, now());
    if (pause) {
      // Not this submission's fault: the whole worker waits, the attempt is given back.
      await queue.retryAt(s.id, pause.until, true);
      log(
        "error",
        `map PR worker paused: ${pause.reason === "config" ? "GitHub refused the worker (token, permissions or repository?)" : "GitHub rate limit"}`,
        {
          id: s.id,
          until: pause.until.toISOString(),
          err: message,
        },
      );
      return { kind: "paused", ...pause };
    }
    // Anything else (network, 5xx, a body cut short, even a bug) is retried: patch
    // problems never get here, buildChange returns them as codes.
    const final = (e instanceof GitHubError && !e.retryable) || s.attempts >= maxAttempts;
    if (final) return giveUp(gh, queue, s, now(), log, message);
    const at = new Date(now().getTime() + backoff(s.attempts));
    await queue.retryAt(s.id, at);
    log("warn", "map submission will retry", {
      id: s.id,
      attempts: s.attempts,
      at: at.toISOString(),
      err: message,
    });
    return { kind: "retry", at };
  }
  if ("failed" in r) {
    await queue.failed(s.id, now(), r.failed);
    log("info", "map submission failed", { id: s.id, failure: r.failed });
    return { kind: "failed", code: r.failed };
  }
  await queue.opened(s.id, now(), r.pr.url, r.pr.number);
  log("info", "map submission pull request", { id: s.id, pr: r.pr.number });
  return { kind: "opened", pr: r.pr };
}

/**
 * Handles every submission that is due now (or only `onlyId`) and returns what happened.
 * Stops at a pause (the caller sleeps until it). An error of the queue itself (Postgres)
 * is thrown: the caller waits and tries again.
 */
export async function runOnce(
  gh: GitHub,
  queue: Queue,
  opts: WorkerOptions & { onlyId?: number },
): Promise<Outcome[]> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const lease = opts.lease ?? 10 * MINUTE;
  const out: Outcome[] = [];
  for (;;) {
    const t = now();
    const s = await queue.claim(t, new Date(t.getTime() + lease), opts.onlyId);
    if (!s) return out;
    const o =
      s.attempts > (opts.maxAttempts ?? 10)
        ? // Its attempts ran out without an outcome: a worker died on it every time.
          await giveUp(gh, queue, s, t, log, "attempts ran out without an outcome")
        : await handle(gh, queue, s, opts);
    out.push(o);
    if (o.kind === "paused" || opts.onlyId !== undefined) return out;
  }
}

/** When the worker may go on after a round: the latest pause, if any. */
export function pausedUntil(outcomes: readonly Outcome[]): Date | undefined {
  let until: Date | undefined;
  for (const o of outcomes) if (o.kind === "paused" && (!until || o.until > until)) until = o.until;
  return until;
}

/**
 * Who the token is. The worker refuses to run as the repository's owner or as a map
 * maintainer (.github/MAINTAINERS of the base): the map PR check exempts their pull
 * requests from the community plot rule, and these pull requests carry players' changes.
 */
export async function checkIdentity(
  gh: GitHub,
  base: string,
): Promise<{ ok: true; login: string } | { ok: false; login: string; reason: string }> {
  const login = await gh.login();
  const me = login.toLowerCase();
  if (me === gh.owner.toLowerCase())
    return { ok: false, login, reason: "the token belongs to the repository owner" };
  const maintainers = (await gh.fileAt(".github/MAINTAINERS", base)) ?? "";
  const listed = maintainers
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
    .filter((l) => l !== "");
  if (listed.includes(me))
    return {
      ok: false,
      login,
      reason: "the token belongs to a map maintainer (.github/MAINTAINERS)",
    };
  return { ok: true, login };
}
