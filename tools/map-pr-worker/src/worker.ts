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
import { branchOf, buildChange, commitMessage, prBody, prTitle } from "./build.ts";
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
  | { kind: "retry"; at: Date };

const MINUTE = 60_000;

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
  const branch = branchOf(s.id);
  const existing = await gh.findPull(branch);
  if (existing) return { pr: existing };

  if ((await gh.branchSha(branch)) === null) {
    const baseSha = await gh.branchSha(base);
    if (baseSha === null) throw new GitHubError(`base branch ${base} not found`, 404, true);
    const built = await buildChange(s, (path) => gh.fileAt(path, baseSha));
    if (!built.ok) return { failed: built.code };
    const entries: TreeEntry[] = [];
    for (const [path, text] of [...built.writes].sort(([a], [b]) => a.localeCompare(b)))
      entries.push({ path, sha: text === null ? null : await gh.createBlob(text) });
    const tree = await gh.createTree(await gh.commitTree(baseSha), entries);
    const commit = await gh.createCommit(commitMessage(s), tree, [baseSha]);
    await gh.createBranch(branch, commit);
  }
  // A branch from an earlier attempt is used as it is: it was only created complete.
  const pr = await gh.openPull({ title: prTitle(s), head: branch, base, body: prBody(s) });
  return { pr };
}

/** One claimed submission, start to end, including the queue update. */
export async function handle(
  gh: GitHub,
  queue: Queue,
  s: Claimed,
  opts: WorkerOptions,
): Promise<Outcome> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const maxAttempts = opts.maxAttempts ?? 10;
  try {
    const r = await openPullRequest(gh, s, opts.base);
    if ("failed" in r) {
      await queue.failed(s.id, now(), r.failed);
      log("info", "map submission failed", { id: s.id, failure: r.failed });
      return { kind: "failed", code: r.failed };
    }
    await queue.opened(s.id, now(), r.pr.url, r.pr.number);
    log("info", "map submission pull request", { id: s.id, pr: r.pr.number });
    return { kind: "opened", pr: r.pr };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (s.attempts >= maxAttempts) {
      await queue.failed(s.id, now(), "github");
      log("error", "map submission gave up", { id: s.id, attempts: s.attempts, err: message });
      return { kind: "failed", code: "github" };
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
    out.push(await handle(gh, queue, s, opts));
    if (opts.onlyId !== undefined) return out;
  }
}
