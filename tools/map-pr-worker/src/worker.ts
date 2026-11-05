// The map PR worker (T4.5 2/2): takes approved map submissions from the queue and opens a
// pull request for each one in this repository, on a branch map-submission/<id> that only
// touches world/. Every step is safe to repeat after a crash:
//   1. an existing pull request from the branch (any state) is the answer;
//   2. else an existing branch is reused as it is (it is only ever created complete);
//   3. else the patch is merged onto the current base, and blobs, tree and commit are
//      written (content-addressed: repeating them is harmless) and then the branch;
//   4. the pull request is opened (or found, if a racing retry opened it first);
//   5. only then the submission moves to pr_opened, guarded by status = 'approved'.
// A failure of the patch (conflict, outside the plots...) moves it to failed with a fixed
// code; a failure of GitHub or the network leaves it approved and tries again later.
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
  /** GitHub refused the worker itself (token, permissions): nobody's attempt is spent. */
  | { kind: "blocked"; at: Date };

const MINUTE = 60_000;
/** How long the worker waits after GitHub refused it (configuration). */
const CONFIG_WAIT = 15 * MINUTE;

/** Wait before attempt n + 1: 1, 2, 4… minutes, at most 6 hours. */
export function backoff(attempts: number): number {
  return Math.min(MINUTE * 2 ** Math.max(0, attempts - 1), 6 * 60 * MINUTE);
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
    // A branch from an earlier attempt: reused only if its commit is this submission's.
    // It was only ever created complete (after its commit), so it is used as it is.
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
    if (e instanceof GitHubError && e.config) {
      // Not this submission's fault: wait for the operator, give the attempt back.
      const at = new Date(now().getTime() + CONFIG_WAIT);
      await queue.retryAt(s.id, at, true);
      log("error", "map PR worker: GitHub refused the worker (token, permissions or repository?)", {
        id: s.id,
        err: message,
      });
      return { kind: "blocked", at };
    }
    if (!(e instanceof GitHubError) || !e.retryable || s.attempts >= maxAttempts) {
      // A GitHub answer that will not change, or one exception too many: a final failure.
      // An exception that is not GitHub's comes from the patch (it parsed on the server).
      const code: FailureCode = e instanceof GitHubError ? "github" : "invalid_patch";
      await queue.failed(s.id, now(), code);
      log("error", "map submission failed", {
        id: s.id,
        attempts: s.attempts,
        failure: code,
        err: message,
      });
      return { kind: "failed", code };
    }
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
 * An error of the queue itself (Postgres) is thrown: the caller waits and tries again.
 */
export async function runOnce(
  gh: GitHub,
  queue: Queue,
  opts: WorkerOptions & { onlyId?: number },
): Promise<Outcome[]> {
  const now = opts.now ?? (() => new Date());
  const lease = opts.lease ?? 10 * MINUTE;
  const out: Outcome[] = [];
  for (;;) {
    const t = now();
    const s = await queue.claim(t, new Date(t.getTime() + lease), opts.onlyId);
    if (!s) return out;
    if (s.attempts > (opts.maxAttempts ?? 10)) {
      // Its attempts ran out without an outcome: a worker died on it (out of memory...)
      // every time. Stop claiming it.
      await queue.failed(s.id, t, "github");
      out.push({ kind: "failed", code: "github" });
    } else {
      const o = await handle(gh, queue, s, opts);
      out.push(o);
      // GitHub refuses the worker itself: the others would fail the same way.
      if (o.kind === "blocked") return out;
    }
    if (opts.onlyId !== undefined) return out;
  }
}
